import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { startMcpHttpFixture } from './fixtures/terminal-mcp-http.ts'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment, terminalHost } from './terminal-tty.ts'

const script = fileURLToPath(new URL('./fixtures/terminal-mcp-server.mjs', import.meta.url))

it.runIf(process.platform === 'win32')('configures a streamable HTTP MCP with a credential reference and controls its live state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-mcp-http-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  await mkdir(cwd)
  const credential = 'private-fixture-MCP_93054'
  const http = await startMcpHttpFixture(credential)
  const key = 'connector-http-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: [
      'tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success',
    ],
    toolCalls: {
      1: { name: 'mcp__http_fixture__read_status', arguments: '{}' },
      3: { name: 'list_mcp_resources', arguments: '{"server":"http_fixture"}' },
      5: { name: 'read_mcp_resource', arguments: '{"server":"http_fixture","uri":"fixture://http/readme"}' },
      7: { name: 'list_mcp_resource_templates', arguments: '{"server":"http_fixture"}' },
    },
    successText: 'HTTP_CONNECTOR_DONE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(home, model.baseURL, key)
    await writeFile(join(cwd, 'connector config.json'), JSON.stringify({
      transport: 'streamable-http', url: http.url, enabled: false, startupTimeoutMs: 4000,
      headers: { Authorization: 'Bearer ${credential:DS_CLI_MCP_FIXTURE_AUTH}' },
    }))
    pty = launch('pwsh.exe', cwd, await shellEnvironment(root, { ...env, DS_CLI_MCP_FIXTURE_AUTH: credential }),
      '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    pty.send('/mcp configure http_fixture "connector config.json"\r')
    await pty.until('Save MCP configuration for http_fixture?')
    pty.send('\x1b[B')
    await pty.until('● Save')
    pty.send('\r')
    await pty.until('http_fixture: configuration saved')
    expect(http.calls).toEqual([])
    pty.send('/mcp enable http_fixture\r')
    await pty.until('Enable MCP server http_fixture?')
    const cancel = pty.mark()
    pty.send('\x1b')
    await pty.until('Enable cancelled', cancel)
    expect(http.calls).toEqual([])
    const enable = pty.mark()
    pty.send('/mcp enable http_fixture\r')
    await pty.until('Enable MCP server http_fixture?', enable)
    pty.send('\x1b[B')
    await pty.until('● Enable', enable)
    pty.send('\r')
    await pty.until('http_fixture: enabled', enable)
    await vi.waitFor(() => { expect(http.calls).toContain('tools/list') }, { timeout: 8000 })
    pty.send('Check @connector:http_fixture')
    await pty.until('http_fixture · MCP connector')
    const pick = pty.mark()
    pty.send('\t')
    await pty.until('❯ Check @connector:http_fixture', pick)
    pty.send('\r')
    await pty.until('HTTP_CONNECTOR_DONE', pick)
    expect(http.calls.filter(method => method === 'tools/call')).toHaveLength(1)
    expect(JSON.stringify(model.requests.map(request => request.body))).toContain('HTTP_CONNECTOR_STATUS')
    pty.send('/mcp resources http_fixture\r')
    await vi.waitFor(() => { expect(model.requests[3]?.outcome).toBe('completed') }, { timeout: 8000 })
    const resourceMenu = pty.mark()
    pty.send('Summarize @connector:http_fixture/read')
    await pty.until('HTTP fixture · MCP resource', resourceMenu)
    const resourcePick = pty.mark()
    pty.send('\t')
    await pty.until('@connector:http_fixture/fixture%3A', resourcePick)
    expect(http.calls).not.toContain('resources/read')
    pty.send('\r')
    await vi.waitFor(() => { expect(model.requests[5]?.outcome).toBe('completed') }, { timeout: 8000 })
    expect(http.calls.filter(method => method === 'resources/read')).toHaveLength(1)
    expect(JSON.stringify(model.requests.map(request => request.body))).toContain('HTTP_RESOURCE_SENTINEL')
    pty.send('/mcp templates http_fixture\r')
    await vi.waitFor(() => { expect(model.requests[7]?.outcome).toBe('completed') }, { timeout: 8000 })
    expect(http.calls.filter(method => method === 'resources/templates/list')).toHaveLength(1)
    expect(JSON.stringify(model.requests[7]?.body)).toContain('HTTP_FIXTURE_TEMPLATE')
    pty.send('/mcp disable http_fixture\r')
    await pty.until('Disable MCP server http_fixture?')
    pty.send('\x1b[B')
    await pty.until('● Disable')
    pty.send('\r')
    await pty.until('http_fixture: disabled')
    const list = pty.mark()
    pty.send('/mcp\r')
    await pty.until('http_fixture  disabled', list)
    const saved = await readFile(join(home, 'ds-cli-host-0.2', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(saved).toContain('credential:DS_CLI_MCP_FIXTURE_AUTH')
    expect(saved + pty.output() + JSON.stringify(model.requests.map(request => request.body))).not.toContain(credential)
    const lastCalls = http.calls.length
    await writeFile(join(cwd, 'missing-credential.json'), JSON.stringify({
      transport: 'streamable-http', url: http.url, enabled: true,
      headers: { Authorization: 'Bearer ${credential:DS_CLI_MCP_FIXTURE_MISSING}' },
    }))
    const missing = pty.mark()
    pty.send('/mcp configure http_fixture missing-credential.json\r')
    await pty.until('Save MCP configuration for http_fixture?', missing)
    pty.send('\x1b[B')
    await pty.until('● Save', missing)
    pty.send('\r')
    await pty.until('http_fixture: configuration saved', missing)
    const terminal = pty
    await vi.waitFor(() => {
      if (!terminal.output(missing).includes('http_fixture  waiting-credentials')) terminal.send('/mcp\r')
      expect(terminal.output(missing)).toContain('http_fixture  waiting-credentials')
    }, { interval: 250, timeout: 8_000 })
    expect(http.calls).toHaveLength(lastCalls)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await http.close()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
})

async function configureServers(home: string, readyLog: string, parkedLog: string): Promise<void> {
  const patchPath = join(home, 'ds-cli-host-0.2', 'cordis.patch.yml')
  const patch: unknown[] = JSON.parse(await readFile(patchPath, 'utf8'))
  const fixture = { transport: 'stdio', command: process.execPath }
  await writeFile(patchPath, JSON.stringify([...patch, {
    id: 'mcp-manager', config: { servers: {
      ready: { ...fixture, args: [script, readyLog] },
      parked: { ...fixture, args: [script, parkedLog], enabled: false },
    } },
  }]))
}

it.runIf(process.platform === 'win32')('runs a native MCP action only after one-shot approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-mcp-approval-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  await mkdir(cwd)
  const key = 'mcp-approval-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    toolName: 'mcp__ready__fixture_status', toolArguments: '{}', successText: 'MCP_APPROVAL_TURN_DONE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(home, model.baseURL, key)
    const readyLog = join(root, 'ready.log')
    await configureServers(home, readyLog, join(root, 'parked.log'))
    const patchPath = join(home, 'ds-cli-host-0.2', 'cordis.patch.yml')
    const patch: unknown[] = JSON.parse(await readFile(patchPath, 'utf8'))
    const gate = fileURLToPath(new URL('./fixtures/terminal-mcp-approval.mjs', import.meta.url))
    await writeFile(patchPath, JSON.stringify([...patch, { insert: [{ id: 'fixture-mcp-approval', name: gate }] }]))
    pty = launch('pwsh.exe', cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    pty.send('/mcp\r')
    await pty.until('ready  connected')
    for (const [message, allow, count] of [
      ['First MCP action.', false, 2], ['Second MCP action.', true, 4],
    ] as const) {
      const before = pty.mark()
      pty.send(message + '\r')
      await pty.until('Approve tool mcp__ready__fixture_status?', before)
      if (allow) {
        pty.send('\x1b[B')
        await pty.until('● Allow once', before)
      }
      pty.send(allow ? '\r' : '\x1b')
      await vi.waitFor(() => { expect(model.requests[count - 1]?.outcome).toBe('completed') }, { timeout: 8000 })
      expect(await readFile(readyLog, 'utf8')).toBe(allow ? 'initialized\ncalled\n' : 'initialized\n')
    }
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
})

it.runIf(process.platform === 'win32')('discovers and reads a native MCP resource only after explicit submissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-mcp-resource-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  await mkdir(cwd)
  const key = 'connector-resource-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    toolCalls: {
      1: { name: 'list_mcp_resources', arguments: '{"server":"ready"}' },
      3: { name: 'read_mcp_resource', arguments: '{"server":"ready","uri":"fixture://local/readme"}' },
    },
    successText: 'RESOURCE_TURN_DONE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(home, model.baseURL, key)
    const readyLog = join(root, 'ready.log')
    await configureServers(home, readyLog, join(root, 'parked.log'))
    pty = launch('pwsh.exe', cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    pty.send('/mcp\r')
    await pty.until('ready  connected')
    pty.send('/mcp resources ready\r')
    await pty.until('RESOURCE_TURN_DONE')
    expect(await readFile(readyLog, 'utf8')).toBe('initialized\nresources-listed\n')
    pty.send('Summarize @connector:ready/read')
    await pty.until('Fixture readme · MCP resource')
    const cancel = pty.mark()
    pty.send('\x1b')
    await pty.until('❯ Summarize @connector:ready/read', cancel)
    expect(model.requests).toHaveLength(2)
    const repick = pty.mark()
    pty.send('m')
    await pty.until('Fixture readme · MCP resource', repick)
    const pick = pty.mark()
    pty.send('\t')
    await pty.until('@connector:ready/fixture%3A', pick)
    expect(await readFile(readyLog, 'utf8')).toBe('initialized\nresources-listed\n')
    pty.send('\r')
    await vi.waitFor(async () => {
      expect(await readFile(readyLog, 'utf8')).toBe('initialized\nresources-listed\nresource-read\n')
      expect(model.requests[3]?.outcome).toBe('completed')
    }, { timeout: 8_000 })
    const wire = JSON.stringify(model.requests.slice(2).map(request => request.body))
    expect(wire).toContain('fixture://local/readme')
    expect(wire).toContain('MCP_RESOURCE_SENTINEL')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
})

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
      const readyLog = join(root, 'ready.log')
      const parkedLog = join(root, 'parked.log')
      await configureServers(home, readyLog, parkedLog)
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

it('catalog verifies native tool visibility and detects a replaced connection in the same Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-mcp-scope-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  await mkdir(cwd)
  const key = 'connector-scope-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success'] })
  try {
    const env = await terminalFixtureEnv(home, model.baseURL, key)
    await configureServers(home, join(root, 'ready.log'), join(root, 'parked.log'))
    const patch = join(root, 'restriction.yml')
    const restriction = fileURLToPath(new URL('./fixtures/terminal-mcp-restriction.mjs', import.meta.url))
    await writeFile(patch, JSON.stringify([{ insert: [{
      id: 'terminal-mcp-restriction', name: restriction, config: { script, log: join(root, 'private.log') },
    }] }]))
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult: requireResult } = await import(${JSON.stringify(terminalHost)})
      const signal = AbortSignal.timeout(50_000)
      const host = await openTerminalHost({ cwd: process.cwd(), signal, patchFiles: [${JSON.stringify(patch)}] })
      try {
        const remote = host.remote
        const waitForConnection = async () => {
          for await (const rows of remote.mcpManager.watch(signal)) {
            if (rows.some(row => row.name === 'ready' && row.status.state === 'connected')) return
          }
          throw new Error('MCP status stream ended')
        }
        await waitForConnection()
        const { workspace } = await host.registerWorkspace(process.cwd())
        for (const sessionId of ['session-mcp-allowed', 'session-mcp-blocked']) {
          requireResult(await remote.session.create({ workspaceId: workspace.workspaceId, sessionId, agentPreset: 'standard' }))
          for await (const frame of remote.session.follow({ address: { kind: 'session', sessionId }, activate: true }, signal)) {
            if (frame.type === 'snapshot') break
          }
        }
        const list = async (sessionId) => requireResult(await remote.terminalConnectors.list(sessionId, signal))
        const before = await list('session-mcp-allowed')
        const blocked = await list('session-mcp-blocked')
        requireResult(await remote.mcpManager.restart('ready'))
        await waitForConnection()
        const after = await list('session-mcp-allowed')
        console.log(JSON.stringify({ before, blocked, after }))
      } finally {
        await host.dispose()
      }
    `], { cwd, env, timeout: 55_000 })
    const { before, blocked, after } = JSON.parse(stdout)
    const match = [
      expect.objectContaining({ id: 'ready', origin: 'host', tools: ['mcp__ready__fixture_status'] }),
      expect.objectContaining({ id: 'private_fixture', origin: 'agent', tools: ['mcp__private_fixture__fixture_status'] }),
    ]
    expect(before).toHaveLength(2)
    expect(before).toEqual(expect.arrayContaining(match))
    expect(blocked).toEqual([])
    expect(after).toEqual(expect.arrayContaining(match))
    expect(after.find((row: { id: string }) => row.id === 'ready')?.generation)
      .toBeGreaterThan(before.find((row: { id: string }) => row.id === 'ready')?.generation)
    expect(model.requests).toHaveLength(0)
  } finally {
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
})

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s completes and explicitly uses a connected MCP tool in chat',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'dscli-mcp-reference-'))
    const cwd = join(root, 'work')
    const home = join(root, 'home')
    await mkdir(cwd)
    const key = 'connector-reference-fixture'
    const model = await startMockLlmServer({
      apiKey: key, sequence: ['tool_call_success', 'success'],
      toolName: 'mcp__ready__fixture_status', toolArguments: '{}', successText: 'CONNECTOR_TURN_DONE',
    })
    let pty: ReturnType<typeof launch> | undefined
    try {
      const env = await terminalFixtureEnv(home, model.baseURL, key)
      const readyLog = join(root, 'ready.log')
      const parkedLog = join(root, 'parked.log')
      await configureServers(home, readyLog, parkedLog)
      pty = launch(shell, cwd, await shellEnvironment(root, env), '--cwd . --mode standard --permission read-only')
      await pty.until('read-only on')
      pty.send('/mcp\r')
      await pty.until('ready  connected')
      const edit = pty.mark()
      pty.send('Check @connector:ready')
      await pty.until('❯ Check @connector:ready', edit)
      await pty.until('ready · MCP connector', edit)
      const cancelled = pty.mark()
      pty.send('\x1b')
      await pty.until('❯ Check @connector:ready', cancelled)
      expect(model.requests).toHaveLength(0)
      pty.send('\r')
      await pty.until('Pick the MCP connector from completion')
      expect(model.requests).toHaveLength(0)
      const repick = pty.mark()
      pty.send('\x7f')
      await pty.until('ready · MCP connector', repick)
      const pick = pty.mark()
      pty.send('\t')
      await pty.until('❯ Check @connector:ready', pick)
      expect(model.requests).toHaveLength(0)
      expect(await readFile(readyLog, 'utf8')).toBe('initialized\n')
      pty.send('\r')
      await pty.until('CONNECTOR_TURN_DONE')
      expect(await readFile(readyLog, 'utf8')).toBe('initialized\ncalled\n')
      const wire = JSON.stringify(model.requests.map(request => request.body))
      expect(wire).toContain('Use the tools from the selected MCP connector')
      expect(wire).toContain('MCP_FIXTURE_STATUS')
      expect(wire).not.toContain('mcp__parked__fixture_status')
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
    } finally {
      await pty?.stop()
      await model.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
)
