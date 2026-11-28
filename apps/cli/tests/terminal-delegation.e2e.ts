import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { openTerminalHostCredentials, readTerminalHostState, terminalHostPaths } from '../src/terminal-host-state.ts'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment, terminalHost } from './terminal-tty.ts'
import type { TerminalHost } from '../src/terminal-host.ts'

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
      await pty.until('on · ptc', confirm)
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

it.runIf(process.platform === 'win32')('reads and continues a named child under the current root and toggles Team mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-team-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const key = 'team-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], repeatLast: true,
    toolName: 'subagent', toolArguments: JSON.stringify({
      description: 'Fixture reviewer', name: 'fixture-reviewer', prompt: 'CHILD_DELEGATION_SENTINEL',
    }),
    successText: 'CHILD_RESULT_SENTINEL',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(join(root, 'home'), model.baseURL, key)
    pty = launch('pwsh.exe', cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    pty.send('/team\r')
    await pty.until('Team mode: off')
    pty.send('/team on\r')
    await pty.until('Team mode: on')
    pty.send('/agents\r')
    await pty.until('No delegated Agents in this session.')
    expect(model.requests).toHaveLength(0)
    pty.send('Delegate a review.\r')
    await pty.until('CHILD_RESULT_SENTINEL')
    const list = pty.mark()
    pty.send('/agents\r')
    await pty.until('Fixture reviewer', list)
    const history = pty.mark()
    pty.send('/agents history fixture-reviewer\r')
    await pty.until('CHILD_DELEGATION_SENTINEL', history)
    await pty.until('CHILD_RESULT_SENTINEL', history)
    pty.send('/agents send fixture-reviewer CHILD_FOLLOWUP_SENTINEL\r')
    await pty.until('Queued a message for fixture-reviewer')
    await vi.waitFor(() => {
      expect(JSON.stringify(model.requests.map(request => request.body))).toContain('CHILD_FOLLOWUP_SENTINEL')
    }, { timeout: 8_000 })
    const off = pty.mark()
    pty.send('/team off\r')
    await pty.until('Team mode: off', off)
    const other = pty.mark()
    pty.send('/new\r')
    await pty.until('No messages yet', other)
    pty.send('/agents send fixture-reviewer outside-root\r')
    await pty.until('No unique Agent matching fixture-reviewer in this session.')
    expect(JSON.stringify(model.requests.map(request => request.body))).not.toContain('outside-root')
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
})

it.runIf(process.platform === 'win32')('keeps two levels of delegated work and shared Team tasks in the original background Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-nested-team-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  await mkdir(cwd)
  const secondLevel = Promise.withResolvers<undefined>()
  const stoppedChild = Promise.withResolvers<undefined>()
  const sent = new Set<string>()
  const key = 'team-tree-fixture'
  function userContent(body: unknown): string {
    const request = body as { messages?: readonly { role: string; content: unknown }[] }
    return request.messages?.filter(message => message.role === 'user' && typeof message.content === 'string'
      && !message.content.startsWith('<system-reminder>')).map(message => message.content).join('\n') ?? ''
  }
  function delegate(name: string, description: string, prompt: string) {
    return { tool: 'subagent', arguments: JSON.stringify({ name, description, prompt }) }
  }
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['success'], repeatLast: true, successText: 'ROOT_TEAM_RECEIPT',
    responseForRequest(body) {
      const user = userContent(body)
      if (user.includes('NESTED_GRANDCHILD_PROMPT')) return { text: 'GRANDCHILD_VERIFICATION_RESULT' }
      if (user.includes('NESTED_CHILD_PROMPT')) {
        if (sent.has('child')) return { text: 'CHILD_REVIEW_RESULT' }
        sent.add('child')
        return delegate('fixture-verifier', 'Second-level verifier', 'NESTED_GRANDCHILD_PROMPT')
      }
      if (user.includes('ROOT_TREE_PROMPT')) {
        if (!sent.has('task')) {
          sent.add('task')
          return { tool: 'team_task_create', arguments: JSON.stringify({
            subject: 'SHARED_FIXTURE_TASK', description: 'Retain the shared task across a terminal restart',
          }) }
        }
        if (!sent.has('root')) {
          sent.add('root')
          return delegate('fixture-reviewer', 'First-level reviewer', 'NESTED_CHILD_PROMPT')
        }
      }
      return undefined
    },
    waitForResponse(request) {
      const content = userContent(request.body)
      if (content.includes('NESTED_CHILD_WAIT_STOP')) return stoppedChild.promise
      return content.includes('NESTED_GRANDCHILD_PROMPT') ? secondLevel.promise : Promise.resolve()
    },
  })
  let pty: ReturnType<typeof launch> | undefined
  let stop: (() => Promise<unknown>) | undefined
  try {
    const fixture = await terminalFixtureEnv(home, model.baseURL, key)
    const config = join(home, 'ds-cli-host-0.2', 'cordis.patch.yml')
    const patch = JSON.parse(await readFile(config, 'utf8')) as unknown[]
    await writeFile(config, JSON.stringify([...patch, { id: 'subagent', config: { maxDepth: 2 } }]))
    const env = await shellEnvironment(root, fixture)
    stop = () => execa(process.execPath, [env.DS_CLI_TEST_BIN!, 'host', 'stop', '--yes'], { cwd, env, timeout: 30000 })
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only', 'shared')
    await pty.until('read-only on')
    const id = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(id).toBeDefined()
    pty.send('/team on\r')
    await pty.until('Team mode: on')
    pty.send('ROOT_TREE_PROMPT\r')
    await vi.waitFor(() => {
      expect(model.requests.some(request => userContent(request.body).includes('NESTED_GRANDCHILD_PROMPT'))).toBe(true)
    }, { timeout: 18_000 })
    pty.send('/agents\r')
    await pty.until('First-level reviewer')
    try { await pty.until('Second-level verifier') } catch (error) {
      const state = await readTerminalHostState(terminalHostPaths(env).state)
      const signal = AbortSignal.timeout(7_000)
      let topology: unknown
      if (state?.phase === 'ready') {
        const { launchUrl } = await openTerminalHostCredentials(state.credentials, signal)
        const module = await import(terminalHost) as {
          connectTerminalHost(input: { cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv }, url: URL): Promise<TerminalHost>
        }
        const client = await module.connectTerminalHost({ cwd, env, signal }, new URL(launchUrl))
        try {
          const list = await client.remote.session.list({}, signal)
          topology = list.ok ? await Promise.all(list.value.items.map(async (item) => {
            const projection = await client.remote.session.projections({ sessionId: item.sessionId }, signal)
            return { session: item.sessionId, origin: item.origin, running: item.running,
              catalog: projection.ok ? projection.value?.values.subagentCatalog : projection.error.code }
          })) : list.error.code
        } finally { await client.detach() }
      }
      const wire = model.requests.map(request => ({
        attempt: request.attempt,
        user: userContent(request.body).slice(0, 280),
        outcome: request.outcome,
        behavior: request.behavior,
      }))
      throw new Error(`Delegation fixture requests: ${JSON.stringify(wire)}; topology: ${JSON.stringify(topology)}`, { cause: error })
    }
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
    secondLevel.resolve(undefined)
    pty = launch('pwsh.exe', cwd, env, `--resume ${id}`, 'shared')
    await pty.until('read-only on')
    pty.send('/agents history fixture-verifier\r')
    await pty.until('GRANDCHILD_VERIFICATION_RESULT')
    pty.send('/agents history fixture-reviewer\r')
    await pty.until('CHILD_REVIEW_RESULT')
    const stopAt = pty.mark()
    pty.send('/agents send fixture-verifier NESTED_CHILD_WAIT_STOP\r')
    await vi.waitFor(() => {
      expect(model.requests.some(request => userContent(request.body).includes('NESTED_CHILD_WAIT_STOP'))).toBe(true)
    }, { timeout: 15_000 })
    pty.send('/agents stop fixture-verifier\r')
    await pty.until('Stop Agent fixture-verifier?', stopAt)
    pty.send('\x1b[B')
    await pty.until('● Stop Agent', stopAt)
    pty.send('\r')
    await pty.until('Stop requested for fixture-verifier', stopAt)
    await vi.waitFor(() => {
      expect(model.requests.some(request => request.outcome === 'client_closed'
        && userContent(request.body).includes('NESTED_CHILD_WAIT_STOP'))).toBe(true)
    }, { timeout: 12_000 })
    pty.send('/team off\r')
    await pty.until('Team mode: off')
    await pty.until('SHARED_FIXTURE_TASK')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    secondLevel.resolve(undefined)
    stoppedChild.resolve(undefined)
    await pty?.stop()
    await stop?.().catch(() => {})
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 135_000)
