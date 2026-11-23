/** Read the active Host conversation's completion directories. @module @deepseek-ai/dsh/terminal-composer */
import type { CliCompletionItem, TriggerMatch } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type TerminalHost } from './terminal-host.ts'
import type { TerminalActiveSession } from './terminal-start.ts'

/**
 * Bind a selected item to its current working context.
 * @param session - ordinary session and confirmed directory.
 * @returns the scope which must still match when the selection is submitted.
 */
export function terminalComposerScope(session: TerminalActiveSession): string {
  return JSON.stringify([session.sessionId, session.cwd, session.agentPreset])
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

/**
 * Return skill or reference candidates without submitting or executing anything.
 * @param host - the attached Host.
 * @param session - the active terminal conversation.
 * @param match - the cursor token to complete.
 * @param signal - caller's menu lifetime.
 * @returns candidates with their originating session scope.
 */
export async function terminalCompletions(
  host: TerminalHost, session: TerminalActiveSession, match: TriggerMatch, signal: AbortSignal,
): Promise<readonly CliCompletionItem[]> {
  const scope = terminalComposerScope(session)
  const lifetime = AbortSignal.any([host.signal, signal])
  const sessionId = session.sessionId
  if (match.trigger !== '@') {
    const { skills } = requireHostResult(await host.remote.skills.list({ sessionId }, lifetime))
    const prefix = match.query.toLowerCase()
    return skills.filter(skill => fits(skill.name, prefix))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(prefix)) - Number(a.name.toLowerCase().startsWith(prefix)))
      .map(skill => ({
        id: skill.name, kind: 'skill', label: '/' + skill.name, insert: '/' + skill.name, scope,
        detail: skill.path === undefined ? skill.description : `${skill.description} · ${skill.path}`,
      }))
  }
  const { items } = requireHostResult(await host.remote.session.list({}, lifetime))
  if (!items.some(item => item.sessionId === sessionId && item.agentAvailable)) return []
  const [files, references] = await Promise.all([
    host.remote.fileReferences.list(sessionId, match.query, lifetime),
    host.remote.sessionReferenceResolver.candidates(sessionId, match.query, lifetime),
  ])
  return [
    ...requireHostResult(files).map(file => ({
      id: file.path, kind: 'file' as const, scope, label: file.path,
      insert: '@' + (/\s|"/u.test(file.path) ? JSON.stringify(file.path) : file.path),
      detail: file.kind === 'directory' ? 'Directory' : 'File',
    })),
    ...requireHostResult(references).map(ref => ({
      id: ref.sessionId, kind: 'session' as const, scope, label: ref.displayTitle ?? ref.label,
      insert: ref.mention, detail: 'Session',
    })),
  ]
}
