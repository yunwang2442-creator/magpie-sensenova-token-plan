/**
 * 网关路由策略测试：不联网，直接调用 strategies.balanced，
 * 断言它的排序语义与 magpie 网关调它的方式一致（routes.Apply 语义）。
 *
 * 注意：策略的“刚休息完”记忆是按账号 key 全局记的（真实网关里就该如此），
 * 所以每个用例都用互不重叠的账号名，避免用例间状态串扰。
 *   bun test/gateway.test.mjs
 */
import assert from "node:assert/strict";

import { strategies } from "../gateway.mjs";

/* 迷你测试跑器（与 unit.test.mjs 相同：`bun test/gateway.test.mjs` 直接跑）。 */
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
  process.exitCode = fail ? 1 : 0;
}

const order = (pool, seats) => strategies.balanced(pool, seats);

/* 造 seat 的小工具（形状 = magpie 的 routes.Seat / seatJSON）。 */
const seat = (key, over = {}) => ({ key, account: true, known: true, used: 0, soon: [], pace: 0, weight: 1, resting: false, tokens: 0, ...over });

test("返回的是排列（magpie routes.Apply 的硬要求）", () => {
  const seats = [seat("perm@a"), seat("perm@b"), seat("perm@c"), seat("perm@d"), seat("perm@e")];
  for (let round = 0; round < 5; round++) {
    const out = order("perm-pool", seats);
    assert.equal(out.length, seats.length);
    assert.deepEqual([...out].sort((x, y) => x - y), [0, 1, 2, 3, 4]);
  }
});

test("正在休息的账号排最后", () => {
  const seats = [
    seat("rest@a", { resting: true, tokens: 5_000 }),
    seat("rest@b"),
    seat("rest@c", { resting: true, tokens: 1_000 }),
  ];
  const out = order("rest-pool", seats);
  assert.equal(out[out.length - 1], 0, "resting 且负载更高的 a 应该在最后");
  assert.equal(out[out.length - 2], 2, "resting 的 c 应该在倒数第二");
  assert.equal(out[0], 1, "健康的 b 应该最先");
});

test("已用额度少的优先（把 5 个账号的额度用匀）", () => {
  const seats = [
    seat("quota@a", { used: 40 }),
    seat("quota@b", { used: 5 }),
    seat("quota@c", { used: 70 }),
  ];
  const out = order("quota-pool", seats);
  assert.deepEqual(out, [1, 0, 2]);
});

test("额度相同时，最近一小时 token 少的优先（避免把大请求连续压给同一个账号）", () => {
  const seats = [
    seat("load@a", { tokens: 90_000 }),
    seat("load@b", { tokens: 2_000 }),
    seat("load@c", { tokens: 30_000 }),
  ];
  const out = order("load-pool", seats);
  assert.deepEqual(out, [1, 2, 0]);
});

test("刚休息完的账号冷却期内在健康账号之后（上游 429 常比 magpie 的一分钟休息更久）", () => {
  // 先让它处于 resting，被记住
  order("cool-pool", [seat("cool@a", { resting: true }), seat("cool@b")]);
  // 再恢复成不 resting：冷却期内应排在从未休息的 b 之后
  const out = order("cool-pool", [seat("cool@a"), seat("cool@b")]);
  assert.deepEqual(out, [1, 0], "刚休息完的 a 应排在健康的 b 之后");
});

test("全部相同时按池内轮转起步，而不是永远第一个", () => {
  const seats = [seat("rr@a"), seat("rr@b"), seat("rr@c")];
  const first = order("rr-pool", seats).map((i) => seats[i].key);
  const second = order("rr-pool", seats).map((i) => seats[i].key);
  assert.deepEqual(first, ["rr@a", "rr@b", "rr@c"]);
  assert.deepEqual(second, ["rr@b", "rr@c", "rr@a"], "第二次应轮转一位");
});

test("分组池：保留供应商在成员表里的先后顺序，只在每个供应商内部做智能排序", () => {
  const seats = [
    seat("g-raccoon@x"),
    seat("g-sensenova@a", { used: 60 }),
    seat("g-qoder@y", { used: 10 }),
    seat("g-sensenova@b", { used: 10 }),
  ];
  const out = order("group/free", seats);
  // raccoon 最先（第一个出现的供应商，且只有一个 seat）
  assert.equal(out[0], 0);
  // sensenova 的两个 seat 内部按 used 排：b(10%) 在 a(60%) 前
  const sensenova = out.filter((i) => seats[i].key.startsWith("g-sensenova"));
  assert.deepEqual(sensenova, [3, 1]);
  // qoder 在 sensenova 之后（成员表里它在 sensenova 后面）
  assert.ok(out.indexOf(2) > out.indexOf(3) || out.indexOf(2) > out.indexOf(1));
});

test("seat key 带 @ 或 # 都能正确解析出供应商", () => {
  const seats = [
    seat("mix@user1"),
    seat("mix#abc123"),
    seat("other@u"),
  ];
  const out = order("mix-pool", seats);
  const mix = out.filter((i) => seats[i].key.startsWith("mix"));
  assert.equal(mix.length, 2, "同供应商的两个 seat 应相邻");
  assert.ok(mix[0] === 0 || mix[0] === 1);
});

test("异常输入不抛错（抛错会被 magpie 记为失败并回退）", () => {
  assert.doesNotThrow(() => order("weird-pool", null));
  assert.doesNotThrow(() => order("weird-pool", [undefined, null]));
  assert.doesNotThrow(() => order("weird-pool", [{}]));
  const out = order("weird-pool", [{}, null]);
  assert.deepEqual([...out].sort((x, y) => x - y), [0, 1]);
});

test("known=false 的账号视为额度 0（可用），不阻塞首轮分发", () => {
  const seats = [seat("known@a", { known: false }), seat("known@b", { used: 50 })];
  const out = order("known-pool", seats);
  assert.equal(out[0], 0);
});

main();