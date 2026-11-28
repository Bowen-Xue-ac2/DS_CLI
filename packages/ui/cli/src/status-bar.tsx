/**
 * The status line and session stats: busy state, session id, and the
 * whole-session figures the web surface renders — turn/step counts, LLM and
 * tool wall time, first-token latency, throughput, cache hit rate, and
 * input/output tokens. The status line sits above the input bar (upper-left);
 * the stats summary renders on the same line's right side, above the input bar.
 * @module @deepseek-ai/dsh-cli-ui/status-bar
 */

import * as React from 'react'
import { Box, Text, useStdout } from 'ink'
import { textWidth, truncateToColumns } from './scroll-layout.ts'
import type { CliViewState } from './types.ts'

/** Format a millisecond span compactly (`2m8s`, `1.2s`, `300ms`). */
function fmtMs(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1_000)
    return `${m}m${s}s`
  }
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

/** Format a token count compactly (`1.6M`, `13.4K`, `512`). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * Keep up to `max` columns of text, appending an ellipsis when truncated.
 * @param text - the text to cap.
 * @param max - the maximum display width in columns.
 * @returns the fitting prefix and a separate ellipsis when needed.
 */
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0 || text === '') return ''
  return textWidth(text) <= max ? text : truncateToColumns(text, max) + '…'
}

/**
 * Build the pipe-separated whole-session stats summary shown on the input
 * bar's right side.
 * @param view - the current view state with accumulated stats.
 * @returns the joined stats summary.
 */
export function statsSummary(view: CliViewState): string {
  const stats = view.stats
  // Average first-token latency over the steps that recorded one.
  const ttft = stats.ttftSteps > 0 ? fmtMs(stats.ttftMs / stats.ttftSteps) : '—'
  // Decode throughput is approximated from total output over total LLM time.
  const decodeMs = stats.llmMs > 0 ? stats.llmMs : 1
  const tokPerSec = stats.outputTokens > 0 ? `${Math.round(stats.outputTokens / (decodeMs / 1_000))} tok/s` : ''
  // Cache hit rate from cache-read over billed input.
  const billedInput = stats.inputTokens + stats.cacheReadTokens
  const cachePct = billedInput > 0 ? `${Math.round((stats.cacheReadTokens / billedInput) * 100)}%` : ''
  const segments = [
    `${stats.turns} 轮 · ${stats.steps} 步`,
    `LLM ${fmtMs(stats.llmMs)} · 工具调用 ${fmtMs(stats.toolMs)}`,
    `首 token 平均 ${ttft}`,
    cachePct !== '' ? `缓存命中 ${cachePct}` : '',
    tokPerSec,
    `输入 ${fmtTokens(billedInput)} tok · 输出 ${fmtTokens(stats.outputTokens)} tok`,
  ].filter(segment => segment !== '')
  return segments.join(' | ')
}

function statusLabel(view: CliViewState): string {
  if (!view.busy) return '○ idle'
  if (view.progress === 'thinking') return '● Thinking'
  if (view.progress === 'responding') return '● Responding'
  if (view.progress === 'tools') return '● Running tools'
  return '● busy'
}

/**
 * Render the busy state and session id as the status line above the input
 * bar, upper-left.
 * @param view - the current view state.
 * @param compact - omit the session id in the transcript header.
 */
export function StatusBar({ view, compact = false }: { view: CliViewState; compact?: boolean }) {
  return (
    <Box flexShrink={compact ? 1 : 0}>
      <Text color={view.busy ? 'yellow' : 'green'} wrap={compact ? 'truncate-end' : 'wrap'}>
        {statusLabel(view)}
      </Text>
      {!compact && <Text dimColor>  {view.sessionId}</Text>}
    </Box>
  )
}

/**
 * Render the whole-session stats summary on the upper-right line, above the
 * input bar. Capped to a single line that never wraps: the strip is truncated
 * with `…` only when it would run past the terminal's right edge.
 * @param view - the current view state with accumulated stats.
 */
export function SessionStats({ view }: { view: CliViewState }) {
  const { stdout } = useStdout()
  const summary = statsSummary(view)
  // Leave room for the idle/session head on the same line's left; the strip
  // itself takes the rest of the row and truncates only at the right edge.
  const columns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80
  const max = columns - textWidth(`${statusLabel(view)}  ${view.sessionId}`) - 1
  if (max <= 0) return null
  const clipped = textWidth(summary) <= max ? summary : max === 1 ? '…' : truncateToWidth(summary, max - 1)
  return (
    <Box flexShrink={0} paddingLeft={1}>
      <Text dimColor>{clipped}</Text>
    </Box>
  )
}

/**
 * The permission badge rendered under the input bar, compact like Claude Code.
 * @param view - the current view state carrying the active preset.
 */
export function PermissionBadge({ view }: { view: CliViewState }) {
  const label = view.permission === 'danger-full-access'
    ? 'bypass permissions on'
    : `${view.permission} on`
  return (
    <Box flexShrink={0} paddingLeft={1}>
      <Text {...(view.permission === 'danger-full-access' ? { color: 'yellow' } : { dimColor: true })}>
        ⏵⏵ {label} <Text dimColor>(shift+tab to cycle)</Text>
      </Text>
    </Box>
  )
}

/**
 * The agent-mode badge rendered under the input bar. Only the roster that
 * composes an agent sets a mode; a deployment without one shows nothing.
 * @param view - the current view state carrying the active agent preset.
 */
export function ModeBadge({ view }: { view: CliViewState }) {
  if (view.mode === undefined) return <Box flexShrink={0} />
  return (
    <Box flexShrink={0} paddingLeft={1}>
      <Text dimColor>mode: {view.mode}</Text>
    </Box>
  )
}
