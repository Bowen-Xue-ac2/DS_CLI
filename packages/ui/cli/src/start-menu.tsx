/** Terminal choices and path input with one active keyboard consumer. @module @deepseek-ai/dsh-cli-ui/start-menu */
import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import { applyKeypress } from './text-input.tsx'

/** One item in a terminal selection field. */
export interface CliMenuOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly disabled?: boolean
}

/** A selection list or a path input in the current menu. */
export type CliMenuField =
  | { readonly label: string; readonly initial: string; readonly options: readonly CliMenuOption[] }
  | { readonly label: string; readonly initial: string; readonly path: true }
  | { readonly label: string; readonly initial: string; readonly text: true }

/** Terminal menu content provided by the caller. */
export interface CliMenu {
  readonly title: string
  readonly detail?: string
  readonly fields: readonly CliMenuField[]
}

/** Final keyboard action from a single menu. */
export type CliMenuResult =
  | { readonly kind: 'chosen'; readonly values: readonly string[] }
  | { readonly kind: 'escape' | 'cancel' }

interface MenuState {
  readonly field: number
  readonly values: readonly string[]
  readonly offset: number
}

function selectable(field: CliMenuField, value: string): boolean {
  return 'options' in field
    ? field.options.some(option => option.id === value && !option.disabled)
    : value.trim() !== ''
}

/**
 * Render a keyboard-operated menu and settle just one choice.
 * @param props - fields, defaults, and the callback for a choice or cancellation.
 * @returns the current menu frame.
 */
export function StartMenu({ menu, onClose }: { menu: CliMenu; onClose(result: CliMenuResult): void }) {
  const [state, setState] = React.useState<MenuState>(() => ({
    field: 0,
    values: menu.fields.map(field => field.initial),
    offset: menu.fields[0]?.initial.length ?? 0,
  }))
  const live = React.useRef(state)
  const settled = React.useRef(false)
  function update(next: MenuState): void {
    live.current = next
    setState(next)
  }
  function finish(result: CliMenuResult): void {
    settled.current = true
    onClose(result)
  }
  function confirm(values: readonly string[]): void {
    if (menu.fields.every((field, i) => selectable(field, values[i] ?? ''))) {
      finish({ kind: 'chosen', values })
    }
  }

  useInput((input, key) => {
    if (settled.current) return
    if (key.escape) {
      finish({ kind: 'escape' })
      return
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      finish({ kind: 'cancel' })
      return
    }
    const current = live.current
    const field = menu.fields[current.field]
    if (field === undefined) return
    if (key.tab) {
      const direction = key.shift ? -1 : 1
      const next = (current.field + direction + menu.fields.length) % menu.fields.length
      update({ ...current, field: next, offset: current.values[next]?.length ?? 0 })
      return
    }
    const value = current.values[current.field] ?? ''
    if ('options' in field) {
      if (key.return) {
        confirm(current.values)
      } else if (key.upArrow || key.downArrow) {
        const available = field.options.filter(option => !option.disabled)
        if (available.length === 0) return
        const at = available.findIndex(option => option.id === value)
        const next = at === -1
          ? (key.upArrow ? available.length - 1 : 0)
          : (at + (key.upArrow ? -1 : 1) + available.length) % available.length
        const selected = available[next]
        if (selected === undefined) return
        const values = current.values.map((previous, i) => i === current.field ? selected.id : previous)
        update({ ...current, values })
      }
      return
    }
    const edit = applyKeypress(input, key, value, current.offset)
    const values = edit.value === undefined
      ? current.values
      : current.values.map((previous, i) => i === current.field ? edit.value ?? '' : previous)
    update({ ...current, values, offset: edit.offset ?? current.offset })
    if (edit.submit !== undefined) confirm(values)
  })

  return (
    <Box flexDirection="column">
      <Text bold>{menu.title}</Text>
      {menu.detail === undefined ? null : <Text>{menu.detail}</Text>}
      {menu.fields.map((field, i) => {
        const value = state.values[i] ?? ''
        const focused = i === state.field
        const options = 'options' in field ? field.options : []
        const selected = Math.max(0, options.findIndex(option => option.id === value))
        const first = Math.max(0, Math.min(selected - 2, options.length - 6))
        return (
          <Box key={field.label} flexDirection="column" marginTop={1}>
            <Text bold {...(focused ? { color: 'cyan' } : {})}>{focused ? '› ' : '  '}{field.label}</Text>
            {'options' in field ? options.slice(first, first + 6).map(option => (
              <Text key={option.id} dimColor={option.disabled === true}>
                {option.id === value ? '  ● ' : '    '}{option.label}{option.detail ? '  ' + option.detail : ''}
              </Text>
            )) : (
              <Text>  {value.slice(0, state.offset)}<Text inverse={focused}>{value[state.offset] ?? ' '}</Text>{value.slice(state.offset + 1)}</Text>
            )}
          </Box>
        )
      })}
      <Box marginTop={1}><Text dimColor>↑↓ select · Tab field · Enter confirm · Esc cancel</Text></Box>
    </Box>
  )
}
