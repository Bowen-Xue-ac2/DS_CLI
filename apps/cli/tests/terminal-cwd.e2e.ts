import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'

it('changes the live directory without changing the workspace or session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-cli-cwd-'))
  const project = join(dir, '项目 A')
  const cwd = join(project, '源文件夹')
  await mkdir(cwd, { recursive: true })
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(new URL('../lib/terminal-host.js', import.meta.url).href)})
      const { commitStart } = await import(${JSON.stringify(new URL('../lib/terminal-start.js', import.meta.url).href)})
      const host = await openTerminalHost({ cwd: process.cwd(), signal: AbortSignal.timeout(35_000) })
      try {
        const active = await commitStart(host, { workspacePath: ${JSON.stringify(project)}, cwd: process.cwd() }, 'session-terminal-cwd')
        const showing = requireHostResult(await host.remote.commands.execute(active.sessionId, '/ds-cli-cwd', [], host.signal))
        const rejected = requireHostResult(await host.remote.commands.execute(active.sessionId, '/ds-cli-cwd "missing"', [], host.signal))
        const still = requireHostResult(await host.remote.commands.execute(active.sessionId, '/ds-cli-cwd', [], host.signal))
        console.log(JSON.stringify({ active, showing, rejected, still }))
      } finally {
        await host.dispose()
      }
    `], { cwd, env: { DSH_HOME: join(dir, 'home') }, timeout: 45_000 })
    const { active, showing, rejected, still } = JSON.parse(stdout)
    expect(active).toMatchObject({ cwd, workspace: { path: project }, sessionId: 'session-terminal-cwd' })
    expect(showing.result).toMatchObject({ kind: 'success', text: cwd })
    expect(rejected.result.kind).toBe('error')
    expect(still.result.text).toBe(cwd)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it.runIf(process.platform === 'win32')('keeps workspace write permissions tied to the original project when the active directory changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-cwd-boundary-'))
  const project = join(root, '项目 A')
  const cwd = join(project, 'src')
  const outside = join(root, '项目 B')
  const temp = join(root, 'host-temp')
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(outside), mkdir(temp)])
  const key = 'ds-cli-test-cwd-boundary'
  const model = await startMockLlmServer({
    apiKey: key,
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success'],
    toolName: 'write',
    toolArguments: JSON.stringify({ file_path: 'marker.txt', content: 'SAFE_TEST_MARKER' }),
  })
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(new URL('../lib/terminal-host.js', import.meta.url).href)})
      const { changeDirectory, commitStart } = await import(${JSON.stringify(new URL('../lib/terminal-start.js', import.meta.url).href)})
      const { setSessionPermission } = await import(${JSON.stringify(new URL('../lib/terminal-permissions.js', import.meta.url).href)})
      const host = await openTerminalHost({ cwd: process.cwd(), signal: AbortSignal.timeout(35_000) })
      try {
        const { sessionId, workspace } = await commitStart(host, {
          workspacePath: ${JSON.stringify(project)}, cwd: process.cwd(),
        }, 'session-terminal-cwd-boundary')
        const events = host.remote.session.follow({ address: { kind: 'session', sessionId } }, host.signal)[Symbol.asyncIterator]()
        try {
          await events.next()
          async function write(requestId) {
            requireHostResult(await host.remote.session.prompt({
              sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: 'Create the test marker.' }],
            }, host.signal))
            let result
            while (true) {
              const frame = await events.next()
              if (frame.done) throw new Error('The session stream closed before turn end')
              if (frame.value.type !== 'event') continue
              const { type, data } = frame.value.event
              if (type === 'tool/result') result = data
              if (type === 'turn/end') return result
            }
          }
          await setSessionPermission(host, sessionId, 'read-only')
          const readOnly = await write('readonly-write')
          await setSessionPermission(host, sessionId, 'workspace-write')
          const changed = await changeDirectory(host, sessionId, ${JSON.stringify(outside)})
          const outOfScope = await write('outside-write')
          await changeDirectory(host, sessionId, process.cwd())
          const inScope = await write('inside-write')
          console.log(JSON.stringify({ sessionId, workspace: workspace.path, changed, readOnly, outOfScope, inScope }))
        } finally { await events.return() }
      } finally { await host.dispose() }
    `], {
      cwd,
      // workspace-write permits native temporary storage. Keep project B outside that grant.
      env: { ...await terminalFixtureEnv(join(root, 'home'), model.baseURL, key), TEMP: temp, TMP: temp },
      timeout: 42_000,
    })
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({
      sessionId: 'session-terminal-cwd-boundary', workspace: project, changed: outside,
      readOnly: { message: { isError: true } },
      outOfScope: { message: { isError: true } },
      inScope: { message: { isError: false } },
    })
    await expect(readFile(join(outside, 'marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toBe('SAFE_TEST_MARKER')
  } finally {
    await model.close()
    await rm(root, { recursive: true, force: true })
  }
})
