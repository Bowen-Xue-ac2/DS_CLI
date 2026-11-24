/** Current-session contributions with ownership shown by the Host plugin catalog. @module @deepseek-ai/dsh/terminal-plugin-catalog */
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliCompletionItem } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type TerminalHost } from './terminal-host.ts'

interface PluginContribution {
  readonly id: string
  readonly commands: readonly string[]
  readonly skills: readonly string[]
}

/** Only effective commands and Skills with identifiable plugin ownership are admitted. */
export async function terminalPluginCatalog(
  host: TerminalHost, sessionId: string, signal: AbortSignal,
): Promise<readonly PluginContribution[]> {
  const [bundleResult, inventoryResult, commandResult, skillResult] = await Promise.all([
    host.remote.pluginManager.listBundles(), host.remote.pluginInventory.list(),
    host.remote.commands.list(sessionId), host.remote.skills.list({ sessionId }, signal),
  ])
  signal.throwIfAborted()
  const active = new Set(requireHostResult(inventoryResult).entries.filter(row => row.enabled && row.fiberPhase === 'active').map(row => row.entryId))
  const commands = requireHostResult(commandResult)
  const skills = requireHostResult(skillResult).skills
  return requireHostResult(bundleResult).flatMap((bundle) => {
    if (!bundle.enabled || bundle.error !== undefined) return []
    const modules = bundle.rows.flatMap(row => row.entryId !== undefined && active.has(row.entryId) ? [row.moduleName] : [])
    if (modules.length === 0) return []
    const owners = [bundle.name, ...modules.filter(name => !name.startsWith('.') && !isAbsolute(name))]
    const commandNames = commands.filter(command => command.definitionId !== undefined
      && owners.some(name => command.definitionId === name || command.definitionId?.startsWith(name + '#') === true
        || command.definitionId?.startsWith(name + '/') === true)).map(command => command.name)
    const skillNames = skills.filter(skill => skill.path !== undefined && knownPackagePath(skill.path, bundle.name, bundle.source))
      .map(skill => skill.name)
    return commandNames.length || skillNames.length ? [{ id: bundle.name, commands: commandNames, skills: skillNames }] : []
  })
}

function knownPackagePath(path: string, name: string, source: string | undefined): boolean {
  if (path.replaceAll('\\', '/').includes(`/node_modules/${name}/`)) return true
  if (source === undefined || !source.startsWith('file:')) return false
  const local = source.startsWith('file://') ? fileURLToPath(source) : source.slice(5)
  if (!isAbsolute(local)) return false
  const distance = relative(local, path).replaceAll('\\', '/')
  return distance !== '..' && !distance.startsWith('../') && !isAbsolute(distance)
}

export async function preparePluginReferences(
  host: TerminalHost, sessionId: string, text: string, selections: readonly CliCompletionItem[], signal: AbortSignal,
): Promise<string> {
  const selected = selections.filter(item => item.kind === 'plugin')
  if (selected.length === 0) return text
  const available = await terminalPluginCatalog(host, sessionId, signal)
  const hints = selected.map((selection) => {
    const entry = available.find(plugin => plugin.id === selection.id)
    if (entry === undefined) throw new Error(`Plugin is no longer available in this session: ${selection.label}`)
    return [entry.id, ...entry.commands.map(command => '/' + command), ...entry.skills.map(skill => '$' + skill)].join(' · ')
  })
  return text + '\n\nSelected plugin contributions in this session:\n' + hints.join('\n')
}
