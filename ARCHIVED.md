# 已归档（Archived）

**归档日期：2026-11-05**

这个私有插件已经被官方包取代，不再维护、不再发布、不再用于新安装。

## 被什么取代

- 官方包：`@magpie-community/opencode-sensenova-auth` **0.2.0**
- 来源：本仓库的改进已通过 PR [magpie-community/plugins#730](https://github.com/magpie-community/plugins/pull/730) 合并
  （squash commit `6a0d9e5`，2026-11-04）
- 官方 provider id：**`sensenova-token-plan`**
- 本仓库 provider id：`sensenova`（两者可以并存，凭据互不影响）

## 迁移记录

本机 magpie 已完成迁移：

| 项目 | 迁移前 | 迁移后 |
|---|---|---|
| 插件 | 本仓库（本地路径） | `@magpie-community/opencode-sensenova-auth` |
| provider | `sensenova` | `sensenova-token-plan` |
| 路由组 / 模型选择 / 使用顺序 | `sensenova/...` | `sensenova-token-plan/...` |

配置备份在：`~/.config/magpie/auto-backups/migration-sensenova-<时间戳>/`

## 和官方版的唯一功能差异

本仓库有 **`balanced` 网关路由**（`gateway.mjs`），官方版没有。原因是上游 `check.mjs`
会跳过声明了 `magpie.gateway` / `middleware` 的包，当时无法随 PR 一起提交。如果以后仍然
需要它，应当作为独立的 middleware 包另行提交，而不是恢复本仓库。

## 保留原因

- 历史参考：0.2.0 的代码、测试和设计过程都在这里
- 后备：如果官方包因平台接口变化而失效，可以对照本仓库修复
- **不要**再把它装回 magpie，除非官方包出现无法及时修复的问题

## 许可证

MIT（见 [LICENSE](LICENSE)）。
