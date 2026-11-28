import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
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
    pty.resize(72, 18)
    mark = pty.mark()
    pty.send('\x14')
    await pty.until('Transcript  ● Responding', mark)
    await pty.until('Following', mark)
    expect(model.requests[1]?.outcome).not.toBe('completed')
    await vi.waitFor(() => expect(model.requests[1]?.outcome).toBe('completed'), { timeout: 12_000 })
    await pty.until('FINAL_TEXT', mark)
    await pty.until('○ idle', mark)
    const returnMark = pty.mark()
    pty.send('\x14')
    await pty.until('❯\r', returnMark)
    const usage = pty.mark()
    pty.send('/usage\r')
    await pty.until('Session usage', usage)
    await pty.until('2 轮 · 2 步', usage)
    expect(model.requests).toHaveLength(2)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 90_000)

it.runIf(process.platform === 'win32')('steers the active turn and keeps queued work when a turn is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-steer-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const key = 'steer-fixture'
  const blocked = Promise.withResolvers<undefined>()
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success', 'success', 'success', 'success', 'success'],
    toolName: 'pwsh',
    toolArguments: JSON.stringify({ command: 'Start-Sleep -Seconds 6; Write-Output STEER_TOOL_FIXTURE',
      description: 'Wait briefly for terminal input' }),
    successText: 'STEER_FIXTURE_FINISHED',
    waitForResponse: request => request.attempt === 4 ? blocked.promise : Promise.resolve(),
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission workspace-write')
    await pty.until('workspace-write on')
    pty.send('/steer Check before starting.\r')
    await pty.until('There is no active turn to steer.')
    expect(model.requests).toHaveLength(0)
    await pty.until('❯ /steer Check before starting.')
    const cleared = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', cleared)
    pty.send('Run the fixture tool.\r')
    await pty.until('Running tools')
    const running = pty.mark()
    pty.send('\x14')
    await pty.until('Transcript  ● Running tools', running)
    await pty.until('… pwsh · Wait briefly for terminal input', running)
    const composer = pty.mark()
    pty.send('\x14')
    await pty.until('● Running tools  session-', composer)
    pty.send('/steer Apply STEER_NEXT_STEP.\r')
    await pty.until('Instruction accepted for the next step')
    pty.send('Apply QUEUE_NEXT_TURN.\r')
    await pty.until('Message accepted for the next turn')
    await vi.waitFor(() => { expect(model.requests[2]?.outcome).toBe('completed') }, { timeout: 18_000 })
    const finished = pty.mark()
    pty.send('\x14')
    await pty.until('✓ pwsh · Wait briefly for terminal input', finished)
    await pty.until('STEER_TOOL_FIXTURE', finished)
    pty.send('\x14')
    await pty.until('❯\r', finished)
    expect(JSON.stringify(model.requests[1]?.body)).toContain('STEER_NEXT_STEP')
    expect(JSON.stringify(model.requests[1]?.body)).not.toContain('QUEUE_NEXT_TURN')
    expect(JSON.stringify(model.requests[2]?.body)).toContain('QUEUE_NEXT_TURN')
    pty.send('Keep this turn active.\r')
    await vi.waitFor(() => { expect(model.requests).toHaveLength(4) }, { timeout: 18_000 })
    const pending = pty.mark()
    pty.send('Run QUEUED_AFTER_CANCEL.\r')
    await pty.until('Message accepted for the next turn', pending)
    pty.send('/cancel\r')
    await pty.until('Turn cancelled', pending)
    blocked.resolve(undefined)
    await pty.until('○ idle', pending)
    pty.send('Wake the saved queue.\r')
    await vi.waitFor(() => { expect(model.requests[4]?.outcome).toBe('completed') }, { timeout: 18_000 })
    expect(JSON.stringify(model.requests[4]?.body)).toContain('QUEUED_AFTER_CANCEL')
    await vi.waitFor(() => { expect(model.requests[5]?.outcome).toBe('completed') }, { timeout: 18_000 })
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    blocked.resolve(undefined)
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 90_000)

it.runIf(process.platform === 'win32')('restores unsent text only in its original saved Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-draft-'))
  const a = join(root, '项目 A')
  const b = join(root, '项目 B')
  await Promise.all([mkdir(a), mkdir(b)])
  const key = 'draft-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success'], successText: 'DRAFT_SENT_ONCE' })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', a, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    const session = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(session).toBeDefined()
    const draft = 'Continue the unsent fixture.'
    pty.send(draft)
    await pty.until('❯ ' + draft)
    pty.send('\x04')
    expect(await pty.exit()).toBe(0)

    pty = launch('pwsh.exe', b, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    expect(pty.output()).not.toContain(draft)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)

    pty = launch('pwsh.exe', a, env, `--resume ${session}`)
    await pty.until('❯ ' + draft)
    expect(model.requests).toHaveLength(0)
    pty.send('\r')
    await pty.until('DRAFT_SENT_ONCE')
    expect(model.requests).toHaveLength(1)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)

    pty = launch('pwsh.exe', a, env, `--resume ${session}`)
    await pty.until('DRAFT_SENT_ONCE')
    expect(pty.output()).not.toContain('❯ ' + draft)
    expect(model.requests).toHaveLength(1)
    const branchMark = pty.mark()
    pty.send('/fork\r')
    await pty.until('Branch from ' + session, branchMark)
    const branch = pty.output(branchMark).match(/session-[\da-f-]{36}/gu)?.find(id => id !== session)
    expect(branch).toBeDefined()
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
    pty = launch('pwsh.exe', a, env, `--resume ${branch}`)
    await pty.until('Branch from ' + session)
    await pty.until('DRAFT_SENT_ONCE')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 120_000)

it.runIf(process.platform === 'win32')('shares one live Session with the JSONL script interface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-program-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'bridge.txt'), 'PROGRAM_BRIDGE_TOOL_RESULT\n')
  const key = 'program-bridge-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], toolName: 'pwsh',
    toolArguments: JSON.stringify({
      command: "Start-Sleep -Seconds 8; Get-Content -LiteralPath 'bridge.txt'",
      description: 'Read the local bridge fixture',
    }),
    successText: 'PROGRAM_BRIDGE_DONE',
  })
  let terminal: ReturnType<typeof launch> | undefined
  let closeHost: (() => Promise<unknown>) | undefined
  const observer = new AbortController()
  let observed: Promise<unknown> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    const bin = env.DS_CLI_TEST_BIN!
    const command = (...args: string[]) => execa(process.execPath, [bin, ...args], { cwd, env, timeout: 25_000 })
    closeHost = () => command('host', 'stop', '--yes')
    terminal = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission workspace-write', 'shared')
    await terminal.until('workspace-write on', 0, 40_000)
    const sessionId = terminal.output().match(/session-[\da-f-]{36}/u)?.[0]
    if (!sessionId) throw new Error('Terminal did not announce its Session')
    const child = execa(process.execPath, [bin, 'session', 'events', sessionId], {
      cwd, env, cancelSignal: observer.signal, reject: false, timeout: 40_000,
    })
    observed = child.catch(() => {})
    let stream = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stream += chunk })
    await vi.waitFor(() => { expect(stream).toContain('"type":"snapshot"') }, { timeout: 10_000 })
    terminal.send('Read the program bridge fixture.\r')
    await terminal.until('Running tools')
    const accepted = await command('session', 'steer', sessionId, 'Add PROGRAM_BRIDGE_STEER.')
    expect(JSON.parse(accepted.stdout)).toEqual({ type: 'accepted', sessionId })
    await terminal.until('PROGRAM_BRIDGE_DONE')
    await vi.waitFor(() => { expect(stream).toContain('"type":"turn/end"') }, { timeout: 14_000 })
    expect(stream).toContain('PROGRAM_BRIDGE_TOOL_RESULT')
    const history = JSON.parse((await command('session', 'history', sessionId)).stdout)
    expect(history).toMatchObject({ type: 'history', sessionId })
    expect(JSON.stringify(history)).toContain('PROGRAM_BRIDGE_DONE')
    expect(JSON.stringify(model.requests[1]?.body)).toContain('PROGRAM_BRIDGE_STEER')
    expect(JSON.stringify(model.requests[1]?.body)).toContain('PROGRAM_BRIDGE_TOOL_RESULT')
    terminal.send('/exit\r')
    expect(await terminal.exit()).toBe(0)
    terminal = launch('pwsh.exe', cwd, env, `--resume ${sessionId}`, 'shared')
    await terminal.until('PROGRAM_BRIDGE_DONE')
    expect(model.requests).toHaveLength(2)
    terminal.send('/exit\r')
    expect(await terminal.exit()).toBe(0)
  } finally {
    observer.abort()
    await observed
    await terminal?.stop()
    await closeHost?.().catch(() => {})
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 120_000)
