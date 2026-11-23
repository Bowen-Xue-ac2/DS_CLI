/** Locate and reopen ordinary conversations through the pinned Host. @module @deepseek-ai/dsh/terminal-sessions */
import { requireHostResult, type TerminalHost, type TerminalSessionAddress } from './terminal-host.ts'
import { changeDirectory, type TerminalActiveSession } from './terminal-start.ts'

/** One visible conversation in the selection menu. */
export interface TerminalSessionChoice {
  readonly address: TerminalSessionAddress
  readonly title: string
  readonly detail: string
  readonly running: boolean
  readonly archived: boolean
  readonly needsMigration: boolean
}

/**
 * Read visible conversations without activating their Agents.
 * @param host - the current authenticated Host.
 * @param input - a workspace scope, optional cross-workspace search, and archive visibility.
 * @param signal - lifetime of this menu lookup.
 * @returns pinned and recent matches with stable session addresses.
 */
export async function listTerminalSessions(
  host: TerminalHost,
  input: { readonly scope?: string; readonly query?: string; readonly archived?: boolean },
  signal: AbortSignal,
): Promise<readonly TerminalSessionChoice[]> {
  const query = input.query?.trim()
  const scope = query ? undefined : input.scope
  const [sessions, hits] = await Promise.all([
    host.remote.session.list({}, signal),
    query ? host.remote.session.search({ query }, signal) : undefined,
  ])
  const contentSearchDisabled = hits?.ok === false && hits.error.message.includes('session search is disabled')
  const snippets = new Map(hits === undefined || contentSearchDisabled
    ? [] : requireHostResult(hits).items.map(hit => [hit.sessionId, hit.snippet]))
  for await (const frame of host.remote.workspace.follow(signal)) {
    if (frame.type !== 'baseline') throw new Error('The Host workspace stream did not start with a baseline')
    const { items, archivedSessionIds, pinnedSessionIds } = frame.value
    const archived = new Set(archivedSessionIds)
    const pinned = new Set(pinnedSessionIds)
    const owners = new Map(items.flatMap(item => item.sessionIds.map(id => [id, item] as const)))
    const choices = requireHostResult(sessions).items
      .filter(session => session.origin !== 'subagent')
      .sort((left, right) => Number(pinned.has(right.sessionId)) - Number(pinned.has(left.sessionId))
        || right.updatedAt - left.updatedAt)
    return choices.flatMap((session) => {
      const owner = owners.get(session.sessionId)
      if (owner === undefined || (scope !== undefined && owner.workspaceId !== scope)) return []
      const isArchived = archived.has(session.sessionId)
      if (isArchived !== (input.archived === true)) return []
      const title = session.projections?.values.title ?? session.sessionId
      const text = [title, session.sessionId, owner.path, session.cwd ?? ''].join(' ').toLowerCase()
      const snippet = snippets.get(session.sessionId)
      if (query && snippet === undefined && !text.includes(query.toLowerCase())) return []
      return [{
        address: { kind: 'session', sessionId: session.sessionId },
        title, detail: snippet ?? session.cwd ?? owner.path, running: session.running === true,
        archived: isArchived, needsMigration: session.formatStatus === 'migration-required',
      }]
    })
  }
  throw new Error('The Host workspace stream closed before its initial state')
}

/**
 * Resolve a saved session to its owner and current Host directory.
 * @param host - the current authenticated Host.
 * @param sessionId - explicitly selected ordinary session.
 * @param signal - lifetime of the lookup.
 * @returns the restored terminal session configuration.
 */
export async function loadTerminalSession(
  host: TerminalHost, sessionId: string, signal: AbortSignal,
): Promise<TerminalActiveSession> {
  const workspaces = await host.listWorkspaces(signal)
  const workspace = workspaces.find(item => item.sessionIds.includes(sessionId))
  if (workspace === undefined) throw new Error(`Session ${sessionId} is not in this Host's workspaces`)
  const state = requireHostResult(await host.remote.session.projections({ sessionId }, signal))
  if (state === null) throw new Error(`Session ${sessionId} is unavailable`)
  if (state.kind === 'migration-required') throw new Error(`Session ${sessionId} requires Host migration`)
  const agentPreset = state.values.agentPreset
  return {
    sessionId, workspace, cwd: await changeDirectory(host, sessionId),
    ...(typeof agentPreset === 'string' ? { agentPreset } : {}),
  }
}
