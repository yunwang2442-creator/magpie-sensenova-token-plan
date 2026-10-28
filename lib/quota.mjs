/**
 * 额度响应 → magpie `auth.usage` 的窗口模型。
 *
 * 上游是控制台的 pool-usage 接口，与"额度管理器"exe 看到的完全同一条：
 *   { code, message, data?: { pools } | pools: [ {
 *       name, pool_type, window_5h / window_7d: { limit, used, remaining, reset_at },
 *       grant_balance, nearest_grant_expiry, nearest_grant_expiring_balance,
 *   } ] }
 * 数字全部以字符串下发，时间为 unix 秒字符串——按 exe 的 flexNum/flexInt 宽容解析。
 *
 * 映射规则（与 exe 的看板口径一致）：
 *   - 每个池的 5h 窗口 → span 18000 的窗口；7d 窗口 → span 604800 的窗口；
 *   - 专属池（Flash-Lite）的窗口用 model 字段限定到 flash-lite 模型族；
 *     接口若直接给了 model_ids 则用它（更精确）；
 *   - 通用池的窗口不限定（对所有模型生效）；
 *   - 活动积分（grant_balance）→ magpie 的 balance。
 */

/** 宽容数值：接受 "600000" / 591300.256 / null，负数归零。 */
export function flexNum(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim() || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 宽容 unix 秒时间戳。 */
export function flexInt(value) {
  const n = Math.trunc(flexNum(value));
  return n > 0 ? n : 0;
}

/** 千分位 + 最多两位小数（整数不带小数点）。 */
export function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  const [int, frac] = (Math.round(v * 100) / 100).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === "00" ? grouped : `${grouped}.${frac.replace(/0$/, "")}`;
}

function isDedicated(pool) {
  const t = String(pool?.pool_type ?? "").toLowerCase();
  return t === "dedicated" || t === "flash";
}

/** 窗口的模型归属：接口给了 model_ids 就用；否则专属池按 flash-lite 词匹配。 */
function scopeOf(pool, dedicated) {
  const ids = Array.isArray(pool?.model_ids) ? pool.model_ids.filter((x) => typeof x === "string" && x) : [];
  if (ids.length) return { models: ids };
  if (dedicated) return { model: "flash-lite" };
  return {};
}

/** 取池数组（data.pools 或顶层 pools）。 */
export function poolsOf(raw) {
  if (Array.isArray(raw?.data?.pools)) return raw.data.pools;
  if (Array.isArray(raw?.pools)) return raw.pools;
  return [];
}

/**
 * pool-usage 响应 → magpie usage 对象。
 *
 * @param {object} raw 接口原始响应
 * @param {{username?: string, planFallback?: string}} [meta]
 * @returns {{plan: string, user?: string, balance?: string, windows: object[]}}
 * @throws {Error} 响应里没有可识别的窗口时（让账号卡片直接显示原因，而不是空）
 */
export function toUsage(raw, { username = "", planFallback = "Token Plan" } = {}) {
  const pools = poolsOf(raw);
  if (!pools.length) {
    const detail = raw?.error?.message ?? raw?.message ?? raw?.error;
    throw new Error(typeof detail === "string" && detail ? `额度响应异常：${detail}` : "额度响应里没有积分池");
  }

  const windows = [];
  let balance = "";

  for (const pool of pools) {
    const dedicated = isDedicated(pool);
    const scope = scopeOf(pool, dedicated);
    const label = typeof pool?.name === "string" && pool.name.trim() ? pool.name.trim() : dedicated ? "专属积分池" : "通用积分池";

    const rows = [
      [pool?.window_5h, "5 小时窗口", 5 * 3600],
      [pool?.window_7d, "7 天窗口", 7 * 24 * 3600],
    ];
    for (const [w, tag, span] of rows) {
      const limit = flexNum(w?.limit);
      if (limit <= 0) continue;
      const remaining = Math.min(flexNum(w?.remaining), limit);
      const used = Math.max(0, limit - remaining);
      windows.push({
        name: `${label} · ${tag}`,
        used: (used / limit) * 100,
        resetsAt: flexInt(w?.reset_at) || undefined,
        display: `已用 ${compact(used)} / ${compact(limit)}`,
        amount: used,
        limit,
        unit: "积分",
        span,
        ...scope,
      });
    }

    // 活动积分（平铺字段）：只有通用池带（专属池为 0）
    if (!balance && !dedicated) {
      const grant = flexNum(pool?.grant_balance);
      if (grant > 0) balance = `${compact(grant)} 积分`;
    }
  }

  if (!windows.length) throw new Error("额度响应里没有可识别的窗口（接口结构可能变了）");

  const plan = raw?.data?.plan?.name ?? raw?.plan?.name;
  return {
    plan: typeof plan === "string" && plan.trim() ? plan.trim() : planFallback,
    ...(username ? { user: username } : {}),
    ...(balance ? { balance } : {}),
    windows,
  };
}
