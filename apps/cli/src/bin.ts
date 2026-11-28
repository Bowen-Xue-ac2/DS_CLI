#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

declare const __DS_CLI_BUILD_REVISION__: string | null

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const version = readVersion()
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9)) {
  console.error(`dsh: Node.js 24.9.0 or newer is required (found ${process.versions.node}).`)
  process.exit(1)
}
const invocation = parseDshArgs(process.argv.slice(2), version)

switch (invocation.mode) {
  case 'profile': {
    if (invocation.profile === 'cli') {
      const optionNames = invocation.args.map(argument => argument.split('=', 1)[0])
      const legacy = optionNames.some(option => option === '--no-interactive' || option === '--model' || option === '--provider')
      if (!legacy) {
        const { runTerminal } = await import('./terminal-run.ts')
        try {
          await runTerminal(invocation.args, invocation.patches, process.cwd())
        } catch (error) {
          console.error(`dsh: ${error instanceof Error ? error.message : String(error)}`)
          process.exitCode = 1
        }
        break
      }
    }
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  case 'build-info': {
    const { describeTerminalRuntime } = await import('./terminal-host.ts')
    console.log(JSON.stringify({
      cli: version,
      revision: typeof __DS_CLI_BUILD_REVISION__ === 'undefined' ? null : __DS_CLI_BUILD_REVISION__,
      host: await describeTerminalRuntime(process.env),
    }))
    break
  }
  case 'host': {
    try {
      if (invocation.action === 'open') {
        const { openTerminalBrowser, requestTerminalBrowser } = await import('./terminal-browser.ts')
        const url = await requestTerminalBrowser(invocation.session)
        if (invocation.printUrl) console.log(url.href)
        else await openTerminalBrowser(url)
      } else {
        const { runTerminalHostCommand } = await import('./terminal-supervisor.ts')
        await runTerminalHostCommand(invocation.action, invocation.yes)
      }
    } catch (error) {
      console.error(`dsh: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
    break
  }
  case 'session': {
    const { runTerminalSessionCommand } = await import('./terminal-session-command.ts')
    try {
      await runTerminalSessionCommand(invocation)
    } catch (error) {
      console.error(`dsh: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
