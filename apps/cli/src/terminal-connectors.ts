/** Terminal operations for the official MCP manager. @module @deepseek-ai/dsh/terminal-connectors */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CliCompletionItem, InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { MCP_SERVER_NAME, type TerminalConnector } from './terminal-connector-remote.ts'
import { requireHostResult, type TerminalHost, type TerminalSettingsValue } from './terminal-host.ts'
import type { TerminalMcpResources } from './terminal-mcp-resources.ts'

const USAGE = 'Usage: /mcp [list | configure <server> <json-file> | enable <server> | disable <server> | probe <server> | restart <server> | resources <server> | templates <server>]'
// The owning Loader entry in the pinned Web Host profile supplies this namespace.
const MANAGER_SETTINGS = 'mcp-manager'

function settingsObject(value: TerminalSettingsValue | undefined): value is { readonly [key: string]: TerminalSettingsValue } {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read current connector metadata without activating a session or calling a connector.
 * @param host - authenticated Host.
 * @param sessionId - receiving Agent's Session ID.
 * @param signal - lookup lifetime.
 * @returns live MCP servers with tools executable in the receiving Agent.
 */
export async function listTerminalConnectors(
  host: TerminalHost, sessionId: string, signal: AbortSignal,
): Promise<readonly TerminalConnector[]> {
  const lifetime = AbortSignal.any([host.signal, signal])
  lifetime.throwIfAborted()
  return requireHostResult(await host.remote.terminalConnectors.list(sessionId, lifetime))
}

/** Verify the selected connectors again before logging the prompt in the receiving Session.
 * @param host - authenticated Host.
 * @param sessionId - Session that will receive the prompt.
 * @param text - normalized user prompt.
 * @param selections - prompt selections associated with this Session.
 * @param resources - resource discoveries belonging to the native tool path.
 * @param signal - submission lifetime.
 * @returns user prompt with the selected native MCP tools identified.
 */
export async function prepareConnectorPrompt(
  host: TerminalHost, sessionId: string, text: string, selections: readonly CliCompletionItem[],
  resources: TerminalMcpResources, signal: AbortSignal,
): Promise<string> {
  const mentions = new Set([...text.matchAll(/(?:^|\s)(@connector:[^\s]+)(?=\s|$)/gu)].map(match => match[1]))
  if (mentions.size === 0) return text
  const selected = selections.filter(item => item.kind === 'connector' && mentions.has(item.insert))
  if (selected.length !== mentions.size) throw new Error('Pick the MCP connector from completion before sending.')
  const available = await listTerminalConnectors(host, sessionId, signal)
  const choices = selected.map((item) => {
    const serverId = item.connectorResource?.server ?? item.id
    const server = available.find(row => row.id === serverId && row.generation === item.connectionGeneration)
    if (server === undefined) throw new Error(`MCP connector ${serverId} changed or is unavailable. Pick it again.`)
    const uri = item.connectorResource?.uri
    if (uri === undefined) {
      return server.tools.length === 0
        ? `Use the native MCP resource tools with server ${JSON.stringify(server.id)} when needed.`
        : `Use the tools from the selected MCP connector when needed: ${server.id} (${server.tools.join(', ')}).`
    }
    if (!resources.list(sessionId, server).some(resource => resource.uri === uri)) {
      throw new Error(`MCP resource from ${serverId} is unavailable. List its resources and pick it again.`)
    }
    return `Use read_mcp_resource for the selected MCP resource with server ${JSON.stringify(server.id)} and URI ${JSON.stringify(uri)}.`
  })
  const request = text.replace(/(^|\s)@connector:[^\s]+(?=\s|$)/gu, '$1').trim()
  if (request === '') throw new Error('Add a message for the selected MCP connector.')
  return `${request}\n\n${choices.join('\n')}`
}

async function managedServers(host: TerminalHost) {
  const signal = AbortSignal.any([host.signal, AbortSignal.timeout(8_000)])
  for await (const servers of host.remote.mcpManager.watch(signal)) return servers
  signal.throwIfAborted()
  throw new Error('The Host MCP status stream closed before sending its initial state')
}

async function confirmMcpChange(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, title: string, detail: string, action: string,
): Promise<boolean> {
  const answer = await io.choose({
    title, detail,
    fields: [{ label: 'Action', initial: 'cancel', options: [
      { id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: action },
    ] }],
  }, host.signal)
  return answer.kind === 'chosen' && answer.values[0] === 'confirm'
}

async function changeMcpSettings(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>,
  operation: 'configure' | 'enable' | 'disable', name: string, filename?: string,
): Promise<string> {
  const settings = requireHostResult(await host.remote.settings.describe())
  const row = settings.namespaces.find(namespace => namespace.ns === MANAGER_SETTINGS)
  if (!settings.writable || row === undefined) return 'The Host MCP settings are read-only.'
  const entries = settingsObject(row.value) && settingsObject(row.value.servers) ? row.value.servers : {}
  if (!Object.hasOwn(entries, name)) {
    const managed = await managedServers(host)
    if (managed.some(server => server.name === name && server.configured)) {
      return `${name}: configuration is owned by its plugin.`
    }
    if (operation !== 'configure') return `Unknown configured MCP server: ${name}`
  }
  const path = ['servers', name]
  let value: TerminalSettingsValue
  let label: string
  let title: string
  let detail: string
  if (operation === 'configure') {
    if (filename === undefined) return USAGE
    let entry: TerminalSettingsValue
    try {
      entry = JSON.parse(await readFile(filename, { encoding: 'utf8', signal: host.signal })) as TerminalSettingsValue
    } catch {
      host.signal.throwIfAborted()
      return 'Could not read an MCP configuration object from that JSON file.'
    }
    if (!settingsObject(entry) || (entry.transport !== 'stdio' && entry.transport !== 'streamable-http')) {
      return 'The MCP configuration must specify transport as stdio or streamable-http.'
    }
    value = { ...entry, enabled: entry.enabled ?? false }
    label = 'Save'
    title = `Save MCP configuration for ${name}?`
    detail = `${entry.transport} · ${entry.enabled === true ? 'Start the configured server after saving' : 'Save the server as disabled'}`
  } else {
    path.push('enabled')
    value = operation === 'enable'
    label = value ? 'Enable' : 'Disable'
    title = `${label} MCP server ${name}?`
    detail = value ? 'The Host will start the configured server.' : 'The Host will close the current connection.'
  }
  if (!await confirmMcpChange(host, io, title, detail, label)) return `${label} cancelled`
  const result = await host.remote.settings.mutate(row.ns, [{ op: 'set', path, value }], row.revision)
  if (!result.ok) {
    return result.error.code === 'settings/conflict'
      ? `${name}: settings changed. Review /mcp and retry.`
      : `${name}: the Host rejected the settings change (${result.error.code}).`
  }
  return `${name}: ${operation === 'configure' ? 'configuration saved' : operation === 'enable' ? 'enabled' : 'disabled'}`
}

/**
 * Inspect configured MCP servers or request an explicit Host management operation.
 * @param host - the current authenticated Host.
 * @param io - terminal confirmation UI for operations that interrupt a live connection.
 * @param args - the optional management subcommand and server name.
 * @param cwd - active working directory for a configuration file.
 * @returns a concise management result for the terminal.
 */
export async function runMcpCommand(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, args: string | undefined, cwd: string,
): Promise<string> {
  const [, operation = 'list', name, extra] = /^(\S+)(?:\s+(\S+))?(?:\s+(.+))?$/u.exec(args?.trim() ?? '') ?? []
  if (operation === 'list') {
    if (name !== undefined) return USAGE
    const servers = await managedServers(host)
    return servers.length === 0 ? 'No managed MCP servers configured' : [
      'MCP servers on this Host',
      ...servers.map(server => `${server.name}  ${server.status.state}${server.configured ? '' : ' (removed)'}`),
    ].join('\n')
  }
  if (name === undefined || !MCP_SERVER_NAME.test(name)) return USAGE
  if (operation === 'configure') {
    if (extra === undefined) return USAGE
    const filename = extra.replace(/^(["'])(.*)\1$/u, '$2')
    return changeMcpSettings(host, io, operation, name, resolve(cwd, filename))
  }
  if (extra !== undefined) return USAGE
  if (operation === 'enable' || operation === 'disable') return changeMcpSettings(host, io, operation, name)
  if (operation !== 'probe' && operation !== 'restart') return USAGE
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
  if (!await confirmMcpChange(
    host, io, `Restart MCP server ${server.name}?`, 'The Host will replace the live connection.', 'Restart',
  )) return 'Restart cancelled'
  try {
    requireHostResult(await host.remote.mcpManager.restart(server.name))
    return `${server.name}: restart requested. Use /mcp to check status.`
  } catch {
    host.signal.throwIfAborted()
    return `${server.name}: Host could not restart this server. Check /mcp for the current state.`
  }
}
