# Changelog

所有重要变更都记在这里。版本号遵循语义化版本。

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
