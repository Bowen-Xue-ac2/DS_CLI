import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32')('reviews a denied tool and a native question, then replays both calls on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-timeline-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const target = join(cwd, 'approval-sentinel.txt')
  await writeFile(target, 'before\n')
  const key = 'timeline-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'tool_call_success', 'success'],
    toolCalls: {
      1: { name: 'pwsh', arguments: JSON.stringify({
        command: "Add-Content -LiteralPath 'approval-sentinel.txt' -Value denied",
        description: 'Write the fixture file', sandbox_permissions: 'workspace-write', justification: 'Fixture check',
      }) },
      2: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{
        id: 'decision', question: 'Choose the fixture outcome',
        options: [{ label: 'First choice' }, { label: 'PROCEED_FIXTURE_CHOICE' }],
      }] }) },
    },
    successText: 'TIMELINE_RESULT_DONE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    const sessionId = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(sessionId).toBeDefined()
    pty.send('/model ds-cli-fixture/fixture-model\r')
    await pty.until('Model: ds-cli-fixture/fixture-model')
    pty.send('Run the timeline fixture.\r')
    await pty.until('Approve tool pwsh?')
    pty.send('\x1b')
    await pty.until('Choose the fixture outcome')
    pty.send('\x1b[B')
    await pty.until('● PROCEED_FIXTURE_CHOICE')
    pty.send('\r')
    await pty.until('TIMELINE_RESULT_DONE')
    expect(await readFile(target, 'utf8')).toBe('before\n')
    expect(model.requests).toHaveLength(3)
    expect(JSON.stringify(model.requests[2]?.body)).toContain('PROCEED_FIXTURE_CHOICE')
    const timeline = pty.mark()
    pty.send('/activity\r')
    await pty.until('pwsh · failed', timeline)
    await pty.until('ask_user_question · succeeded', timeline)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
    pty = launch('pwsh.exe', cwd, env, `--resume ${sessionId}`)
    await pty.until('TIMELINE_RESULT_DONE')
    pty.send('/activity\r')
    await pty.until('ask_user_question · succeeded')
    await pty.until('pwsh · failed')
    expect(model.requests).toHaveLength(3)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 90_000)
