import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'terminal-mcp-restriction'

export async function apply(ctx, config) {
  const fromHost = createRequire(process.argv[1])
  const fromWeb = createRequire(fromHost.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const fromManager = createRequire(fromWeb.resolve('@deepseek-ai/dsh-mcp-manager/package.json'))
  const mcp = await import(pathToFileURL(fromManager.resolve('@deepseek-ai/dsh-mcp-client')).href)
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.id === 'session-mcp-blocked') {
      agent.ctx.tools.restrict({ deny: ['mcp__ready__fixture_status'] })
    }
    if (agent.id === 'session-mcp-allowed') {
      await agent.ctx.plugin(mcp, {
        transport: 'stdio', serverName: 'private_fixture', command: process.execPath,
        args: [config.script, config.log],
      })
    }
  })
}
