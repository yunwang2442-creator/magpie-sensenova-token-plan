/**
 * 离线自测：不起浏览器、不碰网络、不碰真实账号。
 *   bun test/unit.test.mjs      （DPAPI 那一组需要 bun）
 *   node test/unit.test.mjs     （其余组也能跑，DPAPI 组自动跳过）
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createPkce } from "../lib/pkce.mjs";
import {
  AUTHORIZE_URL,
  buildAuthorizeUrl,
  exchangeForm,
  jwtPayload,
  normalizeApiKey,
  refreshForm,
  usernameFromTokens,
} from "../lib/protocol.mjs";
import { compact, flexNum, toUsage } from "../lib/quota.mjs";
import { chatModels, extractModels, fellBack, normalizeModel, toConfigModel, toProviderModel } from "../lib/models.mjs";
import { isSealed, seal, unseal } from "../lib/dpapi.mjs";
import { SenseNovaPlugin } from "../index.mjs";

/* ------------------------------------------------------------ 迷你测试跑器 */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function main() {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      fail++;
      console.error(`  ❌ ${name}\n     ${e?.message ?? e}`);
    }
  }
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------------------------- PKCE */

test("PKCE：verifier 48 字节 → 64 字符，challenge 是它的 S256", () => {
  const p = createPkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  assert.match(p.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.state, /^[A-Za-z0-9_-]{22}$/); // base64url(16 字节)
});

test("PKCE：每次生成都不同", () => {
  const a = createPkce();
  const b = createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

/* -------------------------------------------------------------- 授权 URL */

test("授权 URL：参数与 exe 完全一致（client_id=nova / prompt=login / S256）", () => {
  const url = new URL(buildAuthorizeUrl({ challenge: "CHAL", state: "ST8" }));
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), "nova");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge"), "CHAL");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://platform.sensenova.cn");
  assert.equal(url.searchParams.get("scope"), "openid offline offline_access");
  assert.equal(url.searchParams.get("state"), "ST8");
  assert.equal(url.searchParams.get("prompt"), "login");
});

test("换码 / 续期表单字段（照抄 exe）", () => {
  assert.deepEqual(Object.fromEntries(exchangeForm("C1", "V1")), {
    grant_type: "authorization_code",
    client_id: "nova",
    code: "C1",
    redirect_uri: "https://platform.sensenova.cn",
    code_verifier: "V1",
  });
  assert.deepEqual(Object.fromEntries(refreshForm("RT1")), {
    grant_type: "refresh_token",
    client_id: "nova",
    refresh_token: "RT1",
  });
});

/* ---------------------------------------------------- JWT / API Key 规整 */

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const fakeJwt = (payload) => `eyJhbGciOiJub25lIn0.${b64(payload)}.sig`;

test("账号名：access 的 ext.username 优先，其次 id_token", () => {
  const access = fakeJwt({ ext: { username: "test-user" } });
  const id = fakeJwt({ id_token: { username: "fallback" } });
  assert.equal(usernameFromTokens({ access_token: access, id_token: id }), "test-user");
  assert.equal(usernameFromTokens({ id_token: fakeJwt({ id_token: { username: "nested" } }) }), "nested");
  assert.equal(usernameFromTokens({ access_token: fakeJwt({ preferred_username: "pn" }) }), "pn");
  assert.equal(usernameFromTokens({ access_token: "not-a-jwt" }), "");
  assert.equal(usernameFromTokens({}), "");
  assert.equal(jwtPayload("a.b"), null);
});

test("API Key 规整：去空白 / Bearer 前缀 / 引号", () => {
  assert.equal(normalizeApiKey("  sk-abc  "), "sk-abc");
  assert.equal(normalizeApiKey("Bearer sk-abc"), "sk-abc");
  assert.equal(normalizeApiKey('"sk-abc"'), "sk-abc");
  assert.equal(normalizeApiKey(""), "");
  assert.equal(normalizeApiKey(undefined), "");
});

/* ------------------------------------------------------------- 额度映射 */

// 形状取自 exe 对真实会话的抓取（quota/convert.go 注释）：数字是字符串，时间是 unix 秒。
const POOL_USAGE_FIXTURE = {
  code: 0,
  data: {
    pools: [
      {
        name: "通用积分池",
        pool_type: "default",
        window_5h: { limit: "120000", used: "0", remaining: "120000", reset_at: "1788595830" },
        window_7d: { limit: "1200000", used: "8699.744", remaining: "1191300.256", reset_at: "1788948630" },
        grant_balance: "24506.9624",
        nearest_grant_expiry: "1791122400",
        nearest_grant_expiring_balance: "748.834",
      },
      {
        name: "Flash-Lite积分池",
        pool_type: "dedicated",
        window_5h: { limit: "60000", used: "0", remaining: "60000", reset_at: "1788595830" },
        window_7d: { limit: "600000", used: "1000", remaining: "599000", reset_at: "1788948630" },
        grant_balance: "0",
      },
    ],
  },
};

test("额度映射：两个池 × 两个窗口，专属池限定 flash-lite", () => {
  const usage = toUsage(POOL_USAGE_FIXTURE, { username: "test-user" });
  assert.equal(usage.user, "test-user");
  assert.equal(usage.balance, "24,506.96 积分");
  assert.equal(usage.windows.length, 4);

  const [g5, g7, f5, f7] = usage.windows;
  assert.equal(g5.name, "通用积分池 · 5 小时窗口");
  assert.equal(g5.span, 18000);
  assert.equal(g5.resetsAt, 1788595830); // 秒——magpie 会 ×1000
  assert.equal(g5.display, "已用 0 / 120,000");
  assert.equal(g5.model, undefined);
  assert.equal(g5.unit, "积分");

  // 8699.744 / 1,200,000 = 0.72497866…%
  assert.ok(Math.abs(g7.used - 0.7249786666666667) < 1e-9, `used=${g7.used}`);
  assert.equal(g7.span, 604800);
  assert.equal(g7.limit, 1200000);

  assert.equal(f5.model, "flash-lite");
  assert.equal(f7.model, "flash-lite");
  assert.equal(f5.limit, 60000);
  assert.equal(f5.amount, 0);
});

test("额度映射：顶层 pools、model_ids 与缺字段的宽容", () => {
  const usage = toUsage({
    pools: [
      {
        name: "专属",
        pool_type: "dedicated",
        model_ids: ["sensenova-6.7-flash-lite", "sensenova-6.8-flash-lite"],
        window_5h: { limit: 10, remaining: 5, reset_at: 1000000000 }, // 数字也要吃
      },
    ],
  });
  assert.equal(usage.windows.length, 1);
  assert.deepEqual(usage.windows[0].models, ["sensenova-6.7-flash-lite", "sensenova-6.8-flash-lite"]);
  assert.equal(usage.windows[0].model, undefined);
  assert.equal(usage.windows[0].amount, 5);
  assert.equal(usage.windows[0].used, 50);
});

test("额度映射：异常响应直接报错（账号卡片显示原因，而不是空）", () => {
  assert.throws(() => toUsage({}), /额度响应/);
  assert.throws(() => toUsage({ error: { message: "token 无效" } }), /token 无效/);
  assert.throws(() => toUsage({ pools: [{ name: "x", pool_type: "default" }] }), /没有可识别的窗口/);
});

test("数值格式：千分位与两位小数", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(60000), "60,000");
  assert.equal(compact(600000), "600,000");
  assert.equal(compact(120000), "120,000");
  assert.equal(compact(1200000), "1,200,000");
  assert.equal(compact(591300.256), "591,300.26");
  assert.equal(compact(24506.9624), "24,506.96");
  assert.equal(compact(1000), "1,000");
  assert.equal(flexNum("591300.256"), 591300.256);
  assert.equal(flexNum("-3"), 0);
  assert.equal(flexNum(null), 0);
});

/* ------------------------------------------------------------- 模型清单 */

test("模型清单：三种信封都能解析", () => {
  assert.equal(extractModels({ data: [{ id: "a" }] })[0].id, "a");
  assert.equal(extractModels({ models: [{ model_id: "b" }] })[0].id, "b");
  assert.equal(extractModels([{ model: "c" }])[0].id, "c");
  assert.deepEqual(extractModels({}), []);
  assert.equal(normalizeModel({}), null);
  assert.equal(normalizeModel({ id: "d", name: "  D  " }).name, "D");
});

test("模型清单：magpie 对象形状", () => {
  const m = normalizeModel({ id: "sensenova-6.8-flash-lite" });
  const cfg = toConfigModel(m);
  assert.equal(cfg.limit.context, 262144);
  assert.equal(cfg.limit.output, 65536);
  assert.equal(cfg.tool_call, true);
  assert.equal(cfg.attachment, true); // flash-lite 支持图片输入
  const full = toProviderModel(m, "sensenova");
  assert.equal(full.id, "sensenova-6.8-flash-lite");
  assert.equal(full.providerID, "sensenova");
  assert.equal(full.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(full.limit.context, 262144);
  assert.equal(full.limit.output, 65536);
  assert.equal(full.capabilities.input.image, true);

  const marked = fellBack({ a: cfg });
  assert.equal(marked[Symbol.for("magpie.fellBack")], true);
});

test("模型目录：官网骨架 + /models 覆盖 + 过滤图像/杂项", () => {
  const live = extractModels({
    data: [
      {
        id: "deepseek-flash",
        input_modalities: ["text"],
        max_output_length: 65536,
        supported_features: ["tools", "reasoning"],
        created: 1777392000,
      },
      { id: "kimi-k3", input_modalities: ["text"] },
      { id: "glm-5.2", max_output_length: 131072 },
      { id: "sensenova-u1.5-lite", output_modalities: ["image"] },
      { id: "deepseek-v4.1-flash" },
    ],
  });

  const flash = live.find((m) => m.id === "deepseek-flash");
  assert.equal(flash.name, "DeepSeek V4.1 Flash");
  assert.equal(flash.maxCompletionTokens, 65536);
  assert.deepEqual([...flash.inputModalities].sort(), ["image", "text", "video"]);
  assert.equal(flash.supportsTools, true);
  assert.equal(flash.reasoning, true);
  assert.equal(flash.released, "2026-04-28");

  const kimi = live.find((m) => m.id === "kimi-k3");
  assert.ok(kimi.inputModalities.includes("image"), "官网说 Kimi K3 有视觉能力");

  const glm = live.find((m) => m.id === "glm-5.2");
  assert.equal(glm.maxCompletionTokens, 131072);

  assert.deepEqual(
    chatModels(live).map((m) => m.id).sort(),
    ["deepseek-flash", "glm-5.2", "kimi-k3"],
    "图像模型和 deepseek-v4.1-flash 不应进入 Chat 目录",
  );

  const full = toProviderModel(flash, "sensenova");
  assert.equal(full.capabilities.input.video, true);
  assert.deepEqual(Object.keys(full.variants).sort(), ["high", "low", "max", "none"]);

  const noVideo = toProviderModel(flash, "sensenova", { video: false });
  assert.equal(noVideo.capabilities.input.video, false, "非 Chat 协议不应声明视频");
  assert.equal(
    toProviderModel(flash, "sensenova", { npm: "@ai-sdk/anthropic" }).api.npm,
    "@ai-sdk/anthropic",
  );
});

/* -------------------------------------------------- DPAPI（需要 bun） */

let bunFfi = true;
try {
  await import("bun:ffi");
} catch {
  bunFfi = false;
}

test("DPAPI：密封/解开往返 + 明文透传", async () => {
  if (process.platform !== "win32" || !bunFfi) {
    console.log("     ⏭ 跳过（需要 Windows + bun）");
    return;
  }
  const secret = `refresh-token-probe-${Date.now()}-中文`;
  const sealed = await seal(secret);
  assert.ok(isSealed(sealed), "应当带 dpapi: 前缀");
  assert.ok(!sealed.includes(secret), "密文里不应出现明文");
  assert.equal(await unseal(sealed), secret);
  assert.equal(await unseal("legacy-plain-value"), "legacy-plain-value");
  assert.equal(await seal(""), "");
  assert.equal(await unseal(""), "");
});

test("DPAPI：各种长度（含真实令牌量级）在 GC 压力下往返正确", async () => {
  if (process.platform !== "win32" || !bunFfi) {
    console.log("     ⏭ 跳过（需要 Windows + bun）");
    return;
  }
  // 回归背景：readBlob 曾经在 LocalFree 之后才去读 toArrayBuffer 的**视图**
  //（use-after-free）——小密文侥幸没被覆盖，大密文的头部会被堆元数据改写。
  // 所以长度必须覆盖到真实 refresh_token（~1KB）及更大。
  for (const size of [8, 64, 200, 1200, 2600]) {
    for (let i = 0; i < 6; i++) {
      const junk = new Array(300).fill(0).map((_, k) => `junk-${size}-${i}-${k}`.repeat(6));
      const secret = `秘密-${size}-${i}-` + "x".repeat(Math.max(0, size - 16)) + "🔑";
      const sealed = await seal(secret);
      assert.ok(isSealed(sealed), "应当带 dpapi: 前缀");
      assert.ok(Buffer.from(sealed.slice(6), "base64").length > size, "密文应当比明文大");
      globalThis.Bun?.gc?.(true); // 强制回收，顺带覆盖输入缓冲区被钉住的路径
      assert.equal(await unseal(sealed), secret, `长度 ${size} 第 ${i} 轮往返不一致`);
      void junk;
    }
  }
});

/* ------------------------------------------------------- 插件形状与钩子 */

test("入口：magpie 的解析链（exports[./server] → main → exports[.]）能找到唯一入口，且只导出一个函数", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const entry = pkg.exports?.["./server"] ?? pkg.main ?? pkg.exports?.["."];
  assert.ok(entry, "package.json 必须给出入口");
  const mod = await import(pathToFileURL(join(root, entry)).href);

  // host.js 的 servers()：default.server 优先，否则"导出的每个函数都是一个插件"
  const fns =
    typeof mod.default?.server === "function"
      ? [mod.default.server]
      : Object.values(mod).filter((v) => typeof v === "function");
  assert.equal(fns.length, 1, `入口必须恰好导出一个函数，实际 ${fns.length} 个（OpenCode 也要求如此）`);
  assert.equal(typeof pkg.magpie?.icon, "string", "package.json 里给出账号/插件卡片图标");
  assert.equal(pkg.magpie?.maxConcurrency, 1, "package.json 里给出安全默认并发");
});

test("插件：钩子齐全、config 声明供应商、无 Key 时 fellBack", async () => {
  const plugin = await SenseNovaPlugin({ client: { app: { log: () => {} } } }, {});
  assert.equal(typeof plugin.config, "function");
  assert.equal(plugin.provider.id, "sensenova");
  assert.equal(typeof plugin.provider.models, "function");
  assert.equal(plugin.auth.provider, "sensenova");
  assert.equal(typeof plugin.auth.loader, "function");
  assert.equal(typeof plugin.auth.usage, "function");
  assert.equal(typeof plugin.auth.refresh, "function");
  assert.equal(plugin.auth.refreshLead, 15 * 60 * 1000);
  assert.equal(plugin.auth.maxConcurrency, 1);
  assert.equal(plugin.auth.methods.length, 2);
  assert.equal(plugin.auth.methods[0].type, "oauth");
  assert.equal(plugin.auth.methods[0].prompts, undefined, "浏览器登录不应先问 API Key");
  assert.equal(typeof plugin.auth.methods[0].authorize, "function");
  assert.equal(plugin.auth.methods[1].type, "api");
  assert.equal(plugin.auth.methods[1].prompts[0].key, "apiKey");
  assert.equal(typeof plugin.auth.methods[1].authorize, "function");

  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider.sensenova.name, "SenseNova");
  assert.equal(cfg.provider.sensenova.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.sensenova.api, "https://token.sensenova.cn/v1");
  const declared = Object.keys(cfg.provider.sensenova.models);
  assert.deepEqual(declared.sort(), [
    "deepseek-flash",
    "deepseek-v4-flash",
    "glm-5.2",
    "kimi-k3",
    "sensenova-6.8-flash-lite",
  ]);
  assert.ok(!declared.includes("sensenova-u1.5-lite"), "图像模型不进入 Chat 目录");
  assert.ok(!declared.includes("deepseek-v4.1-flash"), "403 的杂项 id 不进入目录");

  const list = await plugin.provider.models(cfg.provider.sensenova, {});
  assert.equal(list[Symbol.for("magpie.fellBack")], true);
  assert.equal(Object.keys(list).length, 5);
});

test("插件：protocol 选项切换 wire API，并在非 chat 时隐藏视频", async () => {
  const anth = await SenseNovaPlugin({}, { protocol: "anthropic" });
  const cfg = {};
  await anth.config(cfg);
  assert.equal(cfg.provider.sensenova.npm, "@ai-sdk/anthropic");
  assert.equal(cfg.provider.sensenova.models["deepseek-flash"].modalities.input.includes("video"), false);
  const list = await anth.provider.models(cfg.provider.sensenova, {});
  assert.equal(list["deepseek-flash"].modalities.input.includes("video"), false);

  const chat = await SenseNovaPlugin({}, {});
  const cfgChat = {};
  await chat.config(cfgChat);
  assert.equal(cfgChat.provider.sensenova.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfgChat.provider.sensenova.models["deepseek-flash"].modalities.input.includes("video"), true);
});

test("插件：loader 解封 API Key；缺凭据的 usage / refresh 报需要重登", async () => {
  const plugin = await SenseNovaPlugin({ client: { app: { log: () => {} } } }, {});
  const record = {
    type: "oauth",
    access: await seal("ACCESS-TOKEN"),
    refresh: await seal("REFRESH-TOKEN"),
    apiKey: await seal("sk-test-123"),
    expires: Date.now() + 3600_000,
    username: "test-user",
  };
  const loaded = await plugin.auth.loader(async () => record);
  assert.equal(loaded.baseURL, "https://token.sensenova.cn/v1");
  assert.equal(loaded.apiKey, "sk-test-123");

  // “仅 API Key”记录：key 是密封的，loader 也要能解开
  const apiLoaded = await plugin.auth.loader(async () => ({ type: "api", key: await seal("sk-api-456") }));
  assert.equal(apiLoaded.apiKey, "sk-api-456");

  const apiUsage = await plugin.auth.usage(async () => ({ type: "api", key: await seal("sk-api-456") }));
  assert.equal(apiUsage.signIn, "kept");
  assert.match(apiUsage.error, /额度不可见/);

  const noAccess = await plugin.auth.usage(async () => ({ ...record, access: "" }));
  assert.equal(noAccess.signIn, "expired");
  assert.ok(noAccess.error);

  const refreshErr = await plugin.auth.refresh({}).catch((e) => e);
  assert.equal(refreshErr.signIn, "expired");
});

await main();
