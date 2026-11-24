import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32')('follows native Job byte offsets and runs a scheduled delivery in the same Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-automation-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const key = 'automation-fixture'
  let startedWorkflow = false
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], repeatLast: true,
    toolCalls: { 1: { name: 'pwsh', arguments: JSON.stringify({
      command: "Write-Output 'JOB_FIRST'; while (-not (Test-Path -LiteralPath 'release-job')) { Start-Sleep -Milliseconds 100 }; Write-Output 'JOB_FINAL'",
      description: 'Read-only background fixture', sandbox_permissions: 'workspace-write', justification: 'Fixture job',
      run_in_background: true,
    }) } },
    successText: 'MODEL_AUTOMATION_DONE',
    responseForRequest(body) {
      if (startedWorkflow || !JSON.stringify(body).includes('RUN_WORKFLOW_CHECK')) return
      startedWorkflow = true
      return { tool: 'workflow', arguments: JSON.stringify({
        meta: { name: 'automation-check', description: 'Verify the native workflow transcript' },
        script: 'log("workflow fixture"); return { marker: "WORKFLOW_REPLAY_SENTINEL" }',
      }) }
    },
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    const owner = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(owner).toBeDefined()
    pty.send('Start the background fixture.\r')
    await pty.until('Approve tool pwsh?')
    pty.send('\x1b[B')
    await pty.until('● Allow once')
    pty.send('\r')
    await pty.until('MODEL_AUTOMATION_DONE')
    let mark = pty.mark()
    pty.send('/jobs\r')
    await pty.until('· running ·', mark)
    const id = pty.output(mark).match(/(?:pwsh|bash)-[a-f0-9-]+(?= · running)/iu)?.[0]
    expect(id).toBeDefined()
    mark = pty.mark()
    pty.send('/ps\r')
    await pty.until(`Job ${id} · running`, mark)
    mark = pty.mark()
    pty.send('/new\r')
    await pty.until('No messages yet', mark)
    pty.send('/ps\r')
    await pty.until('No active background jobs or shells in this session', mark)
    pty.send(`/jobs stop ${id}\r`)
    await pty.until('Job is unavailable in this session', mark)
    await pty.until(`❯ /jobs stop ${id}`, mark)
    mark = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', mark)
    pty.send(`/resume ${owner}\r`)
    await pty.until('MODEL_AUTOMATION_DONE', mark)
    mark = pty.mark()
    pty.send(`/jobs follow ${id} 0\r`)
    await pty.until('JOB_FIRST', mark)
    const terminal = pty
    const offset = await vi.waitFor(() => {
      const next = terminal.output(mark).match(/→ byte (\d+)/u)?.[1]
      expect(next).toBeDefined()
      return next
    }, { timeout: 12_000 })
    expect(Number(offset)).toBeGreaterThan(0)
    mark = pty.mark()
    pty.send('/jobs detach\r')
    await pty.until('Detached from Job output', mark)
    pty.send(`/jobs follow ${id} ${offset}\r`)
    await pty.until(`reading from byte ${offset}`, mark)
    await writeFile(join(cwd, 'release-job'), '')
    await pty.until('JOB_FINAL', mark)
    await pty.until('· completed', mark)

    mark = pty.mark()
    pty.send('/schedule create\r')
    await pty.until('Schedule a message in this session', mark)
    pty.send('Local delivery check')
    await pty.until('Local delivery check', mark)
    pty.send('\t')
    await pty.until('› Seconds from now', mark)
    pty.send('\t')
    await pty.until('› Message', mark)
    pty.send('SCHEDULED_PROMPT_SENTINEL\r')
    await pty.until('· active', mark)
    const schedule = pty.output(mark).match(/Schedule (\S+) · active/u)?.[1]
    expect(schedule).toBeDefined()
    mark = pty.mark()
    pty.send(`/schedule run ${schedule}\r`)
    await pty.until(`run schedule ${schedule}`, mark)
    pty.send('\x1b[B')
    await pty.until('● Confirm', mark)
    pty.send('\r')
    await vi.waitFor(() => {
      expect(model.requests.some(request => request.outcome === 'completed'
        && JSON.stringify(request.body).includes('SCHEDULED_PROMPT_SENTINEL'))).toBe(true)
    }, { timeout: 15_000 })
    mark = pty.mark()
    pty.send(`/schedule history ${schedule}\r`)
    await pty.until(' · session-', mark)
    mark = pty.mark()
    pty.send('/schedule create after 3\r')
    await pty.until('Schedule a message in this session', mark)
    pty.send('Automatic delivery')
    await pty.until('Automatic delivery', mark)
    pty.send('\t')
    await pty.until('› Seconds from now', mark)
    pty.send('\t')
    await pty.until('› Message', mark)
    pty.send('SCHEDULE_TIMER_SENTINEL\r')
    await vi.waitFor(() => {
      expect(model.requests.some(request => request.outcome === 'completed'
        && JSON.stringify(request.body).includes('SCHEDULE_TIMER_SENTINEL'))).toBe(true)
    }, { timeout: 15_000 })
    mark = pty.mark()
    pty.send('RUN_WORKFLOW_CHECK\r')
    await pty.until('Workflow automation-check · started', mark)
    await vi.waitFor(() => {
      expect(model.requests.some(request => request.outcome === 'completed'
        && JSON.stringify(request.body).includes('Return value:')
        && JSON.stringify(request.body).includes('WORKFLOW_REPLAY_SENTINEL'))).toBe(true)
    }, { timeout: 15_000 })
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 135_000)

it.runIf(process.platform === 'win32')('detaches and rejoins an official persistent user shell before explicit close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-persistent-shell-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const key = 'terminal-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success'] })
  let pty: ReturnType<typeof launch> | undefined
  let stop: (() => Promise<unknown>) | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    stop = () => execa(process.execPath, [env.DS_CLI_TEST_BIN!, 'host', 'stop', '--yes'], { cwd, env, timeout: 30_000 })
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only', 'shared')
    await pty.until('read-only on', 0, 40_000)
    const sessionId = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(sessionId).toBeDefined()
    pty.send('/terminal new pwsh\r')
    await pty.until('Attaching shell')
    await pty.until('PS ')
    pty.send("\$dsCliFixture = 'STILL'; Write-Output ('SHELL_' + 'READY')\r")
    await pty.until('SHELL_READY')
    let mark = pty.mark()
    pty.send('~.')
    await pty.until('Detached from shell', mark)
    const id = pty.output(mark).match(/Detached from shell ([a-f0-9-]{36})/iu)?.[1]
    expect(id).toBeDefined()
    mark = pty.mark()
    pty.send('/ps\r')
    await pty.until(`Shell ${id} · running`, mark)
    pty.hangup()
    await pty.exit()
    pty = launch('bash.exe', cwd, env, `--resume ${sessionId}`, 'shared')
    await pty.until('read-only on', 0, 40_000)
    mark = pty.mark()
    pty.send(`/terminal ${id}\r`)
    await pty.until('Attaching shell', mark)
    await pty.until('SHELL_READY', mark)
    pty.send("Write-Output (\$dsCliFixture + '_THERE')\r")
    await pty.until('STILL_THERE', mark)
    mark = pty.mark()
    pty.send('~.')
    await pty.until('Detached from shell', mark)
    mark = pty.mark()
    pty.send(`/terminal close ${id}\r`)
    await pty.until('Close shell', mark)
    pty.send('\x1b[B')
    await pty.until('● Confirm', mark)
    pty.send('\r')
    await pty.until(`Closed shell ${id}`, mark)
    mark = pty.mark()
    pty.send('/terminal list\r')
    await pty.until('No retained terminals', mark)
    expect(model.requests).toHaveLength(0)
    pty.hangup()
    await pty.exit()
  } finally {
    await pty?.stop()
    await stop?.().catch(() => {})
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 120_000)
