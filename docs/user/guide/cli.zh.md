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

| 命令 | 作用 |
| --- | --- |
| `/exit` | 退出 CLI |
| `/help` | 显示帮助 |
| `/clear` | 清空当前显示的对话 |
| `/workspace` | 选择工作区或浏览目录 |
| `/cd [path]` | 修改当前会话的活动目录 |
| `/agent` 或 `/mode` | 在发送首条消息前选择主 Agent |
| `/model <model>` | 切换本会话的模型 |
| `/permission` 或 **Shift+Tab** | 设置当前会话权限或未来新会话默认值 |

工具请求审批时，可以拒绝或允许一次。启用完全访问时会弹出独立确认。

agent 运行中按 **Ctrl+C** 取消当前回合；在提示符下按则退出。

## 配置交互式 Host

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
