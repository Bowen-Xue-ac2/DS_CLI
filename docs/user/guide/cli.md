# Use the interactive terminal CLI

English | [中文](cli.zh.md)

`dsh` opens a new session on the official Host. In a registered workspace it opens chat immediately. Elsewhere a terminal menu preselects the current directory and default Agent. A session opened in a registered project's subdirectory belongs to the project and runs new tools from that subdirectory.

## Start

From the fork's root, use Node 24.9 or newer, run `pnpm --dir apps/cli/runtime install --frozen-lockfile`, and build with `pnpm run build:lib`.

For the current PowerShell session, define the command before changing directories.

```powershell
$dsCliBin = (Resolve-Path ./apps/cli/lib/bin.js).Path
function dsh { node $dsCliBin @args }
Set-Location -LiteralPath 'C:/work/my-project'
dsh
```

For the current Bash session, define the same command from the fork root.

```bash
ds_cli_bin="$PWD/apps/cli/lib/bin.js"
dsh() {
  node "$ds_cli_bin" "$@"
}
cd -- /path/to/my-project
dsh
```

Use `dsh --choose` to reopen the selector. Tab changes fields, the arrow keys select an option, Enter confirms, and Esc cancels. To use an existing local shim directory in the current shell, prepend it to `$env:Path` in PowerShell or `PATH` in Bash.

```sh
dsh cli
```

Start a brand-new session instead:

```sh
dsh cli --resume fresh
```

Resume a specific session by id:

```sh
dsh cli --resume session-xxxx
```

## Send messages and use slash commands

Type a message and press **Enter** to send it to the Agent. Messages and tool status appear above the input bar.

Type `/`, `@`, or `$` to open its menu immediately. Use **↑/↓** to move and **Esc** to close the menu and keep the draft. Clear and retype the trigger to reopen the menu.

- **`/`** opens common terminal commands such as `/session`, `/usage`, `/status`, and `/ps`. Type a prefix to find more. Press **Enter** to run the command or **Tab** to fill it in and add arguments.
- **`@`** opens Files, Sessions, Agents, Connectors, and Plugins. Pick a category with **Enter** or **Tab**, then pick an item or type to filter. You can also type a prefix directly, such as `@file:` or `@connector:`.
- **`$`** opens the current Agent's Skill menu. Pick **Browse skills** to open the catalog, or type part of a skill name. Pick a skill, add your task, and then send the message.

The status line shows when the model is thinking, responding, or running tools. Press **Ctrl+T** during or after a turn to open the live transcript. While it shows **Following**, new activity moves older rows up automatically. Use **↑** / **↓**, **PgUp** / **PgDn**, or the mouse wheel to browse earlier rows. The transcript shows **Paused** while you browse. Press **End** to jump back to the latest activity and follow it again.

Tool entries show their status, available description and timing, and the first three rows of output. Use **Ctrl+O** to toggle the retained output. The transcript also shows reasoning text supplied by the model provider. Use **Ctrl+T** or **Esc** to return to your draft, and `/history` to load older turns.

Type `@agent:` to find configured Agent presets. Select a preset, add your request, and review the work directory and permission before sending. The request starts in a new session, and you can return to the original conversation with `/sessions`.

Type `@connector:` to find connected MCP servers available to this Agent. Select a connector and send your request to let the Agent use its tools with the current permissions. Use `/mcp resources <server>` to discover resources, then type `@connector:<server>/` to select a result in this session. If the connection changes, select the connector or list its resources again.

| Command | Effect |
| --- | --- |
| `/exit` | Exit the CLI |
| `/help` | Show help |
| `/session [query]` | Pick a saved conversation from this workspace |
| `/usage` | Show session tokens, cache use, and timing |
| `/status` | Show workspace, directory, Agent, permissions, and the last model used |
| `/ps` | List this session's running jobs and persistent shells |
| `/steer <instruction>` | Add plain text for the Agent's next step during active work |
| `/cancel` | Cancel the active turn. The rc.5 Host keeps pending messages and resumes them when the session receives a new message |
| `/commands` | List commands registered by the Host for this session |
| `/clear` | Clear the visible transcript |
| `/workspace` | Select a workspace, browse directories, and choose an existing or new session |
| `/sessions [query]`, `/resume [id]` | Open a saved session from inside the terminal |
| `/new`, `/fork`, `/history` | Start in this workspace, branch this session, or load older turns |
| `/rename <title>`, `/archive`, `/unarchive`, `/pin`, `/unpin` | Organize conversations through the Host |
| `/cd [path]` | Change the active working directory within the session |
| `/agent` or `/mode` | Choose the primary Agent before sending a message |
| `/model [provider/model [effort]]` | Inspect the model catalog or change this session's model and reasoning effort |
| `/permission` or **Shift+Tab** | Choose a current preset or a default for future sessions |
| `/mcp` or `/connectors` | View managed Host connections |
| `/mcp probe <server>`, `/mcp restart <server>` | Probe a configured server or confirm a live connection restart |
| `/mcp configure <server> <json-file>` | Save a stdio or streamable HTTP server using the Host settings schema |
| `/mcp enable <server>`, `/mcp disable <server>` | Confirm a change to a configured server's enabled state |
| `/agents`, `/agents history [child]` | List delegated Agents under this root or open a child's history |
| `/agents send <child> <message>`, `/agents stop <child>` | Continue a resumable child or confirm a stop request |
| `/team [on\|off]` | Inspect shared tasks and change Team mode for this session |
| `/activity [call-id [page]]`, `/questions` | Inspect tool calls and answer a pending question in this session |
| `/plugins [inspect\|install\|discover]` | Browse the Host plugin catalog, inspect a package and confirm changes |
| `/files [list\|search\|view]`, `/attach <path>` | Browse workspace files, add a file or image to the next message, or use `/attach clear` |
| `/diff [file-number [page]]`, `/export <output.md\|output.zip>` | Read the latest Host change summary or export the session to a new file |
| `/jobs [id]`, `/jobs follow <id> [byte]`, `/jobs stop <id>` | Read background output, continue at a byte offset, or confirm a stop |
| `/schedule [create\|pause\|resume\|run\|history]` | Manage Host reminders. `/schedule create every 600` starts the form with a 600-second interval |
| `/terminal [new\|list\|close\|id]` | Open or reattach to a Host shell. Type `~.` to return to chat |
| `/worktree` | Read the Forge worktree, source repository and current Host permissions. Use `/browser` for review controls |
| `/browser` | Open the active session in the local Host's web UI |

The approval menu offers **Deny** and **Allow once** for the requesting tool. Full access requires an explicit confirmation.

**Ctrl+C** cancels the in-flight turn while the agent runs, and exits at the prompt.

## Configure the interactive Host

`/exit` detaches the terminal. The shared Host keeps the session and eligible background work running. Run `dsh host status` to inspect it, `dsh host open --session <id>` to open a specific session in the browser, and `dsh host stop` to explicitly stop it. A different `--patch` set takes effect after stopping the current Host.

After an interrupted Host reports stale state, run `dsh host recover` to clear the launch record once both recorded processes have exited. Run `dsh --resume <id>` to reopen a saved session.

The interactive Host reads settings and stores workspaces and sessions under `$DSH_HOME/ds-cli-host-0.2`. It can also read API keys from the environment inherited from the invoking shell. A named `--resume` restores a session from this Host.

Reopening a session restores its unsent text in the input. Choose connector and plugin references again after reopening so the current Host can resolve them. The transcript includes committed compaction summaries.

In another shell, run `dsh session history <id>` for the recent saved records or `dsh session events <id>` to follow the same session as JSON Lines. Run `dsh session steer <id> "<instruction>"` to send plain text to the next step of an active turn. Ctrl+C stops the event reader and leaves the terminal session running.

<a id="use-a-custom-model-provider"></a>

## Configure the legacy CLI

`dsh cli --no-interactive` and invocations with `--model` or `--provider` use the legacy profile. To configure its OpenAI-compatible DeepSeek adapter, use `$DSH_HOME/settings.yaml`.

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

Three points to get right:

- **`baseURL`** is the gateway root; `/chat/completions` is appended automatically. The adapter speaks the OpenAI chat-completions protocol, so the gateway must expose that endpoint.
- **The model id must carry any gateway prefix.** A gateway that maps `vendor/model` needs the `models[].id` and `agent-default-model.model` to both be the full `vendor/model`, or the request sends the bare name and the gateway rejects it.
- **The key resolves from the environment** named by `apiKeyEnv` at each request; a missing key fails with `MISSING_CREDENTIAL`, never silently.

Changes take effect on the next request without restarting. To switch back, edit `settings.yaml` or pass `--model` / `--provider` for one session.

## Configure web search

The `web_search` tool is a built-in that speaks the Anthropic-compatible Messages API with the `web_search_20250305` server tool. Point it at the same gateway's Anthropic endpoint (separate from the chat-completions base) so searches work when the LLM route is a custom provider.

```yaml
# $DSH_HOME/settings.yaml
web-search-deepseek:
  baseURL: https://gateway.example/anthropic/v1
  apiKeyEnv: GATEWAY_API_KEY
  model: vendor/model
```

A missing key fails with `WEB_PROVIDER_CREDENTIAL_MISSING`, naming the `apiKeyEnv` reference — the same resolution path as the model route, so an LLM provider without a separate search key needs its gateway to expose the Anthropic endpoint.

## Flags

| Flag | Meaning |
| --- | --- |
| `--model <model>` | Override the model for this session |
| `--provider <provider>` | Override the provider |
| `--cwd <path>` | Working directory for the session |
| `--resume <latest\|fresh\|id>` | Which session to drive |
| `--permission <read-only\|workspace-write\|danger-full-access>` | Permission preset |
| `--no-interactive` | Plain output mode for CI |

## Continue

- [Web UI](./index.md)
- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
