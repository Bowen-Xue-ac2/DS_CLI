/**
 * Current-session presets and explicit future defaults backed by the official Host.
 * @module @deepseek-ai/dsh/terminal-permissions
 */
import { requireHostResult, type TerminalHost, type TerminalPermissionCatalog } from './terminal-host.ts'

/**
 * Read the live preset options from the official catalog.
 * @param host - current terminal connection.
 * @returns selectable presets and the Host's default.
 */
export async function permissionCatalog(host: TerminalHost): Promise<TerminalPermissionCatalog> {
  return requireHostResult(await host.remote.permissionPresets.catalog())
}

/**
 * Apply a preset to one session and read back its committed effective value.
 * @param host - authenticated terminal connection.
 * @param sessionId - the session receiving the setting.
 * @param preset - option selected in the Host catalog.
 * @returns the effective preset returned by the Host.
 */
export async function setSessionPermission(host: TerminalHost, sessionId: string, preset: string): Promise<string> {
  if (preset === 'custom' || !(await permissionCatalog(host)).options.some(option => option.value === preset)) {
    throw new Error(`Unknown permission preset: ${preset}`)
  }
  const result = requireHostResult(await host.remote.commands.execute(sessionId, `/permission ${preset}`, [], host.signal))
  if (result?.result.kind !== 'success') throw new Error(result?.result.text ?? 'Permission command unavailable')
  const state = requireHostResult(await host.remote.session.projections({ sessionId }, host.signal))
  if (state?.values.permissions?.currentValue !== preset) throw new Error(`Host did not apply permission ${preset}`)
  return preset
}

/**
 * Read the revision to present with a future default menu.
 * @param host - authenticated terminal connection.
 * @returns the revision when the permission namespace accepts writes.
 */
export async function permissionRevision(host: TerminalHost): Promise<number> {
  const settings = requireHostResult(await host.remote.settings.describe())
  const row = settings.namespaces.find(namespace => namespace.ns === 'permission')
  if (!settings.writable || row === undefined) throw new Error('Host permission defaults are read-only')
  return row.revision
}

/**
 * Change the preset for future sessions, using the revision shown to the user.
 * @param host - authenticated terminal connection.
 * @param preset - a selectable default from the Host catalog.
 * @param revision - the revision before the user edited it.
 * @returns the persisted effective default.
 */
export async function setDefaultPermission(host: TerminalHost, preset: string, revision: number): Promise<string> {
  if (preset === 'custom' || !(await permissionCatalog(host)).defaultOptions.some(option => option.value === preset)) {
    throw new Error(`Invalid default permission preset: ${preset}`)
  }
  requireHostResult(await host.remote.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: preset }], revision))
  if ((await permissionCatalog(host)).defaultPreset !== preset) throw new Error(`Host did not save default permission ${preset}`)
  return preset
}
