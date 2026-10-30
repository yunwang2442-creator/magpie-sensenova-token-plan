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

import { hostname } from "node:os";

import { startLoginCapture } from "./lib/browser.mjs";
import { seal, unseal } from "./lib/dpapi.mjs";
import { createPkce } from "./lib/pkce.mjs";
import {
  BASE_URL,
  buildAuthorizeUrl,
  createApiKey,
  createdApiKey,
  deleteApiKey,
  exchangeCode,
  fetchPoolUsage,
  identityFromTokens,
  keyFingerprint,
  listApiKeys,
  normalizeApiKey,
  probeApiKey,
  refreshTokens,
} from "./lib/protocol.mjs";
import { FALLBACK_MODELS, NPM, catalogModels, createCatalog, fellBack, toConfigModel, toProviderModel } from "./lib/models.mjs";
import { toUsage } from "./lib/quota.mjs";

const PROVIDER = "sensenova";

/** 三种 wire 协议；只有 chat 支持视频。 */
const PROTOCOLS = {
  chat: { npm: NPM, video: true },
  anthropic: { npm: "@ai-sdk/anthropic", video: false },
  responses: { npm: "@ai-sdk/openai", video: false },
};

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

/** Token Plan 每个账号最多 20 个 API Key（官网 Free 档）。 */
const KEY_LIMIT = 20;

/** 本机短标识：让多台机器上的 magpie- Key 能分开清理。 */
const HOST_TAG = keyFingerprint(hostname()).slice(0, 4);

/** 自动创建的 Key 名：magpie-<机器>-<账号>-<时间>-<随机>，满足控制台的命名规则。 */
const keyNameFor = (username) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const who = String(username || "account")
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 24);
  const rand = Math.random().toString(16).slice(2, 6);
  return `magpie-${HOST_TAG}-${who}-${stamp}-${rand}`.slice(0, 64);
};

/**
 * 构建插件。
 *
 * @param {{client?: object}} input magpie 传给插件的输入（client.app.log 等）
 * @param {object} [options] plugins.json 里的 options
 *   - baseURL：覆盖 Token Plan 根地址
 *   - browser：指定浏览器可执行文件路径（同 MAGPIE_SENSENOVA_BROWSER）
 *   - quotaTtlMs / loginTimeoutMs：覆盖缓存时长 / 登录预算
 */
export async function SenseNovaPlugin({ client, magpie } = {}, options = {}) {
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
  const protocol = Object.hasOwn(PROTOCOLS, options.protocol) ? options.protocol : "chat";
  const wire = { ...PROTOCOLS[protocol], protocol };

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

  /** magpie 的 provider 级布尔开关；OpenCode 没有 magpie 时回退到 options。 */
  const optionOn = (key) => {
    try {
      if (magpie?.option?.(PROVIDER, key) === true) return true;
    } catch {
      /* 旧宿主没有这个 API */
    }
    return options?.[key] === true;
  };
  const pruneOldKeys = optionOn("prune_old_keys");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 新创建的 Key 在网关上生效有 3–10 秒延迟；401/403 时多等几次，
   * 不要一次 401 就判定创建失败。网络错误不重试（交给外层 best-effort）。
   */
  const probeWithRetry = async (apiKey) => {
    const delays = [0, 1500, 3000, 4500, 6000];
    let last = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      try {
        return await probeApiKey(apiKey, baseURL);
      } catch (e) {
        last = e;
        if (e?.status !== 401 && e?.status !== 403) throw e;
        log("info", `sensenova: 新 Key 还在生效中（第 ${i + 1} 次，HTTP ${e.status}）`);
      }
    }
    throw last;
  };

  /** 登录前/拉取失败时声明的模型（拿过活清单后就用活清单里的聊天模型播种）。 */
  const seedModels = () => catalog.peek() ?? FALLBACK_MODELS;
  /**
   * 自动清理同机器、同账号的旧 magpie- Key。
   * 默认关闭；auth.options 的 prune_old_keys 打开才跑。
   * keyName 为空代表创建前预清理（保留最新 1 个，为新 Key 腾位）；
   * keyName 给出代表创建后清理（保留最新 2 个，含刚创建的）。
   * 绝不动手动 Key。
   */
  const pruneKeys = async (access, keyName = "") => {
    try {
      const listed = await listApiKeys(access, { pageSize: 20 });
      const at = (value) => {
        const n = Date.parse(String(value ?? ""));
        return Number.isFinite(n) ? n : 0;
      };
      const keys = (listed.api_keys ?? []).slice().sort((a, b) => at(b.create_time) - at(a.create_time));
      const prefix = `magpie-${HOST_TAG}-`;
      const ours = keys.filter((k) => String(k.displayname ?? "").startsWith(prefix));
      if (!ours.length) return;
      const keepLimit = keyName ? 2 : 1;
      const keep = new Set(ours.slice(0, keepLimit).map((k) => k.id));
      if (keyName) {
        const fresh = ours.find((k) => k.displayname === keyName);
        if (fresh?.id) keep.add(fresh.id);
      }
      for (const k of ours) {
        if (keep.has(k.id)) continue;
        await deleteApiKey(access, k.id).catch((e) => log("warn", `sensenova: 清理旧 Key 失败（${e?.message ?? e}）`));
      }
    } catch (e) {
      log("warn", `sensenova: 自动清理旧 Key 跳过（${e?.message ?? e}）`);
    }
  };

  const declareModels = () => Object.fromEntries(catalogModels(seedModels()).map((m) => [m.id, toConfigModel(m, wire)]));

  return {
    /** 声明供应商与模型（登录之前也要让供应商可选中）。 */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: "SenseNova",
        npm: wire.npm,
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
          const live = catalogModels(await catalog.load(apiKey));
          if (!live.length) return fellBack(declared);
          return Object.fromEntries(live.map((m) => [m.id, toProviderModel(m, PROVIDER, { baseURL, ...wire })]));
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

      /** provider 设置页里的布尔开关（magpie 0.1.1876+；OpenCode 忽略）。 */
      options: [
        {
          key: "prune_old_keys",
          label: "自动清理旧 magpie API Key",
          description:
            "浏览器登录成功后，只保留最新 2 个同机器的 magpie- Key；手动创建的 Key 不会删。默认关闭。",
          confirm: "会在登录成功后删除同机器旧的 magpie- Key，保留最新 2 个。",
        },
      ],

      /** 到期前 15 分钟续期（令牌轮换，magpie 负责调度与并发去重）。 */
      refreshLead: DEFAULT_REFRESH_LEAD_MS,

      methods: [
        {
          type: "oauth",
          label: "浏览器登录 SenseNova（自动创建 API Key）",
          /**
           * 官方插件的浏览器登录：authorize 返回要打开的页面，magpie 负责打开。
           *
           * 商汤的 redirect_uri 固定是 https://platform.sensenova.cn（控制台 SPA），
           * 不能改成 localhost（实测 IAM 直接 404 invalid_request）。所以这里由插件
           * 用受控浏览器截停回跳，并返回 opened: true 告诉 magpie "页面已经开了，
           * 不要再开第二个"；url 返回空串，避免 GUI 的 "Open again" 链接把 code
           * 交给控制台 SPA。
           */
          async authorize() {
            const pkce = createPkce();
            const authorizeUrl = buildAuthorizeUrl(pkce);
            const session = await startLoginCapture({
              authorizeUrl,
              expectedState: pkce.state,
              timeoutMs: loginTimeoutMs,
              browserPath,
              log: (message) => log("info", `sensenova: ${message}`),
            });

            return {
              url: "",
              opened: true,
              instructions:
                "已打开一个独立的登录窗口（一次性环境，不碰你日常浏览器的登录态，也不留任何登录数据）。" +
                "请在其中完成 SenseNova 登录——密码、短信验证码都可以；登录成功后会自动创建 API Key 并关闭窗口。",
              method: "auto",

              async callback() {
                try {
                  const { code } = await session.result;
                  const tokens = await exchangeCode({ code, verifier: pkce.verifier });
                  if (!tokens?.refresh_token) {
                    throw new Error("token 响应里没有 refresh_token（scope 需要 offline），无法静默续期");
                  }
                  const access = tokens.access_token ?? "";
                  if (!access) throw new Error("token 响应里没有 access_token");
                  const { username, uid } = identityFromTokens(tokens);

                  // 先看 Key 数量；如果开启了自动清理且已满，先预清理腾出空间
                  try {
                    let listed = await listApiKeys(access);
                    let total = Number(listed?.total_count ?? listed?.total_size ?? 0);
                    if (total >= KEY_LIMIT && pruneOldKeys) {
                      log("info", `sensenova: 账号已有 ${total}/${KEY_LIMIT} 个 Key，执行创建前预清理`);
                      await pruneKeys(access);
                      listed = await listApiKeys(access);
                      total = Number(listed?.total_count ?? listed?.total_size ?? 0);
                    }
                    if (total >= KEY_LIMIT) {
                      const err = new Error(
                        `该账号已有 ${total} 个 API Key（上限 ${KEY_LIMIT}）。请先到控制台删除一个，或改用“仅 API Key”登录。`,
                      );
                      err.code = "key_limit";
                      throw err;
                    }
                    if (total >= KEY_LIMIT - 2) {
                      log("warn", `sensenova: 该账号已有 ${total}/${KEY_LIMIT} 个 API Key，快满了`);
                    }
                  } catch (e) {
                    if (e?.code === "key_limit") throw e;
                    log("warn", `sensenova: 读取 API Key 数量失败（${e?.message ?? e}），继续创建`);
                  }

                  const keyName = keyNameFor(username);
                  const created = await createApiKey(access, keyName);
                  const apiKey = createdApiKey(created);

                  const cleanup = async () => {
                    try {
                      if (created?.id) {
                        await deleteApiKey(access, created.id);
                        return;
                      }
                      const listed = await listApiKeys(access, { pageSize: 20 });
                      const match = (listed?.api_keys ?? []).find((k) => k.displayname === keyName);
                      if (match?.id) await deleteApiKey(access, match.id);
                    } catch (e) {
                      log("warn", `sensenova: 清理未成功的 Key 失败（${e?.message ?? e}）`);
                    }
                  };

                  if (!apiKey) {
                    await cleanup();
                    throw new Error("控制台创建 API Key 成功，但响应里没有完整 Key；请改用“仅 API Key”登录");
                  }

                  // 新 Key 在网关上生效有 3–10 秒延迟；probeWithRetry 会等它。
                  try {
                    await probeWithRetry(apiKey);
                  } catch (e) {
                    if (e?.status === 401 || e?.status === 403) {
                      await cleanup();
                      throw new Error(`自动创建的 API Key 未通过校验（HTTP ${e.status}）；请改用“仅 API Key”登录`);
                    }
                    log("warn", `sensenova: 新 Key 校验没做完（${e?.message ?? e}）`);
                  }

                  if (pruneOldKeys) await pruneKeys(access, keyName);

                  return {
                    type: "success",
                    // 稳定身份：username 优先，其次 JWT sub；两者都没有才用 refresh 指纹。
                    // 不要写死 "SenseNova"：5 个账号会被 settle() 当成同一个而互相覆盖。
                    accountId: username || uid || `sensenova-${keyFingerprint(tokens.refresh_token)}`,
                    uid,
                    username,
                    // 三件凭据一律先 DPAPI 密封再交给 magpie 落盘
                    refresh: await seal(tokens.refresh_token),
                    access: await seal(access),
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
          // authorize 自己收并返回 Key；不声明 keyless 的话 GUI 会再弹一个标准 Key 输入框。
          keyless: true,
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
            const note = typeof inputs?.email === "string" ? inputs.email.trim() : "";
            // 关键安全修复：清理 inputs 并覆盖 metadata，防止宿主 save() 将 inputs 浅拷贝
            // 进落盘的 metadata 导致明文 API Key 泄漏到 plugin-auth.json
            if (inputs && typeof inputs === "object") {
              delete inputs.apiKey;
            }
            return {
              type: "success",
              key: await seal(apiKey),
              // api 方法的 accountId 会被 host 丢弃；账号行只读 metadata.email。
              // 没填备注时用 Key 指纹，保证同一个 Key 重登不会变成新账号。
              // 显式指定 apiKey: undefined，即使宿主做了 inputs 浅拷贝，JSON 序列化也会抹除该键。
              metadata: {
                email: note || `key:${keyFingerprint(apiKey)}`,
                apiKey: undefined,
              },
            };
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
          // 只有明确的 401 才是登录失效；403 可能是 WAF/地区/权限，
          // 标成 expired 会让账号被路由直接跳过，范围太宽。
          if (e?.status === 401) {
            return { error: "控制台会话已失效，请重新登录", signIn: "expired" };
          }
          const detail = String(e?.message ?? e).slice(0, 300);
          return { error: `读取额度失败：${detail}`, signIn: "kept" };
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
          if (!tokens?.access_token) throw new Error("续期响应里没有 access_token");
          return {
            access: await seal(tokens.access_token),
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
