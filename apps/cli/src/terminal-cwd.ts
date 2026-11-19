/**
 * User command contributed to the official Host for its per-session working directory.
 * @module @deepseek-ai/dsh/terminal-cwd
 */

/** Cordis plugin name in the terminal Host profile. */
export const name = 'ds-cli-cwd'

/** Official Host services used by the command. */
export const inject = ['commands', 'workingDirectory']

interface AgentScope {
  readonly session: object
}

interface HostCommandContext {
  readonly commands: {
    register(definition: {
      name: string
      description: string
      recordInput: false
      handler(request: { agent: AgentScope; rawInput: string; signal: AbortSignal }):
      Promise<{ kind: 'success' | 'error'; text: string }>
    }): () => void
  }
  readonly workingDirectory: {
    get(session: object): string
    set(agent: AgentScope, path: string, signal: AbortSignal): Promise<string>
  }
}

/**
 * Register an abortable command that delegates to the Host's working directory service.
 * @param ctx - official Host context provided by the loader.
 * @returns the registration disposer.
 */
export function apply(ctx: HostCommandContext): () => void {
  return ctx.commands.register({
    name,
    description: 'Read or set the terminal session working directory',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      if (rawInput.trim() === '') return { kind: 'success', text: ctx.workingDirectory.get(agent.session) }
      let path: unknown
      try {
        path = JSON.parse(rawInput)
      } catch {
        return { kind: 'error', text: 'Working directory must be one JSON string' }
      }
      if (typeof path !== 'string' || path.trim() === '') {
        return { kind: 'error', text: 'Working directory must be a nonempty path' }
      }
      try {
        return { kind: 'success', text: await ctx.workingDirectory.set(agent, path, signal) }
      } catch (error) {
        signal.throwIfAborted()
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
