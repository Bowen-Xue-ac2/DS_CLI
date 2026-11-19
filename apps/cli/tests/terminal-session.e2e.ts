import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'

it('commits the chosen workspace and preset only after confirming startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-session-'))
  const cwd = join(root, '项目 A')
  await mkdir(cwd)
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(new URL('../lib/terminal-host.js', import.meta.url).href)})
      const { resolveStart, commitStart } = await import(${JSON.stringify(new URL('../lib/terminal-start.js', import.meta.url).href)})
      const signal = AbortSignal.timeout(35_000)
      const host = await openTerminalHost({ cwd: process.cwd(), signal })
      try {
        const initial = await host.listWorkspaces(signal)
        const listing = requireHostResult(await host.remote.directoryPicker.list(process.cwd(), signal))
        const roster = requireHostResult(await host.remote.agentPresets.list()).presets
        const start = resolveStart({ cwd: process.cwd(), choose: false }, initial, roster)
        const before = await host.listWorkspaces(signal)
        const active = await commitStart(host, start.selection, 'session-terminal-confirm')
        const repeated = await commitStart(host, start.selection, 'session-terminal-confirm')
        const after = await host.listWorkspaces(signal)
        const projection = requireHostResult(await host.remote.session.projections({ sessionId: active.sessionId }, signal))
        console.log(JSON.stringify({ start, before, listing, active, repeated, after, projection }))
      } finally {
        await host.dispose()
      }
    `], {
      cwd,
      env: { DSH_HOME: join(root, 'home') },
      timeout: 45_000,
    })
    const { start, before, listing, active, repeated, after, projection } = JSON.parse(stdout)
    expect(start.kind).toBe('choose')
    expect(before).not.toContainEqual(expect.objectContaining({ path: cwd }))
    expect(listing.path).toBe(cwd)
    expect(repeated.sessionId).toBe(active.sessionId)
    expect(after).toContainEqual(expect.objectContaining({ path: cwd, sessionIds: [active.sessionId] }))
    expect(active.agentPreset).toEqual(expect.any(String))
    expect(projection.values.agentPreset).toBe(active.agentPreset)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('persists the future default without changing existing session permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-permission-default-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(new URL('../lib/terminal-host.js', import.meta.url).href)})
      const { commitStart } = await import(${JSON.stringify(new URL('../lib/terminal-start.js', import.meta.url).href)})
      const { permissionCatalog, permissionRevision, setDefaultPermission, setSessionPermission } = await import(${JSON.stringify(new URL('../lib/terminal-permissions.js', import.meta.url).href)})
      const signal = AbortSignal.timeout(35_000)
      const open = () => openTerminalHost({ cwd: process.cwd(), signal })
      const selection = { workspacePath: process.cwd(), cwd: process.cwd() }
      async function current(host, sessionId) {
        return requireHostResult(await host.remote.session.projections({ sessionId }, signal)).values.permissions.currentValue
      }
      let host = await open()
      try {
        const { defaultPreset } = await permissionCatalog(host)
        const alternative = defaultPreset === 'read-only' ? 'workspace-write' : 'read-only'
        const first = await commitStart(host, selection, 'session-permission-first')
        await setSessionPermission(host, first.sessionId, alternative)
        const afterCurrent = (await permissionCatalog(host)).defaultPreset
        const second = await commitStart(host, selection, 'session-permission-second')
        const revision = await permissionRevision(host)
        await setDefaultPermission(host, alternative, revision)
        const secondAfter = await current(host, second.sessionId)
        let rejectedStale = false
        try { await setDefaultPermission(host, defaultPreset, revision) }
        catch { rejectedStale = true }
        await host.dispose()
        host = await open()
        const savedDefault = (await permissionCatalog(host)).defaultPreset
        const third = await commitStart(host, selection, 'session-permission-third')
        console.log(JSON.stringify({
          defaultPreset, alternative, afterCurrent, secondAfter, rejectedStale, savedDefault,
          firstAfterRestart: await current(host, first.sessionId), thirdCurrent: await current(host, third.sessionId),
        }))
      } finally { await host.dispose() }
    `], { cwd, env: { DSH_HOME: join(root, 'home') }, timeout: 40_000 })
    const result = JSON.parse(stdout)
    expect(result.afterCurrent).toBe(result.defaultPreset)
    expect(result.secondAfter).toBe(result.defaultPreset)
    expect(result.rejectedStale).toBe(true)
    expect(result.savedDefault).toBe(result.alternative)
    expect(result.firstAfterRestart).toBe(result.alternative)
    expect(result.thirdCurrent).toBe(result.alternative)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
