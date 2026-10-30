/**
 * SenseNova Token Plan 的 magpie 网关路由策略。
 *
 * 这个文件不是 provider 插件的一部分，而是 magpie 的 **gateway middleware**：
 * magpie 在网关进程里用 moejs 加载它，把 `strategies` 注册成
 * `<插件短名>/<策略名>`，出现在所有路由选择器里（供应商、号池、分组）。
 *
 * 为什么需要它：SenseNova 的 429 是**按账号**的上游状态，而且一次 429 会
 * 持续几分钟（受控实测：其它账号全 429 时仍有账号返回 200；同一账号 4 分钟
 * 内多次单发仍 429）。magpie 自带的 `rotate` 只按顺序轮询、`usage` 只看额度
 * 百分比，都不会同时考虑“最近是否刚被限流”和“最近实际发了多少 token”。
 * 这个策略按当前健康度、额度占用、近一小时负载排序，让请求优先落到最可能
 * 答上来的账号，减少无谓的 429 重试和等待。
 *
 * 策略只排序，不发请求，也不改变 magpie 的 429 重试/休息逻辑。
 * 每次调用有 20ms 预算；抛错或返回非排列时 magpie 会回退到原顺序（fail open）。
 *
 * 数据来源（magpie 的 routes.Seat）：
 *   key      账号或 Key 的稳定标识，形如 `sensenova@user` 或 `sensenova#abc123`
 *   account  是否是订阅账号（不是 API Key）
 *   known    额度是否已读到
 *   used     当前适用额度窗口的已用百分比（0–100，按请求的模型计算）
 *   pace     每周剩余额度/小时（本策略不用）
 *   weight   Key 权重（本策略不用）
 *   resting  是否刚失败正在休息
 *   tokens   最近一小时实际发出的 token 数（半衰期 1 小时的衰减值）
 */

/** 休息结束后再压后多久（毫秒）。上游 429 常常比 magpie 的一分钟休息更久。 */
const REST_COOL = 120_000;

/** 记住休息状态的最长时间，避免 Map 无限增长。 */
const REMEMBER = 6 * 60_000;

/** 每个账号最后一次被看到处于 resting 的时间。 */
const lastRest = new Map();

/** 每个池的轮转计数：所有条件都相同时，让“谁先”逐次轮换，而不是永远第一个。 */
const turns = new Map();

/** 从 seat key 里取供应商 id：`sensenova@user` / `sensenova#abc123` → `sensenova`。 */
function providerOf(key) {
  const s = String(key ?? "");
  const at = s.search(/[@#]/);
  return at > 0 ? s.slice(0, at) : s;
}

/** 该 seat 当前的健康档位：0 健康，2 刚休息完（冷却中），3 正在休息。 */
function healthOf(seat, now) {
  const key = String(seat?.key ?? "");
  if (seat?.resting === true) {
    lastRest.set(key, now);
    return 3;
  }
  const at = lastRest.get(key);
  return at !== undefined && now - at < REST_COOL ? 2 : 0;
}

/**
 * 排一次序。
 *
 * 规则（从先到后）：
 *   1. 供应商按在池里第一次出现的顺序（分组里保留你排的成员顺序）；
 *   2. 同一供应商内：健康 > 刚休息完 > 正在休息；
 *   3. 已用额度少的优先（把 5 个账号的额度用匀，避免先打满一个）；
 *   4. 最近一小时 token 少的优先（避免连续把大请求压给同一个账号）；
 *   5. 全部相同则按池内轮转起步（round-robin tie-break）。
 */
function balanced(pool, seats) {
  if (!Array.isArray(seats)) return [];

  const now = Date.now();

  // 清理过期的休息记忆。
  if (lastRest.size > 64) {
    for (const [key, at] of lastRest) {
      if (now - at > REMEMBER) lastRest.delete(key);
    }
  }

  const items = seats.map((seat, index) => ({ seat: seat ?? {}, index }));

  // 供应商首次出现的顺序 + 每个供应商的 seat 数。
  const providerRank = new Map();
  const providerSize = new Map();
  for (const { seat } of items) {
    const provider = providerOf(seat.key);
    if (!providerRank.has(provider)) providerRank.set(provider, providerRank.size);
    providerSize.set(provider, (providerSize.get(provider) ?? 0) + 1);
  }

  const turn = turns.get(pool) ?? 0;
  turns.set(pool, (turn + 1) % 1_000_000);

  // 同一个供应商内，seat 的序号（用于轮转 tie-break）。
  const position = new Map();

  const ranked = items.map(({ seat, index }) => {
    const provider = providerOf(seat.key);
    const at = position.get(provider) ?? 0;
    position.set(provider, at + 1);
    const size = providerSize.get(provider) || 1;

    return {
      index,
      provider: providerRank.get(provider) ?? 0,
      health: healthOf(seat, now),
      used: Number.isFinite(seat.used) ? seat.used : 0,
      tokens: Number.isFinite(seat.tokens) ? seat.tokens : 0,
      tie: ((at - turn) % size + size) % size,
    };
  });

  ranked.sort(
    (a, b) =>
      a.provider - b.provider ||
      a.health - b.health ||
      a.used - b.used ||
      a.tokens - b.tokens ||
      a.tie - b.tie ||
      a.index - b.index,
  );

  return ranked.map((row) => row.index);
}

export const strategies = {
  /**
   * `magpie-sensenova-token-plan/balanced`
   *
   * 推荐设在 sensenova **供应商**自己的 routing 上；分组里只要它的路由与
   * 分组不同，magpie 就会保留它自己的路由（ownRouting），所以组里调用
   * 商汤时同样按这 5 个账号的健康度/额度/负载排序。
   */
  balanced,
};