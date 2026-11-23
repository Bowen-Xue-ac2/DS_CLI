import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { consumer, launch, shellEnvironment, terminalHost } from './terminal-tty.ts'

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s starts bare dsh from a known subdirectory and chooses an Agent for a new directory',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'ds-cli-tty-'))
    const a = join(root, '项目 A')
    const sub = join(a, 'src')
    const b = join(root, '项目 B')
    const home = join(root, 'home')
    await Promise.all([mkdir(sub, { recursive: true }), mkdir(b)])
    const sentinel = 'TOOL_READ_FROM_PROJECT_A_SRC'
    const rootSentinel = 'TOOL_READ_FROM_PROJECT_A_ROOT'
    await writeFile(join(a, 'sentinel.txt'), rootSentinel)
    await writeFile(join(sub, 'sentinel.txt'), sentinel)
    const key = 'ds-cli-tty-mock'
    const server = await startMockLlmServer({
      apiKey: key, sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'], repeatLast: true,
      toolName: 'pwsh',
      toolArguments: JSON.stringify({
        command: "Get-Content -LiteralPath 'sentinel.txt'",
        description: 'Read the sentinel from the active directory',
      }),
      successText: 'SHELL_VERIFIED',
    })
    const env = await terminalFixtureEnv(home, server.baseURL, key)
    await writeFile(join(home, 'ds-cli-host-0.2', 'settings.yaml'), 'permission:\n  defaultPreset: read-only\n')
    const sessions: ReturnType<typeof launch>[] = []
    function latestToolOutput(): string {
      const request = server.requests.at(-1)?.body as { messages?: { role: string; content?: string }[] } | undefined
      return request?.messages?.filter(message => message.role === 'tool').map(message => message.content ?? '').join('\n') ?? ''
    }
    try {
      const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
        const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(terminalHost)})
        const { permissionCatalog } = await import(${JSON.stringify(new URL('../lib/terminal-permissions.js', import.meta.url).href)})
        const host = await openTerminalHost({ cwd: process.cwd(), signal: AbortSignal.timeout(20_000) })
        try {
          await host.registerWorkspace(process.cwd())
          if ((await permissionCatalog(host)).defaultPreset !== 'read-only') throw new Error('The Host did not load the fixture permission')
          console.log(JSON.stringify(requireHostResult(await host.remote.agentPresets.list()).presets))
        } finally { await host.dispose() }
      `], { cwd: a, env, timeout: 25_000 })
      const presets = (JSON.parse(stdout) as { id: string; name?: string; isDefault: boolean; broken?: string }[])
        .filter(preset => !preset.broken)
      const current = presets.findIndex(preset => preset.isDefault)
      if (current === -1 || presets.length < 2) throw new Error('Host did not supply two healthy Agents')
      const next = presets[(current + 1) % presets.length]
      if (next === undefined) throw new Error('Missing Agent choice')
      const vars = await shellEnvironment(root, env)
      const open = (cwd: string, args?: string) => {
        const pty = launch(shell, cwd, vars, args)
        sessions.push(pty)
        return pty
      }

      const known = open(sub)
      await known.until('Workspace 项目 A')
      await known.until(sub)
      await known.until('read-only on')
      expect(known.output()).not.toContain('Choose workspace and Agent')
      const entry = consumer === undefined ? '/shim/dsh' : '/node_modules/.bin/dsh'
      expect(known.output().replaceAll('\\', '/')).toContain(entry)
      known.send('Read the local sentinel.\r')
      await known.until('SHELL_VERIFIED')
      expect(latestToolOutput()).toContain(sentinel)
      const beforeCd = known.mark()
      known.send('/cd ..\r')
      await known.until('Directory ' + a, beforeCd)
      const afterCd = known.mark()
      known.send('Read the sentinel again after changing directories.\r')
      await vi.waitFor(() => { expect(latestToolOutput()).toContain(rootSentinel) }, { timeout: 18_000 })
      await known.until('SHELL_VERIFIED', afterCd)
      const sessionA = known.output().match(/session-[\da-f-]{36}/u)?.[0]
      if (sessionA === undefined) throw new Error('The terminal did not show the project A session ID')
      known.send('/exit\r')
      expect(await known.exit()).toBe(0)

      const cancelled = open(b)
      await cancelled.until('Choose workspace and Agent')
      cancelled.send('\t')
      await cancelled.until('› Agent')
      cancelled.send('\x1b')
      expect(await cancelled.exit()).toBe(0)

      const fresh = open(b)
      await fresh.until('Choose workspace and Agent')
      fresh.send('\t')
      await fresh.until('› Agent')
      fresh.send('\x1b[B')
      await fresh.until('● ' + (next.name ?? next.id))
      fresh.send('\r')
      await fresh.until('Workspace 项目 B')
      await fresh.until('mode: ' + next.id)
      await fresh.until('read-only on')
      fresh.send('/permission workspace-write\r')
      await fresh.until('workspace-write on')
      fresh.send('Reply from the chosen Agent.\r')
      await fresh.until('SHELL_VERIFIED')
      expect(JSON.stringify(server.requests.map(request => request.body))).toContain('Reply from the chosen Agent.')
      const sessionId = fresh.output().match(/session-[\da-f-]{36}/u)?.[0]
      if (sessionId === undefined) throw new Error('The terminal did not show the created session ID')
      fresh.send('/exit\r')
      expect(await fresh.exit()).toBe(0)

      const resumed = open(b, '--resume ' + sessionId)
      await resumed.until('Workspace 项目 B')
      await resumed.until(sessionId)
      await resumed.until('mode: ' + next.id)
      await resumed.until('workspace-write on')
      await resumed.until('Reply from the chosen Agent.')
      const requestsBeforeNavigation = server.requests.length
      const beforeSearch = resumed.mark()
      resumed.send('/sessions ' + sessionA + '\r')
      await resumed.until('Choose a session', beforeSearch)
      await resumed.until('Read the local sentinel.', beforeSearch)
      resumed.send('\x1b')
      await resumed.until(sessionId, beforeSearch)
      const beforeResume = resumed.mark()
      resumed.send('/sessions ' + sessionA + '\r')
      await resumed.until('Choose a session', beforeResume)
      resumed.send('\r')
      await resumed.until('Workspace 项目 A', beforeResume)
      await resumed.until('Read the sentinel again after changing directories.', beforeResume)
      expect(server.requests.length).toBe(requestsBeforeNavigation)
      resumed.send('/exit\r')
      expect(await resumed.exit()).toBe(0)

      const reopened = open(b)
      await reopened.until('Workspace 项目 B')
      await reopened.until('read-only on')
      expect(reopened.output()).not.toContain('Choose workspace and Agent')
      const beforeSwitch = reopened.mark()
      reopened.send('/workspace\r')
      await reopened.until('Choose workspace and Agent', beforeSwitch)
      const beforeSelection = reopened.mark()
      reopened.send('\x1b[B')
      await vi.waitFor(() => {
        expect(reopened.output().slice(-1_500)).toMatch(/● 项目 [AB]/u)
      }, { timeout: 10_000 })
      if (!reopened.output().slice(-1_500).includes('● 项目 A')) reopened.send('\x1b[B')
      await reopened.until('● 项目 A', beforeSelection)
      reopened.send('\r')
      await reopened.until('Open workspace', beforeSelection)
      reopened.send('\r')
      await reopened.until('Choose a session', beforeSelection)
      reopened.send('\r')
      await reopened.until('Workspace 项目 A', beforeSwitch)
      await reopened.until('Directory ' + a, beforeSwitch)
      reopened.send('/exit\r')
      expect(await reopened.exit()).toBe(0)

      const chooser = open(b, '--choose')
      await chooser.until('Choose workspace and Agent')
      chooser.send('\t')
      await chooser.until('› Agent')
      chooser.send('\x1b')
      expect(await chooser.exit()).toBe(0)
    } finally {
      for (const session of sessions) await session.stop()
      await server.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
  115_000,
)

it.runIf(process.platform === 'win32')('answers the native approval in the terminal and keeps its keys out of chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-approval-tty-'))
  const cwd = join(root, 'workspace')
  const file = join(cwd, 'counter.txt')
  await mkdir(cwd)
  await writeFile(file, 'before\n')
  const key = 'ds-cli-approval-tty-fixture'
  const command = "Add-Content -LiteralPath 'counter.txt' -Value approved"
  const server = await startMockLlmServer({
    apiKey: key,
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success'],
    toolName: 'pwsh',
    toolArguments: JSON.stringify({
      command,
      description: 'Append one test line',
      sandbox_permissions: 'workspace-write',
      justification: 'Write one line to the test counter.',
    }),
    successText: 'APPROVAL_TURN_COMPLETE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await terminalFixtureEnv(join(root, 'home'), server.baseURL, key)
    const terminal = launch('pwsh.exe', cwd, await shellEnvironment(root, env), '--cwd . --permission read-only')
    pty = terminal
    await terminal.until('read-only on')
    let requestCount = 0
    for (const [prompt, decision] of [
      ['Request the first write.', '\x1b'],
      ['Request the second write.', '\r'],
      ['Request the third write.', '\x03'],
    ] as const) {
      const before = terminal.mark()
      terminal.send(prompt + '\r')
      await terminal.until('Approve tool pwsh?', before)
      await terminal.until(command, before)
      if (decision === '\r') {
        terminal.send('ignored-menu-input')
        await new Promise(resolve => setTimeout(resolve, 60))
        terminal.send('\x1b[B')
        await terminal.until('● Allow once', before)
      }
      terminal.send(decision)
      requestCount += 2
      await vi.waitFor(() => { expect(server.requests).toHaveLength(requestCount) }, { timeout: 18_000 })
      await terminal.until('APPROVAL_TURN_COMPLETE', before)
      const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/)
      expect(lines).toEqual(requestCount === 2 ? ['before'] : ['before', 'approved'])
    }
    expect(terminal.output()).not.toContain('ignored-menu-input')
    terminal.send('/exit\r')
    expect(await terminal.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 75_000)
