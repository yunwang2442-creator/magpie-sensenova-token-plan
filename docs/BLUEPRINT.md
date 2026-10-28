# magpie-sensenova 蓝图

> 状态：v0.7.0 已完成（私有仓库）：P0/P1 审计修复 + 图像生成模型 + 额度合计 / Key 清理 / 形状自检脚本；自动 Key 生命周期与发布物料仍待做。

## 0. 当前进度（v0.7.0）

- **已完成**：模型目录（聊天 + 图像）、额度语义、按账号模型缓存、协议 variants、稳定账号身份、keyless、浏览器登录 `url:""`、403 kept、Key 清理脚本、额度合计脚本、形状自检。
- **现在能做**：`try.ps1` 沙箱、自动 Key prune（需先决定是否开启）、host-scoped Key 名、18/20 警告。
- **上游阻塞**：自定义额度页——`PageReads` 只有 `usage:summary` / `providers:list`，没有 `usage:quotas`；跨账号合计先用 `scripts/quota-total.mjs`。
- **发布前**：`private`/`files`/NOTICE/第三方署名、英文 README、CI、npm/topic。

## 1. 一句话目标

把「本地自用插件」升级为「按可发布标准维护的私有插件」：模型目录准确、额度显示可信、登录不折腾、429 的边界说清楚，并且随时可以一步公开。

## 2. 已定决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **私有优先，公开就绪**：私有仓库 + 本地安装，按发布标准维护 | 拿到标准化收益，不背公开支持负担；想公开时加 topic/npm 即可 |
| D2 | **保持 Chat Completions**，现在就修多模态目录 | Chat 是唯一支持视频的协议；目录修正不改传输层 |
| D3 | **Projects 为唯一源**，workspace 备份后删除 | 两份源码一致；magpie 现在已指向 Projects |
| D4 | **429 不在插件内重试** | 上游 TPM/RPM 限制；插件重试会阻塞 magpie 的换号 |
| D5 | **provider id 保持 `sensenova`** | 保住现有 5 个账号，不用重登 |
| D6 | **插件只写 `maxConcurrency` 默认值** | `maxRPM` 是 magpie 的 provider 设置，不是插件字段 |

## 3. 目标状态

```
现在                                   v1.0 目标
本地文件夹 + 手动加插件          →    私有仓库 + 本地安装（公开时加 topic/npm）
API Key 粘贴 + 浏览器登录        →     保留；后续加“仅 API Key”和可选自动建 Key
7 个模型（2 个实际不可用）       →     5 个聊天模型 + 2 个图像模型（明确不接 chat）
4 窗口 × 5 账号                   →     同上（额度准确；聚合页另做）
Windows DPAPI                     →     DPAPI + macOS Keychain（v1.1）
429 靠换账号                      →     已知边界 + 降 RPM + 推荐路由组
```

## 4. 模型目录（以官网文档为准）

| 官网名称 | Model ID | Chat | 输入 | 输出 | 上下文 | 最大输出 | 备注 |
|---|---|---|---|---|---|---|---|
| SenseNova 6.8 Flash Lite | `sensenova-6.8-flash-lite` | ✅ | 文本、图片 | 文本 | 262,144 | 65,536 | 轻量多模态 |
| SenseNova U1.5 Lite | `sensenova-u1.5-lite` | ❌ / Drawer ✅ | 文本、参考图 | 图片 | 262,144 | 65,536 | 图像生成/编辑，magpie Drawers 走 `/v1/images/*` |
| SenseNova U1.5 Fast | `sensenova-u1.5-fast` | ❌ / Drawer ✅ | 文本、参考图 | 图片 | 262,144 | 65,536 | 图像生成加速版 |
| DeepSeek V4 Flash | `deepseek-v4-flash` | ✅ | 文本 | 文本 | 1,048,576 | 65,536 | V4 Flash 0731 |
| DeepSeek V4.1 Flash | `deepseek-flash` | ✅ | 文本、图片、视频（仅 Chat） | 文本 | 1,048,576 | 65,536 | V4.1 Flash 1017；你启用的就是这个 |
| GLM-5.2 | `glm-5.2` | ✅ | 文本 | 文本 | 1,048,576 | 131,072 | 长程 Coding |
| Kimi K3 | `kimi-k3` | ✅ | 文本、图片 | 文本 | 1,048,576 | 65,536 | 429 重灾区 |

**不进入 chat 目录的**：`sensenova-u1.5-lite`、`sensenova-u1.5-fast`（图像输出，但会出现在 magpie 的 Image generation 选择器），`deepseek-v4.1-flash`（`/models` 杂项，实际 403）。

## 5. 额度口径

| 积分池 | 5 小时 | 周窗口 | 来源 |
|---|---|---|---|
| 通用积分池 | 120,000 | 1,200,000 | 官网 + `pool-usage` 一致 |
| Flash-Lite 专属池 | 官网写 60,000；本机接口返回 120,000 | 官网写 600,000；本机接口返回 1,200,000 | **以接口为准** |

结论：插件不写死额度，只展示 `pool-usage` 返回的 `limit` / `remaining` / `reset_at`。

## 6. 阶段

### P0 基线（已完成）

- `CONTEXT.md`、`docs/BLUEPRINT.md`、`LICENSE`、`.gitignore`、`CHANGELOG.md`
- `git init` + 首次提交；v0.1.0 的原始状态保留在 `workspace/_backup` 的 zip 里
- 出口：`bun test/unit.test.mjs` 全绿；无个人信息

### P1 正确性 → v0.2.0（已完成）

- 模型目录：读 `max_output_length` / `supported_features` / `created` / `description`；补 5 个聊天模型；排除图像模型；删 `deepseek-v4.1-flash`
- 多模态：`deepseek-flash` 加图片 + 视频；`kimi-k3` 加图片；`sensenova-6.8-flash-lite` 保留图片
- 输出上限：65,536 / GLM-5.2 131,072
- 额度：README/测试改成 120,000/1,200,000；保留动态读取
- 429：`auth.maxConcurrency: 1` 默认；README 写清上游限制；给 Kimi → DeepSeek 路由组示例
- 出口：5 个账号真实登录 + `magpie quota` 正确；`provider models` 只列 5 个聊天模型

### P2 体验 → v0.3.0（已完成大部分）

- [x] 新增 `api` 方法（只粘贴 Key，不读额度；Key 同样 DPAPI 密封）
- [x] `protocol` 选项：`chat`（默认）/ `anthropic` / `responses`
- [x] “一键登录自动建 Key”：浏览器登录 → `POST /lite/console/v1/metered/api-keys`（`key_type=API_KEY_TYPE_TOKEN_PLAN`，key 名以 magpie- 开头）→ 等待 3–10 秒生效 → `GET /v1/models` 校验
- [ ] 中英双语提示与 README
- 出口：新账号 30 秒内完成登录；老账号不受影响

### P3 发布 → v1.0.0

- 私有仓库；想公开时加 `magpie-plugin` topic + npm `magpie-sensenova-token-plan`
- CI（bun test）、release notes、截图
- 出口：干净机器 `magpie plugin add <路径或 npm>` 可用

### P4 平台（后续）

- macOS Keychain
- 按账号学习不可用模型（403 / `insufficient_quota` 后隐藏）
- 多账号额度聚合页，或把 `upstream-issue-draft.md` 提交给 magpie

## 7. 429 的边界

- 典型错误：`RateLimitExceeded.EndpointTPMExceeded`、`ModelAccountRpmRateLimitExceeded`、`Throttling.BurstRate`、`insufficient_quota`。
- 5 个账号同时 429 说明是**模型/端点级**限制，不是账号轮换能解决的。
- 插件侧只做：`maxConcurrency` 默认 1、README 说明、路由组示例。
- 用户侧可调：provider 的 `maxConcurrency` / `maxRPM`、模型选择、时段。
- 推荐路由组：`kimi-k3 → deepseek-flash`（或 `deepseek-v4-flash`）。

## 8. 非目标

- 不重写 magpie 的 Draws 逻辑：插件只把 U1.5 列进目录，`/v1/images/generations` 和 `/v1/images/edits` 的转发交给 magpie。
- 不做多账号额度合并显示（magpie 的限制；留给上游或后续页面）。
- 不进 `magpie-community/registry`（除非以后决定公开并接受社区维护）。
- 不在插件内做 429 重试或自定义路由策略。

## 9. 发布前检查清单

- [ ] `bun test/unit.test.mjs` / `bun test/signin-flow.test.mjs` / `bun test/smoke-capture.mjs` 全绿
- [ ] `git grep -n "C:\\\\Users\\\\|@gmail|@qq|sk-[A-Za-z0-9]"` 无个人信息
- [ ] README 无个人路径；额度表与接口一致
- [ ] `package.json` 的 `private` 按“私有/公开”状态决定
- [ ] LICENSE、CHANGELOG、`.gitignore` 齐全
- [ ] 5 个账号 `magpie quota` 显示正确
- [ ] 只列 5 个聊天模型；图像模型不出现在 chat 目录
- [ ] `auth.maxConcurrency` 生效
- [ ] 公开时：`magpie-plugin` topic + npm 包名不冲突
