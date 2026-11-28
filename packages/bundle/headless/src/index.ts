/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, drives the task to quiescence,
 * flushes its Session, prints the final assistant text, and exits.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the task resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
  /** Resume a saved headless Session in its original working directory. */
  sessionId?: string
  /** Emit committed events as JSON Lines. */
  json?: boolean
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
  sessionId: z.string(),
  json: z.boolean(),
})

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: HeadlessIo['stdout']; stderr: HeadlessIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task on a fresh or restored Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - task, optional saved Session and output mode.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer. A deployment
  // that DOES configure one has to join it here first
  // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
  const cwd = await realpath(process.cwd())
  const requestedId = config.sessionId
  if (requestedId !== undefined && !/^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(requestedId)) {
    throw new Error('Invalid headless session ID. Use the sessionId from a previous run.')
  }
  const setup: AgentSetup = async (agentCtx) => {
    if (requestedId !== undefined) {
      const header = agentCtx.agent?.session.header
      if (header?.cwd === undefined || header.parentSession !== undefined || await realpath(header.cwd) !== cwd) {
        throw new Error('Run headless resume from the original session directory.')
      }
    }
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  const { agent } = requestedId === undefined
    ? await agents.create({ sessionId: SessionId(`session-${randomUUID()}`), meta: { cwd }, agentOptions, setup })
    : await agents.resume({ resumeSessionId: SessionId(requestedId), agentOptions, setup })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const write = (event: object): void => { io.stdout.write(JSON.stringify(event) + '\n') }
  if (config.json === true) write({ type: 'session', sessionId: agent.id, cwd })
  const unsubscribe = config.json === true ? ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.seq < firstSeq) return
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      write({ type: 'status', phase: event.type === 'turn/start' ? 'turn_start' : 'turn_end', ...event.data })
    } else if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'text') write({ type: 'text', text: block.text })
      }
    }
  }) : undefined
  let outcome: RunOutcome
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await sessions.flush(agent.session)
    outcome = summarize(agent.session.events, firstSeq)
  } finally {
    unsubscribe?.()
  }
  if (config.json === true) write({ type: 'final', sessionId: agent.id, reason: outcome.reason ?? null, text: outcome.text })
  else io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
