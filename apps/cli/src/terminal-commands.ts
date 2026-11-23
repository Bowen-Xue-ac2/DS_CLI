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
