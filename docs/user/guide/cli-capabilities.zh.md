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
| 插件发现、随附插件、第三方包 | 查询 Host 插件管理列表，按各插件文档提供安装条件和平台依赖。 |
| MCP 连接和后台 Jobs | 核对 Host 的 MCP 管理器与 Job 名单的首帧。工具访问由当前 Agent 和提供方配置决定。 |
| 独立运行入口 | 使用显式的 `headless` profile 或项目的 SDK、ACP 入口。 |

[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)列出面向用户的改动。[Host 组合](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/bundle/web-app)和[可选组合包](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/experimental)提供完整的安装、平台和依赖信息。
