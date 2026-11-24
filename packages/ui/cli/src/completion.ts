/** Cursor-relative ranges for terminal completion. @module @deepseek-ai/dsh-cli-ui/completion */

/** The token and active query at a cursor, in UTF-16 offsets. */
export interface TriggerMatch {
  readonly trigger: '@' | '/' | '$'
  readonly start: number
  readonly end: number
  readonly query: string
}

/** A Host-backed choice with a stable identity, distinct from its text. */
export interface CliCompletionItem {
  readonly id: string
  readonly kind: 'skill' | 'file' | 'session' | 'agent' | 'connector' | 'plugin'
  readonly label: string
  readonly insert: string
  readonly scope: string
  readonly connectionGeneration?: number
  readonly connectorResource?: { readonly server: string; readonly uri: string }
  readonly pathKind?: 'file' | 'directory'
  readonly detail?: string
  readonly disabled?: boolean
}

/** Load choices for a cursor token in the active terminal context. */
export type CliCompletionSource = (match: TriggerMatch, signal: AbortSignal) => Promise<readonly CliCompletionItem[]>

/**
 * Locate a supported trigger at the current cursor.
 * @param text - entire input draft, including any suffix after the cursor.
 * @param cursor - UTF-16 insertion offset.
 * @returns the token to replace and its query up to the cursor, if any.
 */
export function findTrigger(text: string, cursor: number): TriggerMatch | undefined {
  const offset = Math.max(0, Math.min(cursor, text.length))
  const prefix = text.slice(0, offset)
  const quoted = /(?:^|\s)(@"((?:[^"\\\n]|\\.)*))$/u.exec(prefix)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    const suffix = /^(?:[^"\\\n]|\\.)*"?/u.exec(text.slice(offset))?.[0] ?? ''
    return { trigger: '@', start: offset - quoted[1].length, end: offset + suffix.length, query: quoted[2] }
  }
  const plain = /(?:^|\s)([@/$])([^\s"\\]*)$/u.exec(prefix)
  if (plain === null) return undefined
  const trigger = plain[1]
  const query = plain[2] ?? ''
  const start = offset - query.length - 1
  if (trigger !== '@' && trigger !== '/' && trigger !== '$') return undefined
  if (trigger !== '@' && (text.slice(0, start).trim() !== '' || !/^[a-z0-9._-]*$/u.test(query))) {
    return undefined
  }
  const remainder = trigger === '@' ? /^[^\s"\\]*/u : /^[a-z0-9._-]*/u
  const suffix = remainder.exec(text.slice(offset))?.[0] ?? ''
  return { trigger, start, end: offset + suffix.length, query }
}

/**
 * Replace a completed token while retaining text before and after it.
 * @param text - the draft examined by findTrigger.
 * @param match - the active token range.
 * @param insert - the selected completion text.
 * @returns the edited draft.
 */
export function applyCompletion(text: string, match: TriggerMatch, insert: string): string {
  return text.slice(0, match.start) + insert + text.slice(match.end)
}
