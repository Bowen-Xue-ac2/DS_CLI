import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const hostEntry = new URL('../lib/terminal-host.js', import.meta.url).href

it('registers and reads a workspace through the rc.5 Host from a real caller cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-host-'))
  const cwd = join(root, '项目 A')
  await mkdir(cwd)
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost } = await import(${JSON.stringify(hostEntry)})
      const signal = AbortSignal.timeout(35_000)
      const host = await openTerminalHost({ cwd: process.cwd(), signal })
      try {
        const first = await host.registerWorkspace(process.cwd())
        const second = await host.registerWorkspace(process.cwd())
        const listing = await host.listWorkspaces(signal)
        console.log(JSON.stringify({ first, second, listing }))
      } finally {
        await host.dispose()
      }
    `], {
      cwd,
      env: { DSH_HOME: join(root, 'home') },
      timeout: 45_000,
    })
    const { first, second, listing } = JSON.parse(stdout)
    expect(first.created).toBe(true)
    expect(first.workspace.workspaceId).toEqual(expect.any(String))
    expect(second).toMatchObject({ created: false, workspace: { workspaceId: first.workspace.workspaceId } })
    expect(listing).toContainEqual(expect.objectContaining({ workspaceId: first.workspace.workspaceId, path: cwd }))
  } finally {
    // This directory was allocated exclusively by this test.
    await rm(root, { recursive: true, force: true })
  }
})
