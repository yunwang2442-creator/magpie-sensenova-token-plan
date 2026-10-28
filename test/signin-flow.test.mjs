/**
 * 端到端签入流程测试（浏览器与网络全部打桩，离线可跑）：
 *
 *   1. authorize → callback 产出的账号记录形状（magpie 落盘的就是它）；
 *   2. magpie 的 save() 之后，loader / provider.models / auth.usage / auth.refresh
 *      四个钩子对这条记录的使用——请求头、请求体、缓存、失效判定全查。
 *
 *   bun test/signin-flow.test.mjs
 */

import assert from "node:assert/strict";
import { hostname } from "node:os";
import { mock } from "bun:test";

import { keyFingerprint } from "../lib/protocol.mjs";

const TOKEN_URL = "https://platform.sensenova.cn/oauth2/token";
const POOL_URL = "https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage";

/* 1) 打桩浏览器：登录窗口"抓到"一个假 code（真流程见 smoke-capture） */
mock.module("../lib/browser.mjs", () => ({
  findBrowser: () => "edge-stub",
  startLoginCapture: async () => ({
    result: Promise.resolve({ code: "FAKE_CODE", state: "FAKE_STATE", redirectUrl: "" }),
    close: async () => {},
    navigate: async () => {},
  }),
}));

/* 2) 打桩网络 */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `header.${b64(payload)}.sig`;
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACCESS_JWT = jwt({ ext: { username: "wy-test" }, sub: "uid-1" });
const POOL_FIXTURE = {
  code: 0,
  data: {
    pools: [
      {
        name: "通用积分池",
        pool_type: "default",
        window_5h: { limit: "120000", remaining: "102000", reset_at: "1788595830" },
        window_7d: { limit: "1200000", remaining: "1191300.256", reset_at: "1788948630" },
        grant_balance: "24506.9624",
      },
      {
        name: "Flash-Lite积分池",
        pool_type: "dedicated",
        window_5h: { limit: "60000", remaining: "60000", reset_at: "1788595830" },
      },
    ],
  },
};

let calls = [];
let keyList = [];
let quotaStatus = 200;
let tokenResponse = null; // 覆盖换码/续期的响应

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  if (u.startsWith("https://token.sensenova.cn/v1/models")) {
    return jsonRes({
      data: [
        { id: "sensenova-6.8-flash-lite" },
        { id: "glm-5.2" },
        { id: "sensenova-u1.5-lite", output_modalities: ["image"] },
        { id: "deepseek-v4.1-flash" },
      ],
    });
  }
  if (u.startsWith("https://platform.sensenova.cn/lite/console/v1/metered/api-keys")) {
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return jsonRes({ api_key_plain: "sk-created", id: "key-1", displayname: body.displayname, key_type: body.key_type });
    }
    if (init.method === "DELETE") return new Response("", { status: 204 });
    return jsonRes({ api_keys: keyList, total_count: keyList.length || 1 });
  }
  if (u === TOKEN_URL) {
    if (tokenResponse) return tokenResponse;
    const body = String(init.body ?? "");
    if (body.includes("authorization_code")) {
      return jsonRes({ access_token: ACCESS_JWT, id_token: "", refresh_token: "RT-1", expires_in: 3600 });
    }
    return jsonRes({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 7200 });
  }
  if (u === POOL_URL) {
    if (quotaStatus !== 200) return jsonRes({ message: "no" }, quotaStatus);
    return jsonRes(POOL_FIXTURE);
  }
  throw new Error(`未预期的请求: ${u}`);
};

/* 3) 导入被测插件（此时浏览器已被打桩） */
const { SenseNovaPlugin } = await import("../index.mjs");
const { unseal } = await import("../lib/dpapi.mjs");

const logs = [];
const plugin = await SenseNovaPlugin({ client: { app: { log: (o) => logs.push(o) } } }, {});

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ❌ ${name}\n     ${e?.message ?? e}`);
  }
};

let record = null;

await check("authorize：不返回链接 + opened，先登录再自动建 Key", async () => {
  const s = await plugin.auth.methods[0].authorize();
  assert.equal(s.url, "", "url 必须为空：GUI 的 Open again 会把 code 交给 SPA");
  assert.equal(s.opened, true, "插件自己开了浏览器，告诉 magpie 不要再开");
  assert.equal(s.method, "auto");
  assert.equal(typeof s.callback, "function");
  assert.equal(s.prompts, undefined, "浏览器登录不应先问 API Key");
});

await check("callback：换码 + 自动创建 API Key，三件凭据全部密封", async () => {
  const result = await plugin.auth.methods[0].authorize().then((s) => s.callback());
  assert.equal(result.type, "success");
  assert.equal(result.accountId, "wy-test");
  assert.equal(result.uid, "uid-1");
  assert.equal(result.username, "wy-test");
  assert.equal(await unseal(result.refresh), "RT-1");
  assert.equal(await unseal(result.access), ACCESS_JWT);
  assert.equal(await unseal(result.apiKey), "sk-created");
  assert.ok(result.refresh.startsWith("dpapi:"), "refresh 必须密封后才交给 magpie 落盘");
  const left = result.expires - Date.now();
  assert.ok(left > 3500_000 && left <= 3600_000, `expires 应约为 1 小时后，实际 ${left}`);

  const keyPost = calls.find((c) => c.url.includes("/metered/api-keys") && c.init.method === "POST");
  assert.ok(keyPost, "浏览器登录应自动创建 Token Plan API Key");
  const body = JSON.parse(String(keyPost.init.body));
  assert.match(body.displayname, /^magpie-[0-9a-f]{4}-/);
  assert.equal(body.key_type, "API_KEY_TYPE_TOKEN_PLAN");

  // 模拟 magpie 的 save()：oauth 记录 = {type, refresh, access, expires, ...extra}
  const { type: _t, provider: _p, refresh, access, expires, ...extra } = result;
  record = { type: "oauth", refresh, access, expires, ...extra };
});

await check("loader：解出 API Key 交给宿主（宿主据此拼 Authorization）", async () => {
  const loaded = await plugin.auth.loader(async () => record);
  assert.equal(loaded.baseURL, "https://token.sensenova.cn/v1");
  assert.equal(loaded.apiKey, "sk-created");
});

await check("api 方法：只校验/密封 Key，不打开浏览器", async () => {
  const s = await plugin.auth.methods[1].authorize({ apiKey: "  Bearer sk-api  ", email: "note" });
  assert.equal(s.type, "success");
  assert.equal(await unseal(s.key), "sk-api");
  assert.ok(s.key === "sk-api" || s.key.startsWith("dpapi:"), "Windows 上应密封");
  assert.equal(s.metadata.email, "note", "账号备注要落进 metadata.email");

  const noNote = await plugin.auth.methods[1].authorize({ apiKey: "sk-api" });
  assert.match(noNote.metadata.email, /^key:[0-9a-f]{12}$/, "没填备注时用稳定 Key 指纹");
  assert.equal(noNote.metadata.email, (await plugin.auth.methods[1].authorize({ apiKey: "sk-api" })).metadata.email);
});

await check("provider.models：活清单替换兜底（不打 fellBack 标记）", async () => {
  const list = await plugin.provider.models({ models: {} }, { auth: record });
  assert.deepEqual(Object.keys(list).sort(), ["glm-5.2", "sensenova-6.8-flash-lite", "sensenova-u1.5-lite"]);
  assert.equal(list[Symbol.for("magpie.fellBack")], undefined);
  assert.equal(list["glm-5.2"].providerID, "sensenova");
});

await check("key lifecycle：prune_old_keys 只删旧的同机 magpie- Key", async () => {
  const tag = keyFingerprint(hostname()).slice(0, 4);
  keyList = [
    { id: "old3", displayname: `magpie-${tag}-old3`, create_time: "2026-10-28T00:00:00Z" },
    { id: "old2", displayname: `magpie-${tag}-old2`, create_time: "2026-10-28T01:00:00Z" },
    { id: "old1", displayname: `magpie-${tag}-old1`, create_time: "2026-10-28T02:00:00Z" },
  ];
  const prunePlugin = await SenseNovaPlugin({
    client: { app: { log: () => {} } },
    magpie: { option: (_id, key) => key === "prune_old_keys" },
  });
  const result = await prunePlugin.auth.methods[0].authorize().then((s) => s.callback());
  assert.equal(result.type, "success");
  const deletes = calls.filter((c) => c.init.method === "DELETE" && c.url.includes("/metered/api-keys/"));
  assert.ok(deletes.some((c) => c.url.endsWith("/old3")), "old3 should be deleted");
  assert.ok(!deletes.some((c) => c.url.endsWith("/old2")), "old2 should be kept");
  assert.ok(!deletes.some((c) => c.url.endsWith("/old1")), "old1 should be kept");
  keyList = [];
});

await check("usage：带控制台令牌读额度、映射窗口，并命中 60 秒缓存", async () => {
  calls = calls.filter((c) => !c.url.includes("pool-usage"));
  const usage = await plugin.auth.usage(async () => record);
  assert.equal(usage.user, "wy-test");
  assert.equal(usage.balance, "24,506.96 积分");
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].display, "18,000 / 120,000");
  assert.equal(usage.windows[2].model, "flash-lite");
  const quotaCalls = calls.filter((c) => c.url.includes("pool-usage"));
  assert.equal(quotaCalls.length, 1);
  assert.equal(quotaCalls[0].init.headers.Authorization, `Bearer ${ACCESS_JWT}`);
  assert.match(quotaCalls[0].init.headers["User-Agent"], /Chrome/);

  await plugin.auth.usage(async () => record); // 第二次：应命中缓存
  assert.equal(calls.filter((c) => c.url.includes("pool-usage")).length, 1, "缓存期内不应重复打接口");
});

await check("usage：401 标记为需要重新登录", async () => {
  quotaStatus = 401;
  const freshPlugin = await SenseNovaPlugin({}, {}); // 新实例：没有额度缓存
  const usage = await freshPlugin.auth.usage(async () => record);
  assert.equal(usage.signIn, "expired");
  assert.match(usage.error, /重新登录/);
  quotaStatus = 200;
});

await check("usage：403 不标过期，只报错 kept", async () => {
  quotaStatus = 403;
  const freshPlugin = await SenseNovaPlugin({}, {});
  const usage = await freshPlugin.auth.usage(async () => record);
  assert.equal(usage.signIn, "kept");
  assert.match(usage.error, /读取额度失败/);
  quotaStatus = 200;
});

await check("refresh：轮换令牌（新 refresh 覆盖旧值，并回填 expires）", async () => {
  calls = calls.filter((c) => c.url !== TOKEN_URL);
  const renewed = await plugin.auth.refresh(record);
  assert.equal(await unseal(renewed.refresh), "RT-2");
  assert.equal(await unseal(renewed.access), "AT-2");
  const left = renewed.expires - Date.now();
  assert.ok(left > 7100_000 && left <= 7200_000, `expires 应约为 2 小时后，实际 ${left}`);
  const form = String(calls.find((c) => c.url === TOKEN_URL).init.body);
  assert.match(form, /grant_type=refresh_token/);
  assert.match(form, /client_id=nova/);
  assert.match(form, /refresh_token=RT-1/);
  const headers = calls.find((c) => c.url === TOKEN_URL).init.headers;
  assert.equal(headers.Origin, "https://platform.sensenova.cn");
});

await check("refresh：invalid_grant → 抛出 signIn=expired（账号标记待重登）", async () => {
  tokenResponse = jsonRes({ error: "invalid_grant", error_description: "refresh token expired" }, 400);
  const err = await plugin.auth.refresh(record).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "应当抛出");
  assert.equal(err.signIn, "expired");
  assert.match(err.message, /refresh token expired/);
  tokenResponse = null;
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
