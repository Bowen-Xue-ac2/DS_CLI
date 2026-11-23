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

Type `/` to search for Skills available in the current session. Use the arrow keys and **Tab** or **Enter** to pick a Skill, then add your request and press **Enter** to send it. `$name` is a typing shortcut for a known Skill. Type `@` to complete workspace paths and session references. **Esc** closes the menu and preserves the draft.

Type `@agent:` to find configured Agent presets. Select a preset, add your request, and review the work directory and permission before sending. The request starts in a new session, and you can return to the original conversation with `/sessions`.

| Command | Effect |
| --- | --- |
| `/exit` | Exit the CLI |
| `/help` | Show help |
| `/commands` | List commands registered by the Host for this session |
| `/clear` | Clear the visible transcript |
| `/workspace` | Select a workspace, browse directories, and choose an existing or new session |
| `/sessions [query]`, `/resume [id]` | Open a saved session from inside the terminal |
| `/new`, `/fork`, `/history` | Start in this workspace, branch this session, or load older turns |
| `/rename <title>`, `/archive`, `/unarchive`, `/pin`, `/unpin` | Organize conversations through the Host |
| `/cd [path]` | Change the active working directory within the session |
| `/agent` or `/mode` | Choose the primary Agent before sending a message |
| `/model <model>` | Switch the model for this session |
| `/permission` or **Shift+Tab** | Choose a current preset or a default for future sessions |
| `/mcp` or `/connectors` | View managed Host connections |
| `/mcp probe <server>`, `/mcp restart <server>` | Probe a configured server or confirm a live connection restart |

The approval menu offers **Deny** and **Allow once** for the requesting tool. Full access requires an explicit confirmation.

**Ctrl+C** cancels the in-flight turn while the agent runs, and exits at the prompt.

## Configure the interactive Host

The interactive Host reads settings and stores workspaces and sessions under `$DSH_HOME/ds-cli-host-0.2`. It can also read API keys from the environment inherited from the invoking shell. A named `--resume` restores a session from this Host.

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
