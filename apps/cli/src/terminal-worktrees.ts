/** Optional Forge worktree controls using the pinned Host approval and Git scope. @module @deepseek-ai/dsh/terminal-worktrees */
import type { InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type HostResult, type TerminalHost, type TerminalSessionProjection } from './terminal-host.ts'
import type { TerminalActiveSession } from './terminal-start.ts'

export interface TerminalForgeRemote {
  readonly forgePanel: {
    requestWorktree(sessionId: string, from: string | null, signal: AbortSignal): Promise<HostResult<void>>
    cancelWorktree(sessionId: string, signal: AbortSignal): Promise<HostResult<void>>
    restoreWorktree(sessionId: string, signal: AbortSignal): Promise<HostResult<void>>
    continueInProject(sessionId: string, signal: AbortSignal): Promise<HostResult<void>>
    localDiff(sessionId: string, scope: { kind: 'staged' | 'unstaged' | 'uncommitted' }, signal: AbortSignal):
    Promise<HostResult<{
      readonly files: readonly { readonly path: string; readonly additions?: number; readonly deletions?: number }[]
      readonly omitted: number
    }>>
  }
}

export async function runTerminalWorktree(
  host: TerminalHost, io: InteractiveIo, session: TerminalActiveSession, state: TerminalSessionProjection['values'], input: string,
): Promise<string> {
  const { sessionId } = session
  const worktree = state.forgeWorktree
  const facts = [`Directory: ${state.workingDirectory ?? session.cwd}`, `Host permissions: ${state.permissions?.currentValue ?? 'unavailable'}`]
  if (worktree === undefined) return [...facts, 'Enable Forge Worktree through /plugins official.'].join('\n')
  if (!input) return [...facts, ...(worktree === null ? ['No active worktree for this session.'] : [
    `Branch ${worktree.branch} · base ${worktree.baseCommit}`, `Worktree: ${worktree.path}`, `Repository: ${worktree.repositoryRoot}`,
  ]), 'Use /browser for change-request review.'].join('\n')
  const [, action, value] = /^(\S+)(?:\s+(.*))?$/u.exec(input) ?? []
  const { forgePanel } = host.remote
  const { signal } = host
  if (action === 'diff') {
    if (value !== 'staged' && value !== 'unstaged' && value !== 'uncommitted') {
      throw new Error('Usage: /worktree diff <staged|unstaged|uncommitted>')
    }
    const diff = requireHostResult(await forgePanel.localDiff(sessionId, { kind: value }, signal))
    return [`Git scope: ${value} · ${diff.files.length} files`, ...diff.files.slice(0, 100).map(file =>
      file.additions === undefined ? file.path : `${file.path} +${file.additions} -${file.deletions ?? 0}`),
    ...(diff.omitted ? [`${diff.omitted} untracked files omitted`] : [])].join('\n')
  }
  if (action !== 'create' && action !== 'cancel' && action !== 'restore' && action !== 'project') {
    throw new Error('Usage: /worktree [create [base]|cancel|restore|project|diff <scope>]')
  }
  const selected = await io.choose({
    title: `Confirm worktree action: ${action}`,
    detail: action === 'create' ? `Base ${value ?? 'HEAD'}. The Host attempts creation before the next turn.`
      : worktree?.path ?? session.cwd,
    fields: [{ label: 'Action', initial: 'cancel', options: [
      { id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: 'Confirm' },
    ] }],
  }, signal)
  if (selected.kind !== 'chosen' || selected.values[0] !== 'confirm') return 'Worktree action cancelled'
  switch (action) {
    case 'create':
      requireHostResult(await forgePanel.requestWorktree(sessionId, value ?? null, signal))
      return 'Host recorded the worktree request for the next turn'
    case 'cancel':
      requireHostResult(await forgePanel.cancelWorktree(sessionId, signal))
      return 'Host withdrew the worktree request'
    case 'restore':
      requireHostResult(await forgePanel.restoreWorktree(sessionId, signal))
      return 'Host restored the session worktree'
    case 'project':
      requireHostResult(await forgePanel.continueInProject(sessionId, signal))
      return 'Host switched the working directory to the project'
  }
}
