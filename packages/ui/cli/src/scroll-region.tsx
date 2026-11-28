/**
 * The top scroll region: a virtualized window over the transcript's styled
 * line model (`scroll-layout`). It renders only the visible slice of lines, so
 * a long transcript scrolls inside the region and the input stays pinned at
 * the bottom — and it never relies on ink's fixed-height clipping, which
 * mis-wraps CJK once content overflows.
 *
 * Scrolling is keyboard-driven: PgUp/PgDn page the window. While pinned to the
 * bottom the region auto-follows new items as they arrive; scrolling back pauses
 * the follow until the user returns to the bottom. The details view also
 * supports line scrolling with ↑/↓ and jumping to the latest line with End.
 * @module @deepseek-ai/dsh-cli-ui/scroll-region
 */

import * as React from 'react'
import { Box, Text, useInput, useStdin, useStdout } from 'ink'
import type { CliViewState } from './types.ts'
import { layoutItems, parseMouseWheel, scrollStep, viewportSlice } from './scroll-layout.ts'
import type { StyledRun } from './scroll-layout.ts'

/** Rows reserved above the scroll region by the status line, stats, and input. */
const FIXED_ROWS = 4

/** The minimum usable viewport height in rows. */
const MIN_HEIGHT = 5

/** Render one styled run as an ink `<Text>`, carrying only set styles. */
function StyledText({ run }: { run: StyledRun }) {
  return (
    <Text
      {...(run.bold ? { bold: true } : {})}
      {...(run.italic ? { italic: true } : {})}
      {...(run.dim ? { dimColor: true } : {})}
      {...(run.color !== undefined ? { color: run.color } : {})}
    >
      {run.text}
    </Text>
  )
}

/**
 * The scrollable conversation region. The visible window is a slice of the
 * styled line list sized to the terminal rows, so the newest items stay on
 * screen and the input stays pinned at the bottom.
 * @param view - the current view state.
 * @param details - show provider reasoning and individual tool calls in transcript mode.
 * @param menuRows - lines occupied by the composer completion menu.
 * @param reservedRows - lines occupied by the rest of the composer and status.
 */
export function ScrollRegion({ view, details = false, menuRows = 0, reservedRows = FIXED_ROWS }: {
  view: CliViewState
  details?: boolean
  menuRows?: number
  reservedRows?: number
}) {
  const { stdout } = useStdout()
  const { internal_eventEmitter: inputEvents } = useStdin()
  const [, onResize] = React.useReducer((revision: number) => revision + 1, 0)
  React.useEffect(() => {
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout, onResize])
  const width = stdout.columns && stdout.columns > 0 ? stdout.columns : 80
  const rows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24
  // Leave one spare row alongside the transcript header and footer. Ink
  // clears the entire screen on each update when its frame fills the terminal.
  const height = Math.max(details || menuRows > 0 ? 1 : MIN_HEIGHT, rows - (details ? 3 : reservedRows + menuRows))
  const items = React.useMemo(() => view.partial === undefined ? view.items : [...view.items, ...view.partial], [view.items, view.partial])

  const [expanded, setExpanded] = React.useState(false)
  const lines = React.useMemo(() => layoutItems(items, width, expanded, details), [items, width, expanded, details])
  const total = lines.length
  const tail = Math.max(0, total - height)
  // When browsing history, anchor the top row to the start of the transcript.
  // A bottom-relative offset would move that row each time new output arrived.
  const [historyTop, setHistoryTop] = React.useState<number>()
  const offset = Math.max(0, tail - (historyTop ?? tail))

  React.useEffect(() => {
    if (!details) return
    // Ink 5 recognizes End but does not expose it in the useInput key map.
    const onInput = (input: string) => {
      if (/^\x1b(?:\[(?:F|[48]~)|OF)$/u.test(input)) setHistoryTop(undefined)
    }
    inputEvents.on('input', onInput)
    return () => { inputEvents.off('input', onInput) }
  }, [details, inputEvents])

  useInput((rawInput, key) => {
    if (key.ctrl && rawInput === 'o') {
      setExpanded(open => !open)
      return
    }
    const wheel = parseMouseWheel(rawInput)
    const pageUp = key.pageUp || wheel > 0 || (details && key.upArrow)
    const pageDown = key.pageDown || wheel < 0 || (details && key.downArrow)
    if (!pageUp && !pageDown) return
    const step = key.upArrow || key.downArrow ? 1 : height
    setHistoryTop((previous) => {
      const next = scrollStep(Math.max(0, tail - (previous ?? tail)), { pageUp, pageDown }, step, tail)
      return next === 0 ? undefined : tail - next
    })
  })

  const [start, end] = viewportSlice(total, height, offset)
  const visible = lines.slice(start, end)

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={height}>
        {visible.length === 0
          ? <Text dimColor wrap="truncate-end">{details ? 'No activity yet.' : 'No messages yet — type a prompt below.'}</Text>
          : visible.map((line, index) => (
            <Box key={`line-${start + index}`} height={1} flexDirection="row">
              {line.runs.length === 0
                ? <Text> </Text>
                : line.runs.map((run, runIndex) => <StyledText key={runIndex} run={run} />)}
            </Box>
          ))}
      </Box>
      {details && (
        <Text dimColor wrap="truncate-end">
          {historyTop === undefined ? 'Following' : 'Paused'} · End latest · ↑↓ / PgUp PgDn · Ctrl+O output · Ctrl+T / Esc back
        </Text>
      )}
    </Box>
  )
}
