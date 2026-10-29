# magpie-sensenova

SenseNova（商量 / 日日新）Token Plan 的 magpie 供应商插件：**模型调用 + 控制台积分额度，一次浏览器登录全拿到**。

> 当前状态：私有维护、按发布标准整理。没有发布到 npm，也没有挂 GitHub topic；安装方式是把本文件夹交给 magpie。

## 它解决什么

商汤把两件事放在了两个地方：

| | 在哪里 | 用什么凭据 |
|---|---|---|
| 模型调用 | `https://token.sensenova.cn/v1`（OpenAI 兼容 / Chat Completions） | 控制台的 **API Key** |
| 积分额度 | `https://platform.sensenova.cn/…/tokenplan/pool-usage` | 控制台 **OAuth 登录令牌**（API Key 读不到额度） |

所以登录时要两样东西：**API Key（粘贴）+ 控制台登录（浏览器点一下）**。

## 协议：我们用的是 Chat Completions

插件用 `@ai-sdk/openai-compatible`，请求打到 `POST /v1/chat/completions`。这也是官网三种协议里**唯一支持视频输入**的：

| 协议 | 端点 | 视频 | 适用 |
|---|---|---|---|
| **Chat Completions（本插件）** | `/v1/chat/completions` | ✅ | 通用；DeepSeek V4.1 Flash 的视频只在这里可用 |
| Anthropic Messages | `/v1/messages` | ❌ | Claude Code 等 Anthropic 生态 |
| Responses | `/v1/responses` | ❌ | Codex 等 Responses 生态；无状态 |

如果以后要接 Claude Code / Codex 的原生协议，可以加 `protocol` 选项；但切到那两种协议后**视频输入不可用**。

### 协议选项

默认 `chat`。需要原生协议时，在 `plugins.json` 的 `options` 里设置：

```json
{ "protocol": "anthropic" }
```

或 `"responses"`。非 `chat` 协议下，插件会自动从 `deepseek-flash` 的输入能力里移除 `video`；图片输入仍然保留（Anthropic / Responses 都支持图片）。Responses 是无状态兼容，不支持 `previous_response_id`、内置工具和 `input_file`。

## 模型清单

内置目录以[官网文档](https://platform.sensenova.cn/docs)为准；`GET /v1/models` 只用来覆盖上下文、输出上限、价格和描述。两者冲突时：**能力看文档，上限看接口**。

| 官网名称 | Model ID | Chat | 输入 | 输出 | 上下文 | 最大输出 |
|---|---|---|---|---|---|---|
| SenseNova 6.8 Flash Lite | `sensenova-6.8-flash-lite` | ✅ | 文本、图片 | 文本 | 262,144 | 65,536 |
| DeepSeek V4 Flash | `deepseek-v4-flash` | ✅ | 文本 | 文本 | 1,048,576 | 384,000 |
| DeepSeek V4.1 Flash | `deepseek-flash` | ✅ | 文本、图片、视频（仅 Chat） | 文本 | 1,048,576 | 393,216 |
| GLM-5.2 | `glm-5.2` | ✅ | 文本 | 文本 | 1,048,576 | 131,072 |
| Kimi K3 | `kimi-k3` | ✅ | 文本、图片 | 文本 | 1,048,576 | 65,536 |

**图像生成模型**：

- `sensenova-u1.5-lite` / `sensenova-u1.5-fast`：不进入 Chat 目录，但会出现在 magpie 的 **Settings → Models → Image generation** 里；走 `/v1/images/generations` 和 `/v1/images/edits`，由 magpie 的 Drawers 自动处理和转发，插件只提供 Key/base。
- `deepseek-v4.1-flash`：`/v1/models` 会返回这个 id，但实际请求返回 403（`model is not available in the current token plan`），已从目录过滤。

> `deepseek-flash` 就是 DeepSeek V4.1 Flash 1017 版；不要被 id 里的 “flash” 误导。

> 输出上限：DeepSeek 两个模型用 **实测的 `max_tokens` 合法上界**（2026-10-29：`should be in [1, 393216]` / `[1, 384000]`），不是 `/models` 的 65,536；Kimi 因 429 未测，保持 65,536。这里说的是“请求能开到多大”，不是“模型一定生成这么长”。

**推理档位**：Chat 发 `reasoningEffort`；Anthropic 发 `thinking` + `output_config.effort`；Responses 只保留 `none`（该兼容端点忽略其他档位）。`sensenova-6.8-flash-lite` 额外有 `medium`，其余模型是 `none/low/high/max`。

### 图像生成

在 **Settings → Models → Image generation** 选 `sensenova/sensenova-u1.5-lite`（或 `u1.5-fast`），然后走 `/v1/images/generations` 或 `/v1/images/edits`。magpie 会自动把编辑请求转成 SenseNova 要的 JSON `images:[{image_url:"data:..."}]`，并在生成时请求 `b64_json`；插件不需要单独的图像代码。

## 安装

```bash
# GUI：magpie → 插件 → 添加插件 → 填这个文件夹的路径
# 或 CLI：
magpie plugin add "<path-to-this-folder>"
```

> ⚠️ **不要和 `aqiu817/magpie-sensenova`、`itgo067/magpie-plugin-sensenova` 同时启用**：三者都声明 provider id `sensenova`。magpie 会让其中一个服务该 provider；要换用本插件，先在插件页把另一个删掉，或用 `magpie plugin use` 指定。

## 使用

供应商列表里点 **SenseNova → 登录**，有两种方式：

### 方式一：浏览器登录（额度 + 模型，自动创建 API Key）

1. 选择后**直接弹出**一个一次性浏览器窗口——不再先问 API Key；
2. 在里面正常登录（密码 / 短信验证码都可以）；
3. 登录成功后，插件用控制台令牌自动创建一个以 `magpie-` 开头的 **Token Plan API Key**，等它生效（通常 3–10 秒）并校验，然后关闭窗口；账号出现在列表里，额度随即显示。

> 这个一次性窗口是**唯一入口**：插件返回 `url` 为空 + `opened: true`，magpie 不会再给 “Open again” 链接。不要再用别的浏览器打开授权页——code 会被控制台 SPA 消费，受控窗口反而拿不到。

> 每个账号最多 20 个 API Key。自动创建会新增一个；如果已到上限，插件会提示你先去控制台删除一个，或改用“仅 API Key”方式。重新登录也会新增一个 Key；想复用已有 Key 就用方式二。

### 方式二：仅 API Key（模型可用，不读额度）

1. 粘贴 **Token Plan API Key**（只会问一次：方法声明了 `keyless`，host 不会再弹第二个标准 Key 框）；
2. 可选填一个账号备注（手机号 / 邮箱），用来区分多账号；留空时用 Key 指纹，重登不会变成新账号；
3. 保存后模型立即可用，但账号卡片不会显示额度——因为没有控制台令牌。

这条路径适合：只用 OpenCode / 不关心额度、或者控制台 OAuth 临时不可用时先保证模型能跑。Key 同样在落盘前经 DPAPI 密封；额度端点不会被访问。

多账号：再点一次“添加账号”，用另一个账号重走一遍即可。

## 额度

控制台两个积分池被映射成 magpie 的窗口：

| 控制台 | magpie 窗口 | 说明 |
|---|---|---|
| 通用积分池 · 5 小时 | span 18000s | 当前 120,000 分 / 滚动 5 小时 |
| 通用积分池 · 周 | span 604800s | 当前 1,200,000 分 / 滚动 7 天 |
| Flash-Lite 积分池 · 5 小时 / 周 | 同上，且限定 `flash-lite` 模型 | 官网写 60,000 / 600,000；本机接口可能返回 120,000 / 1,200,000 |
| 活动积分（`grant_balance`） | `balance` + 钱包窗口 | 带到期时间的那部分赠送积分；有 `nearest_grant_expiry` 时额外给 `runsOutAt/runsOut` |

**额度不写死**：插件只显示 `pool-usage` 返回的 `limit` / `used` / `remaining` / `reset_at`。优先用 `used`，缺失时用 `limit - remaining`；两者都没有就**跳过该窗口**，不伪造 0（否则会被误读成 100% 已用）。官网文档和接口可能不一致（尤其是 Flash-Lite 专属池），以你的账号接口为准。

额度读取有 60 秒缓存（magpie 会频繁刷新额度行，不必每次都打接口）。

### Key 清理

浏览器登录每次都会新建一个 `magpie-*` Key；账号上限是 20 个。用：

```bash
bun scripts/key-gc.mjs          # 预览，不删
bun scripts/key-gc.mjs --apply  # 删除旧的 magpie-*，保留最新 2 个
```

脚本只删 `magpie-*`，永远保护当前账号正在用的 Key，也不会碰你手动创建的 `Key`。**默认 dry-run**；多机器使用同一账号时先看清单再 `--apply`。

想让它自动跑：在 provider 设置页打开 **“自动清理旧 magpie API Key”**（`auth.options` 的 `prune_old_keys`，默认关闭）。打开后浏览器登录成功会保留最新 2 个同机器 `magpie-*`；手动 `Key` 不动。旧版本留下的无机器前缀的 Key 仍用上面的脚本清。

## 429：先看边界

公测期的 TPM/RPM 很紧，常见错误：

| 错误 | 含义 |
|---|---|
| `RateLimitExceeded.EndpointTPMExceeded` | 模型/端点的每分钟 token 超限 |
| `ModelAccountRpmRateLimitExceeded` | 该账号对该模型的每分钟请求超限 |
| `Throttling.BurstRate` | 瞬时突发被限 |
| `insufficient_quota` | 该账号/套餐不能用这个模型（**不一定是积分用完**） |

排查顺序：

1. **看是不是同一个模型**：Kimi K3、GLM-5.2 在高峰期最容易 429；DeepSeek Flash 相对稳。
2. **看是不是 5 个账号同时 429**：如果是，说明是模型/端点级限制，换账号没用。
3. **降 provider 的 `maxRPM`**：例如 Kimi 设为 3；`maxConcurrency` 保持 1。
4. **加一个路由组**：让 Kimi 失败后落到 DeepSeek：

```bash
magpie group add coding models=sensenova/kimi-k3,sensenova/deepseek-flash
```

`models=` 的顺序就是尝试顺序；routing 用你惯用的策略（`magpie group --help` 里有 `routing=` 的说明）。核心是“同 provider 内按模型降级”，不是把插件改成自动重试。

插件**不会**在内部重试 429：那会阻塞 magpie 的换号/换模型。插件只提供 `auth.maxConcurrency: 1` 这个安全默认值；`maxRPM` 是 magpie 的 provider 设置，请在 provider 里改。

## 凭据与安全

- **不存账号密码**。浏览器登录是你和商汤之间的直连，插件不接触密码。
- **浏览器登录会在你的账号里创建一个 API Key**（名字以 `magpie-` 开头），只用来给 magpie 发模型请求；创建后立即用 `GET /v1/models` 校验，失败会明确报错。不想让它创建 Key，就用“仅 API Key”方式。
- `refresh_token` / `access_token` / API Key 落盘前经 **Windows DPAPI**（`CryptProtectData`）密封，形状是 `dpapi:<base64>`：
  - 只有**当前 Windows 用户**能解开；拷走 `plugin-auth.json` 到别的机器/用户都解不开；
  - 换机器或换 Windows 用户后，账号需要重新登录一次（这是特性，不是 bug）。
- 登录用的一次性浏览器实例：独立临时 profile（`%TEMP%` 下），与日常浏览器完全隔离，收尾时整个目录删除。浏览器自身的后台联网也关了（`--disable-background-networking` / `--disable-component-update` / `--disable-sync` / `--disable-default-apps` / `--no-service-autorun` / `--disable-breakpad` / `--no-pings`）。
- 插件当前只与两个厂商域名通信：
  - `platform.sensenova.cn`：授权、令牌、额度；
  - `token.sensenova.cn`：模型。
  自动建 Key 走 `platform.sensenova.cn/lite/console/v1/metered/api-keys`，仍是同一个厂商域名。没有统计、没有遥测、没有第三方地址；日志不打印令牌（只打状态码与厂商给的错误描述）。
- **非 Windows 平台（未适配）**：DPAPI 不存在，凭据会**明文落盘**。目标平台目前是 Windows；macOS Keychain 在路线图里。
- 日志只出现在 magpie 自己的日志里，不写文件、不打印令牌。
- 额度端点 `pool-usage` 是控制台前端自用的、未公开的接口；平台改版可能让它失效，也可能触发风控。模型调用不受影响。
- 本插件与商汤无隶属关系；使用前请自行确认平台条款。

## 自动化行为

- **续期**：到期前 15 分钟，magpie 调插件的 `refresh` 静默换新令牌；`refresh_token` 被吊销时标记账号“需要重新登录”，不会静默失败。
- **模型清单**：内置目录 + 活的 `GET /models`（缓存 6 小时）；拉不到时回退到内置清单，并标记 `fellBack`。
- **并发**：`auth.maxConcurrency: 1`；provider 级别的设置会覆盖它。

## 自测

```bash
cd "<path-to-this-folder>"

bun test/unit.test.mjs          # 离线单测：PKCE / 授权URL / 额度映射 / 模型 / DPAPI / 入口解析
bun test/signin-flow.test.mjs   # 端到端签入（打桩浏览器与网络）：账号记录形状 + 四个钩子的请求
bun test/smoke-capture.mjs      # 浏览器截停留烟测：本地回环复刻"授权→302→回调"，不联网
SMOKE_HEADFUL=1 bun test/smoke-capture.mjs   # 同上，但用可见窗口跑（会闪一下）

bun scripts/login-test.mjs                # 真实登录自测（弹窗，不经过 magpie）
bun scripts/login-test.mjs sk-你的APIKey  # 顺带列出 Token Plan 现有模型

bun scripts/check-shape.mjs               # 不联网：检查 config/provider.models/auth/loader/usage/refresh 形状
bun scripts/protocol-test.mjs             # 真实账号各发一个 max_tokens=1：Chat / Anthropic / Responses
bun scripts/protocol-test.mjs --account 3 --protocol anthropic
bun scripts/quota-total.mjs               # 5 个账号按窗口合计（调用 magpie quota --json）
bun scripts/quota-total.mjs --json        # 机器可读
bun scripts/key-gc.mjs                    # Key 清理预览（默认不删）
bun scripts/key-gc.mjs --apply            # 真删：保留最新 2 个 magpie-*，保护当前 Key

pwsh -File scripts/try.ps1                 # Windows 沙箱：隔离配置加载插件，不碰日常 magpie
pwsh -File scripts/try.ps1 -Clean          # 同上，结束删除沙箱
```

## 排错

| 现象 | 原因 / 办法 |
|---|---|
| "没有找到 Microsoft Edge 或 Chrome" | 装 Edge，或设 `MAGPIE_SENSENOVA_BROWSER=C:\path\to\msedge.exe`，或在插件 options 里写 `"browser": "…"` |
| 登录窗口不弹 | 看 magpie 日志里 `[sensenova]` 开头的行（`client.app.log`） |
| 浏览器里登录完成但 magpie 说超时 | 登录预算 8 分钟（可 `options.loginTimeoutMs` 调大）；中途关窗会立即失败 |
| 登录成功但提示自动创建 API Key 失败 | 账号可能已有 20 个 Key；去控制台删一个，或改用“仅 API Key”。错误里会带控制台的原始说明 |
| 自动创建的 Key 没通过校验 | 新 Key 通常要 3–10 秒生效，插件会自动重试；超过约 15 秒仍 401 才会失败。失败时插件会尝试删掉这个 Key，也可以去控制台手动删 |
| "API Key 被拒绝" | 粘贴不完整，或这个 Key 不属于 Token Plan；控制台重新生成 |
| 额度显示"控制台会话已失效" | 令牌被平台吊销——重新登录一次 |
| 换电脑后账号报解密失败 | DPAPI 按用户/机器绑定，重新登录即可 |
| 某个模型 403 / `insufficient_quota` | 该账号/套餐不能用这个模型；换个模型或换个账号，不等于额度用完 |
| 429 | 看上面的“429：先看边界”；先降 RPM、换模型，再考虑换号 |
| 额度行始终空白 | `GET pool-usage` 结构变了：跑 `bun scripts/login-test.mjs` 看原始报错 |

## 选项（`plugins.json` 里该插件的 `options`）

```json
{
  "baseURL": "https://token.sensenova.cn/v1",
  "protocol": "chat",
  "browser": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "quotaTtlMs": 60000,
  "loginTimeoutMs": 480000
}
```

## 结构

```
index.mjs              插件入口（只导出一个函数，magpie/OpenCode 都接受）
lib/protocol.mjs       协议常量与请求（PKCE 参数、请求头、换码/续期/额度）
lib/pkce.mjs           PKCE 码对与 state
lib/browser.mjs        受控浏览器登录（CDP Fetch 截停回跳导航）
lib/dpapi.mjs          Windows DPAPI 密封/解开（bun:ffi）
lib/quota.mjs          额度响应 → magpie 窗口映射
lib/models.mjs         模型目录：官网骨架 + 活的 /models 覆盖
scripts/login-test.mjs 独立登录自测
scripts/check-shape.mjs 不联网的 hook 形状自检
scripts/protocol-test.mjs 三协议真实烟测
scripts/quota-total.mjs 多账号额度合计
scripts/key-gc.mjs      Token Plan Key 清理（默认 dry-run）
scripts/try.ps1         Windows 沙箱加载插件
test/unit.test.mjs     离线单测
test/signin-flow.test.mjs  端到端签入（打桩浏览器与网络）
test/smoke-capture.mjs 浏览器截停留烟测（本地回环，不联网）
CONTEXT.md             领域术语表
docs/BLUEPRINT.md      路线图与已定决策
```

## 已知的坑（改代码前先看）

- `lib/dpapi.mjs`：DPAPI 的输出必须**先拷贝再 `LocalFree`**（`toArrayBuffer` 返回视图，小密文侥幸看不出来，大密文头部会被堆元数据改写）。
- `lib/browser.mjs`：收尾时**不**调 `WebSocket.close()`、**不**用 Bun 的 `rmSync` 删目录——Bun 1.3.1 在这两处与 CDP 会话收尾叠加时会偶发原生崩溃（插件宿主是长驻进程，崩了会连累 magpie）。
- `lib/models.mjs`：不要退回“`/v1/models` 是唯一真相”。它会漏 `deepseek-flash` 的图片/视频、漏 `kimi-k3` 的视觉，还会多出 403 的 `deepseek-v4.1-flash`。

## License

MIT。见 [LICENSE](./LICENSE)。
