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
    pty.send('Inspect @')
    await pty.until('Files · Find files and folders')
    await pty.until('Sessions · Reference a saved conversation')
    await pty.until('Agents · Start with a different Agent')
    await pty.until('Connectors · Select an MCP service')
    await pty.until('Plugins · Find enabled plugins')
    pty.send('\t')
    await pty.until('Inspect @file:')
    const searched = pty.mark()
    pty.send('project-not')
    await pty.until('project-note.txt', searched)
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

it.runIf(process.platform === 'win32')('sends a file and another session together and rejects a deleted file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-combined-reference-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const file = join(cwd, 'combined note.txt')
  await writeFile(file, 'COMBINED_FILE_SENTINEL')
  const key = 'combined-reference-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['success', 'tool_call_success', 'success'],
    toolName: 'pwsh',
    toolArguments: JSON.stringify({ command: "Get-Content -LiteralPath 'combined note.txt'", description: 'Read the referenced file' }),
    successText: 'COMBINED_TURN_DONE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(join(root, 'home'), model.baseURL, key)
    pty = launch('pwsh.exe', cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    const sourceId = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(sourceId).toBeDefined()
    pty.send('/rename prior-fixture-review\r')
    await pty.until('Session renamed to prior-fixture-review')
    pty.send('Save COMBINED_HISTORY_SENTINEL as the result of the earlier review.\r')
    await pty.until('COMBINED_TURN_DONE')
    const create = pty.mark()
    pty.send('/new\r')
    await pty.until('No messages yet', create)
    const targetId = pty.output(create).match(/session-[\da-f-]{36}/gu)?.at(-1)
    expect(targetId).toBeDefined()
    expect(targetId).not.toBe(sourceId)
    const lookup = pty.mark()
    pty.send('Compare @combined')
    await pty.until('combined note.txt · File', lookup)
    const filePick = pty.mark()
    pty.send('\t')
    await pty.until('❯ Compare @"combined note.txt"', filePick)
    pty.send('with @prior-fixture')
    await pty.until('prior-fixture-review · Session', filePick)
    const sessionPick = pty.mark()
    pty.send('\t')
    await pty.until('dsh-session:', sessionPick)
    expect(model.requests).toHaveLength(1)
    const send = pty.mark()
    pty.send('\r')
    await pty.until('COMBINED_TURN_DONE', send)
    const wire = JSON.stringify(model.requests.slice(1).map(request => request.body))
    expect(wire).toContain('COMBINED_HISTORY_SENTINEL')
    expect(wire).toContain('COMBINED_FILE_SENTINEL')

    const stale = pty.mark()
    pty.send('Check @combined')
    await pty.until('combined note.txt · File', stale)
    const insert = pty.mark()
    pty.send('\t')
    await pty.until('❯ Check @"combined note.txt"', insert)
    await rm(file)
    pty.send('\r')
    await pty.until('Reference is unavailable in this session: combined note.txt', insert)
    expect(model.requests).toHaveLength(3)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
