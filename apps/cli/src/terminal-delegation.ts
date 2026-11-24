/** Browse and control the current Host session's delegated work. @module @deepseek-ai/dsh/terminal-delegation */
import { randomUUID } from 'node:crypto'
import type { InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type TerminalHost, type TerminalSessionEvent, type TerminalSubagent } from './terminal-host.ts'

interface Child extends TerminalSubagent {
  readonly parentSessionId: string
  readonly depth: number
  readonly status: string
}

function childName(child: Child): string { return child.name ?? child.label ?? child.id }

async function readAgentTree(host: TerminalHost, root: string, signal: AbortSignal) {
  const { session } = host.remote
  const [snapshot, summaries] = await Promise.all([
    session.projections({ sessionId: root }, signal), session.list({}, signal),
  ])
  const state = requireHostResult(snapshot)
  if (state?.kind !== 'sequenced') throw new Error('The root session has no readable Agent catalog.')
  const running = new Set(requireHostResult(summaries).items.filter(item => item.running).map(item => item.sessionId))
  const seen = new Set([root])
  const rows: Child[] = []
  let truncated = false
  async function visit(parent: string, children: readonly TerminalSubagent[], depth: number): Promise<void> {
    for (const child of children) {
      signal.throwIfAborted()
      if (seen.has(child.id)) continue
      if (rows.length === 200 || depth === 12) { truncated = true; return }
      seen.add(child.id)
      const result = child.mode === 'external' ? undefined : await session.projections({ sessionId: child.id }, signal)
      const related = result?.ok === true ? result.value : undefined
      const finished = related?.values.subagentTiming?.lastTurnCompleted
      const status = running.has(child.id) ? 'running'
        : finished === true ? 'completed'
          : finished === false ? 'ended early'
            : child.mode !== 'external' && related == null ? 'history unavailable' : 'inactive'
      rows.push({ ...child, parentSessionId: parent, depth, status })
      await visit(child.id, related?.values.subagentCatalog ?? [], depth + 1)
    }
  }
  await visit(root, state.values.subagentCatalog ?? [], 0)
  return { rows, truncated }
}

/** Inspect the Team board or persist a new mode through the Host.
 * @param host - authenticated terminal Host.
 * @param root - current root Session.
 * @param args - optional explicit on or off choice.
 * @returns mode and current task board.
 */
export async function runTerminalTeam(host: TerminalHost, root: string, args?: string): Promise<string> {
  const { remote, signal } = host
  if (args !== undefined && args !== 'on' && args !== 'off') return 'Usage: /team [on | off]'
  if (args !== undefined) requireHostResult(await remote.agentTeams.setEnabled(root, args === 'on', signal))
  const projection = requireHostResult(await remote.session.projections({ sessionId: root }, signal))
  const team = projection?.values.agentTeam
  if (projection?.kind !== 'sequenced' || team === undefined) return 'Team state is unavailable for this session.'
  if (team.failure !== undefined) return `Team board is unavailable: ${team.failure}`
  return [`Team mode: ${team.enabled === true ? 'on' : 'off'}`, ...team.tasks.filter(task => task.status !== 'deleted')
    .map(task => [task.id, task.status, task.subject, task.ownerName ?? task.ownerId,
      task.blockedBy.length === 0 ? undefined : `blocked by ${task.blockedBy.join(', ')}`].filter(Boolean).join(' · '))].join('\n')
}

/** Inspect or act on a child whose ancestry was confirmed from the current root.
 * @param host - authenticated terminal Host.
 * @param io - terminal chooser for history and stop confirmation.
 * @param root - current root Session.
 * @param args - optional history, send or stop subcommand.
 * @param receipts - unacknowledged deliveries keyed by child Session.
 * @returns a notice and, for history, a non-activating read of child events.
 */
export async function runTerminalAgents(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, root: string, args: string | undefined,
  receipts: Map<string, { text: string; requestId: string }>,
): Promise<{ readonly text: string; readonly history?: readonly TerminalSessionEvent[] }> {
  const { remote, signal } = host
  const [operation, target, input] = /^(history|send|stop)(?:\s+(\S+))?(?:\s+(.+))?$/u.exec(args ?? '')?.slice(1) ?? []
  if (args !== undefined && (operation === undefined || (operation !== 'history' && target === undefined)
    || (operation === 'send' ? input === undefined : input !== undefined))) {
    return { text: 'Usage: /agents [history [child] | send <child> <message> | stop <child>]' }
  }
  const { rows, truncated } = await readAgentTree(host, root, signal)
  if (operation === undefined) {
    return { text: rows.length === 0 ? 'No delegated Agents in this session.' : [
      ...rows.map(child => `${'  '.repeat(child.depth)}${child.label ?? childName(child)} · ${childName(child)} · ${child.status} · ${child.mode} · ${child.id}`),
      ...(truncated ? ['The Agent catalog exceeds the display limit.'] : []),
    ].join('\n') }
  }
  let child: Child | undefined
  if (target === undefined) {
    const options = rows.filter(row => row.mode !== 'external')
      .map(row => ({ id: row.id, label: row.label ?? childName(row), detail: `${row.status} · ${row.id}` }))
    const first = options[0]
    if (first === undefined) return { text: 'No child histories in this session.' }
    const answer = await io.choose({ title: 'Open Agent history', fields: [{ label: 'Agent', initial: first.id, options }] }, signal)
    if (answer.kind !== 'chosen') return { text: 'Agent history cancelled.' }
    child = rows.find(row => row.id === answer.values[0])
  } else {
    child = rows.find(row => row.id === target)
    const named = child === undefined ? rows.filter(row => row.name === target) : [child]
    child = named.length === 1 ? named[0] : undefined
  }
  if (child === undefined) return { text: `No unique Agent matching ${target ?? 'the selection'} in this session.` }
  const label = childName(child)
  if (operation === 'history') {
    if (child.mode === 'external') return { text: `${label} has no local session history.` }
    const history = requireHostResult(await remote.session.events({
      address: { kind: 'subagent', childSessionId: child.id, parentSessionId: child.parentSessionId, mode: child.mode },
      maxMessages: 12,
    }, signal))
    return { text: `Agent history · ${label}`, history: history.records.map(record => record.event) }
  }
  if (operation === 'send' && input !== undefined) {
    if (child.mode !== 'continuable') return { text: `${label} does not accept follow-up messages.` }
    const old = receipts.get(child.id)
    const requestId = old?.text === input ? old.requestId : randomUUID()
    receipts.set(child.id, { requestId, text: input })
    requireHostResult(await remote.subagents.prompt({
      childSessionId: child.id, requestId, delivery: 'queue', content: [{ type: 'text', text: input }],
    }, signal))
    receipts.delete(child.id)
    return { text: `Queued a message for ${label}` }
  }
  const answer = await io.choose({
    title: `Stop Agent ${label}?`, fields: [{ label: 'Action', initial: 'cancel', options: [
      { id: 'cancel', label: 'Keep running' }, { id: 'stop', label: 'Stop Agent' },
    ] }],
  }, signal)
  if (answer.kind !== 'chosen' || answer.values[0] !== 'stop') return { text: 'Agent stop cancelled.' }
  requireHostResult(await remote.subagents.interruptByUser(child.id))
  return { text: `Stop requested for ${label}` }
}
