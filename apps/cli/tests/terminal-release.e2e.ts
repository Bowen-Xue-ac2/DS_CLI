import { mkdtemp, rm, stat } from 'node:fs/promises'
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
