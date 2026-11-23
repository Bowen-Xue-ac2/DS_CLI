/** Terminal operations for the official MCP manager. @module @deepseek-ai/dsh/terminal-connectors */
import type { InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type TerminalHost } from './terminal-host.ts'

const USAGE = 'Usage: /mcp [list | probe <server> | restart <server>]'

async function managedServers(host: TerminalHost) {
  const signal = AbortSignal.any([host.signal, AbortSignal.timeout(8_000)])
  for await (const servers of host.remote.mcpManager.watch(signal)) return servers
  signal.throwIfAborted()
  throw new Error('The Host MCP status stream closed before sending its initial state')
}

/**
 * Inspect configured MCP servers or request an explicit Host management operation.
 * @param host - the current authenticated Host.
 * @param io - terminal confirmation UI for operations that interrupt a live connection.
 * @param args - the optional management subcommand and server name.
 * @returns a concise management result for the terminal.
 */
export async function runMcpCommand(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, args?: string,
): Promise<string> {
  const [operation = 'list', name, extra] = args?.trim().split(/\s+/u) ?? []
  if (operation === 'list') {
    if (name !== undefined) return USAGE
    const servers = await managedServers(host)
    return servers.length === 0 ? 'No managed MCP servers configured' : [
      'MCP servers on this Host',
      ...servers.map(server => `${server.name}  ${server.status.state}${server.configured ? '' : ' (removed)'}`),
    ].join('\n')
  }
  if (operation !== 'probe' && operation !== 'restart') return USAGE
  if (name === undefined || !/^[A-Za-z0-9_-]{1,32}$/u.test(name) || extra !== undefined) return USAGE
  const servers = await managedServers(host)
  const server = servers.find(item => item.name === name && item.configured)
  if (server === undefined) return `Unknown configured MCP server: ${name}`

  if (operation === 'probe') {
    try {
      const probe = requireHostResult(await host.remote.mcpManager.probe(server.name, host.signal))
      const cleanup = probe.cleanupError !== undefined ? 'cleanup failed'
        : probe.closeConfirmed ? 'closed' : 'closure unconfirmed'
      if (!probe.ok) return `${server.name}: probe failed at ${probe.stage} · ${cleanup}`
      const count = probe.toolNames.length
      return `${server.name}: probe passed · ${count}${probe.truncated ? '+' : ''} tool${count === 1 && !probe.truncated ? '' : 's'} · ${cleanup}`
    } catch {
      host.signal.throwIfAborted()
      return `${server.name}: Host could not start the probe. Check /mcp for the current state.`
    }
  }

  if (server.status.state === 'disabled') return `${server.name}: enable this server before restarting`
  const answer = await io.choose({
    title: `Restart MCP server ${server.name}?`,
    detail: 'The Host will replace the live connection.',
    fields: [{ label: 'Action', initial: 'cancel', options: [
      { id: 'cancel', label: 'Keep connection' }, { id: 'restart', label: 'Restart' },
    ] }],
  }, host.signal)
  if (answer.kind !== 'chosen' || answer.values[0] !== 'restart') return 'Restart cancelled'
  try {
    requireHostResult(await host.remote.mcpManager.restart(server.name))
    return `${server.name}: restart requested. Use /mcp to check status.`
  } catch {
    host.signal.throwIfAborted()
    return `${server.name}: Host could not restart this server. Check /mcp for the current state.`
  }
}
