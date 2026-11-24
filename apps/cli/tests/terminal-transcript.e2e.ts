import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32')('shows provider reasoning in the transcript and renders a reply before it finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-transcript-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const key = 'transcript-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['reasoning_success', 'slow_success'],
    reasoningText: 'PROVIDER_REASONING_FIXTURE',
    successText: 'FIRST_TEXT followed by a deliberately slow response to verify live output. FINAL_TEXT',
    chunkSize: 10, chunkDelayMs: 450,
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    pty.send('Explain the fixture.\r')
    await pty.until('FINAL_TEXT')
    pty.send('Keep this draft')
    await pty.until('Keep this draft')
    let mark = pty.mark()
    pty.send('\x14')
    await pty.until('Transcript', mark)
    await pty.until('PROVIDER_REASONING_FIXTURE', mark)
    mark = pty.mark()
    pty.send('\x14')
    await pty.until('Keep this draft', mark)
    pty.send('\x15')
    await pty.until('❯\r', mark)
    mark = pty.mark()
    pty.send('Show live output.\r')
    await pty.until('● Responding', mark)
    await pty.until('FIRST_TEXT', mark)
    expect(model.requests[1]?.outcome).not.toBe('completed')
    await vi.waitFor(() => expect(model.requests[1]?.outcome).toBe('completed'), { timeout: 12_000 })
    await pty.until('2 轮 · 2 步', mark)
    pty.send('/usage\r')
    await pty.until('Session usage')
    expect(model.requests).toHaveLength(2)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 90_000)
