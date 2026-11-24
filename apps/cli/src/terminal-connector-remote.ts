/** Wire contract for the terminal Host's session-scoped MCP catalog. @module @deepseek-ai/dsh/terminal-connector-remote */

/** Connected provider and executable tools visible to the requesting Agent. */
export interface TerminalConnector {
  readonly id: string
  readonly generation: number
  readonly tools: readonly string[]
  readonly resources: boolean
  readonly origin: 'host' | 'agent'
}

/** Identifier required by the pinned MCP client. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u

function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError('Expected a Session ID')
  }
  return value
}

function parseCatalog(value: unknown): readonly TerminalConnector[] {
  if (!Array.isArray(value)) throw new TypeError('Expected an MCP connector catalog')
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || !('id' in entry) || !('generation' in entry)
      || !('tools' in entry) || !('resources' in entry) || !('origin' in entry)
      || (entry.origin !== 'host' && entry.origin !== 'agent') || typeof entry.id !== 'string' || !MCP_SERVER_NAME.test(entry.id)
      || typeof entry.generation !== 'number' || !Number.isSafeInteger(entry.generation)
      || typeof entry.resources !== 'boolean' || !Array.isArray(entry.tools)
      || !entry.tools.every(tool => typeof tool === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(tool))) {
      throw new TypeError('Invalid MCP connector catalog entry')
    }
    const tools: string[] = entry.tools
    return { id: entry.id, generation: entry.generation, tools, resources: entry.resources, origin: entry.origin }
  })
}

const packageId = '@deepseek-ai/dsh-terminal-connector-catalog'
const catalog = {
  id: packageId + '#terminalConnectors/list',
  namespace: 'terminalConnectors',
  method: 'list',
  service: 'terminalConnectorCatalog',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
    codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => ({ parse: parseSessionId }) },
  }],
  cancellation: { parameter: 'signal' },
  result: {
    mode: 'strict', typeSymbol: packageId + '#Catalog', create: () => ({ parse: parseCatalog }), decode: parseCatalog,
  },
} as const

/** Mount the catalog on the same Gateway and Agent lookup used by file references. */
export const terminalConnectorRemote = { package: packageId, descriptors: [catalog] } as const

/** Register the catalog implementation in the terminal's official Host profile. */
export const terminalConnectorHost = {
  package: packageId,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: terminalConnectorRemote.descriptors,
} as const
