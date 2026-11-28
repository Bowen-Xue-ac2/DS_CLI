/**
 * A self-managed terminal text input over `useInput`, modeled on the Claude
 * Code input: cursor offset tracking, up/down history navigation, and the
 * "coalesced Enter" handling — a slow link can deliver `"o\r"` as one chunk,
 * so a value ending in `\r` (with no embedded `\r`) submits instead of
 * inserting the carriage return as text.
 *
 * The keypress-to-edit logic lives in the pure {@link applyKeypress} so it is
 * unit-testable without an ink stdin (ink's testing library does not drive
 * `useInput`).
 * @module @deepseek-ai/dsh-cli-ui/text-input
 */

import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import { parseMouseWheel } from './scroll-layout.ts'
import { applyCompletion, findTrigger, type CliCompletionItem, type CliCompletionSource } from './completion.ts'

/** The key descriptor ink passes to `useInput`. */
export interface CliInputKey {
  return?: boolean
  escape?: boolean
  ctrl?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
  backspace?: boolean
  delete?: boolean
}

/** One keystroke's effect on the input. */
export interface KeypressEdit {
  /** The next value, when the value changes. */
  value?: string
  /** The next cursor offset. */
  offset?: number
  /** Submit this line, when Enter (or coalesced Enter) is pressed. */
  submit?: string
}

/**
 * Fold one raw keypress onto the current value and cursor.
 * @param rawInput - the raw input string ink delivered.
 * @param key - the parsed key descriptor.
 * @param value - the current input value.
 * @param offset - the current cursor offset.
 * @param onHistoryUp - up-arrow history callback; returns the older value.
 * @param onHistoryDown - down-arrow history callback; returns the newer value.
 * @returns the next value/offset and an optional submit.
 */
export function applyKeypress(
  rawInput: string,
  key: CliInputKey,
  value: string,
  offset: number,
  onHistoryUp?: (current: string) => string | undefined,
  onHistoryDown?: (current: string) => string | undefined,
): KeypressEdit {
  // A mouse event is not text: with SGR mouse mode enabled the terminal sends
  // `\x1b[<…M` sequences that the scroll region consumes. ink strips the
  // leading ESC and may deliver the sequence in chunks, so a parseable wheel
  // event, any `[<` prefix, or a `digits;semicolons` fragment (a torn remainder
  // of the SGR payload) must never reach the input as printable text.
  if (parseMouseWheel(rawInput) !== 0
    || rawInput.startsWith('[<')
    || (rawInput.includes(';') && /^[0-9;<>]*[Mm]?$/.test(rawInput))) return {}
  // Coalesced Enter: a single chunk like "o\r" on a slow link is a value plus
  // Enter. Strip the trailing \r, apply the text, then submit.
  if (rawInput.length > 1 && rawInput.endsWith('\r') && !rawInput.slice(0, -1).includes('\r')) {
    const text = rawInput.slice(0, -1)
    const next = value.slice(0, offset) + text + value.slice(offset)
    return { value: next, offset: offset + text.length, submit: next }
  }
  if (key.return) {
    return value.trim() !== '' ? { submit: value, offset: 0 } : {}
  }
  if (key.escape || (key.ctrl && rawInput === 'c')) return {}
  if (key.ctrl && rawInput === 'u') return { value: '', offset: 0 }
  if (key.leftArrow) return { offset: Math.max(0, offset - 1) }
  if (key.rightArrow) return { offset: Math.min(value.length, offset + 1) }
  if (key.upArrow) {
    if (onHistoryUp) {
      const older = onHistoryUp(value)
      if (older !== undefined) return { value: older, offset: older.length }
    }
    return {}
  }
  if (key.downArrow) {
    if (onHistoryDown) {
      const newer = onHistoryDown(value)
      if (newer !== undefined) return { value: newer, offset: newer.length }
    }
    return {}
  }
  // Backspace and Delete both arrive as key.delete in tmux/SSH (the DEL byte
  // \x7f), so treat them identically as a backward delete at the cursor.
  if (key.backspace || key.delete) {
    if (offset > 0) {
      return { value: value.slice(0, offset - 1) + value.slice(offset), offset: offset - 1 }
    }
    return {}
  }
  if (rawInput.length > 0 && !key.ctrl) {
    // Normal printable input, including multi-char paste and SSH-coalesced
    // characters that are not Enter.
    const text = rawInput.replace(/\r/g, '')
    if (text === '') return {}
    return { value: value.slice(0, offset) + text + value.slice(offset), offset: offset + text.length }
  }
  return {}
}

/** The input props the REPL io supplies. */
export interface CliTextInputProps {
  /** The current value (controlled by the parent). */
  value: string
  /** Called on every edit. */
  onChange(this: void, value: string): void
  /** Called when the user presses Enter on a non-empty line. */
  onSubmit(this: void, value: string): void
  /** Called on up-arrow history navigation; returns the older value or undefined. */
  onHistoryUp?(this: void, current: string): string | undefined
  /** Called on down-arrow history navigation; returns the newer value or undefined. */
  onHistoryDown?(this: void, current: string): string | undefined
  /** Whether the input is focused (a modal or busy state may blur it). */
  focus?: boolean
  /** Optional Host-backed choices in this input's current context. */
  completion?: CliCompletionSource
  /** Key shared by the visible session, directory and Agent. */
  completionScope?: string
  /** Remember the selected identity separately from its editable text. */
  onCompletion?(this: void, item: CliCompletionItem): void
  /** Reserve one terminal line per visible completion row. */
  onCompletionRows?(this: void, rows: number): void
  /** Identity of a rejected submission restored into an empty input. */
  restoreCursor?: object
}

/**
 * Render a self-managed terminal input with a visible cursor.
 * @param props - value/onChange plus history and submit callbacks.
 */
export function CliTextInput({
  value, onChange, onSubmit, onHistoryUp, onHistoryDown, focus = true,
  completion, completionScope, onCompletion, onCompletionRows, restoreCursor,
}: CliTextInputProps) {
  const [offset, setOffset] = React.useState(value.length)
  if (offset > value.length) setOffset(value.length)
  const [menu, setMenu] = React.useState<{
    key: string
    items: readonly CliCompletionItem[]
    error?: string
  }>()
  const [selection, setSelection] = React.useState<{ key: string; index: number }>()
  const [dismissed, setDismissed] = React.useState<string>()
  const menuKey = JSON.stringify([completionScope, value, offset])
  if (dismissed !== undefined && dismissed !== menuKey) setDismissed(undefined)
  const match = focus && dismissed !== menuKey ? findTrigger(value, offset) : undefined
  const open = match !== undefined && completion !== undefined
  const active = !open ? undefined : menu?.key === menuKey ? menu
    : { key: menuKey, items: completion.initial?.(match) ?? [] }
  const selectable = active?.items.filter(item => !item.disabled) ?? []
  const selectedIndex = selection?.key === menuKey && selection.index < selectable.length ? selection.index : 0
  const picked = selectable[selectedIndex]
  const first = Math.max(0, (picked === undefined || active === undefined ? 0 : active.items.indexOf(picked)) - 4)
  const visible = active?.items.slice(first, first + 7) ?? []
  const hint = open && visible.length === 0 ? menu?.key !== menuKey ? 'Searching…'
    : active?.error ?? 'No matching options' : active?.error
  React.useLayoutEffect(() => {
    onCompletionRows?.(visible.length + Number(hint !== undefined))
  }, [hint, onCompletionRows, visible.length])
  React.useEffect(() => {
    const match = focus && findTrigger(value, offset)
    if (!match || completion === undefined || dismissed === menuKey) return
    const controller = new AbortController()
    void completion(match, controller.signal).then((items) => {
      if (controller.signal.aborted) return
      setMenu({ key: menuKey, items })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setMenu({ key: menuKey, items: completion.initial?.(match) ?? [], error: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort()
  }, [completion, dismissed, focus, menuKey, offset, value])
  // Synchronous mirrors of value/offset so rapid consecutive keystrokes fold
  // against the latest state instead of a stale render closure.
  const valueRef = React.useRef(value)
  const offsetRef = React.useRef(offset)
  const focused = React.useRef(focus)
  React.useLayoutEffect(() => { focused.current = focus }, [focus])
  React.useLayoutEffect(() => { valueRef.current = value }, [value])
  React.useLayoutEffect(() => { offsetRef.current = offset }, [offset])
  React.useLayoutEffect(() => {
    if (restoreCursor === undefined) return
    offsetRef.current = value.length
    setOffset(value.length)
  }, [restoreCursor, value])

  function submit(line: string): void {
    valueRef.current = ''
    offsetRef.current = 0
    setOffset(0)
    onSubmit(line)
  }

  useInput((rawInput, key) => {
    if (!focused.current) return
    const liveKey = JSON.stringify([completionScope, valueRef.current, offsetRef.current])
    if (key.escape && completion !== undefined && findTrigger(valueRef.current, offsetRef.current) !== undefined) {
      setDismissed(liveKey)
      setMenu(undefined)
      return
    }
    if (active !== undefined && liveKey === active.key) {
      if ((key.upArrow || key.downArrow) && selectable.length > 0) {
        setSelection({ key: liveKey, index: (selectedIndex + (key.upArrow ? selectable.length - 1 : 1)) % selectable.length })
        return
      }
      if ((key.return || (key.tab && !key.shift)) && picked !== undefined) {
        const match = findTrigger(valueRef.current, offsetRef.current)
        if (match === undefined) return
        const suffix = valueRef.current.slice(match.end)
        if (key.return && picked.kind === 'command') {
          submit(applyCompletion(valueRef.current, match, picked.insert).trim())
          return
        }
        const category = picked.kind === 'category'
        const spacer = category || /^\s/u.test(suffix) ? '' : ' '
        const next = applyCompletion(valueRef.current, match, picked.insert + spacer)
        const nextOffset = match.start + picked.insert.length + spacer.length
        setDismissed(category ? undefined : JSON.stringify([completionScope, next, nextOffset]))
        setMenu(undefined)
        valueRef.current = next
        offsetRef.current = nextOffset
        onChange(next)
        setOffset(nextOffset)
        if (!category && picked.kind !== 'command') onCompletion?.(picked)
        return
      }
    }
    const edit = applyKeypress(rawInput, key, valueRef.current, offsetRef.current, onHistoryUp, onHistoryDown)
    if (edit.value !== undefined || edit.offset !== undefined) setDismissed(undefined)
    if (edit.value !== undefined) { valueRef.current = edit.value; onChange(edit.value) }
    if (edit.submit !== undefined && completion?.initial !== undefined && dismissed !== liveKey) {
      const cursor = edit.value === undefined ? offsetRef.current : edit.offset ?? offsetRef.current
      const pending = findTrigger(valueRef.current, cursor)
      if (pending && /^(?:[/@$]|\$all:|@(?:file|session|agent|connector|plugin):)$/iu.test(pending.trigger + pending.query)) {
        offsetRef.current = cursor
        setOffset(cursor)
        return
      }
    }
    if (edit.offset !== undefined) { offsetRef.current = edit.offset; setOffset(edit.offset) }
    if (edit.submit !== undefined) submit(edit.submit)
  }, { isActive: focus })

  // Render the value with an inverted cursor block.
  const before = value.slice(0, offset)
  const at = value[offset] ?? ' '
  const after = value.slice(offset + 1)
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{before}</Text>
        <Text inverse>{at}</Text>
        <Text>{after}</Text>
      </Box>
      {hint === undefined ? null : <Text wrap="truncate-end" dimColor>{hint}</Text>}
      {visible.map(item => (
        <Text key={item.kind + ':' + item.id} wrap="truncate-end" dimColor={item.disabled === true} inverse={picked === item}>
          {picked === item ? '› ' : '  '}{item.label}{item.detail ? ' · ' + item.detail : ''}
        </Text>
      ))}
    </Box>
  )
}
