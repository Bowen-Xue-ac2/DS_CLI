import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s reattaches to the original background Host and a turn that finished after exit',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'dscli-background-'))
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const gate = Promise.withResolvers<undefined>()
    const approvalGate = Promise.withResolvers<undefined>()
    const protectedFile = join(cwd, 'protected.txt')
    const original = 'BACKGROUND_READ_FROM_WORKSPACE\n'
    await writeFile(protectedFile, original)
    const key = 'background-fixture'
    const model = await startMockLlmServer({
      apiKey: key, sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'], successText: 'BACKGROUND_TURN_FINISHED',
      toolCalls: {
        1: { name: 'read', arguments: JSON.stringify({ file_path: 'protected.txt' }) },
        3: { name: 'pwsh', arguments: JSON.stringify({
          command: "Add-Content -LiteralPath 'protected.txt' -Value modified",
          description: 'Fixture write', sandbox_permissions: 'workspace-write', justification: 'Test no Peer approval',
        }) },
      },
      waitForResponse: request => request.attempt === 1 ? gate.promise : request.attempt === 3 ? approvalGate.promise : Promise.resolve(),
    })
    let peer: ReturnType<typeof launch> | undefined
    let other: ReturnType<typeof launch> | undefined
    let command: ((args: string[]) => Promise<string>) | undefined
    try {
      const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
      const bin = env.DS_CLI_TEST_BIN
      if (bin === undefined) throw new Error('Missing built terminal entry')
      command = async args => (await execa(process.execPath, [bin, ...args], { cwd, env, timeout: 30000 })).stdout
      expect(JSON.parse(await command(['host', 'status']))).toEqual({ status: 'stopped' })
      peer = launch(shell, cwd, env, '--cwd . --mode standard --permission read-only', 'shared')
      other = launch(shell, cwd, env, '--cwd . --mode standard --permission read-only', 'shared')
      await Promise.all([peer.until('read-only on', 0, 40_000), other.until('read-only on', 0, 40_000)])
      const first = JSON.parse(await command(['host', 'status']))
      expect(first).toMatchObject({ status: 'ready', generation: expect.any(String), pid: expect.any(Number) })
      const rawState = await readFile(join(root, 'home', 'ds-cli-host-0.2', '.terminal-host', 'state.json'), 'utf8')
      const { controlPort, credentials } = JSON.parse(rawState) as { controlPort: number; credentials: string }
      expect(rawState.includes('token=')).toBe(false)
      expect(Buffer.from(credentials, 'base64').toString('utf8').includes('launchUrl')).toBe(false)
      const refused = await fetch(`http://127.0.0.1:${controlPort}/stop/${first.generation}`, {
        method: 'POST', signal: AbortSignal.timeout(3_000),
      })
      expect(refused.status).toBe(404)
      await expect(command(['host', 'stop'])).rejects.toThrow('Use dsh host stop --yes')
      const sessionId = peer.output().match(/session-[\da-f-]{36}/u)?.[0]
      expect(sessionId).toBeDefined()
      other.send('/exit\r')
      expect(await other.exit()).toBe(0)
      if (shell === 'pwsh.exe') {
        await writeFile(join(cwd, 'other-overlay.yml'), '[]\n')
        other = launch(shell, cwd, env, 'cli --patch other-overlay.yml --cwd . --mode standard --permission read-only', 'shared')
        await other.until('different runtime or patch set')
        expect(await other.exit()).toBe(1)
        expect(await command(['host', 'status'])).toContain(first.generation)
      }
      peer.send('Finish the fixture after this terminal exits.\r')
      await vi.waitFor(() => { expect(model.requests).toHaveLength(1) }, { timeout: 12000 })
      expect(model.requests[0]?.outcome).toBeUndefined()
      if (shell === 'bash.exe') {
        peer.hangup()
        await peer.exit()
      } else {
        peer.send('/exit\r')
        expect(await peer.exit()).toBe(0)
      }
      gate.resolve(undefined)
      await vi.waitFor(() => { expect(model.requests[1]?.outcome).toBe('completed') }, { timeout: 12000 })
      expect(JSON.stringify(model.requests[1]?.body)).toContain(original.trim())
      peer = launch(shell, cwd, env, `--resume ${sessionId}`, 'shared')
      await peer.until('BACKGROUND_TURN_FINISHED')
      expect(await command(['host', 'status'])).toContain(first.generation)
      expect(model.requests).toHaveLength(2)
      if (shell === 'pwsh.exe') {
        const handoff = await command(['host', 'open', '--session', sessionId!, '--print-url'])
        const target = new URL(handoff)
        expect(target.origin).toBe(`http://127.0.0.1:${controlPort}`)
        const otherSession = 'session-00000000-0000-0000-0000-000000000000'
        await expect(command(['host', 'open', '--session', otherSession, '--print-url'])).rejects.toThrow('HTTP 404')
        const substituted = new URL(target.pathname.replace(sessionId!, otherSession), target.origin)
        expect((await fetch(substituted, { redirect: 'manual' })).status).toBe(404)
        const redirect = await fetch(target, { redirect: 'manual' })
        expect(redirect.status).toBe(303)
        const web = new URL(redirect.headers.get('location')!)
        expect(web.hash).toBe(`#dsh-cli=${sessionId}`)
        expect(web.search).toBe('')
        const cookie = redirect.headers.getSetCookie()[0]?.split(';', 1)[0]
        expect(cookie).toBeDefined()
        const index = await fetch(web, { headers: { cookie: cookie! } })
        expect(index.status).toBe(200)
        expect(await index.text()).toContain('@ds-cli/browser-handoff')
        const transcript = await fetch(new URL(`/api/session.markdown?sessionId=${sessionId}`, web), { headers: { cookie: cookie! } })
        expect(await transcript.text()).toContain('BACKGROUND_TURN_FINISHED')
        expect((await fetch(target, { redirect: 'manual' })).status).toBe(404)
      }
      peer.send('Try the protected write after disconnect.\r')
      await vi.waitFor(() => { expect(model.requests).toHaveLength(3) }, { timeout: 12000 })
      peer.send('/exit\r')
      expect(await peer.exit()).toBe(0)
      approvalGate.resolve(undefined)
      await vi.waitFor(() => { expect(model.requests[2]?.outcome).toBe('completed') }, { timeout: 12000 })
      expect(await readFile(protectedFile, 'utf8')).toBe(original)
      peer = launch(shell, cwd, env, `--resume ${sessionId}`, 'shared')
      const attached = peer
      await vi.waitFor(() => { expect(attached.output()).toMatch(/Approve tool pwsh\?|⇣ 1 tool · pwsh/u) }, { timeout: 24_000 })
      if (peer.output().includes('Approve tool pwsh?')) peer.send('\x1b')
      expect(await readFile(protectedFile, 'utf8')).toBe(original)
      peer.send('/exit\r')
      expect(await peer.exit()).toBe(0)
      const stopped = JSON.parse(await command(['host', 'stop', '--yes']))
      expect(stopped).toMatchObject({ status: 'stopped', generation: first.generation })
      expect(JSON.parse(await command(['host', 'status']))).toEqual({ status: 'stopped' })
      if (shell === 'pwsh.exe') {
        const stateFile = join(root, 'home', 'ds-cli-host-0.2', '.terminal-host', 'state.json')
        await writeFile(stateFile, rawState, { flag: 'wx' })
        expect(JSON.parse(await command(['host', 'status']))).toMatchObject({ status: 'stale', generation: first.generation })
        await expect(command(['host', 'stop', '--yes'])).rejects.toThrow()
        expect(await readFile(stateFile, 'utf8')).toBe(rawState)
        const received: (string | undefined)[] = []
        const otherListener = createServer((request, response) => {
          received.push(request.headers.authorization)
          response.writeHead(200, { 'content-length': 43 }).end('x'.repeat(43))
        })
        try {
          await new Promise<void>((ready, reject) => {
            otherListener.once('error', reject)
            otherListener.listen(0, '127.0.0.1', ready)
          })
          const address = otherListener.address()
          if (address === null || typeof address === 'string') throw new Error('Failed to allocate a test listener')
          await writeFile(stateFile, JSON.stringify({
            ...JSON.parse(rawState), pid: process.pid, supervisorPid: process.pid, controlPort: address.port,
          }))
          expect(JSON.parse(await command(['host', 'status']))).toMatchObject({ status: 'stale' })
          await expect(command(['host', 'stop', '--yes'])).rejects.toThrow()
          expect(received).toEqual([undefined, undefined])
        } finally {
          await new Promise<void>((resolve) => { otherListener.close(() => { resolve() }) })
        }
      }
    } finally {
      gate.resolve(undefined)
      approvalGate.resolve(undefined)
      await peer?.stop()
      await other?.stop()
      await command?.(['host', 'stop', '--yes']).catch(() => {})
      await model.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
  120_000,
)
