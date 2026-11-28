/** Replayable terminal projection of committed Host tool calls. @module @deepseek-ai/dsh/terminal-activity */
import { stripVTControlCharacters } from 'node:util'
import type { TerminalSessionEvent } from './terminal-host.ts'

/** One committed tool invocation within a turn and model step. */
export interface TerminalActivityItem {
  readonly key: string
  readonly callId: string
  readonly name: string
  readonly turn: number
  readonly step: number
  readonly state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly arguments?: string
  readonly summary?: string
  readonly output?: string
  readonly startedAt?: number
  readonly durationMs?: number
  readonly diagnostic?: string
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function boundedText(value: string): string {
  const clean = stripVTControlCharacters(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' || character === '\t' ? character : '')
    .replace(/("(?:api[-_]?key|token|secret|password|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/giu, '$1"[redacted]"')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
  return clean.length > 6_000 ? clean.slice(0, 6_000) + '\n[output truncated]' : clean
}

function resultText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? boundedText(value) : ''
  return boundedText(value.map((entry) => {
    const block = object(entry)
    return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }).filter(Boolean).join('\n'))
}

function toolSummary(value: string): string | undefined {
  try {
    const { description } = object(JSON.parse(value))
    if (typeof description !== 'string') return undefined
    const summary = boundedText(description).replace(/\s+/gu, ' ').trim()
    if (summary.length === 0) return undefined
    return summary.length > 120 ? summary.slice(0, 119) + '…' : summary
  } catch {
    return undefined
  }
}

/**
 * Apply one committed frame to the projected tool calls in its own Session.
 * @param calls - invocation index owned by the current replay.
 * @param event - sequenced Host event.
 * @returns an inserted or updated item.
 */
export function applyTerminalActivity(
  calls: Map<string, TerminalActivityItem>, event: TerminalSessionEvent,
): TerminalActivityItem | undefined {
  const data = object(event.data)
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return undefined
  const result = object(data.message)
  const callId = event.type === 'tool/call' ? data.callId : result.toolCallId
  if (typeof callId !== 'string' || typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const key = JSON.stringify([data.turn, data.step, callId])
  const earlier = calls.get(key)
  let item: TerminalActivityItem
  if (event.type === 'tool/call') {
    if (earlier !== undefined || typeof data.name !== 'string') return undefined
    const summary = typeof data.arguments === 'string' ? toolSummary(data.arguments) : undefined
    item = {
      key, callId, turn: data.turn, step: data.step, name: data.name, state: 'running',
      ...(typeof data.arguments === 'string' ? { arguments: boundedText(data.arguments) } : {}),
      ...(summary === undefined ? {} : { summary }),
      ...(event.time === undefined ? {} : { startedAt: event.time }),
    }
  } else {
    if (earlier !== undefined && earlier.state !== 'running') return undefined
    const error = object(data.error)
    const reason = typeof error.code === 'string' ? error.code : undefined
    const state = reason === 'ABORTED' || reason === 'ABORTED_BEFORE_DISPATCH' ? 'cancelled'
      : result.isError === true ? 'failed' : 'succeeded'
    const durationMs = earlier?.startedAt === undefined || event.time === undefined
      ? undefined : Math.max(0, event.time - earlier.startedAt)
    const source = object(result.source)
    const name = typeof source.toolName === 'string' ? source.toolName : 'Tool'
    item = {
      ...earlier, key, callId, turn: data.turn, step: data.step, name: earlier?.name ?? name, state,
      output: resultText(result.content), ...(reason === undefined ? {} : { diagnostic: reason }),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
  }
  calls.set(key, item)
  return item
}

/** @param records - frames from one Session. @returns one call per committed turn/step/call identity. */
export function projectTerminalActivity(records: readonly TerminalSessionEvent[]): readonly TerminalActivityItem[] {
  const projected = new Map<string, TerminalActivityItem>()
  const seen = new Set<number>()
  for (const event of [...records].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    applyTerminalActivity(projected, event)
  }
  return [...projected.values()]
}
