---
description: "The terminal distribution, its pinned Host, and how to verify available features."
kind: "reference"
---

# Terminal capabilities

English | [中文](cli-capabilities.zh.md)

The terminal uses the official DSH `0.2.2-rc.5` Host installed from `apps/cli/runtime/pnpm-lock.yaml`. Run `dsh --build-info` to read the CLI version, source revision at build time, and installed Host version. Interactive startup uses the caller's working directory and finds the Host relative to the installed package. The Host data directory is `ds-cli-host-0.2` under `DSH_HOME`.

| Capability | Where to verify |
|---|---|
| Workspace, session, model and Agent presets, Skills, permission catalog | Query the pinned Host using the assertions in [terminal-host.e2e.ts](../../../apps/cli/tests/terminal-host.e2e.ts). |
| Entry, terminal flags, effective directory and first tool | Run the [dual-shell acceptance tests](../../../apps/cli/tests/terminal-shells.e2e.ts) on Windows. Set `DS_CLI_TEST_INSTALL_DIR` to the packed npm consumer root to use its standard installed executable. |
| Session continuity and background Host | `/sessions`, `dsh host status`, and `dsh host stop`. [Background acceptance](../../../apps/cli/tests/terminal-background.e2e.ts) exercises terminal detach, reconnect and stop in PowerShell and Git Bash. |
| References, Skills, Agents, and approvals | `@`, `$`, `@agent:`, `/agents`, and `/team`. [Timeline](../../../apps/cli/tests/terminal-activity.e2e.ts) and [delegation acceptance](../../../apps/cli/tests/terminal-delegation.e2e.ts) verify Host receipts. |
| Plugins and MCP | `/plugins`, `@plugin:`, `/mcp`, and `@connector:`. The [plugin test](../../../apps/cli/tests/terminal-plugins.e2e.ts) uses a local bundle and [MCP tests](../../../apps/cli/tests/terminal-connectors.e2e.ts) use stdio and loopback HTTP fixtures. Configure third-party credentials through their documented flows. |
| Files, attachments, turn changes, and export | `/files`, `/attach`, `/diff`, and `/export`. [Asset acceptance](../../../apps/cli/tests/terminal-assets.e2e.ts) covers paths with spaces and Chinese characters, native images, the Git index, and Markdown. |
| Jobs, schedules, and persistent shells | `/jobs`, `/schedule`, and `/terminal`. The [automation acceptance](../../../apps/cli/tests/terminal-automation.e2e.ts) reads exit states, byte offsets and delivery receipts from the pinned Host. |
| Rich documents and official optional bundles | `/browser` or `dsh host open --session <id>` opens the same Host. Use **Plugins** to inspect Git Worktrees, Forge, review, LiveShare, Office, Computer Use, and external Agent bundles. Availability depends on the active composition, platform, installation and account. |
| Independent runners | Use the explicit `headless` profile or the project's SDK and ACP entry points. |

<a id="optional-bundles"></a>

## Optional bundles

The rc.5 distribution reported 18 official entries on Windows. Names below use the common prefix `@deepseek-ai/dsh-`. Check `/plugins official` for the local state, then use `/browser` for the corresponding Web controls after enabling a bundle.

| Entries | Entry point and verification scope |
|---|---|
| `experimental-forge-bundle`, `experimental-tool-worktree`, `experimental-auto-review` | Use `/worktree` for Forge checkout requests, status and Git scopes. Local checkout and write isolation were exercised. Remote reviews require a code-host account. |
| `experimental-plugin-market-bundle`, `experimental-badge-skill-bundle` | `/plugins discover` and `/plugins source-add`. The tests exercise marketplace enablement, a loopback index, and live loading of a local bundle. |
| `experimental-session-search`, `experimental-session-titles-bundle`, `deepseek-chat-import` | Use `/sessions [query]`, native Session titles, and the Host's import view. Import uses the data source selected by the user. |
| `experimental-terminal-bundle`, `experimental-ralph-bundle` | Use `/terminal`, `/jobs`, or the active Session's native tools for retained shells and workflows. Ralph uses its bundle configuration. |
| `experimental-inspector-profile`, `experimental-cot-translation-bundle`, `personalized-recommendations` | Check required settings in plugin details and use the corresponding controls on the same Host. |
| `experimental-liveshare`, `experimental-voice-input-bundle` | Use the Host's Web controls. Sharing and microphone access use their respective confirmation flows. |
| `cua-bundle` | The Host reports `unsupported-platform` on Windows. |
| `subagent-claude-code`, `subagent-codex` | The official catalog lists these for installation. Enable delegation after installation and provider authorization. |

The [official release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) list user-facing changes. The [published Host composition](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/bundle/web-app) and [optional bundle manifests](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/experimental) provide the installer, platform, and dependency source for optional features.
