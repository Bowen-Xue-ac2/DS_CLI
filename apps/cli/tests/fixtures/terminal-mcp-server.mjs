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
      capabilities: { tools: {} },
    }
  } else if (request.method === 'tools/list') {
    response.result = { tools: [{ name: 'fixture_status', inputSchema: { type: 'object' } }] }
  } else {
    response.error = { code: -32601, message: 'Method not found' }
  }
  process.stdout.write(JSON.stringify(response) + '\n')
}
