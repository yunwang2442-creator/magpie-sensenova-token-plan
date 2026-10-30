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
 *
 * 策略只排序，不发请求，也不改变 magpie 的 429 重试/休息逻辑。
 * 每次调用有 20ms 预算；抛错或返回非排列时 magpie 会回退到原顺序（fail open）。
 *
 * 数据来源（magpie 的 routes.Seat → seatJSON）：
 *   key      账号或 Key 的稳定标识：裸 `sensenova`、`sensenova@user` 或 `sensenova#abc123`
 *   account  是否是订阅账号（不是 API Key）
 *   known    额度是否已读到（false 时 used 不可信）
 *   used     当前适用额度窗口的已用百分比（0–100，按请求的模型计算，带长小数）
 *   soon     各额度窗口的重置时间（unix ms 数组）
 *   pace     每周剩余额度/小时（本策略不用）
 *   weight   Key 权重（本策略不用）
 *   resting  是否刚失败正在休息
 *   tokens   最近实际发出的 token 数（magpie 侧 1 小时半衰期的衰减值）
 *
 * 已知边界：magpie 注册 JS 策略时不带 ByUse 标志，Routing 页的 trace 不会
 * 显示 token 依据（routes.Strategy 只挂 Order）；resting 档的内部次序也会被
 * magpie 自己的 restLast 覆盖——无碍，健康档位才是本策略的主要产出。
 */

/** 休息结束后再压后多久（毫秒）。上游 429 常常比 magpie 的一分钟休息更久。 */
const REST_COOL = 120_000;

/** 休息/冷却记忆的最长保留时间，防止 Map 无界增长。 */
const REMEMBER = 6 * 60_000;

/** 额度量化档位（百分点）：used 几乎总带小数，不量化的话 token 避让永远轮不到。 */
const USED_BAND = 0.5;

/** 窗口在这段时间内重置 → 优先把“快过期的额度”用掉。 */
const SOON_WINDOW = 3_600_000;

/** 每多少次调用做一次记忆清扫。 */
const PRUNE_EVERY = 512;

/** turns 的容量上限（池的数量级很小，纯粹防异常环境的无界增长）。 */
const TURNS_CAP = 64;

/** 账号本次 resting 回合的起点（用于冷却从“首次观察到休息”起算，不被连续调用刷新）。 */
const restingSince = new Map();

/** 账号上一次 resting 回合的起点。 */
const lastRest = new Map();

/** 每个池的轮转计数：所有条件都相同时，让“谁先”逐次轮换，而不是永远第一个。 */
const turns = new Map();

let calls = 0;

/** 从 seat key 里取供应商 id：`sensenova` / `sensenova@user` / `sensenova#abc123` → `sensenova`。 */
function providerOf(key) {
  const s = String(key ?? "");
  const at = s.search(/[@#]/);
  return at > 0 ? s.slice(0, at) : s;
}

/** 该 seat 当前的健康档位：0 健康，2 刚休息完（冷却中），3 正在休息。 */
function healthOf(seat, key, now) {
  if (seat.resting === true) {
    // 冷却从“本次休息回合首次被观察到”起算；休息期间反复调用不刷新，
    // 否则 magpie 休息越久、我们额外压得越久。
    if (!restingSince.has(key)) restingSince.set(key, now);
    return 3;
  }
  const started = restingSince.get(key);
  if (started !== undefined) {
    // 休息刚结束：把这一回合的起点定格为冷却起点。
    restingSince.delete(key);
    lastRest.set(key, started);
  }
  const at = lastRest.get(key);
  return at !== undefined && now - at < REST_COOL ? 2 : 0;
}

/** 数值清洗：非有限数一律归 0（JSON 不会带 NaN/Infinity，纯防御）。 */
const num = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

/**
 * 排一次序。
 *
 * 规则（从先到后）：
 *   1. 供应商按在池里第一次出现的顺序（分组里保留你排的成员顺序）；
 *   2. 同一供应商内：健康 > 刚休息完（冷却中）> 正在休息；
 *   3. 已用额度少的优先——按 0.5 个百分点量化分档，同档内才继续比；
 *   4. 同档时，窗口将在 1 小时内重置的优先（把快过期的额度用掉）；
 *   5. 同档时，最近一小时 token 少的优先（避免连续把大请求压给同一个账号）；
 *   6. 全部相同则按池内轮转起步（round-robin tie-break）。
 */
function balanced(pool, seats) {
  if (!Array.isArray(seats)) return [];
  const now = Date.now();

  // 周期性清扫记忆，保证有界（Array.from 同时把稀疏数组的洞变成 undefined）。
  calls += 1;
  if (calls % PRUNE_EVERY === 0) {
    for (const [key, at] of restingSince) if (now - at > REMEMBER) restingSince.delete(key);
    for (const [key, at] of lastRest) if (now - at > REMEMBER) lastRest.delete(key);
    while (turns.size > TURNS_CAP) {
      const oldest = turns.keys().next().value;
      turns.delete(oldest);
    }
  }

  const items = Array.from(seats, (seat, index) => ({ seat: seat ?? {}, index }));

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

    // 额度未知（known=false）时不当作 0%：折算成“已用 60%”的中性偏后档，
    // 避免额度读取失败时流量持续打到读不到额度的账号。
    const used = seat.known === false ? Math.max(num(seat.used), 60) : num(seat.used);
    const band = Math.round(used / USED_BAND) * USED_BAND;

    const soons = Array.isArray(seat.soon) ? seat.soon.filter(Number.isFinite) : [];
    const minSoon = soons.length ? Math.min(...soons) : Infinity;
    const renewSoon = minSoon > now && minSoon - now < SOON_WINDOW ? 0 : 1;

    return {
      index,
      provider: providerRank.get(provider) ?? 0,
      health: healthOf(seat, String(seat.key ?? ""), now),
      band,
      renewSoon,
      tokens: num(seat.tokens),
      tie: ((at - turn) % size + size) % size,
    };
  });

  ranked.sort(
    (a, b) =>
      a.provider - b.provider ||
      a.health - b.health ||
      a.band - b.band ||
      a.renewSoon - b.renewSoon ||
      a.tokens - b.tokens ||
      a.tie - b.tie ||
      a.index - b.index,
  );

  return ranked.map((row) => row.index);
}

export const strategies = {
  /**
   * `magpie-sensenova/balanced`（本机路径安装）/ `magpie-sensenova-token-plan/balanced`（npm 安装）
   *
   * 推荐设在 sensenova **供应商**自己的 routing 上；分组里只要它的路由与
   * 分组不同，magpie 就会保留它自己的路由（ownRouting），所以组里调用
   * 商汤时同样按这 5 个账号的健康度/额度/负载排序。
   * 不要设在混合供应商的分组上——那会让分组退化为“按成员表顺序逐家尝试”。
   */
  balanced,
};