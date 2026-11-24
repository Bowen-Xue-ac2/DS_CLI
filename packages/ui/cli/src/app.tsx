/**
 * The ink application root: a Claude Code-style layout — the conversation
 * scrolls in the flexible top region, a status line and the round-bordered
 * prompt input stay fixed at the bottom.
 * @module @deepseek-ai/dsh-cli-ui/app
 */

import * as React from 'react'
import { Box, Text as InkText, useInput } from 'ink'
import { useCliView, type CliViewStoreLike } from './hooks/use-cli-view.ts'
import { isCancelKey, isExitKey } from './keys.ts'
import { ScrollRegion } from './scroll-region.tsx'
import { ModeBadge, PermissionBadge, SessionStats, StatusBar } from './status-bar.tsx'
import { CliTextInput } from './text-input.tsx'
import { StartMenu, type CliMenu, type CliMenuResult } from './start-menu.tsx'
import type { CliCompletionItem, CliCompletionSource } from './completion.ts'

/** Submitted text and the claims the user selected in this session. */
export interface CliSubmission {
  readonly sessionId: string
  readonly text: string
  readonly selections: readonly CliCompletionItem[]
}

/** The props the io wires from the driver's view store and interaction hooks. */
export interface CliAppProps {
  /** The driver-owned view store. */
  store: CliViewStoreLike
  /** Submit one input line to the driver. */
  onSubmit(this: void, line: string, submission: CliSubmission): void
  /** Cancel the in-flight turn (Ctrl+C while busy). */
  onCtrlC(this: void): void
  /** Request a clean exit (Ctrl+C at the prompt, or Ctrl+D). */
  onExit(this: void): void
  /** Up-arrow history navigation. */
  onHistoryUp?(this: void, current: string): string | undefined
  /** Down-arrow history navigation. */
  onHistoryDown?(this: void, current: string): string | undefined
  /** Shift+Tab cycles the permission preset. */
  onCyclePermission?(this: void): void
  /** An active menu temporarily owns the keyboard, while the draft stays mounted here. */
  menu?: { readonly id: number; readonly content: CliMenu; finish(result: CliMenuResult): void }
  /** Optional live completion directories. */
  completion?: CliCompletionSource
  /** A failed admission whose draft should be retained if the user has not already edited another. */
  restore?: CliSubmission
}

/** The assembled terminal UI. */
export function CliApp({
  store, onSubmit, onCtrlC, onExit, onHistoryUp, onHistoryDown, onCyclePermission, menu, completion, restore,
}: CliAppProps) {
  const view = useCliView(store)
  const [drafts, setDrafts] = React.useState<ReadonlyMap<string, CliSubmission>>(() => new Map())
  const [transcript, setTranscript] = React.useState(false)
  const draft = drafts.get(view.sessionId)
  const input = draft?.text ?? ''
  React.useEffect(() => {
    if (restore === undefined) return
    setDrafts(previous => previous.has(restore.sessionId) ? previous : new Map(previous).set(restore.sessionId, restore))
  }, [restore])
  function setInput(value: string): void {
    setDrafts((previous) => {
      const next = new Map(previous)
      if (value === '') next.delete(view.sessionId)
      else next.set(view.sessionId, {
        sessionId: view.sessionId, text: value,
        selections: next.get(view.sessionId)?.selections.filter(item => value.includes(item.insert)) ?? [],
      })
      return next
    })
  }
  function rememberChoice(item: CliCompletionItem): void {
    setDrafts((previous) => {
      const current = previous.get(view.sessionId)
      if (current === undefined) return previous
      const selections = current.selections.filter(value => value.kind !== item.kind || value.id !== item.id)
      return new Map(previous).set(view.sessionId, { ...current, selections: [...selections, item] })
    })
  }
  useInput((inputChar, key) => {
    // Keep Ink's raw input active while the prompt hands the keyboard to a menu.
    if (menu !== undefined) return
    if ((key.ctrl && inputChar === 't') || (transcript && key.escape)) {
      if (view.sessionId !== '') setTranscript(open => !open)
      return
    }
    if (transcript) return
    // Shift+Tab cycles the permission preset.
    if (key.shift && key.tab) {
      onCyclePermission?.()
      return
    }
    // Ctrl+C / Ctrl+D are handled here; printable input belongs to the
    // text input, which also owns the prompt focus.
    if (isCancelKey(inputChar, key)) {
      if (view.busy || (view.inputLocked === true && view.sessionId !== '')) onCtrlC()
      else onExit()
    } else if (isExitKey(inputChar, key)) {
      onExit()
    }
  })
  if (menu !== undefined) return <StartMenu key={menu.id} menu={menu.content} onClose={menu.finish} />
  if (view.inputLocked === true && view.sessionId === '') return <InkText>Connecting to DSH Host…</InkText>
  if (transcript) return (
    <Box flexDirection="column">
      <InkText bold>Transcript</InkText>
      <ScrollRegion key="transcript" view={view} details />
      <InkText dimColor>PgUp / PgDn to scroll · Ctrl+T or Esc to return</InkText>
    </Box>
  )
  return (
    <Box flexDirection="column">
      {view.project === undefined ? null : (
        <InkText>Workspace {view.project} · Directory {view.cwd}</InkText>
      )}
      <ScrollRegion view={view} />
      <Box flexShrink={0} flexDirection="row">
        <Box flexGrow={1}>
          <StatusBar view={view} />
        </Box>
        <SessionStats view={view} />
      </Box>
      <Box
        flexShrink={0}
        flexDirection="row"
        alignItems="flex-start"
        borderStyle="round"
        borderColor={view.busy ? 'yellow' : 'gray'}
        borderLeft={false}
        borderRight={false}
        borderBottom
      >
        <InkText color={view.busy ? 'yellow' : 'green'}>{view.busy ? '…' : '❯'} </InkText>
        <Box flexGrow={1} flexShrink={1}>
          <CliTextInput
            key={view.sessionId}
            value={input}
            onChange={setInput}
            onSubmit={(line) => {
              onSubmit(line, { sessionId: view.sessionId, text: line, selections: draft?.selections ?? [] })
              setInput('')
            }}
            focus={view.inputLocked !== true}
            {...(restore !== undefined && draft === restore ? { restoreCursor: restore } : {})}
            {...(completion === undefined ? {} : {
              completion, completionScope: JSON.stringify([view.sessionId, view.cwd, view.mode]), onCompletion: rememberChoice,
            })}
            {...(onHistoryUp === undefined ? {} : { onHistoryUp })}
            {...(onHistoryDown === undefined ? {} : { onHistoryDown })}
          />
        </Box>
      </Box>
      <ModeBadge view={view} />
      <Box flexDirection="row">
        <PermissionBadge view={view} />
        <InkText dimColor>  ·  Ctrl+T transcript</InkText>
      </Box>
    </Box>
  )
}
