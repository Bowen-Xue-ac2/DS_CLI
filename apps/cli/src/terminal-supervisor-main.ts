/** Standalone entry of the detached terminal Host supervisor. @module @deepseek-ai/dsh/terminal-supervisor-main */
import { serveTerminalHost } from './terminal-supervisor.ts'

const input = process.argv[3]
if (process.argv[2] !== '--serve' || input === undefined) process.exitCode = 1
else {
  try { await serveTerminalHost(JSON.parse(input) as Parameters<typeof serveTerminalHost>[0]) } catch {
    process.exitCode = 1
  }
}
