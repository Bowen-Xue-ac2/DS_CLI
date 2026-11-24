export const name = 'terminal-mcp-approval'

export function apply(ctx) {
  ctx.on('tools/pre-execute', (execution, next) => execution.name === 'mcp__ready__fixture_status'
    ? Promise.resolve({ kind: 'ask', reason: 'Confirm the fixture MCP action.' }) : next(), { prepend: true })
}
