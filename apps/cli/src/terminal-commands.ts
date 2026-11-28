/** Resolve a terminal submission without executing any Host operation. @module @deepseek-ai/dsh/terminal-commands */

/** Official command metadata needed to route an explicit invocation. */
export interface TerminalCommandDescriptor {
  readonly name: string
  readonly description?: string
  readonly definitionId?: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
}

/** A user-invocable skill in the current Host conversation. */
export interface TerminalSkillDescriptor {
  readonly name: string
  readonly description: string
  readonly path?: string
}

/** The selected identity is separate from editable prompt text. */
export interface TerminalSkillChoice {
  readonly name: string
  readonly sessionId: string
}

/** Local, registered, or model-facing outcome of parsing the draft. */
export type TerminalSubmission =
  | { readonly kind: 'local-command'; readonly text: string }
  | { readonly kind: 'host-command'; readonly command: TerminalCommandDescriptor; readonly text: string }
  | { readonly kind: 'prompt'; readonly text: string }

// The first seven rows are visible for a bare slash. Other commands are one prefix away.
const SHORTCUTS = [
  ['session', 'Open a saved session'], ['usage', 'Show token and timing totals for this session'],
  ['status', 'Show workspace, model, permissions and progress'], ['ps', 'List active jobs and shells'],
  ['model', 'Choose a model and reasoning effort'], ['permission', 'Change permissions'],
  ['help', 'Show commands and keyboard shortcuts'],
  ['activity', 'Inspect tool calls'], ['agent', 'Choose the main Agent'], ['agents', 'Inspect delegated work'],
  ['archive', 'Archive this session'], ['attach', 'Attach a file to the next message'],
  ['browser', 'Open this session in the browser'], ['cancel', 'Cancel the current turn'],
  ['cd', 'Change the tool working directory'],
  ['clear', 'Clear the terminal transcript view'], ['commands', 'List Host commands'],
  ['connectors', 'Manage MCP servers'], ['diff', 'Show the latest workspace changes'],
  ['exit', 'Disconnect this terminal'], ['export', 'Export this conversation'], ['files', 'Browse workspace files'],
  ['fork', 'Branch this conversation'], ['history', 'Load older messages'], ['jobs', 'Read or manage background jobs'],
  ['mcp', 'Manage MCP servers'], ['mode', 'Choose the main Agent'], ['new', 'Start a new conversation'],
  ['pin', 'Pin this session'], ['plugins', 'Manage Host plugins'], ['questions', 'Answer a pending question'],
  ['quit', 'Disconnect this terminal'], ['rename', 'Rename this session'],
  ['resume', 'Open a saved session by ID'], ['schedule', 'Manage scheduled messages'],
  ['sessions', 'Find saved sessions'], ['steer', 'Add an instruction at the next step of an active turn'],
  ['team', 'View or configure the Agent team'],
  ['terminal', 'Open or reconnect a persistent shell'], ['unarchive', 'Restore this session'],
  ['unpin', 'Unpin this session'], ['workspace', 'Choose a workspace'], ['worktree', 'Manage the session worktree'],
] as const

/** Commands implemented by the terminal rather than the Host command dispatcher. */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set(SHORTCUTS.map(([name]) => name))

/**
 * Return short, local slash commands for the current query.
 * @param query - characters typed after the slash.
 * @returns the featured commands for an empty query, or matching local commands.
 */
export function terminalShortcuts(query: string): readonly (readonly [string, string])[] {
  return query === '' ? SHORTCUTS.slice(0, 7) : SHORTCUTS.filter(([name]) => name.startsWith(query))
}

/**
 * Route typed input by its explicit choice and the current session directory.
 * @param input - draft text and any skill the user picked.
 * @param catalog - current skills, registered commands and local command names.
 * @returns the single action indicated by the draft.
 */
export function resolveTerminalSubmission(
  input: { readonly text: string; readonly sessionId: string; readonly skill?: TerminalSkillChoice },
  catalog: {
    readonly skills: readonly TerminalSkillDescriptor[]
    readonly commands: readonly TerminalCommandDescriptor[]
    readonly local?: ReadonlySet<string>
  },
): TerminalSubmission {
  const token = /^\s*([/$])([a-z0-9._-]+)(?=\s|$)/u.exec(input.text)
  const name = token?.[2]
  if (input.skill !== undefined) {
    if (input.skill.sessionId !== input.sessionId || name !== input.skill.name
      || !catalog.skills.some(entry => entry.name === name)) {
      throw new Error('The selected Skill is no longer available. Pick it again in this session.')
    }
    return { kind: 'prompt', text: input.text.replace(/^(\s*)\$/u, '$1/') }
  }
  if (token?.[1] === '$' && catalog.skills.some(entry => entry.name === name)) {
    return { kind: 'prompt', text: input.text.replace(/^(\s*)\$/u, '$1/') }
  }
  if (token?.[1] === '/' && name !== undefined) {
    if (catalog.local?.has(name) === true) return { kind: 'local-command', text: input.text }
    const command = catalog.commands.find(entry => entry.name === name)
    if (command !== undefined) return { kind: 'host-command', command, text: input.text }
    if (!catalog.skills.some(entry => entry.name === name)) {
      throw new Error(`Unknown slash command or Skill: /${name}`)
    }
  }
  return { kind: 'prompt', text: input.text }
}
