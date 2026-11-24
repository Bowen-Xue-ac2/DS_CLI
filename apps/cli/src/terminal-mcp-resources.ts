/** Resource discoveries from native MCP tool results for the receiving Session. @module @deepseek-ai/dsh/terminal-mcp-resources */
import type { TerminalConnector } from './terminal-connector-remote.ts'
import type { TerminalSessionEvent } from './terminal-host.ts'

interface Resource {
  readonly name: string
  readonly uri: string
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseObject(value: string): Readonly<Record<string, unknown>> {
  try {
    const result: unknown = JSON.parse(value)
    return asObject(result)
  } catch { return {} }
}

function listing(content: unknown, serverId: string): readonly Resource[] | undefined {
  if (!Array.isArray(content)) return undefined
  const prefix = `MCP server: ${serverId}\n`
  const text = content.map(asObject).find(part =>
    part.type === 'text' && typeof part.text === 'string' && part.text.startsWith(prefix))?.text
  if (typeof text !== 'string' || text.length > 256_000) return undefined
  const rows = parseObject(text.slice(prefix.length)).resources
  if (!Array.isArray(rows)) return undefined
  const unique = new Map<string, Resource>()
  for (const raw of rows.slice(0, 100)) {
    const { uri, name } = asObject(raw)
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048 || !uri.isWellFormed()
      || /[\p{Cc}\p{Cf}]/u.test(uri)) continue
    const label = typeof name === 'string' ? name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 120) : ''
    unique.set(uri, { name: label || uri, uri })
  }
  return [...unique.values()]
}

/** Retain resource metadata from explicitly requested native tool calls until a connection changes. */
export class TerminalMcpResources {
  private readonly pending = new Map<string, TerminalConnector>()
  private readonly calls = new Map<string, TerminalConnector>()
  private readonly discovered = new Map<string, { readonly generation: number; readonly entries: readonly Resource[] }>()

  /** @param sessionId - receiving Session. @param connector - connector at the time the user requested discovery. */
  begin(sessionId: string, connector: TerminalConnector): void {
    this.pending.set(JSON.stringify([sessionId, connector.id]), connector)
  }

  /** @param sessionId - current Session. @param connector - live connector that must still expose the resource tools. */
  list(sessionId: string, connector: TerminalConnector): readonly Resource[] {
    const saved = this.discovered.get(JSON.stringify([sessionId, connector.id]))
    return connector.resources && saved?.generation === connector.generation ? saved.entries : []
  }

  /** @param sessionId - journal owning the event. @param event - committed native tool call or result. */
  observe(sessionId: string, event: TerminalSessionEvent): void {
    if (event.type === 'tool/call') {
      const { callId, name, arguments: args } = asObject(event.data)
      if (name !== 'list_mcp_resources' || typeof callId !== 'string' || typeof args !== 'string') return
      const { server, cursor } = parseObject(args)
      if (typeof server !== 'string' || cursor !== undefined) return
      const key = JSON.stringify([sessionId, server])
      const pending = this.pending.get(key)
      if (pending === undefined) return
      this.pending.delete(key)
      this.calls.set(JSON.stringify([sessionId, callId]), pending)
    } else if (event.type === 'tool/result') {
      const { toolCallId, isError, content } = asObject(asObject(event.data).message)
      if (typeof toolCallId !== 'string') return
      const key = JSON.stringify([sessionId, toolCallId])
      const connector = this.calls.get(key)
      if (connector === undefined) return
      this.calls.delete(key)
      const entries = isError === true ? undefined : listing(content, connector.id)
      if (entries !== undefined) {
        this.discovered.set(JSON.stringify([sessionId, connector.id]), { generation: connector.generation, entries })
      }
    }
  }
}
