import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const consumer = process.env.DS_CLI_TEST_INSTALL_DIR
const bin = consumer === undefined
  ? fileURLToPath(new URL('../lib/bin.js', import.meta.url))
  : join(consumer, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

it('reports separate CLI and installed Host versions without initializing a profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-release-'))
  const home = join(root, 'home')
  try {
    const { stdout } = await execa(process.execPath, [bin, '--build-info'], {
      cwd: root,
      env: { DSH_HOME: home },
      timeout: 15_000,
    })
    expect(JSON.parse(stdout)).toEqual({
      cli: '0.1.0',
      revision: expect.stringMatching(/^[0-9a-f]{12}$/u),
      host: { expected: '0.2.2-rc.5', installed: '0.2.2-rc.5' },
    })
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('requires a terminal for bare dsh instead of starting a compatibility profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-non-tty-'))
  const home = join(root, 'home')
  try {
    const result = await execa(process.execPath, [bin], {
      cwd: root,
      env: { DSH_HOME: home },
      reject: false,
      timeout: 15_000,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('requires an interactive terminal')
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('recovers only a dead recorded Host and keeps its persisted data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-recovery-'))
  const home = join(root, 'home')
  const host = join(home, 'ds-cli-host-0.2')
  const directory = join(host, '.terminal-host')
  const file = join(directory, 'state.json')
  const lease = join(directory, 'lease')
  const data = join(host, 'fixture-session.jsonl')
  const generation = 'd1000000-0000-0000-0000-000000000000'
  const departed = await execa(process.execPath, ['-p', 'process.pid'], { cwd: root })
  const deadPid = Number(departed.stdout)
  const state = { version: 1, generation, supervisorPid: process.pid, pid: deadPid,
    runtime: 'fixture-runtime', patches: [], phase: 'ready', controlPort: 12345, credentials: '' }
  const command = () => execa(process.execPath, [bin, 'host', 'recover'], {
    cwd: root, env: { DSH_HOME: home }, reject: false, timeout: 15_000,
  })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(data, 'persisted session')
    await writeFile(lease, '')
    await writeFile(file, JSON.stringify(state))
    const refused = await command()
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('both processes exited')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state)
    await writeFile(file, JSON.stringify({ ...state, supervisorPid: deadPid }))
    const answers = await Promise.all([command(), command()])
    expect(answers.some(result => result.stdout.includes('"status":"recovered"'))).toBe(true)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lease)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(data, 'utf8')).toBe('persisted session')
    expect((await command()).stdout).toBe('{"status":"stopped"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
