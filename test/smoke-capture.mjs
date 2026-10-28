/**
 * 浏览器捕获烟测：用本地回环 HTTP 服务复刻"授权 → 302 → 回调"的全过程，
 * 验证 CDP 在回调导航落地**之前**截停、提取 code，并且回调页面从未被加载
 * （即官方 SPA 那种"消费 code"的角色根本没有机会执行）。
 *
 * 全程无头、不联网、不碰真实账号；需要本机有 Edge/Chrome。
 *   bun test/smoke-capture.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { startLoginCapture } from "../lib/browser.mjs";

const CODE = "SMOKE_CODE_123";
const STATE = "smoke-state-abc";
const HEADLESS = process.env.SMOKE_HEADFUL !== "1"; // SMOKE_HEADFUL=1 时用可见窗口跑（会闪一下）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rootServed = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const redirect = (location) => {
    res.writeHead(302, { location });
    res.end();
  };
  if (url.pathname === "/authorize") return redirect(`/?code=${CODE}&state=${STATE}`);
  if (url.pathname === "/deny") {
    return redirect(`/?error=access_denied&error_description=nope&state=${STATE}`);
  }
  if (url.pathname === "/mismatch") return redirect("/?code=WRONG&state=OTHER");
  if (url.pathname === "/") {
    rootServed++;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>回调页面不应该被加载</h1>");
    return;
  }
  res.writeHead(204);
  res.end();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`本地回环服务: ${base}`);

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

const capture = (path) =>
  startLoginCapture({
    authorizeUrl: `${base}${path}`,
    expectedState: STATE,
    callbackHost: "127.0.0.1",
    headless: HEADLESS,
    timeoutMs: 30_000,
    log: (m) => console.log(`     · ${m}`),
  });

let firstSession = null;

await check("回调被截停、提取 code，且回调页面从未加载", async () => {
  const session = await capture("/authorize");
  firstSession = session;
  try {
    const got = await session.result;
    assert.equal(got.code, CODE);
    assert.equal(got.state, STATE);
    assert.equal(rootServed, 0, "回调页面不应该被加载（SPA 没机会执行）");
  } finally {
    await session.close();
  }
});

await check("平台拒绝（?error=…）时给出明确错误", async () => {
  const session = await capture("/deny");
  try {
    const err = await session.result.then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "应当拒绝");
    assert.match(err.message, /access_denied|nope/);
  } finally {
    await session.close();
  }
});

await check("state 不匹配的回调被放行，随后正确的回调仍能捕获", async () => {
  rootServed = 0;
  const session = await capture("/mismatch");
  try {
    const deadline = Date.now() + 10_000;
    while (rootServed === 0 && Date.now() < deadline) await sleep(100);
    assert.ok(rootServed > 0, "state 不匹配的回调应当被放行（页面真的加载）");
    await session.navigate(`${base}/?code=SECOND&state=${STATE}`);
    const got = await session.result;
    assert.equal(got.code, "SECOND");
  } finally {
    await session.close();
  }
});

await new Promise((r) => server.closeAllConnections?.() ?? r());
await new Promise((r) => server.close(r));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
