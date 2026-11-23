import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

const script = fileURLToPath(new URL('./fixtures/terminal-mcp-server.mjs', import.meta.url))

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s lists, probes and restarts configured MCP servers without a model request',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'dscli-mcp-'))
    const cwd = join(root, 'work')
    const home = join(root, 'home')
    await mkdir(cwd)
    const key = 'mcp-fixture'
    const model = await startMockLlmServer({ apiKey: key, sequence: ['success'] })
    let pty: ReturnType<typeof launch> | undefined
    try {
      const env = await terminalFixtureEnv(home, model.baseURL, key)
      const patchPath = join(home, 'ds-cli-host-0.2', 'cordis.patch.yml')
      const patch: unknown[] = JSON.parse(await readFile(patchPath, 'utf8'))
      const readyLog = join(root, 'ready.log')
      const parkedLog = join(root, 'parked.log')
      const fixture = { transport: 'stdio', command: process.execPath }
      await writeFile(patchPath, JSON.stringify([...patch, {
        id: 'mcp-manager', config: { servers: {
          ready: { ...fixture, args: [script, readyLog] },
          parked: { ...fixture, args: [script, parkedLog], enabled: false },
        } },
      }]))
      pty = launch(shell, cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
      await pty.until('read-only on')
      pty.send('/connectors\r')
      await pty.until('parked  disabled')
      pty.send('/mcp probe parked\r')
      await pty.until('parked: probe passed · 1 tool · closed')
      expect(await readFile(parkedLog, 'utf8')).toBe('initialized\n')
      const probe = pty.mark()
      pty.send('/mcp\r')
      await pty.until('parked  disabled', probe)
      await pty.until('ready  connected', probe)
      pty.send('/mcp restart missing\r')
      await pty.until('Unknown configured MCP server: missing')
      pty.send('/mcp restart ready\r')
      await pty.until('Restart MCP server ready?')
      const cancel = pty.mark()
      pty.send('\x1b')
      await pty.until('Restart cancelled', cancel)
      expect(await readFile(readyLog, 'utf8')).toBe('initialized\n')
      const restart = pty.mark()
      pty.send('/mcp restart ready\r')
      await pty.until('Restart MCP server ready?', restart)
      pty.send('\x1b[B')
      await pty.until('● Restart', restart)
      const confirm = pty.mark()
      pty.send('\r')
      await pty.until('ready: restart requested', confirm)
      await vi.waitFor(async () => {
        expect(await readFile(readyLog, 'utf8')).toBe('initialized\ninitialized\n')
      }, { timeout: 8_000 })
      expect(model.requests).toHaveLength(0)
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
    } finally {
      await pty?.stop()
      await model.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
)
