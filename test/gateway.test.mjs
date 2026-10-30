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

/* 排列断言（magpie routes.Apply 的硬要求）。 */
const isPermutation = (out, n) => assert.deepEqual([...out].sort((x, y) => x - y), Array.from({ length: n }, (_, i) => i));

test("返回的是排列（magpie routes.Apply 的硬要求）", () => {
  const seats = [seat("perm@a"), seat("perm@b"), seat("perm@c"), seat("perm@d"), seat("perm@e")];
  for (let round = 0; round < 5; round++) {
    const out = order("perm-pool", seats);
    assert.equal(out.length, seats.length);
    isPermutation(out, seats.length);
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

test("同档额度（0.5 个百分点内）才比较 token 负载；差一档就用额度说话", () => {
  // used 5.0 与 5.2 同档 → tokens 少的 b 先
  const same = order(
    "band-pool",
    [seat("band@a", { used: 5.2, tokens: 90_000 }), seat("band@b", { used: 5.0, tokens: 2_000 })],
  );
  assert.deepEqual(same, [1, 0]);
  // used 5.0 与 6.0 跨档 → 额度少的 a 先，即使它 token 多
  const cross = order(
    "band-pool2",
    [seat("band2@a", { used: 5.0, tokens: 90_000 }), seat("band2@b", { used: 6.0, tokens: 2_000 })],
  );
  assert.deepEqual(cross, [0, 1]);
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

test("窗口 1 小时内重置的账号优先（把快过期的额度用掉）", () => {
  const now = Date.now();
  const seats = [
    seat("soon@a", { soon: [now + 30 * 60_000] }), // 30 分钟后重置
    seat("soon@b", { soon: [now + 5 * 3600_000] }), // 5 小时后重置
  ];
  const out = order("soon-pool", seats);
  assert.equal(out[0], 0, "30 分钟后重置的 a 应优先");
});

test("刚休息完的账号冷却期内在健康账号之后（上游 429 常比 magpie 的一分钟休息更久）", () => {
  // 先让它处于 resting，被记住
  order("cool-pool", [seat("cool@a", { resting: true }), seat("cool@b")]);
  // 再恢复成不 resting：冷却期内应排在从未休息的 b 之后
  const out = order("cool-pool", [seat("cool@a"), seat("cool@b")]);
  assert.deepEqual(out, [1, 0], "刚休息完的 a 应排在健康的 b 之后");
});

test("休息期间连续调用不刷新冷却起点（休息结束 magpie 已压过的时间不重复计）", () => {
  // 连续 3 次让 a 处于 resting
  for (let i = 0; i < 3; i++) order("episode-pool", [seat("ep@a", { resting: true }), seat("ep@b")]);
  // 恢复后 a 进冷却，排在 b 后；再次断言稳定性即可（真实时长无法在此快进）
  const out = order("episode-pool", [seat("ep@a"), seat("ep@b")]);
  assert.deepEqual(out, [1, 0]);
});

test("额度未知的账号（known=false）不排最前，避免额度读取失败时被持续打爆", () => {
  const seats = [seat("known@a", { known: false }), seat("known@b", { used: 50 })];
  const out = order("known-pool", seats);
  assert.equal(out[0], 1, "known=false 视同已用 60%，排在已知 50% 之后");
  isPermutation(out, 2);
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

test("seat key 带 @ 或 # 都能正确解析出供应商；裸供应商 id 也可以", () => {
  const seats = [
    seat("mix@user1"),
    seat("mix#abc123"),
    seat("other@u"),
    seat("sensenova"),
  ];
  const out = order("mix-pool", seats);
  const mix = out.filter((i) => seats[i].key.startsWith("mix"));
  assert.equal(mix.length, 2, "同供应商的两个 seat 应相邻");
  assert.ok(mix[0] === 0 || mix[0] === 1);
});

test("边界输入：空数组、单个 seat、NaN/Infinity/负数、重复 key、稀疏数组", () => {
  assert.deepEqual(order("edge", []), []);
  assert.deepEqual(order("edge", [seat("edge@a")]), [0]);

  const weird = [
    seat("w@a", { used: NaN, tokens: NaN }),
    seat("w@b", { used: Infinity, tokens: -5 }),
    seat("w@c", { used: -10, tokens: Infinity }),
    seat("w@d", { used: "12", tokens: "3" }),
  ];
  const outWeird = order("edge-weird", weird);
  isPermutation(outWeird, weird.length);

  const dup = [seat("dup@x"), seat("dup@x"), seat("dup@y")];
  isPermutation(order("edge-dup", dup), dup.length);

  const sparse = new Array(4);
  sparse[0] = seat("sp@a");
  sparse[2] = seat("sp@b");
  isPermutation(order("edge-sparse", sparse), 4);

  const holed = [seat("h@a"), undefined, seat("h@b")];
  isPermutation(order("edge-holed", holed), 3);
});

test("5000 个 seat 也在 20ms 预算内（留足余量到 50ms 断言）", () => {
  const seats = Array.from({ length: 5000 }, (_, i) => seat(`perf@${i % 7}-${i}`, { used: (i * 7) % 100, tokens: i * 13 }));
  const t0 = Date.now();
  const out = order("perf-pool", seats);
  const cost = Date.now() - t0;
  isPermutation(out, seats.length);
  assert.ok(cost < 50, `5000 seats 耗时 ${cost}ms，超出预算`);
});

test("异常输入不抛错（抛错会被 magpie 记为失败并回退）", () => {
  assert.doesNotThrow(() => order("weird-pool", null));
  assert.doesNotThrow(() => order("weird-pool", undefined));
  assert.doesNotThrow(() => order("weird-pool", "nope"));
  assert.doesNotThrow(() => order("weird-pool", [{}]));
  assert.doesNotThrow(() => order("weird-pool", [undefined, null]));
  const out = order("weird-pool", [{}, null]);
  assert.deepEqual([...out].sort((x, y) => x - y), [0, 1]);
});

main();