import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s uses registered capabilities, approves one tool and resumes on the same Host',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'dscli-full-harness-'))
    const cwd = join(root, '项目 harness')
    await mkdir(cwd)
    const file = join(cwd, 'harness note.txt')
    await writeFile(file, 'PACKED_HARNESS_INPUT\n')
    const key = 'packaged-harness-fixture'
    const model = await startMockLlmServer({
      apiKey: key, sequence: ['tool_call_success', 'slow_success'], chunkSize: 8, chunkDelayMs: 150,
      toolCalls: { 1: { name: 'pwsh', arguments: JSON.stringify({
        command: "Add-Content -LiteralPath 'harness note.txt' -Value PACKED_HARNESS_EDIT",
        description: 'Add the fixture line once', sandbox_permissions: 'workspace-write', justification: 'One-shot acceptance',
      }) } },
      successText: 'PACKED_HARNESS_COMPLETE',
    })
    let pty: ReturnType<typeof launch> | undefined
    let stop: (() => Promise<unknown>) | undefined
    try {
      const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
      stop = () => execa(process.execPath, [env.DS_CLI_TEST_BIN!, 'host', 'stop', '--yes'], { cwd, env, timeout: 30_000 })
      pty = launch(shell, cwd, env, '--cwd . --mode standard --permission read-only', 'shared')
      await pty.until('read-only on', 0, 40_000)
      const id = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
      expect(id).toBeDefined()
      pty.send('/sessions\r')
      await pty.until('Choose a session')
      pty.send('\x1b')
      pty.send('/plugins\r')
      await pty.until('Official')
      pty.send('\x1b')
      pty.send('/mcp\r')
      await pty.until('No managed MCP servers configured')
      let mark = pty.mark()
      pty.send('$dsh-do')
      await pty.until('$dsh-doc', mark)
      pty.send('\t')
      await pty.until('❯ $dsh-doc', mark)
      mark = pty.mark()
      pty.send('Apply the local fixture update to @harness')
      await pty.until('harness note.txt · File', mark)
      pty.send('\t')
      await pty.until('@"harness note.txt"', mark)
      expect(model.requests).toHaveLength(0)
      pty.send('\r')
      await pty.until('Approve tool pwsh?')
      pty.resize(72, 18)
      pty.send('\x1b[B')
      await pty.until('● Allow once')
      mark = pty.mark()
      pty.send('\r')
      await pty.until('● Responding', mark)
      await pty.until('PACKED_HARNESS_COMPLETE', mark)
      pty.resize(162, 40)
      mark = pty.mark()
      pty.send('\x14')
      await pty.until('Transcript', mark)
      await pty.until('PACKED_HARNESS_COMPLETE', mark)
      await pty.until('pwsh', mark)
      pty.send('\x14')
      expect((await readFile(file, 'utf8')).trim().split(/\r?\n/u)).toEqual(['PACKED_HARNESS_INPUT', 'PACKED_HARNESS_EDIT'])
      expect(JSON.stringify(model.requests[0]?.body)).toContain('harness note.txt')
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
      pty = launch(shell, cwd, env, `--resume ${id}`, 'shared')
      await pty.until('PACKED_HARNESS_COMPLETE', 0, 40_000)
      pty.send('/activity\r')
      await pty.until('pwsh · succeeded')
      expect(model.requests).toHaveLength(2)
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
    } finally {
      await pty?.stop()
      await stop?.().catch(() => {})
      await model.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
  120_000,
)
