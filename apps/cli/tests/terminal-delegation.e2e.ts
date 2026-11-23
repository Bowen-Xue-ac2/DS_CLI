import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s sends a chosen preset one turn in a new session after confirmation',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'dscli-preset-'))
    const cwd = join(root, 'work')
    const home = join(root, 'home')
    await mkdir(cwd)
    const key = 'preset-fixture'
    const model = await startMockLlmServer({ apiKey: key, sequence: ['success'], successText: 'PRESET_TARGET_DONE' })
    let pty: ReturnType<typeof launch> | undefined
    try {
      const env = await terminalFixtureEnv(home, model.baseURL, key)
      await writeFile(join(home, 'ds-cli-host-0.2', 'settings.yaml'), 'permission:\n  defaultPreset: read-only\n')
      pty = launch(shell, cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
      await pty.until('read-only on')
      const sourceId = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
      expect(sourceId).toBeDefined()
      pty.send('@agent:ptc')
      await pty.until('New session with this Agent')
      const pick = pty.mark()
      pty.send('\t')
      await pty.until('❯ @agent:ptc', pick)
      const review = pty.mark()
      pty.send('Explain this fixture.\r')
      await pty.until('Send to a new Agent session?', review)
      await pty.until(`${cwd} · read-only`, review)
      expect(model.requests).toHaveLength(0)
      const cancelled = pty.mark()
      pty.send('\x1b')
      await pty.until('Explain this fixture.', cancelled)
      expect(model.requests).toHaveLength(0)
      const retry = pty.mark()
      pty.send('\r')
      await pty.until('Send to a new Agent session?', retry)
      pty.send('\x1b[B')
      await pty.until('● Send', retry)
      const confirm = pty.mark()
      pty.send('\r')
      await pty.until('PRESET_TARGET_DONE', confirm)
      await pty.until('mode: ptc', confirm)
      await pty.until('read-only on', confirm)
      const targetId = pty.output(confirm).match(/session-[\da-f-]{36}/gu)?.at(-1)
      expect(targetId).toBeDefined()
      expect(targetId).not.toBe(sourceId)
      expect(model.requests).toHaveLength(1)
      expect(JSON.stringify(model.requests[0]?.body)).toContain('Explain this fixture.')
      expect(JSON.stringify(model.requests[0]?.body)).not.toContain('@agent:ptc')
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
    } finally {
      await pty?.stop()
      await model.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
)
