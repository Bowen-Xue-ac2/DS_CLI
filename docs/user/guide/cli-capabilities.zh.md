---
description: "终端发行包、固定的 Host 版本和可用能力的验收入口。"
kind: "reference"
---

# 终端能力

[English](cli-capabilities.md) | 中文

终端使用由 `apps/cli/runtime/pnpm-lock.yaml` 安装的官方 DSH `0.2.2-rc.5` Host。用 `dsh --build-info` 查看 CLI 版本、构建对应的源码提交及已安装 Host 版本。交互启动保留调用工作目录，并从安装包定位 Host。Host 数据存于 `DSH_HOME` 下的 `ds-cli-host-0.2`。

| 能力 | 验收入口 |
|---|---|
| 工作区、会话、模型和 Agent 预设、Skills、权限目录 | [Host 验收测试](../../../apps/cli/tests/terminal-host.e2e.ts)查询固定版本的真实 Host。 |
| 启动、终端参数、活动目录和首个工具 | 在 Windows 运行[双 Shell 验收](../../../apps/cli/tests/terminal-shells.e2e.ts)。将 `DS_CLI_TEST_INSTALL_DIR` 指向临时 npm 安装根目录，使用安装包生成的入口。 |
| 会话继续、后台 Host | `/sessions`、`dsh host status`、`dsh host stop`。[后台测试](../../../apps/cli/tests/terminal-background.e2e.ts)覆盖 PowerShell 与 Git Bash 的关窗、重连和停机。 |
| 文件引用、Skill、Agent 与审批 | `@`、`$`、`@agent:`、`/agents`、`/team`。工具执行和审批以 [时间线](../../../apps/cli/tests/terminal-activity.e2e.ts) 与 [委派测试](../../../apps/cli/tests/terminal-delegation.e2e.ts) 的 Host 回执为准。 |
| 插件与 MCP | `/plugins`、`@plugin:`、`/mcp`、`@connector:`。[插件测试](../../../apps/cli/tests/terminal-plugins.e2e.ts)使用本地包，[MCP 测试](../../../apps/cli/tests/terminal-connectors.e2e.ts)使用 stdio 与回环 HTTP 夹具。第三方服务按提供方流程配置凭据。 |
| 文件、附件、轮次改动、导出 | `/files`、`/attach`、`/diff`、`/export`。[文件验收](../../../apps/cli/tests/terminal-assets.e2e.ts)覆盖中文和空格路径、原生图片、Git index 及 Markdown。 |
| Job、定时任务、持久 Shell | `/jobs`、`/schedule`、`/terminal`。按 Host 回执读取退出状态、字节偏移和投递记录。[自动化验收](../../../apps/cli/tests/terminal-automation.e2e.ts)使用同一 Host 的真实服务。 |
| 富文档与官方可选组合 | `/browser` 或 `dsh host open --session <id>` 进入同一 Host。通过 **插件** 菜单查看 Git Worktree、Forge、审阅、LiveShare、Office、Computer Use、外部 Agent 等组合。可用性取决于 Host 的组合、平台、安装及账号条件。 |
| 独立运行入口 | 使用显式的 `headless` profile 或项目的 SDK、ACP 入口。 |

<a id="optional-bundles"></a>

## 可选组合包

Windows 的 rc.5 发行包返回了 18 个官方条目。以下名称使用共同前缀 `@deepseek-ai/dsh-`。在 `/plugins official` 查看本机状态，确认启用后，经 `/browser` 继续使用相应的 Web 界面。

| 条目 | 入口与验收边界 |
|---|---|
| `experimental-forge-bundle`、`experimental-tool-worktree`、`experimental-auto-review` | Forge 可用 `/worktree` 查看状态、申请检出或查看 Git scope。实测独立检出和写入范围。远程评审需要代码托管账号。 |
| `experimental-plugin-market-bundle`、`experimental-badge-skill-bundle` | `/plugins discover` 与 `/plugins source-add`。已实测官方市场启用、回环索引和本地包的热加载。 |
| `experimental-session-search`、`experimental-session-titles-bundle`、`deepseek-chat-import` | `/sessions [query]`、原生会话标题和同 Host 的导入界面。导入需要由用户选择数据源。 |
| `experimental-terminal-bundle`、`experimental-ralph-bundle` | 官方持久 Shell 和工作流以当前会话的 `/terminal`、`/jobs` 或原生工具进入。Ralph 使用该组合包的配置。 |
| `experimental-inspector-profile`、`experimental-cot-translation-bundle`、`personalized-recommendations` | 在插件详情查看配置条件，在同 Host 的 Web 界面查看对应入口。 |
| `experimental-liveshare`、`experimental-voice-input-bundle` | 从同 Host 的 Web 界面启用。共享与麦克风授权由用户在对应界面完成。 |
| `cua-bundle` | Windows 端返回 `unsupported-platform`。 |
| `subagent-claude-code`、`subagent-codex` | 官方发现列表显示为待安装。确认安装及供应方授权后，从所选 Agent 的委派工具进入。 |

[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)列出面向用户的改动。[Host 组合](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/bundle/web-app)和[可选组合包](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/experimental)提供完整的安装、平台和依赖信息。
