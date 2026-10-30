# Changelog

所有重要变更都记在这里。版本号遵循语义化版本。

## [0.8.1] - 2026-10-30

### 修复（四路子代理审计的直接产出）

**gateway.mjs（路由策略）**
- **“token 负载避让”实际是死代码**：magpie 下发的 `used` 带长小数，几乎不可能精确相等，导致 tokens 比较永远轮不到。现在按 0.5 个百分点量化分档，同档内 token 避让才生效。
- **额度未知（`known=false`）的账号被当 0% 永远排最前**：额度读取失败时流量会持续打到读不到额度的账号。现在视同已用 60% 的中性偏后档。
- **冷却起点被连续调用刷新**：休息期间每次调用都重置计时，magpie 休息越久我们额外压得越久。现在按“休息回合”记账，冷却从回合首次被观察到起算。
- **稀疏数组/带洞数组直接抛 TypeError**：`seats.map` 保留洞。现在用 `Array.from` 归一。
- **忽略 `soon`，窗口快重置的额度被留到过期**：同档额度时，1 小时内重置的账号优先。
- `lastRest`/`turns` 的清理护栏改为周期性无条件清扫 + `turns` 容量上限。

**index.mjs（Key 生命周期 / 登录）**
- **满 20 Key 预清理是“先删后建”非事务**：创建失败时 Key 已被删光。现在预清理保留最新 2 个（含正在使用的），创建失败账号仍可用。
- **`pruneKeys` 可能删掉正在用的 Key**：现在按末 4 位对 `api_key` 加保护；`create_time` 不可解析的 Key 一律跳过不删（新旧无法判定，宁可留着）。
- **KEY_LIMIT 守卫只认 `total_count` 字段名**：字段缺失/改名时静默失效。现在 `pageSize: 20` + `api_keys` 长度兜底；满额报错文案补“打开自动清理可自救”。
- **`delete inputs.apiKey` 在冻结/密封对象上抛 TypeError**，api 登录整体中断。现在 try/catch 包裹（metadata 遮蔽仍是主防线）。
- **`provider.models({models:{}})` 返回 0 个模型**：现在空 declared 回退到内置清单。
- `prune_old_keys` 开关改为惰性读取，设置页切换后无需重载插件。

**lib/models.mjs（模型清单）**
- **`created` 越界抛 RangeError，一条坏记录吞掉整个 `/models` 活清单**（静默回退兜底）。现在年份夹在 2000–2200，超界放弃；`extractModels` 单条 try/catch，坏记录只丢自己。

**lib/browser.mjs（登录浏览器）**
- **`cmd /c rmdir` 的 cmd 元字符拆分**：路径含 `&`/`^` 等时会删错目录、留下含登录态的 profile，甚至执行额外命令。现在路径含元字符时改走 `rmSync`（该分支无 CDP 会话，无 Bun 崩溃风险）。
- 启动失败分支的 profile 清理从 fire-and-forget 改为 `await`。
- `MAGPIE_SENSENOVA_BROWSER` 指向不存在的路径时现在会日志提示（此前静默忽略）。

**scripts/key-gc.mjs**
- **跨机器误删**：默认只匹配本机 `magpie-<host>-*`；`--all-machines` 才放宽到所有 `magpie-*`。头部过时注释已更正；缺 `id` 的行跳过；`--apply` 时若正在用的 Key 匹配不到 `api_key` 字段则跳过该账号并提示。

**契约自检**
- `scripts/check-shape.mjs` 补 gateway `strategies.balanced` 形状检查（排列 + resting 置底）。

### 文档

- README：登录旧框架、“价格覆盖”不实声明、Key 保护口径、路由策略边界（不要设在混合分组）与验证方式、`Use for SenseNova` 切换按钮、指定浏览器不做候选回退、临时 profile 可手删、自测清单补 gateway。
- BLUEPRINT：非目标与 v0.8.0 自相矛盾一句、DeepSeek 输出上限过期、额度口径过期、“私有稳定版”版本号。
- `upstream-issue-draft.md` 加旧口径数字警示。

### 测试

- gateway 用例 10 → **15**（新增：量化分档、renewSoon、known、稀疏/重复/NaN/Infinity、5000 seat 性能上限）。
- 现状：**24 单测 + 12 端到端 + 15 网关 + 3 烟测**；`check-shape` 覆盖 gateway 形状。

## [0.8.0] - 2026-10-30

### 新增

- **专属网关路由策略 `magpie-sensenova/balanced`**（`gateway.mjs`，magpie gateway middleware）：按账号健康度、额度占用、近期负载为 5 个账号排序，替代盲目轮询。
  - **健康优先**：正在休息（刚 429）的账号排最后；休息结束后 2 分钟冷却期内仍排在健康账号之后——受控实测上游 429 常比 magpie 的一分钟休息持续更久。
  - **额度均衡**：已用百分比少的优先，把 5 个账号的 5h/7d 窗口用匀，避免先打满一个。
  - **负载避让**：额度相同时最近一小时 token 少的优先（magpie 的衰减计数，半衰期 1 小时），避免连续把大请求压给同一账号。
  - **轮转 tie-break**：全部相同时按池内轮转起步，而不是永远第一个。
  - **分组安全**：用于分组时保留成员表的供应商顺序，只在每个供应商内部做智能排序；由于 `ownRouting`，供应商自己设了它之后，分组调用商汤同样生效。
  - 失败安全：策略只排序不发请求，20ms 预算，抛错/超时/非排列一律回退 magpie 原顺序。
- 实测依据（本机受控实验 + 第三方 3043 次请求研究）：429 按账号持续数分钟、同账号高 RPS 即 `rps exhausted`、额度墙在低速率下几乎不触发——所以“挑当前健康的账号”比“盲目轮询”更有效。

### 说明

- 启用方式：**Providers → SenseNova → Routing → `magpie-sensenova/balanced`**（本仓库已设置）；分组保持原路由即可，供应商自己的路由会保留。
- 路由名按安装方式而异：本机路径安装是 `magpie-sensenova/balanced`，npm 包安装是 `magpie-sensenova-token-plan/balanced`。

## [0.7.3] - 2026-10-30

### 安全修复

- **防止宿主浅拷贝导致 API Key 明文落盘**：`api` 登录方式下，magpie 宿主的 `save()` 会将 `inputs` 中的全部字段浅拷贝进 `metadata`，导致明文 API Key 留在 `plugin-auth.json` 的 `metadata.apiKey` 中。现已在 `authorize` 中清除 `inputs.apiKey` 并在 `metadata` 中显式遮蔽为 `undefined`，彻底消除明文落盘风险。

### 修复

- **Key 上限自救（解决死锁）**：此前若账号已有 20 个 Key，且开启了 `prune_old_keys`，登录流程在 `createApiKey` 之前会因 `total >= KEY_LIMIT` 直接抛错终止，导致自动清理永远无法执行。现在检测到满额时若开启了自动清理，会先执行一次前置预清理（删除旧的同机 `magpie-*` Key），腾出配额后再创建，彻底解除满额死锁。
- **浏览器容错回退**：`startLoginCapture` 在首选浏览器（Edge）启动失败或调试端口无响应时，自动尝试本机安装的其他 Chromium 浏览器（如 Chrome），提升复杂 Windows 环境与策略拦截下的登录成功率。
- **专属池识别双保险**：`isDedicated` 在判断 `pool_type` 之余，同时匹配 `pool.name` 是否包含 "Flash" 或 "专属"，防止商汤接口字段微调时丢失专属池归属。
- **`protocol-test.mjs`**：新增 `--all` 参数，可一次性遍历测试全部 5 个账号的 Chat / Anthropic / Responses 协议连通性。

## [0.7.2] - 2026-10-29

### 修复

- **额度路由隔离**：通用积分池窗口现在用 `notModels` 排除 Flash-Lite 模型（优先用接口返回的 `model_ids`，缺失时用 `sensenova-6.7-flash-lite` / `sensenova-6.8-flash-lite` 兜底）。此前 magpie 取所有适用窗口的最大 `used`，通用池耗尽会把仍有专属额度的 Flash-Lite 一起判死。专属池窗口仍用 `models` 限定到这些模型。
- 实测真实 `pool-usage`：通用窗口带 `notModels`，Flash-Lite 窗口带 `models`；单测增至 23 个。

## [0.7.1] - 2026-10-29

### 新增

- `scripts/protocol-test.mjs`：真实账号给 Chat / Anthropic Messages / Responses 各发一个 `max_tokens=1`，报告 HTTP 状态与厂商错误；429 不当作脚本失败。
- 本地图标：`magpie.icon` 改为内置 data URI（官方 favicon 的 PNG 字节），离线/被墙也能显示。
- `scripts/try.ps1` 自动选择缓存里最新的 Bun，不再硬编码 1.4.4。

## [0.7.0] - 2026-10-29

### 新增

- **图像生成**：`sensenova-u1.5-lite` / `sensenova-u1.5-fast` 进入 provider 目录（不进入 Chat），magpie 的 Image generation picker 会列出它们；`/v1/images/generations` 和 `/v1/images/edits` 由 magpie Drawers 转发，插件只提供 Key/base。
- **Key 生命周期自动开关**：`auth.options` 增加 `prune_old_keys`（默认关闭，provider 设置页可开）；打开后登录成功只保留最新 2 个同机器 `magpie-*` Key，手动 Key 不动。
- **Key 名带机器短标识**：`magpie-<host>-<账号>-<时间>-<随机>`，多机器不会互相清。
- **18/20 警告**：账号接近 20 个 Key 时日志提示。
- **`scripts/try.ps1` 沙箱**：隔离 `HOME`/`APPDATA`/`LOCALAPPDATA`/`XDG_*`，在临时配置里 `plugin add` + `plugin`，不碰日常 magpie；复用已下载 Bun，不重复下载。

### 修复

- 模型目录现在同时包含聊天与图像模型；`provider.models` 在登录前 7 个、登录后按 live 清单（当前 6 个，U1.5 Fast 不在 live）。
- 测试更新：22 单测 + 11 端到端 + 3 烟测；新增按账号 Key 清理测试。

## [0.6.0] - 2026-10-29

### 新增

- **DeepSeek 实测输出上限**：`deepseek-flash` 393,216、`deepseek-v4-flash` 384,000（2026-10-29 实测 `max_tokens` 合法范围）；Kimi 因 429 未测，保持 65,536。
- `scripts/quota-total.mjs`：读 `magpie quota --json`，按窗口名合计 5 个账号的额度，取最早重置时间；不做页面。
- `scripts/key-gc.mjs`：Token Plan Key 清理，**默认 dry-run**，`--apply` 才删；保留最新 2 个 `magpie-*`，保护当前账号正在用的 Key，绝不碰手动创建的 `Key`。
- `scripts/check-shape.mjs`：不联网检查 config / provider.models / auth / loader / usage / refresh 形状；思路改编自 magpie-community/plugins（MIT）。
- `package.json` 增加 `check` / `test` 脚本。

### 文档

- README 补充输出上限的“实测合法范围”说明、Key 清理流程和三个脚本的用法。

## [0.5.0] - 2026-10-29

### 修复

- **仅 API Key 方法声明 `keyless: true`**：host 不再弹第二个标准 Key 输入框；备注写入 `metadata.email`，留空时用 Key 指纹，重登不会变成新账号。
- **稳定账号身份**：OAuth 返回 JWT `sub` 作为 `uid`；`accountId` 不再写死 `"SenseNova"`，避免 5 个账号被 `settle()` 当成同一个互相覆盖。
- **额度未知不再伪装成 0**：优先 `used`，其次 `limit - remaining`；两者都缺失时跳过窗口；负 `remaining` 允许 >100% 超支；活动积分的 `nearest_grant_expiry` / `nearest_grant_expiring_balance` 映射成钱包窗口的 `runsOutAt/runsOut`。
- **模型目录按账号分桶缓存**：A 账号的 `/models` 不再给 B 账号用 6 小时；同账号并发只发一次；失败保留上次成功清单；空清单 30 秒负缓存。
- **推理档位带实际参数**：Chat 发 `reasoningEffort`；Anthropic 发 `thinking/output_config`；Responses 只保留 `none`；每个模型有自己的 `efforts`。
- **浏览器登录返回 `url: ""` + `opened: true`**：避免 GUI 的 “Open again” 链接把 code 交给控制台 SPA。
- **403 不再标记为掉登录**：只有 401 标 `expired`；403/5xx 返回 `signIn: "kept"`。
- **续期校验 `access_token`**：响应缺 access_token 时明确失败，不保存空凭据。
- `rmdir` 路径加引号，避免用户名/临时目录含空格时清理失败。
- 新增/更新 21 个单测 + 10 个端到端测试；覆盖分账号缓存、used/remaining、负数超支、钱包窗口、keyless、403 kept。

## [0.4.2] - 2026-10-29

### 修复

- **自动建 Key 改走 Token Plan 的正确接口**：`POST https://platform.sensenova.cn/lite/console/v1/metered/api-keys`，body 带 `key_type: "API_KEY_TYPE_TOKEN_PLAN"`。之前用 IAM 的 `/iam/idp/v1/apiKeys` 创建的是通用/按量 Key（`type` 为空），对 `/v1/models` 返回 401。
- **等待新 Key 生效**：新 Key 在网关上生效通常需要 3–10 秒；`probeApiKey` 对 401/403 依次重试（0/1.5/3/4.5/6 秒，约 15 秒）。
- **失败自动清理**：校验仍失败时，按 `displayname` 找到刚创建的 Key 并删除，避免在账号里留垃圾。
- 新增 `deleteApiKey`；`listApiKeys` 支持 `pageSize`。
- README 更新接口、等待时间和排错说明。

## [0.4.1] - 2026-10-29

### 修复

- 浏览器启动时移除 `__COMPAT_LAYER` / `COMPAT_LAYER` / `CHROME_HEADLESS` / `ELECTRON_RUN_AS_NODE`，避免 Edge 在 magpie GUI 宿主里走 `--edge-skip-compat-layer-relaunch` 重启、丢失 `DevToolsActivePort`，窗口停在 `about:blank`。
- 调试端口启动失败时给出明确原因（管理员/兼容模式）和“仅 API Key”退路。

## [0.4.0] - 2026-10-28

### 修复

- **浏览器登录不再先问 API Key**：选择“浏览器登录”后直接打开受控浏览器，登录完成后再自动创建 API Key。
- **按 magpie 官方契约返回 `url` + `opened: true`**：插件自己打开了页面，magpie 不再重复打开；界面能正确显示“等待登录”。
- 登录成功后调用控制台 IAM 创建 `magpie-…` API Key，并用 `GET /v1/models` 校验；创建失败会明确提示改用“仅 API Key”。
- 自动创建前检查账号的 Key 数量，达到 20 个上限时直接给出可操作提示，不白创建。
- 新增 `listApiKeys` / `createApiKey` 协议函数；README 与安全说明同步。

## [0.3.0] - 2026-10-28

### 新增

- **`protocol` 选项**：`chat`（默认）/ `anthropic` / `responses`，在 `plugins.json` 的 `options` 里切换 wire API。
- 非 `chat` 协议自动隐藏 `deepseek-flash` 的视频输入能力（Anthropic / Responses 不支持视频），图片输入保留。
- README 增加协议选项、Responses 无状态限制、视频能力说明。

## [0.2.1] - 2026-10-28

### 新增

- **“仅 API Key”登录方式**：不打开浏览器、不访问额度端点，只校验并 DPAPI 密封 API Key；适合只用 OpenCode / 不关心额度的场景。
- 可选的账号备注（手机号 / 邮箱），用于区分多账号。
- `loader` / `provider.models` 同时兼容 oauth 记录（密封在 `apiKey`）与 api 记录（密封在 `key`）。
- 仅 API Key 的账号在额度卡片上显示说明，而不是静默空白。

## [0.2.0] - 2026-10-28

### 修复

- **模型目录以官网文档为准**：内置 5 个聊天模型；`/v1/models` 只覆盖上下文、输出上限、价格与描述。
- **移除不可用模型**：`sensenova-u1.5-lite`（图像生成）、`sensenova-u1.5-fast`（图像生成）不进入 Chat 目录；`deepseek-v4.1-flash`（实际 403）从目录过滤。
- **修正输出上限**：读取 `max_output_length`，不再把所有模型写成 32,768；GLM-5.2 为 131,072，其余为 65,536。
- **补齐多模态能力**：`deepseek-flash` 增加图片 + 视频（视频仅 Chat）；`kimi-k3` 增加图片；`sensenova-6.8-flash-lite` 保留图片。
- **推理档位**：模型暴露 `none / low / high / max` 四个 `reasoning_effort` 档位。
- **额度文案**：README 与测试从 60,000/600,000 更新为 120,000/1,200,000；插件仍以 `pool-usage` 返回值为准。
- **并发默认值**：`auth.maxConcurrency` / `magpie.maxConcurrency` 设为 1；provider 级别的设置仍可覆盖。

### 文档

- 新增 `CONTEXT.md`（领域术语表）与 `docs/BLUEPRINT.md`（路线图与已定决策）。
- README 增加协议说明（Chat 是唯一支持视频的协议）、429 边界、模型可用性说明。
- 新增 `LICENSE`、`.gitignore`、`NOTICE.md`。

### 安全

- README 明确：DPAPI 仅 Windows；macOS/Linux 当前明文；`pool-usage` 是控制台内部接口。
- 移除 README 中的个人路径。

## [0.1.0] - 2026-10-15

### 初始版本

- SenseNova Token Plan 模型（OpenAI 兼容 / Chat Completions）。
- 浏览器 PKCE 登录，截停授权回跳，早于官方 SPA 消费 code。
- 控制台积分池映射成 magpie 的 5 小时 / 周窗口。
- Windows DPAPI 密封 refresh/access/API Key。
- 离线单测、端到端签入测试、浏览器截停留烟测。
