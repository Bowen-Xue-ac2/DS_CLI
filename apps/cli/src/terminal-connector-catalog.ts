/** Session-scoped projection of the rc.5 Host MCP tool registry. @module @deepseek-ai/dsh/terminal-connector-catalog */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { MCP_SERVER_NAME, terminalConnectorHost, type TerminalConnector } from './terminal-connector-remote.ts'

/** Cordis plugin loaded by the terminal Host profile. */
export const name = 'ds-cli-connector-catalog'

/** Native Host services used by the catalog. */
export const inject = ['tools', 'typert']

interface Tool {
  readonly name: string
}

interface McpFiber {
  readonly uid: number | null
  readonly ctx: object
  readonly config?: { readonly serverName?: unknown }
}

interface McpClient {
  connectionStatusOf(fiber: McpFiber): {
    current(): { readonly state: string; readonly connectedAt?: number; readonly toolCount?: number }
  } | undefined
}

interface Scopes {
  scopeOf(context: object): object | undefined
  scopeChainOf(key: object): readonly object[]
}

interface CatalogService {
  readonly typertRemote: {
    readonly service: CatalogService
    readonly serviceKey: 'terminalConnectorCatalog'
    readonly namespace: 'terminalConnectors'
  }
  list(agent: object, signal: AbortSignal): readonly TerminalConnector[]
}

interface CatalogContext {
  readonly tools: {
    definitions(scope?: object): readonly Tool[]
    executable(name: string, scope?: object): Tool | undefined
  }
  readonly registry: { get(plugin: McpClient): { readonly fibers: Iterable<McpFiber> } | undefined }
  readonly typert: { register(contribution: typeof terminalConnectorHost): () => Promise<void> }
  provide(key: 'terminalConnectorCatalog', service: CatalogService): unknown
}

async function loadMcpRuntime(): Promise<readonly [McpClient, Scopes]> {
  const bin = process.argv[1]
  if (bin === undefined) throw new Error('The connector catalog requires the terminal Host launcher')
  const fromHost = createRequire(bin)
  const fromWeb = createRequire(fromHost.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const fromManager = createRequire(fromWeb.resolve('@deepseek-ai/dsh-mcp-manager/package.json'))
  const client = fromManager.resolve('@deepseek-ai/dsh-mcp-client')
  const scopes = createRequire(client).resolve('@deepseek-ai/dsh-scope')
  return Promise.all([import(pathToFileURL(client).href), import(pathToFileURL(scopes).href)])
}

/**
 * Project live MCP instances whose provider scope and tools are visible to the receiving Agent.
 * @param ctx - official Host plugin context.
 * @returns disposer withdrawing the catalog endpoint.
 */
export async function apply(ctx: CatalogContext): Promise<() => Promise<void>> {
  const [mcp, scopes] = await loadMcpRuntime()
  // The registered descriptor and binding let the Gateway resolve the native Agent lookup.
  const service: CatalogService = {
    get typertRemote(): CatalogService['typertRemote'] {
      return { service, serviceKey: 'terminalConnectorCatalog', namespace: 'terminalConnectors' }
    },
    list(agent, signal) {
      signal.throwIfAborted()
      const keyChain = scopes.scopeChainOf(agent)
      const providers = new Map<string, { readonly fiber: McpFiber; readonly rank: number }>()
      for (const fiber of ctx.registry.get(mcp)?.fibers ?? []) {
        const server = fiber.config?.serverName
        if (fiber.uid === null || typeof server !== 'string' || !MCP_SERVER_NAME.test(server)) continue
        const owner = scopes.scopeOf(fiber.ctx)
        const rank = owner === undefined ? keyChain.length : keyChain.indexOf(owner)
        if (rank >= 0 && rank < (providers.get(server)?.rank ?? Infinity)) providers.set(server, { fiber, rank })
      }
      const resources = ctx.tools.executable('list_mcp_resources', agent) !== undefined
        && ctx.tools.executable('read_mcp_resource', agent) !== undefined
      const catalog: TerminalConnector[] = []
      for (const [id, { fiber, rank }] of providers) {
        const status = mcp.connectionStatusOf(fiber)?.current()
        if (status?.state !== 'connected' || status.connectedAt === undefined || status.toolCount === undefined) continue
        const owner = keyChain[rank]
        const parent = keyChain[rank + 1]
        const prefix = `mcp__${id}__`
        const registered = ctx.tools.definitions(owner).filter(tool => tool.name.startsWith(prefix)
          && (owner === undefined || ctx.tools.executable(tool.name, parent) !== tool))
        // Overlapping namespaces (e.g. a and a__b) can also appear in raw tool names.
        if (registered.length !== status.toolCount) continue
        const tools = registered.filter(tool => ctx.tools.executable(tool.name, agent) === tool).map(tool => tool.name)
        if (tools.length > 0 || (status.toolCount === 0 && resources)) {
          catalog.push({ id, generation: status.connectedAt, tools, resources, origin: owner === undefined ? 'host' : 'agent' })
        }
      }
      return catalog
    },
  }
  ctx.provide('terminalConnectorCatalog', service)
  return ctx.typert.register(terminalConnectorHost)
}
