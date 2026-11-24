import { once } from 'node:events'
import { createServer } from 'node:http'

/** Loopback streamable HTTP with an explicit credential and observable protocol calls. */
export async function startMcpHttpFixture(credential: string) {
  const calls: string[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end()
      return
    }
    if (request.headers.authorization !== 'Bearer ' + credential) {
      response.writeHead(401).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body) as {
        id?: string | number
        method: string
        params?: { protocolVersion?: string; uri?: string }
      }
      calls.push(message.method)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      let result: object
      switch (message.method) {
        case 'initialize':
          result = {
            protocolVersion: message.params?.protocolVersion,
            serverInfo: { name: 'terminal-http-fixture', version: '1' },
            capabilities: { tools: {}, resources: {} },
          }
          break
        case 'tools/list':
          result = { tools: [{ name: 'read_status', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
          break
        case 'tools/call':
          result = { content: [{ type: 'text', text: 'HTTP_CONNECTOR_STATUS' }] }
          break
        case 'resources/list':
          result = { resources: [{ name: 'HTTP fixture', uri: 'fixture://http/readme', mimeType: 'text/plain' }] }
          break
        case 'resources/templates/list':
          result = { resourceTemplates: [{ name: 'HTTP_FIXTURE_TEMPLATE', uriTemplate: 'fixture://http/{name}', mimeType: 'text/plain' }] }
          break
        case 'resources/read':
          if (message.params?.uri !== 'fixture://http/readme') {
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
              jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Resource not found' },
            }))
            return
          }
          result = { contents: [{ uri: 'fixture://http/readme', mimeType: 'text/plain', text: 'HTTP_RESOURCE_SENTINEL' }] }
          break
        default:
          result = {}
      }
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP fixture address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: () => new Promise<void>((done, fail) => {
      server.close((error) => { if (error) fail(error); else done() })
      server.closeAllConnections()
    }),
  }
}
