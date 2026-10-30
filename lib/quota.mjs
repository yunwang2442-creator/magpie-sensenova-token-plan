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
 *   - 通用池的窗口用 notModels 排除专属池模型：厂商的扣费顺序是“先专属、再通用”，
 *     magpie 若不排除会取两个窗口的最大 used，通用池一满就误判 Flash-Lite 不可用；
 *   - 活动积分（grant_balance）→ magpie 的 balance；带到期批次时再加一个钱包窗口。
 */

/** 宽容数值：接受 "600000" / 591300.256 / null，负数归零。 */
export function flexNum(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim() || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 可选数值：缺失 / 空串 / NaN → undefined；负数保留（remaining 可能为负）。 */
function optionalNum(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
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
  const name = String(pool?.name ?? "").toLowerCase();
  return t === "dedicated" || t === "flash" || name.includes("flash") || name.includes("专属");
}

/** 专属池没有给 model_ids 时的兜底 id。 */
const FLASH_LITE_IDS = ["sensenova-6.7-flash-lite", "sensenova-6.8-flash-lite"];

/**
 * 窗口的模型归属。
 *
 * 专属池：限定到 Flash-Lite。通用池：**排除** Flash-Lite——因为厂商的扣费顺序是
 * “先专属、再通用”；如果通用池也把 Flash-Lite 算进去，magpie 的
 * `Allowance.For` 会取两个窗口的最大 used，通用池一满就把 Flash-Lite 也判死，
 * 即使专属池还有额度。用 `notModels` 把 Flash-Lite 从通用窗口里摘出去。
 */
function scopeOf(pool, dedicated, dedicatedIds) {
  const ids = Array.isArray(pool?.model_ids) ? pool.model_ids.filter((x) => typeof x === "string" && x) : [];
  if (dedicated) return ids.length ? { models: ids } : { model: "flash-lite" };
  if (dedicatedIds.length) return { notModels: [...dedicatedIds] };
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
 * `used` 是已用数量（不是百分比）；优先用它，其次 `limit - remaining`。
 * 两者都缺失时跳过该窗口——不要伪造 0，否则会被误读成 100% 已用。
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

  // 专属池的模型 id：接口给了就用；没给时按 Flash-Lite 兜底。
  // 通用池窗口要排除这些 id，避免通用池用完把专属池模型一起判死。
  const dedicatedIds = [
    ...new Set(
      pools
        .filter(isDedicated)
        .flatMap((p) => {
          const ids = Array.isArray(p?.model_ids) ? p.model_ids.filter((x) => typeof x === "string" && x) : [];
          return ids.length ? ids : FLASH_LITE_IDS;
        }),
    ),
  ];

  const windows = [];
  let balance = "";
  let wallet = null;

  for (const pool of pools) {
    const dedicated = isDedicated(pool);
    const scope = scopeOf(pool, dedicated, dedicatedIds);
    const label = typeof pool?.name === "string" && pool.name.trim() ? pool.name.trim() : dedicated ? "专属积分池" : "通用积分池";

    const rows = [
      [pool?.window_5h, "5 小时窗口", 5 * 3600],
      [pool?.window_7d, "7 天窗口", 7 * 24 * 3600],
    ];
    for (const [w, tag, span] of rows) {
      const limit = flexNum(w?.limit);
      if (limit <= 0) continue;

      const usedAmount = optionalNum(w?.used);
      const remaining = optionalNum(w?.remaining);
      const amount =
        usedAmount !== undefined
          ? Math.max(0, usedAmount)
          : remaining !== undefined
            ? Math.max(0, limit - remaining)
            : undefined;

      // 用量未知：跳过，不要编 0。Magpie 支持 used=null，但跳过更干净。
      if (amount === undefined) continue;

      windows.push({
        name: `${label} · ${tag}`,
        used: (amount / limit) * 100, // 允许 >100：超支是真实状态
        resetsAt: flexInt(w?.reset_at) || undefined,
        display: `${compact(amount)} / ${compact(limit)}`,
        amount,
        limit,
        unit: "积分",
        span,
        ...scope,
      });
    }

    // 活动积分（平铺字段）：只有通用池带（专属池为 0）
    if (!balance && !dedicated) {
      const grant = flexNum(pool?.grant_balance);
      if (grant > 0) {
        balance = `${compact(grant)} 积分`;
        const expiry = flexInt(pool?.nearest_grant_expiry);
        const expiring = flexNum(pool?.nearest_grant_expiring_balance);
        // 只有带到期批次时才单列钱包窗口，避免多一行无意义的余额。
        if (expiry || expiring) {
          wallet = {
            name: "活动积分",
            balance: grant,
            unit: "积分",
            display: `${compact(grant)} 积分`,
            ...(expiry ? { runsOutAt: expiry } : {}),
            ...(expiring ? { runsOut: expiring } : {}),
          };
        }
      }
    }
  }

  if (wallet) windows.push(wallet);
  if (!windows.length) throw new Error("额度响应里没有可识别的窗口（接口结构可能变了）");

  const plan = raw?.data?.plan?.name ?? raw?.plan?.name;
  return {
    plan: typeof plan === "string" && plan.trim() ? plan.trim() : planFallback,
    ...(username ? { user: username } : {}),
    ...(balance ? { balance } : {}),
    windows,
  };
}
