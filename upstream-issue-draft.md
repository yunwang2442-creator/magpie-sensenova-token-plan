# magpie 上游需求稿：多账号额度合并显示（本地存档，未提交）

> 存档说明（2026-10-15）：这是给 yetone/magpie 的 feature request 草稿，按用户决定
> **只存本地、不向上游提交**。若要提交，直接复制下方「Issue 正文」粘贴到新 issue 即可。
> 事实依据：magpie v0.1.1246 源码（`internal/provider/quotas.go` 的 `QuotaSpan.Pool`
> 与 `PooledWindows`，见已关闭的 #523）；数据示例取自本机 magpie-sensenova 插件的真实数据。
>
> ⚠️ **数字口径警示（2026-10-30）**：稿内额度数字是 2026-10-15 的旧口径
> （5h 60,000 / 7d 600,000）；当前接口已是通用池 120,000 / 1,200,000。
> 提交前按 README「额度」一节重算全部数字与合计。

---

## Issue 正文（英文，可直接粘贴）

**Title:** `feat(usage): opt-in aggregation of one provider's multi-account quota windows (display-only, routing unchanged)`

**Body:**

### Why

A plugin provider can have several accounts of the same vendor, each reporting the same set of window names. In this setup, SenseNova Token Plan has 5 accounts × 4 windows (通用积分池 5h/7d + Flash-Lite 积分池 5h/7d). The usage page and the tray panel render one card per account — one expanded, the rest brief bars — which is ~20 rows for 5 accounts, and "how much is left across all accounts" cannot be read anywhere; it has to be summed by hand.

### Request

An opt-in, display-only aggregation for such providers:

- When a provider's plugin declares its accounts' windows additive (e.g. a provider-level flag, or per-window `pool` values that are provider-scoped), the usage page shows **one aggregated card** for that provider, in addition to today's per-account cards (which stay one tap away, exactly as they render now).
- The aggregated card shows, per window name: sum of remaining/limit/amount across accounts, the earliest `resetsAt` among them (the binding one), and pace recomputed from the sums.
- **Routing is untouched**: Smart ordering, session affinity and sink keep operating per account, exactly as today.

### Why the existing pieces nearly fit

`QuotaSpan.Pool` ("the shared pool the window draws on") plus `PooledWindows` already aggregate windows *across models within one account* for pooled vendors (Antigravity, see closed #523). This request is the same aggregation one level up — across the accounts of one provider — at the quota-report/display layer only. Summing needs no new data: `Used` / `Remaining` / `Limit` / `Amount` / `Unit` are all numeric per window, and window names are identical across the accounts of a farm.

### Data example (5 SenseNova accounts, 2026-10-15)

| window | acct 1 | acct 2 | acct 3 | acct 4 | acct 5 | aggregated card would show |
|---|---|---|---|---|---|---|
| 通用积分池 · 5h | 99.98% left | 67.22% | 100% | 100% | 100% | ~93.4% left, resets = earliest of the five |
| 通用积分池 · 7d | 100% | 96.72% | 100% | 100% | 100% | ~99.3% left |
| Flash-Lite 积分池 · 5h | 100% ×5 | | | | | 100% |
| Flash-Lite 积分池 · 7d | 100% ×5 | | | | | 100% |

(per-account limits: 5h = 60,000 credits, 7d = 600,000 credits; the aggregated card would show 300,000 / 3,000,000 as the farm's pools.)

### Alternatives considered

- **One synthetic account with plugin-side rotation** — rejected: it moves account selection into the plugin and loses magpie's Smart ordering, affinity, sink, and the cache-read/write-aware affinity heuristic.
- **Nothing (per-account cards only)** — today's behavior; the pain this draft describes.

### Scope

Display only; no change for providers that don't opt in; no routing changes.

---

## 中文要点（便于与作者沟通）

- 需求：同一插件供应商的多个账号，其额度窗口在**显示层**合并成一张卡——按窗口名求和、取最早重置时间、配速按合计重算。
- 路由完全不动：挑号、会话粘性、限流沉底照旧按账号走。
- 依据：现有 `QuotaSpan.Pool` + `PooledWindows` 已在账号**内**做过同样的事（Antigravity 池聚合，#523），只差跨账号这一层。
- 数据示例：本机 SenseNova 5 账号 × 4 窗口（上表）。
