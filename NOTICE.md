# NOTICE

- 本项目是第三方本地客户端，**与商汤科技（SenseTime）无隶属关系**，也不代表商汤官方立场。
- “SenseNova / 商量 / 日日新”是商汤科技的商标；本插件仅用于识别所接入的服务。
- 插件的 provider 契约、额度字段与登录流程参考了 magpie（MIT，yetone/magpie）及 magpie-community 插件的公开实现；当前版本未复制其源码。
- `scripts/check-shape.mjs` 的思路改编自 magpie-community/plugins 的 `scripts/check.mjs`（MIT，Copyright (c) 2026 magpie-community contributors）。
- 模型与额度来自 SenseNova Token Plan。`pool-usage` 是控制台前端自用的、未公开的接口；平台改版、限流或条款变化都可能影响它。插件不绕过任何平台限制。
- 本插件不存储账号密码。浏览器登录由用户与商汤直接完成；插件只保存 OAuth 令牌与 API Key，并在 Windows 上用 DPAPI 密封。
- 非 Windows 平台当前没有等价的安全存储，凭据会明文落盘；在补齐 macOS Keychain 之前，不建议在非 Windows 机器上使用。
- 插件运行在 magpie 的插件宿主里，拥有该进程的文件与网络权限；请只安装你信任的插件。
