# magpie-sensenova

一个 magpie 供应商插件：把 SenseNova（商量 / 日日新）Token Plan 的模型调用与控制台积分额度放进同一个供应商里。它存在的原因是平台把这两件事放在了两套凭据后面：模型用 API Key，额度用控制台 OAuth 令牌。

## Language

### 供应商与账号

**Provider（供应商）**:
magpie 里的一个模型来源，id 固定为 `sensenova`。它由一个插件声明，可以挂多个账号。
_Avoid_: 提供商、渠道、channel

**Account（账号）**:
一个 SenseNova 账号。每个账号有自己的控制台登录、积分池和模型可用性；同一个账号下的多个 API Key 共享同一份额度。
_Avoid_: 账户、用户、user

**API Key**:
模型调用凭据，形如 `sk-…`，在控制台创建。它只能调用模型，读不到积分额度。
_Avoid_: 密钥、token（单独使用时）

**Console Token（控制台令牌）**:
控制台 OAuth 登录得到的 access/refresh token，用来读积分额度和账号信息。它不能代替 API Key 调用模型。
_Avoid_: 登录态、cookie、session

**Account Scope（账号作用域）**:
magpie 调用插件时限定在某个账号内的上下文；`getAuth()` 和 `client.auth.set` 都只作用于这个账号。
_Avoid_: 全局状态、当前用户

### 额度

**Credit（积分）**:
SenseNova Token Plan 的计量单位。不同模型按不同倍率扣积分。
_Avoid_: 点数、token、额度（作为单位时）

**Allowance（额度）**:
某个积分池在一个窗口内允许使用的积分上限。
_Avoid_: 余额、quota（作为上限时）

**Pool（积分池）**:
额度的分组。通用积分池覆盖大多数模型；Flash-Lite 专属积分池只覆盖 Flash-Lite 系列。
_Avoid_: 池子、bucket

**Window（窗口）**:
额度的滚动计时范围。当前有 5 小时窗口和周窗口两层；窗口从首次使用开始滚动，不是自然日重置。
_Avoid_: 周期、重置时间

**Usage（用量）**:
某个账号在某个窗口内已经消耗的积分，以及重置时间。插件把它映射成 magpie 的额度行。
_Avoid_: 余额、账单

**Plan（套餐）**:
账号当前所属的订阅档位；公测期是 `Free Plan`。
_Avoid_: 订阅、tier

### 模型与协议

**Model ID**:
厂商 API 接受的模型标识，例如 `deepseek-flash`。它不等同于营销名称：`deepseek-flash` 的实际模型是 DeepSeek V4.1 Flash 1017 版。
_Avoid_: 模型名、model name

**Chat Completions**:
OpenAI 风格的 `/v1/chat/completions` 协议。本插件默认使用它，也是三种协议中唯一支持视频输入的。
_Avoid_: OpenAI 协议、chat 模式

**Anthropic Messages**:
Anthropic 风格的 `/v1/messages` 协议，面向 Claude Code 等工具；不支持视频输入。
_Avoid_: Claude 协议、messages 模式

**Responses**:
OpenAI Responses 风格的 `/v1/responses` 协议，面向 Codex 等工具；无状态、不支持视频和 `input_file`。
_Avoid_: Responses API、Codex 协议

**Fallback Catalog（兜底清单）**:
登录前或实时模型列表拉取失败时使用的内置模型清单。它必须来自官方文档，而不是 `/v1/models` 的偶然返回。
_Avoid_: 默认模型、静态列表

### 故障

**429**:
厂商返回的限流错误，通常是按模型/账号的 TPM 或 RPM 超限。它不是插件并发 bug，换账号也不一定有用。
_Avoid_: 插件错误、配额用完

**Model Not Available（模型不可用）**:
厂商返回 403（`model is not available in the current token plan`）或 429（`insufficient_quota`）表示该账号/套餐不能用这个模型，不等于积分池耗尽。
_Avoid_: 余额不足、额度用完
