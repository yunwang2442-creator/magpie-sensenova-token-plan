/**
 * SenseNova（商量 / 日日新）Token Plan 供应商插件。
 *
 * 一个供应商，两套凭据，一次登录全拿到：
 *
 *   - 模型：Token Plan 说 OpenAI 方言（https://token.sensenova.cn/v1），
 *     用控制台生成的 API Key 请求，走 @ai-sdk/openai-compatible 常规通道。
 *   - 额度：控制台积分（general / Flash-Lite 池）在另一个 API 上
 *     （platform.sensenova.cn/…/tokenplan/pool-usage），要控制台 OAuth 的
 *     Bearer 令牌——浏览器登录拿到的就是它。
 *
 * 与同类实现的差别（"集百家之长"）：
 *   - 登录：移植自家 exe（sensenova额度管理器）的登录捕获——PKCE + 在授权回跳
 *     落地瞬间截停，早于官方 SPA 消费 code；载体从 WebView2 注入换成 CDP（见 lib/browser.mjs）。
 *   - 存储：refresh_token / access_token / API Key 落盘前经 Windows DPAPI 密封，
 *     只有当前 Windows 用户能解开；**账号密码从头到尾不出现**。
 *   - 续期：交给 magpie 的 auth.refresh（到期前 15 分钟自动换，令牌轮换后覆盖保存）。
 *   - 额度：按 exe 的看板口径映射成 magpie 窗口（5 小时 / 7 天，专属池限定 flash-lite）。
 *   - 模型清单：内置骨架来自官网文档；活的 GET /models 只覆盖上限/价格/描述，
 *     并过滤掉图像模型与 `/models` 里的杂项 id。
 *
 * 本文件只导出**一个函数**（magpie 会把每个导出函数都当成一个插件，
 * OpenCode 则要求入口不能导出非函数值），辅助模块都在 lib/ 下。
 *
 * @module magpie-sensenova
 */

import { startLoginCapture } from "./lib/browser.mjs";
import { seal, unseal } from "./lib/dpapi.mjs";
import { createPkce } from "./lib/pkce.mjs";
import {
  BASE_URL,
  buildAuthorizeUrl,
  exchangeCode,
  fetchPoolUsage,
  normalizeApiKey,
  probeApiKey,
  refreshTokens,
  usernameFromTokens,
} from "./lib/protocol.mjs";
import { FALLBACK_MODELS, NPM, chatModels, createCatalog, fellBack, toConfigModel, toProviderModel } from "./lib/models.mjs";
import { toUsage } from "./lib/quota.mjs";

const PROVIDER = "sensenova";

/** 额度读取的缓存时长：60 秒内重复读不重新打接口（magpie 会频繁刷新额度）。 */
const DEFAULT_QUOTA_TTL_MS = 60_000;
/** 到期前 15 分钟续期（与 exe 的 renew_ahead_min=15 一致）。 */
const DEFAULT_REFRESH_LEAD_MS = 15 * 60 * 1000;
/** 用户在浏览器里完成登录的总预算（magpie 的登录窗口是 10 分钟）。 */
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60 * 1000;
/** access_token 缺 expires_in 时的保守生存期（exe 文档：约 3 小时）。 */
const FALLBACK_TOKEN_LIFETIME_MS = 3 * 3600 * 1000;
/** 每个账号同时最多发几条请求。public beta 的 TPM/RPM 很紧，1 是安全默认值。 */
const DEFAULT_MAX_CONCURRENCY = 1;

const lifetimeOf = (expiresIn) =>
  Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0 ? Number(expiresIn) * 1000 : FALLBACK_TOKEN_LIFETIME_MS;

/**
 * 构建插件。
 *
 * @param {{client?: object}} input magpie 传给插件的输入（client.app.log 等）
 * @param {object} [options] plugins.json 里的 options
 *   - baseURL：覆盖 Token Plan 根地址
 *   - browser：指定浏览器可执行文件路径（同 MAGPIE_SENSENOVA_BROWSER）
 *   - quotaTtlMs / loginTimeoutMs：覆盖缓存时长 / 登录预算
 */
export async function SenseNovaPlugin({ client } = {}, options = {}) {
  const baseURL =
    typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL.trim().replace(/\/+$/, "")
      : BASE_URL;
  const browserPath = typeof options.browser === "string" && options.browser.trim() ? options.browser.trim() : undefined;
  const quotaTtlMs =
    Number.isFinite(Number(options.quotaTtlMs)) && Number(options.quotaTtlMs) > 0
      ? Number(options.quotaTtlMs)
      : DEFAULT_QUOTA_TTL_MS;
  const loginTimeoutMs =
    Number.isFinite(Number(options.loginTimeoutMs)) && Number(options.loginTimeoutMs) > 0
      ? Number(options.loginTimeoutMs)
      : DEFAULT_LOGIN_TIMEOUT_MS;

  const catalog = createCatalog({ baseURL });
  const quotaCache = new Map(); // 密封的 access_token → { at, value }（续期后 key 变化，自动失效）

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: PROVIDER, level, message } });
    } catch {
      /* 日志是尽力而为 */
    }
  };

  /**
   * 账号记录里的 API Key：
   *   - oauth 记录：密封在 `apiKey`；
   *   - api 记录：密封在 `key`（新登录），或历史明文 key。
   * 两种都兼容，避免老账号重新登录。
   */
  const apiKeyOf = async (auth) => {
    if (!auth) return "";
    const raw = auth.type === "api" ? (auth.key ?? "") : (auth.apiKey ?? "");
    if (!raw) return "";
    if (String(raw).startsWith("dpapi:")) return unseal(raw);
    return normalizeApiKey(raw);
  };

  /** 登录前/拉取失败时声明的模型（拿过活清单后就用活清单里的聊天模型播种）。 */
  const seedModels = () => catalog.peek() ?? FALLBACK_MODELS;
  const declareModels = () => Object.fromEntries(chatModels(seedModels()).map((m) => [m.id, toConfigModel(m)]));

  return {
    /** 声明供应商与模型（登录之前也要让供应商可选中）。 */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: "SenseNova",
        npm: NPM,
        api: baseURL,
        ...was,
        models: { ...declareModels(), ...(was.models ?? {}) },
      };
    },

    provider: {
      id: PROVIDER,

      /**
       * 这个账号现在能用的聊天模型：活清单过滤后为准，失败就交回声明清单（打 fellBack 标记）。
       */
      async models(provider, { auth } = {}) {
        const declared = provider?.models ?? declareModels();
        let apiKey = "";
        try {
          apiKey = await apiKeyOf(auth);
        } catch (e) {
          log("warn", `sensenova: ${e?.message ?? e}`);
          return fellBack(declared);
        }
        if (!apiKey) return fellBack(declared);
        try {
          const live = chatModels(await catalog.load(apiKey));
          if (!live.length) return fellBack(declared);
          return Object.fromEntries(live.map((m) => [m.id, toProviderModel(m, PROVIDER, { baseURL })]));
        } catch (e) {
          log("warn", `sensenova: 保留声明的模型清单（${e?.message ?? e}）`);
          return fellBack(declared);
        }
      },
    },

    auth: {
      provider: PROVIDER,
      /** 每个账号的并发上限；用户/provider 级别的设置会覆盖它。 */
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,

      /** 到期前 15 分钟续期（令牌轮换，magpie 负责调度与并发去重）。 */
      refreshLead: DEFAULT_REFRESH_LEAD_MS,

      methods: [
        {
          type: "oauth",
          label: "浏览器登录 SenseNova（额度 + 模型）",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "Token Plan API Key（控制台 → API-Key 管理）",
              placeholder: "sk-…",
              validate: (value) =>
                normalizeApiKey(value) ? null : "API Key 不能为空：没有它这个账号无法发起模型请求",
            },
          ],

          /**
           * 打开受控登录窗口并等回调。
           *
           * 契约（magpie）：authorize 只有 1 分钟预算——所以这里只负责把窗口开起来，
           * 真正的等待放在 callback（它拿到 10 分钟预算）。
           * url 返回空串：窗口由插件自己打开，magpie 不要再开一个默认浏览器，
           * 否则登录会在**不受控**的浏览器里完成，code 会被官方 SPA 消费掉。
           */
          async authorize(inputs) {
            const apiKey = normalizeApiKey(inputs?.apiKey);
            if (!apiKey) {
              throw new Error("需要 Token Plan API Key（控制台 → API-Key 管理 里生成），否则登录后模型请求无法使用。");
            }

            // 预检：只有明确的 401/403 才拦下登录；网络故障不拦（后面请求时自会体现）
            try {
              await probeApiKey(apiKey, baseURL);
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) throw e;
              log("warn", `sensenova: API Key 预检没做完（${e?.message ?? e}），继续登录`);
            }

            const pkce = createPkce();
            const session = await startLoginCapture({
              authorizeUrl: buildAuthorizeUrl(pkce),
              expectedState: pkce.state,
              timeoutMs: loginTimeoutMs,
              browserPath,
              log: (message) => log("info", `sensenova: ${message}`),
            });

            return {
              url: "",
              instructions:
                "已打开一个独立的登录窗口（一次性环境，不碰你日常浏览器的登录态，也不留任何登录数据）。" +
                "请在其中完成 SenseNova 登录——密码、短信验证码都可以；登录成功后窗口会自己关闭。",
              method: "auto",

              async callback() {
                try {
                  const { code } = await session.result;
                  const tokens = await exchangeCode({ code, verifier: pkce.verifier });
                  if (!tokens?.refresh_token) {
                    throw new Error("token 响应里没有 refresh_token（scope 需要 offline），无法静默续期");
                  }
                  const username = usernameFromTokens(tokens);
                  return {
                    type: "success",
                    accountId: username || "SenseNova",
                    username,
                    // 三件凭据一律先 DPAPI 密封再交给 magpie 落盘
                    refresh: await seal(tokens.refresh_token),
                    access: await seal(tokens.access_token ?? ""),
                    expires: Date.now() + lifetimeOf(tokens.expires_in),
                    apiKey: await seal(apiKey),
                  };
                } catch (e) {
                  return { type: "failed", error: e?.message ?? String(e) };
                } finally {
                  await session.close();
                }
              },
            };
          },
        },
        {
          type: "api",
          label: "仅 API Key（模型可用，不读额度）",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "Token Plan API Key（控制台 → API Keys）",
              placeholder: "sk-…",
              validate: (value) => (normalizeApiKey(value) ? null : "API Key 不能为空"),
            },
            {
              type: "text",
              key: "email",
              message: "账号备注（手机号 / 邮箱，可选；用于区分多账号）",
              placeholder: "可留空",
            },
          ],
          /**
           * 只验证并密封 Key，不打开浏览器。
           * 这条路径读不到额度（没有控制台令牌），但模型调用完整可用。
           */
          async authorize(inputs) {
            const apiKey = normalizeApiKey(inputs?.apiKey);
            if (!apiKey) return { type: "failed", error: "API Key 不能为空" };
            try {
              await probeApiKey(apiKey, baseURL);
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) {
                return { type: "failed", error: e?.message ?? String(e) };
              }
              log("warn", `sensenova: API Key 预检没做完（${e?.message ?? e}），继续保存`);
            }
            return { type: "success", key: await seal(apiKey) };
          },
        },
      ],

      /**
       * 账号 → 请求路由。宿主会拿 loader 的 apiKey 自动给 openai-compatible
       * 请求加上 `Authorization: Bearer …`。oauth / api 两种记录都在这里归一。
       */
      async loader(getAuth) {
        const auth = await getAuth();
        const apiKey = await apiKeyOf(auth);
        return { baseURL, apiKey };
      },

      /**
       * 额度：读控制台积分池，映射成 magpie 的窗口。
       */
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth) return { error: "未登录" };
        if (auth.type === "api") {
          return {
            error: "此账号只登录了 API Key：模型可用，额度不可见。要用额度，请用浏览器登录添加账号。",
            signIn: "kept",
          };
        }

        let access = "";
        try {
          access = await unseal(auth?.access ?? "");
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "expired" };
        }
        if (!access) return { error: "凭据缺失，请重新登录", signIn: "expired" };

        const cacheKey = auth.access;
        const hit = quotaCache.get(cacheKey);
        if (hit && Date.now() - hit.at < quotaTtlMs) return hit.value;

        try {
          const raw = await fetchPoolUsage(access);
          const value = toUsage(raw, { username: auth.username || auth.accountId || "" });
          if (quotaCache.size > 8) quotaCache.clear();
          quotaCache.set(cacheKey, { at: Date.now(), value });
          return value;
        } catch (e) {
          if (e?.status === 401 || e?.status === 403) {
            return { error: "控制台会话已失效，请重新登录", signIn: "expired" };
          }
          return { error: `读取额度失败：${e?.message ?? e}` };
        }
      },

      /**
       * 静默续期（magpie 在到期前调用）；refresh_token 被吊销时打 signIn=expired 标记。
       */
      async refresh(auth) {
        let refreshToken = "";
        try {
          refreshToken = await unseal(auth?.refresh ?? "");
        } catch (e) {
          throw Object.assign(new Error(e?.message ?? String(e)), { signIn: "expired" });
        }
        if (!refreshToken) {
          throw Object.assign(new Error("没有 refresh_token，需要重新登录"), { signIn: "expired" });
        }

        try {
          const tokens = await refreshTokens(refreshToken);
          return {
            access: await seal(tokens.access_token ?? ""),
            // Hydra 轮换 refresh_token：响应里的是新的，必须覆盖
            refresh: await seal(tokens.refresh_token || refreshToken),
            expires: Date.now() + lifetimeOf(tokens.expires_in),
          };
        } catch (e) {
          const error = new Error(`续期失败：${e?.message ?? e}`);
          if (e?.invalidGrant || e?.status === 401) error.signIn = "expired";
          throw error;
        }
      },
    },
  };
}
