/**
 * SenseNova 平台协议：常量、请求头、OAuth 换码/续期、额度读取。
 *
 * 全部照抄自"额度管理器"exe：
 *   - 常量与参数顺序：auth/auth.go（AuthorizeURL / TokenURL / ClientID=nova / RedirectURI / Scope / prompt=login）
 *   - 请求头：auth.go 与 quota/quota.go（补 Origin/Referer 与 Client-Hints，避开 WAF 与 CORS 校验）
 *   - 额度端点：platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage（Bearer 控制台 access_token）
 *
 * 与 exe 的差异只有一处：exe 用 Go 的 http.Client，这里用 fetch + AbortSignal.timeout。
 */

export const AUTHORIZE_URL = "https://platform.sensenova.cn/oauth2/auth";
export const TOKEN_URL = "https://platform.sensenova.cn/oauth2/token";
export const POOL_USAGE_URL = "https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage";
export const PLATFORM_ORIGIN = "https://platform.sensenova.cn";

export const CLIENT_ID = "nova";
export const REDIRECT_URI = "https://platform.sensenova.cn";
export const SCOPE = "openid offline offline_access";

/** Token Plan 的 OpenAI 兼容根（模型请求）。 */
export const BASE_URL = "https://token.sensenova.cn/v1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** 协议层错误：带上 HTTP 状态与 OAuth 错误码，便于区分"会话失效"与"暂时失败"。 */
export class ProtocolError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
    this.code = code;
  }

  /** refresh_token 被官方吊销/过期时的标志（需要重新登录）。 */
  get invalidGrant() {
    return this.code === "invalid_grant";
  }
}

function clientHints() {
  return {
    "User-Agent": USER_AGENT,
    "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

/** token 端点的请求头（auth.go 的补齐，避开商汤 WAF 反爬与 CORS 校验）。 */
export function tokenHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    Origin: PLATFORM_ORIGIN,
    Referer: `${PLATFORM_ORIGIN}/`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...clientHints(),
  };
}

/** 额度端点的请求头（quota.go 原样）。 */
export function quotaHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Referer: `${PLATFORM_ORIGIN}/console`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...clientHints(),
  };
}

/** 授权 URL（参数与 exe 的 PKCE.AuthorizeURL 一致，含 prompt=login 强制重新认证）。 */
export function buildAuthorizeUrl({ challenge, state }) {
  const q = new URLSearchParams();
  q.set("client_id", CLIENT_ID);
  q.set("response_type", "code");
  q.set("code_challenge", challenge);
  q.set("code_challenge_method", "S256");
  q.set("redirect_uri", REDIRECT_URI);
  q.set("state", state);
  q.set("scope", SCOPE);
  q.set("prompt", "login");
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/** 授权码换令牌的表单（照抄 exe）。 */
export function exchangeForm(code, verifier) {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", CLIENT_ID);
  form.set("code", code);
  form.set("redirect_uri", REDIRECT_URI);
  form.set("code_verifier", verifier);
  return form;
}

/** 静默续期的表单（照抄 exe）。 */
export function refreshForm(refreshToken) {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", CLIENT_ID);
  form.set("refresh_token", refreshToken);
  return form;
}

async function postToken(form, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: tokenHeaders(),
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProtocolError(`token 端点请求失败: ${e?.message ?? e}`);
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应按状态码处理 */
  }
  if (!res.ok || json?.error) {
    const code = typeof json?.error === "string" ? json.error : "";
    const detail = json?.error_description || text.slice(0, 200).trim() || `HTTP ${res.status}`;
    throw new ProtocolError(`token 端点: ${detail}`, { status: res.status, code });
  }
  if (!json || typeof json !== "object") {
    throw new ProtocolError("token 端点返回了非 JSON 内容", { status: res.status });
  }
  return json;
}

/** 用授权码 + 我们的 code_verifier 换令牌。返回 { access_token, id_token, refresh_token, expires_in, ... }。 */
export function exchangeCode({ code, verifier, timeoutMs }) {
  return postToken(exchangeForm(code, verifier), { timeoutMs });
}

/** 用 refresh_token 静默换新令牌（Hydra 轮换：返回里的 refresh_token 是新的，必须覆盖保存）。 */
export function refreshTokens(refreshToken, { timeoutMs } = {}) {
  return postToken(refreshForm(refreshToken), { timeoutMs });
}

/** 读控制台积分额度（通用池 / Flash-Lite 专属池）。 */
export async function fetchPoolUsage(accessToken, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(POOL_USAGE_URL, {
      headers: quotaHeaders(accessToken),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProtocolError(`额度端点请求失败: ${e?.message ?? e}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProtocolError(`额度端点拒绝了会话（HTTP ${res.status}）`, { status: res.status });
  }
  if (!res.ok) {
    throw new ProtocolError(`额度端点 HTTP ${res.status}`, { status: res.status });
  }
  try {
    return await res.json();
  } catch {
    throw new ProtocolError("额度端点返回了非 JSON 内容", { status: res.status });
  }
}

/** 解码 JWT payload（不校验签名——token 是我们自己从官方端点拿的）。 */
export function jwtPayload(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * 从令牌集里取账号名（exe 的顺序：access 的 ext.username / username，再取 id_token 的）。
 * 兜底取 preferred_username / email / sub，以及 id_token 里的嵌套 username。
 */
export function usernameFromTokens(tokens) {
  for (const token of [tokens?.access_token, tokens?.id_token]) {
    const claims = jwtPayload(token);
    if (!claims) continue;
    const candidate =
      claims?.ext?.username ??
      claims?.username ??
      claims?.id_token?.username ??
      claims?.preferred_username ??
      claims?.email ??
      claims?.sub;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/** 清理用户手输的 API Key（去空白、误贴的 "Bearer " 前缀与引号）。 */
export function normalizeApiKey(value) {
  let s = String(value ?? "").trim();
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, "");
  return s.replace(/^["'`]|["'`]$/g, "").trim();
}

/**
 * 快速验证 API Key 是否可用（best effort）：
 * 只有明确的 401/403 才判定为"无效"；网络故障不拦登录。
 */
export async function probeApiKey(apiKey, baseURL = BASE_URL, { timeoutMs = 10_000 } = {}) {
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProtocolError(`API Key 被拒绝（HTTP ${res.status}），请检查是否复制完整`, { status: res.status });
  }
  return res.ok;
}
