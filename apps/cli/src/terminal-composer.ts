/** Read the active Host conversation's completion directories. @module @deepseek-ai/dsh/terminal-composer */
import { resolve } from 'node:path'
import type { CliCompletionItem, TriggerMatch } from '@deepseek-ai/dsh-cli-ui'
import { listTerminalConnectors } from './terminal-connectors.ts'
import { requireHostResult, type TerminalHost } from './terminal-host.ts'
import type { TerminalMcpResources } from './terminal-mcp-resources.ts'
import { terminalPluginCatalog } from './terminal-plugin-catalog.ts'
import type { TerminalActiveSession } from './terminal-start.ts'
import { terminalShortcuts } from './terminal-commands.ts'

/**
 * Bind a selected item to its current working context.
 * @param session - ordinary session and confirmed directory.
 * @returns the scope which must still match when the selection is submitted.
 */
export function terminalComposerScope(session: TerminalActiveSession): string {
  return JSON.stringify([session.sessionId, session.cwd, session.agentPreset])
}

/**
 * Confirm that chosen files and sessions still exist in the receiving context.
 * @param host - authenticated Host.
 * @param session - Session and active directory that will receive these references.
 * @param selections - claims retained by the composer.
 * @param signal - submission lifetime.
 */
export async function validateTerminalReferences(
  host: TerminalHost, session: TerminalActiveSession, selections: readonly CliCompletionItem[], signal: AbortSignal,
): Promise<void> {
  const { sessionId, cwd } = session
  await Promise.all(selections.map(async (item) => {
    let exists: boolean
    if (item.kind === 'file') {
      const path = resolve(cwd, item.id)
      const result = item.pathKind === 'directory'
        ? await host.remote.workspaceFiles.list(sessionId, path, signal)
        : await host.remote.workspaceFiles.stat(sessionId, path, signal)
      signal.throwIfAborted()
      if (!result.ok && !result.error.code.startsWith('workspace-file/')) requireHostResult(result)
      exists = result.ok
    } else if (item.kind === 'session') {
      const sessions = requireHostResult(await host.remote.sessionReferenceResolver.candidates(sessionId, item.id, signal))
      exists = sessions.some(session => session.sessionId === item.id)
    } else {
      return
    }
    if (!exists) throw new Error(`Reference is unavailable in this session: ${item.label}`)
  }))
}

function fits(name: string, query: string): boolean {
  const text = name.toLowerCase()
  let at = 0
  for (const part of query.toLowerCase()) {
    const next = text.indexOf(part, at)
    if (next < 0) return false
    at = next + 1
  }
  return true
}

const REFERENCE_CATEGORIES = [
  ['file', 'Files', 'Find files and folders'],
  ['session', 'Sessions', 'Reference a saved conversation'],
  ['agent', 'Agents', 'Start with a different Agent'],
  ['connector', 'Connectors', 'Select an MCP service'],
  ['plugin', 'Plugins', 'Find enabled plugins'],
] as const

/** @param match - active trigger. @param scope - receiving context. @returns local completion rows. */
export function initialTerminalCompletions(match: TriggerMatch, scope: string): readonly CliCompletionItem[] {
  if (match.trigger === '/') {
    return terminalShortcuts(match.query).map(([name, detail]) => ({
      id: name, kind: 'command', label: '/' + name, insert: '/' + name, detail, scope,
    }))
  }
  if (match.query !== '') return []
  if (match.trigger === '$') return [{
    id: 'all', kind: 'category', label: 'Browse skills', insert: '$all:', scope,
  }]
  return REFERENCE_CATEGORIES.map(([id, label, detail]) => ({
    id, kind: 'category', label, insert: `@${id}:`, detail, scope,
  }))
}

/**
 * Return skill or reference candidates without submitting or executing anything.
 * @param host - the attached Host.
 * @param session - the active terminal conversation.
 * @param match - the cursor token to complete.
 * @param resources - discoveries made by the current terminal through native MCP tools.
 * @param signal - caller's menu lifetime.
 * @returns candidates with their originating session scope.
 */
export async function terminalCompletions(
  host: TerminalHost, session: TerminalActiveSession, match: TriggerMatch,
  resources: TerminalMcpResources, signal: AbortSignal,
): Promise<readonly CliCompletionItem[]> {
  const scope = terminalComposerScope(session)
  const lifetime = AbortSignal.any([host.signal, signal])
  const sessionId = session.sessionId
  const initial = initialTerminalCompletions(match, scope)
  if (match.trigger === '/' || (match.trigger === '@' && match.query === '')) return initial
  if (match.trigger === '$') {
    const { skills } = requireHostResult(await host.remote.skills.list({ sessionId }, lifetime))
    const prefix = match.query.replace(/^all:/u, '').toLowerCase()
    const choices = skills.filter(skill => fits(skill.name, prefix))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(prefix)) - Number(a.name.toLowerCase().startsWith(prefix)))
      .map(skill => ({
        id: skill.name, kind: 'skill' as const, label: '$' + skill.name, insert: '$' + skill.name, scope,
        detail: skill.description,
      }))
    return [...initial, ...choices]
  }
  if (/^plugin:/iu.test(match.query)) {
    const query = match.query.slice(7)
    return (await terminalPluginCatalog(host, sessionId, lifetime)).filter(plugin => fits(plugin.id, query))
      .map(plugin => ({
        id: plugin.id, kind: 'plugin', label: plugin.id, insert: '@plugin:' + plugin.id, scope,
        detail: [...plugin.commands.map(name => '/' + name), ...plugin.skills.map(name => '$' + name)].join(' · '),
      }))
  }
  const category = /^(file|session|agent|connector):/iu.exec(match.query)?.[1]?.toLowerCase()
  const query = category === undefined ? match.query : match.query.slice(category.length + 1)
  const connectorQuery = category === 'connector'
  const { presets } = category === undefined || category === 'agent' ? requireHostResult(await host.remote.agentPresets.list()) : { presets: [] }
  lifetime.throwIfAborted()
  const agents: CliCompletionItem[] = presets
    .filter(preset => fits(preset.id, query) || fits(preset.name ?? '', query))
    .map(preset => ({
      id: preset.id, kind: 'agent', scope,
      label: preset.name ?? preset.id, insert: '@agent:' + preset.id,
      detail: preset.broken ?? 'New session with this Agent',
      disabled: preset.broken !== undefined,
    }))
  if (category === 'agent') return agents
  const { items } = requireHostResult(await host.remote.session.list({}, lifetime))
  if (!items.some(item => item.sessionId === sessionId && item.agentAvailable)) return agents
  const connectorFilter = query
  const [servers, files, references] = await Promise.all([
    category === undefined || connectorQuery ? listTerminalConnectors(host, sessionId, lifetime).then(
      rows => ({ rows }),
      (error: unknown) => {
        if (connectorQuery || lifetime.aborted) throw error
        return { rows: [] }
      },
    ) : { rows: [] },
    category === undefined || category === 'file' ? host.remote.fileReferences.list(sessionId, query, lifetime) : undefined,
    category === undefined || category === 'session' ? host.remote.sessionReferenceResolver.candidates(sessionId, query, lifetime) : undefined,
  ])
  const resourceSeparator = connectorQuery ? connectorFilter.indexOf('/') : -1
  let connectors: CliCompletionItem[]
  if (resourceSeparator >= 0) {
    const serverId = connectorFilter.slice(0, resourceSeparator)
    const resourceQuery = connectorFilter.slice(resourceSeparator + 1)
    const server = servers.rows.find(row => row.id === serverId)
    connectors = server === undefined ? [] : resources.list(sessionId, server)
      .filter(resource => fits(resource.name, resourceQuery) || fits(resource.uri, resourceQuery))
      .map(resource => ({
        id: JSON.stringify([server.id, resource.uri]), kind: 'connector', scope, label: resource.name,
        insert: `@connector:${server.id}/${encodeURIComponent(resource.uri)}`, detail: 'MCP resource',
        connectionGeneration: server.generation, connectorResource: { server: server.id, uri: resource.uri },
      }))
  } else {
    connectors = servers.rows.filter(server => fits(server.id, connectorFilter)).map(server => ({
      id: server.id, kind: 'connector', scope, label: server.id,
      insert: '@connector:' + server.id,
      detail: server.origin === 'host' ? 'MCP connector · Host' : 'MCP connector · Agent',
      connectionGeneration: server.generation,
    }))
  }
  return [
    ...agents,
    ...connectors,
    ...(files === undefined ? [] : requireHostResult(files)).map(file => ({
      id: file.path, kind: 'file' as const, scope, label: file.path,
      insert: '@' + (/\s|"/u.test(file.path) ? JSON.stringify(file.path) : file.path),
      pathKind: file.kind, detail: file.kind === 'directory' ? 'Directory' : 'File',
    })),
    ...(references === undefined ? [] : requireHostResult(references)).map(ref => ({
      id: ref.sessionId, kind: 'session' as const, scope, label: ref.displayTitle ?? ref.label,
      insert: ref.mention, detail: 'Session',
    })),
  ]
}
