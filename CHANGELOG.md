# Changelog

所有重要变更都记在这里。版本号遵循语义化版本。

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
