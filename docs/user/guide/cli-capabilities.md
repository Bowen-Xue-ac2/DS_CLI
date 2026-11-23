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
| Plugin discovery, bundled plugins, third-party packages | Check the Host plugin-manager bundle listing and use the installation and platform requirements of each selected package. |
| MCP servers and background jobs | Check the first frames from the Host MCP manager and job roster. Tool access depends on the current Agent and configured providers. |
| Independent runners | Use the explicit `headless` profile or the project's SDK and ACP entry points. |

The [official release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) list user-facing changes. The [published Host composition](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/bundle/web-app) and [optional bundle manifests](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/experimental) provide the installer, platform, and dependency source for optional features.
