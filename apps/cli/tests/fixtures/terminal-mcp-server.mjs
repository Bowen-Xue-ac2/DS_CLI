import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  const response = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'initialize') {
    await appendFile(process.argv[2], 'initialized\n')
    response.result = {
      protocolVersion: request.params.protocolVersion,
      serverInfo: { name: 'cli-mcp-fixture', version: '1' },
      capabilities: { tools: {}, resources: {} },
    }
  } else if (request.method === 'tools/list') {
    response.result = { tools: [{
      name: 'fixture_status',
      description: 'Return a fixed status from the fixture',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    }] }
  } else if (request.method === 'tools/call' && request.params.name === 'fixture_status') {
    await appendFile(process.argv[2], 'called\n')
    response.result = { content: [{ type: 'text', text: 'MCP_FIXTURE_STATUS' }] }
  } else if (request.method === 'resources/list') {
    await appendFile(process.argv[2], 'resources-listed\n')
    response.result = { resources: [{ uri: 'fixture://local/readme', name: 'Fixture readme', mimeType: 'text/plain' }] }
  } else if (request.method === 'resources/templates/list') {
    response.result = { resourceTemplates: [] }
  } else if (request.method === 'resources/read' && request.params.uri === 'fixture://local/readme') {
    await appendFile(process.argv[2], 'resource-read\n')
    response.result = {
      contents: [{ uri: 'fixture://local/readme', mimeType: 'text/plain', text: 'MCP_RESOURCE_SENTINEL' }],
    }
  } else {
    response.error = { code: -32601, message: 'Method not found' }
  }
  process.stdout.write(JSON.stringify(response) + '\n')
}
