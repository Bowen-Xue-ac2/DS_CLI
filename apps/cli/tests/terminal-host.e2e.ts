import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const consumer = process.env.DS_CLI_TEST_INSTALL_DIR
const hostEntry = consumer === undefined
  ? new URL('../lib/terminal-host.js', import.meta.url).href
  : pathToFileURL(join(consumer, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'terminal-host.js')).href

it('registers and reads a workspace through the rc.5 Host from a real caller cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-host-'))
  const cwd = join(root, '项目 A')
  await mkdir(cwd)
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(hostEntry)})
      const signal = AbortSignal.timeout(35_000)
      const host = await openTerminalHost({ cwd: process.cwd(), signal })
      try {
        async function firstFrame(stream) {
          for await (const frame of stream) return frame
          throw new Error('Host stream closed before its first frame')
        }
        const first = await host.registerWorkspace(process.cwd())
        const second = await host.registerWorkspace(process.cwd())
        const listing = await host.listWorkspaces(signal)
        const { remote } = host
        const { presets } = requireHostResult(await remote.agentPresets.list())
        const standard = presets.find(preset => preset.id === 'standard' && !preset.broken)
        const session = requireHostResult(await remote.session.create({
          workspaceId: first.workspace.workspaceId, sessionId: 'session-release-test', agentPreset: standard?.id,
        }))
        const sessionId = session.sessionId
        const [models, skills, permissions, bundles, sessions, jobs, mcp] = await Promise.all([
          remote.session.modelCatalog(),
          remote.skills.list({ sessionId }, signal),
          remote.permissionPresets.catalog(),
          remote.pluginManager.listBundles(),
          remote.session.list({}, signal),
          firstFrame(remote.job.list({ sessionId }, signal)),
          firstFrame(remote.mcpManager.watch(signal)),
        ])
        console.log(JSON.stringify({
          first, second, listing, standard: standard?.id,
          capabilities: [models.ok, skills.ok, permissions.ok, bundles.ok, sessions.ok, jobs?.type === 'rows', Array.isArray(mcp)],
        }))
      } finally {
        await host.dispose()
      }
    `], {
      cwd,
      env: { DSH_HOME: join(root, 'home') },
      timeout: 45_000,
    })
    const { first, second, listing, standard, capabilities } = JSON.parse(stdout)
    expect(first.created).toBe(true)
    expect(first.workspace.workspaceId).toEqual(expect.any(String))
    expect(second).toMatchObject({ created: false, workspace: { workspaceId: first.workspace.workspaceId } })
    expect(listing).toContainEqual(expect.objectContaining({ workspaceId: first.workspace.workspaceId, path: cwd }))
    expect(standard).toBe('standard')
    expect(capabilities).toEqual(Array.from({ length: 7 }, () => true))
  } finally {
    // This directory was allocated exclusively by this test.
    await rm(root, { recursive: true, force: true })
  }
})
