import { expect, it } from 'vitest'
import type { TerminalConnector } from '../src/terminal-connector-remote.ts'
import { TerminalMcpResources } from '../src/terminal-mcp-resources.ts'

it('uses only discovered resources in the owning session and connection generation', () => {
  const cache = new TerminalMcpResources()
  const connector: TerminalConnector = { id: 'fixture', tools: [], origin: 'host', resources: true, generation: 1 }
  cache.begin('session-a', connector)
  cache.observe('session-a', {
    seq: 1, type: 'tool/call',
    data: { callId: 'call-fixture', name: 'list_mcp_resources', arguments: '{"server":"fixture"}' },
  })
  const response = {
    seq: 2, type: 'tool/result',
    data: { message: {
      toolCallId: 'call-fixture', content: [{ type: 'text', text: 'MCP server: fixture\n' + JSON.stringify({
        resources: [{ name: 'Readme', uri: 'fixture://resource' }],
      }) }],
    } },
  }
  cache.observe('session-b', response)
  expect(cache.list('session-b', connector)).toEqual([])
  expect(cache.list('session-a', connector)).toEqual([])
  cache.observe('session-a', response)
  expect(cache.list('session-a', connector)).toEqual([{ name: 'Readme', uri: 'fixture://resource' }])
  expect(cache.list('session-a', { ...connector, generation: 2 })).toEqual([])
  expect(cache.list('session-a', { ...connector, resources: false })).toEqual([])
})
