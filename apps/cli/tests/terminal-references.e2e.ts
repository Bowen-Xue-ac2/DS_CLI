import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32')('completes a workspace file without submitting until the second Enter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-reference-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'project-note.txt'), 'REFERENCE_CONTENT_SENTINEL')
  const key = 'ds-cli-reference-fixture'
  const server = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], repeatLast: true,
    toolName: 'pwsh',
    toolArguments: JSON.stringify({ command: "Get-Content -LiteralPath 'project-note.txt'", description: 'Read the referenced file' }),
    successText: 'REFERENCE_TURN_FINISHED',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(join(root, 'home'), server.baseURL, key)
    pty = launch('pwsh.exe', cwd, await shellEnvironment(root, env), '--cwd . --permission read-only')
    await pty.until('read-only on')
    pty.send('Inspect @project-not')
    await pty.until('project-note.txt')
    pty.send('\x1b')
    expect(server.requests).toHaveLength(0)
    const resumed = pty.mark()
    pty.send('e')
    await pty.until('project-note.txt', resumed)
    const beforePick = pty.mark()
    pty.send('\r')
    await pty.until('❯ Inspect @project-note.txt', beforePick)
    expect(server.requests).toHaveLength(0)
    pty.send('\r')
    await pty.until('REFERENCE_TURN_FINISHED')
    const messages = JSON.stringify(server.requests.map(request => request.body))
    expect(messages).toContain('@project-note.txt')
    expect(messages).toContain('REFERENCE_CONTENT_SENTINEL')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
