/** Programmatic access to a saved terminal Session on the shared Host. @module @deepseek-ai/dsh/terminal-session-command */
import { randomUUID } from 'node:crypto'
import type { DshInvocation } from './args.ts'
import { requireHostResult, type TerminalHost } from './terminal-host.ts'
import { loadTerminalSession } from './terminal-sessions.ts'
import { ensureTerminalHost } from './terminal-supervisor.ts'

async function writeRecord(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + '\n', (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** @param invocation - Session, read mode or plain-text steering request from the launcher. */
export async function runTerminalSessionCommand(invocation: Extract<DshInvocation, { mode: 'session' }>): Promise<void> {
  const controller = new AbortController()
  const interrupt = (): void => { controller.abort() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let host: TerminalHost | undefined
  try {
    const { signal } = controller
    host = await ensureTerminalHost({ cwd: process.cwd(), signal })
    const { sessionId } = await loadTerminalSession(host, invocation.sessionId, signal)
    const address = { kind: 'session', sessionId } as const
    const { session } = host.remote
    if (invocation.action === 'history') {
      const history = requireHostResult(await session.events({ address, maxMessages: 100 }, signal))
      await writeRecord({ type: 'history', sessionId, ...history })
    } else if (invocation.action === 'events') {
      for await (const frame of session.follow({ address, activate: false, assistantStream: true }, signal)) {
        await writeRecord({ ...frame, sessionId })
      }
    } else if (invocation.action === 'steer') {
      const { items } = requireHostResult(await session.list({}, signal))
      if (!items.some(item => item.sessionId === sessionId && item.running)) {
        throw new Error('There is no active turn to steer.')
      }
      requireHostResult(await session.prompt({
        sessionId, requestId: randomUUID(), mode: 'steer', content: [{ type: 'text', text: invocation.text }],
      }, signal))
      await writeRecord({ type: 'accepted', sessionId })
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await host?.dispose()
    if (controller.signal.aborted) process.exitCode = 130
  }
}
