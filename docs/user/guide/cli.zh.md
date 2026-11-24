# 使用交互式终端 CLI

[English](cli.md) | 中文

`dsh` 在官方 Host 上开启新会话。已登记项目直接进入聊天，新目录会预选当前路径与默认 Agent。在已登记项目的子目录启动时，会话归所属项目，新工具从该子目录执行。

## 启动

在 fork 根目录使用 Node 24.9 或更高版本，运行 `pnpm --dir apps/cli/runtime install --frozen-lockfile` 安装独立 Host，再用 `pnpm run build:lib` 构建。

PowerShell 中先为当前终端定义命令，再进入工作目录。

```powershell
$dsCliBin = (Resolve-Path ./apps/cli/lib/bin.js).Path
function dsh { node $dsCliBin @args }
Set-Location -LiteralPath 'C:/work/my-project'
dsh
```

Bash 中也在切目录前定义同一个入口。

```bash
ds_cli_bin="$PWD/apps/cli/lib/bin.js"
dsh() {
  node "$ds_cli_bin" "$@"
}
cd -- /path/to/my-project
dsh
```

使用 `dsh --choose` 主动打开选择器。Tab 切字段，方向键选项，Enter 确认，Esc 取消。已有本地包装器时，可在当前 PowerShell 的 `$env:Path` 或 Bash 的 `PATH` 开头加入包装器目录。

```sh
dsh cli
```

改为启动一个全新会话：

```sh
dsh cli --resume fresh
```

按 id 恢复指定会话：

```sh
dsh cli --resume session-xxxx
```

## 发送消息与使用 slash 命令

输入消息并按 **Enter** 发送给 Agent。消息和工具状态显示在输入栏上方。

输入 `/` 查看 `/session`、`/usage`、`/status` 和 `/ps` 等常用命令，也可以继续输入前缀查找其他终端命令。用方向键选择，按 **Enter** 执行，或按 **Tab** 补全并添加参数。输入 `$` 选择 Skill，输入 `@` 选择工作区路径或会话。**Esc** 关闭菜单并保留草稿。

状态栏显示模型思考、生成回复或运行工具的阶段。按 **Ctrl+T** 打开详览，展开工具卡和模型提供方返回的思考文本。用 **PgUp** 或 **PgDn** 翻页，用 **Ctrl+T** 或 **Esc** 返回草稿。较早的回合可先用 `/history` 加载。

输入 `@agent:` 查找已配置的 Agent 预设。选中预设并写好请求后，确认工作目录和权限再发送。请求会在新会话执行，原会话仍可通过 `/sessions` 打开。

输入 `@connector:` 查找当前 Agent 可用的 MCP 连接器。选中并发送请求后，Agent 可按当前权限使用其工具。用 `/mcp resources <server>` 发现资源，再输入 `@connector:<server>/` 选择本会话发现的结果。连接发生变化后，请重新选择连接器或列出资源。

| 命令 | 作用 |
| --- | --- |
| `/exit` | 退出 CLI |
| `/help` | 显示帮助 |
| `/session [query]` | 选择当前工作区的一条历史会话 |
| `/usage` | 查看当前会话的 token、缓存与耗时 |
| `/status` | 查看工作区、目录、Agent、权限和最近请求使用的模型 |
| `/ps` | 列出当前会话中正在运行的任务与持久 Shell |
| `/commands` | 查看 Host 为当前会话注册的命令 |
| `/clear` | 清空当前显示的对话 |
| `/workspace` | 选择工作区或浏览目录，再打开已有会话或新建 |
| `/sessions [query]`、`/resume [id]` | 在终端内打开保存的会话 |
| `/new`、`/fork`、`/history` | 在当前工作区新建会话、分支当前会话或载入更早轮次 |
| `/rename <title>`、`/archive`、`/unarchive`、`/pin`、`/unpin` | 通过 Host 整理会话 |
| `/cd [path]` | 修改当前会话的活动目录 |
| `/agent` 或 `/mode` | 在发送首条消息前选择主 Agent |
| `/model [provider/model [effort]]` | 查看模型目录，或切换本会话的模型与推理档 |
| `/permission` 或 **Shift+Tab** | 设置当前会话权限或未来新会话默认值 |
| `/mcp` 或 `/connectors` | 查看 Host 管理的连接状态 |
| `/mcp probe <server>`、`/mcp restart <server>` | 探测已配置的服务器，或确认后重启连接 |
| `/mcp configure <server> <json-file>` | 按 Host 配置结构保存 stdio 或 streamable HTTP 服务器 |
| `/mcp enable <server>`、`/mcp disable <server>` | 确认启停已配置的服务器 |
| `/agents`、`/agents history [child]` | 查看本根会话的子 Agent，或打开子会话历史 |
| `/agents send <child> <message>`、`/agents stop <child>` | 续聊支持后续消息的子 Agent，或确认停止 |
| `/team [on\|off]` | 查看共享任务并切换当前会话的团队模式 |
| `/activity [call-id [page]]`、`/questions` | 查看工具执行过程，回答当前会话待处理的问题 |
| `/plugins [inspect\|install\|discover]` | 浏览 Host 插件目录、检查包和确认修改 |
| `/files [list\|search\|view]`、`/attach <path>` | 浏览工作区文件、为下一条消息添加文件或图片，或用 `/attach clear` 清除 |
| `/diff [file-number [page]]`、`/export <output.md\|output.zip>` | 查看 Host 最近一次改动摘要，或将会话导出到新文件 |
| `/jobs [id]`、`/jobs follow <id> [byte]`、`/jobs stop <id>` | 查看后台输出、从指定字节继续读取，或确认停止 |
| `/schedule [create\|pause\|resume\|run\|history]` | 管理 Host 定时任务。`/schedule create every 600` 打开预填 600 秒间隔的表单 |
| `/terminal [new\|list\|close\|id]` | 打开或重新连接 Host Shell。输入 `~.` 即可返回聊天 |
| `/worktree` | 查看 Forge 的工作树、源仓库及当前 Host 权限。用 `/browser` 进入审阅控制 |
| `/browser` | 在本机 Host 的 Web 界面打开当前会话 |

工具请求审批时，可以拒绝或允许一次。启用完全访问时会弹出独立确认。

agent 运行中按 **Ctrl+C** 取消当前回合；在提示符下按则退出。

## 配置交互式 Host

`/exit` 断开当前终端。共享 Host 保留会话和可继续运行的后台工作。用 `dsh host status` 查状态，`dsh host open --session <id>` 在浏览器打开指定会话，`dsh host stop` 显式停机。使用不同的 `--patch` 组合前，先停止当前 Host。

交互式 Host 在 `$DSH_HOME/ds-cli-host-0.2` 读取配置，并保存工作区和会话。模型密钥也可以从启动终端继承的环境变量中读取。指定 `--resume` 会话 ID 时，从该 Host 恢复会话。

<a id="use-a-custom-model-provider"></a>

## 配置旧版 CLI

`dsh cli --no-interactive` 和指定 `--model` 或 `--provider` 的调用使用旧版 profile。它的 DeepSeek 适配器兼容 OpenAI API，可在 `$DSH_HOME/settings.yaml` 中配置。

```yaml
# $DSH_HOME/settings.yaml
llm-deepseek:
  baseURL: https://gateway.example/v1
  apiKeyEnv: GATEWAY_API_KEY
  thinking: disabled
  models:
    - id: vendor/model
      name: vendor/model
      contextWindow: 128000
agent-default-model:
  provider: deepseek-official
  model: vendor/model
```

三个要点：

- **`baseURL`** 是网关根地址；自动追加 `/chat/completions`。适配器说 OpenAI chat-completions 协议，因此网关必须暴露该端点。
- **模型 id 必须携带网关前缀。** 若网关映射 `vendor/model`，则 `models[].id` 与 `agent-default-model.model` 都必须是完整的 `vendor/model`，否则请求发送裸模型名会被网关拒绝。
- **key 在每次请求时从 `apiKeyEnv` 命名的环境变量解析**；key 缺失时以 `MISSING_CREDENTIAL` 失败，绝不静默。

改动在下一个请求即生效，无需重启。要切回，编辑 `settings.yaml` 或为单个会话传 `--model` / `--provider`。

## 配置网页搜索

`web_search` 工具是内置的，说 Anthropic 兼容 Messages API 并使用 `web_search_20250305` 服务端工具。把它指向同一网关的 Anthropic 端点（与 chat-completions base 分开），这样 LLM 路由用自定义 provider 时搜索也能工作。

```yaml
# $DSH_HOME/settings.yaml
web-search-deepseek:
  baseURL: https://gateway.example/anthropic/v1
  apiKeyEnv: GATEWAY_API_KEY
  model: vendor/model
```

key 缺失时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败并指名 `apiKeyEnv` 引用——与模型路由相同的解析路径，因此没有独立搜索 key 的 LLM provider 需要其网关暴露 Anthropic 端点。

## 参数

| 参数 | 含义 |
| --- | --- |
| `--model <model>` | 覆盖本会话的模型 |
| `--provider <provider>` | 覆盖 provider |
| `--cwd <path>` | 会话工作目录 |
| `--resume <latest\|fresh\|id>` | 驱动哪个会话 |
| `--permission <read-only\|workspace-write\|danger-full-access>` | 权限 preset |
| `--no-interactive` | CI 明文输出模式 |

## 继续

- [Web UI](./index.md)
- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
