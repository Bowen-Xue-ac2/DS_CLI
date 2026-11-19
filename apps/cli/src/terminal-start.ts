/**
 * Decide how a terminal invocation opens its first session using Host state.
 * @module @deepseek-ai/dsh/terminal-start
 */
import { isAbsolute, relative, sep } from 'node:path'
import { requireHostResult, type TerminalHost, type TerminalWorkspace } from './terminal-host.ts'

/** A primary Agent declaration returned by the Host. */
export interface TerminalAgentPreset {
  readonly id: string
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

/** Inputs after the launcher's working path has been resolved on disk. */
export interface TerminalStartIntent {
  readonly cwd: string
  readonly choose: boolean
  readonly explicitCwd?: boolean
  readonly agentPreset?: string
  readonly permission?: string
}

/** Workspace ownership, per-session working path, and selected presets. */
export interface StartSelection {
  readonly workspacePath: string
  readonly cwd: string
  readonly agentPreset?: string
  readonly permission?: string
}

/** Whether the terminal can open chat directly or needs a selection. */
export interface StartDecision {
  readonly kind: 'chat' | 'choose'
  readonly selection: StartSelection
}

/** The Host identities and directory selected for a terminal session. */
export interface TerminalActiveSession {
  readonly sessionId: string
  readonly workspace: TerminalWorkspace
  readonly cwd: string
  readonly agentPreset?: string
}

/**
 * Find the most specific registered ancestor of a canonical path.
 * @param cwd - physical directory the user chose.
 * @param workspaces - canonical Host workspace paths.
 * @returns the nearest enclosing workspace, if one exists.
 */
export function enclosingWorkspace(cwd: string, workspaces: readonly TerminalWorkspace[]): TerminalWorkspace | undefined {
  let match: TerminalWorkspace | undefined
  for (const workspace of workspaces) {
    const inside = relative(workspace.path, cwd)
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) continue
    if (match === undefined || workspace.path.length > match.path.length) match = workspace
  }
  return match
}

/**
 * Resolve the two bare dsh entry paths without writing Host state.
 * @param intent - caller directory and explicit startup options.
 * @param workspaces - the Host opening workspace list.
 * @param roster - the Host's currently declared primary Agents.
 * @returns a direct chat selection or the defaults for the chooser.
 */
export function resolveStart(
  intent: TerminalStartIntent,
  workspaces: readonly TerminalWorkspace[],
  roster: readonly TerminalAgentPreset[],
): StartDecision {
  const workspace = enclosingWorkspace(intent.cwd, workspaces)
  const requested = intent.agentPreset
  const preset = requested === undefined
    ? roster.find(option => option.isDefault && option.broken === undefined)
    : roster.find(option => option.id === requested)
  if (requested !== undefined) {
    if (preset === undefined) throw new Error(`Unknown Agent preset: ${requested}`)
    if (preset.broken !== undefined) throw new Error(`Agent preset ${requested}: ${preset.broken}`)
  }
  return {
    kind: !intent.choose && (workspace !== undefined || intent.explicitCwd === true) && preset !== undefined
      ? 'chat'
      : 'choose',
    selection: {
      workspacePath: workspace?.path ?? intent.cwd,
      cwd: intent.cwd,
      ...(preset === undefined ? {} : { agentPreset: preset.id }),
      ...(intent.permission === undefined ? {} : { permission: intent.permission }),
    },
  }
}

/**
 * Register the chosen workspace and open a blank session in it after confirmation.
 * @param host - terminal connection to the selected Host.
 * @param selection - confirmed workspace and primary Agent.
 * @param candidate - reusable identity for retries of the same confirmation.
 * @returns the workspace and session identities returned by the Host.
 */
export async function commitStart(
  host: TerminalHost,
  selection: StartSelection,
  candidate: string,
): Promise<TerminalActiveSession> {
  if (selection.agentPreset !== undefined) {
    const { presets } = requireHostResult(await host.remote.agentPresets.list())
    const preset = presets.find(option => option.id === selection.agentPreset)
    if (preset === undefined || preset.broken !== undefined) {
      throw new Error(`Agent preset is no longer available: ${selection.agentPreset}`)
    }
  }
  const { workspace } = await host.registerWorkspace(selection.workspacePath)
  const created = requireHostResult(await host.remote.session.create({
    workspaceId: workspace.workspaceId,
    sessionId: candidate,
    ...(selection.agentPreset === undefined ? {} : { agentPreset: selection.agentPreset }),
  }))
  const cwd = relative(workspace.path, selection.cwd) === ''
    ? workspace.path
    : await changeDirectory(host, created.sessionId, selection.cwd)
  return { ...created, workspace, cwd }
}

/**
 * Read or change the official working directory for a single session.
 * @param host - authenticated terminal connection.
 * @param sessionId - active session to receive the human command.
 * @param path - path to set, or omit to read the effective directory.
 * @returns the directory confirmed by the Host.
 */
export async function changeDirectory(host: TerminalHost, sessionId: string, path?: string): Promise<string> {
  const line = path === undefined ? '/ds-cli-cwd' : `/ds-cli-cwd ${JSON.stringify(path)}`
  const execution = requireHostResult(await host.remote.commands.execute(sessionId, line, [], host.signal))
  if (execution?.result.kind !== 'success' || execution.result.text === undefined) {
    throw new Error(execution?.result.text ?? 'The terminal working directory command is unavailable')
  }
  return execution.result.text
}
