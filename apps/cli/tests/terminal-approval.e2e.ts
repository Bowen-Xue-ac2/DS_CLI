import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'

it.runIf(process.platform === 'win32')('controls an actual PowerShell write through one-shot Host approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-approval-'))
  const cwd = join(root, 'workspace')
  const file = join(cwd, 'counter.txt')
  await mkdir(cwd)
  await writeFile(file, 'before\n')
  const key = 'ds-cli-test-key'
  const server = await startMockLlmServer({
    apiKey: key,
    sequence: [
      'tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success',
    ],
    successText: 'TURN_COMPLETE',
    toolName: 'pwsh',
    toolArguments: JSON.stringify({
      command: "Add-Content -LiteralPath 'counter.txt' -Value approved",
      description: 'Append one line to the test counter',
      sandbox_permissions: 'workspace-write',
      justification: 'The test counter requires a write in this workspace.',
    }),
  })
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      import { readFile } from 'node:fs/promises'
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(new URL('../lib/terminal-host.js', import.meta.url).href)})
      const { commitStart } = await import(${JSON.stringify(new URL('../lib/terminal-start.js', import.meta.url).href)})
      const { setSessionPermission } = await import(${JSON.stringify(new URL('../lib/terminal-permissions.js', import.meta.url).href)})
      const host = await openTerminalHost({ cwd: process.cwd(), signal: AbortSignal.timeout(32_000) })
      const outcomes = []
      const asked = []
      const decided = []
      const toolEvents = []
      try {
        const active = await commitStart(host, { workspacePath: process.cwd(), cwd: process.cwd() }, 'session-terminal-approval')
        const sessionId = active.sessionId
        await setSessionPermission(host, sessionId, 'read-only')
        const detach = host.answerApprovals(() => sessionId, async request => {
          if (request.toolName !== 'pwsh' || !request.callId) return 'unavailable'
          const outcome = outcomes.length === 1 ? 'allowed-once' : 'rejected'
          outcomes.push(outcome)
          return outcome
        })
        const events = host.remote.session.follow({ address: { kind: 'session', sessionId } }, host.signal)[Symbol.asyncIterator]()
        try {
          await events.next()
          async function turn(requestId, text) {
            requireHostResult(await host.remote.session.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, host.signal))
            while (true) {
              const frame = await events.next()
              if (frame.done) throw new Error('The session stream closed before turn end')
              if (frame.value.type !== 'event') continue
              const { type, data } = frame.value.event
              if (type === 'approval/asked') asked.push(data)
              if (type === 'approval/decided') decided.push(data)
              if (type === 'tool/result') toolEvents.push(data)
              if (type === 'turn/end') return
            }
          }
          await turn('deny-write', 'Request the test counter write.')
          const denied = await readFile('counter.txt', 'utf8')
          await turn('allow-write', 'Request the test counter write again.')
          await turn('deny-again', 'Request the test counter write a third time.')
          const permission = requireHostResult(await host.remote.session.projections({ sessionId }, host.signal)).values.permissions.currentValue
          console.log(JSON.stringify({ denied, outcomes, asked, decided, toolEvents, permission }))
        } finally { await events.return(); detach() }
      } finally { await host.dispose() }
    `], {
      cwd, env: await terminalFixtureEnv(join(root, 'home'), server.baseURL, key),
      timeout: 40_000,
    })
    const { denied, outcomes, asked, decided, toolEvents, permission } = JSON.parse(stdout)
    expect(denied).toBe('before\n')
    expect(outcomes, JSON.stringify({ asked, decided, toolEvents }).slice(0, 1600))
      .toEqual(['rejected', 'allowed-once', 'rejected'])
    expect(permission).toBe('read-only')
    expect((await readFile(file, 'utf8')).match(/approved/g)).toHaveLength(1)
    expect(asked).toHaveLength(3)
    expect(new Set(asked.map((event: { id: string }) => event.id)).size).toBe(3)
    expect(decided).toEqual(asked.map((event: { id: string }, i: number) => ({ id: event.id, outcome: outcomes[i] })))
    expect(toolEvents).toMatchObject([
      { error: { code: 'SANDBOX_ESCALATION_REJECTED' } },
      { message: { isError: false } },
      { error: { code: 'SANDBOX_ESCALATION_REJECTED' } },
    ])
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
