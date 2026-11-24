/**
 * Interactive terminal entry that drives the same sessions as the official Host.
 * @module @deepseek-ai/dsh/terminal-run
 */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { Command, CommanderError } from 'commander'
import {
  createInteractiveIo, type CliSubmission, type CliViewItem, type CliViewState, type InteractiveIo,
} from '@deepseek-ai/dsh-cli-ui'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  openTerminalHost, requireHostResult, type TerminalApprovalOutcome, type TerminalApprovalRequest,
  type TerminalHost, type TerminalPermissionCatalog, type TerminalSessionEvent, type TerminalWorkspace,
} from './terminal-host.ts'
import {
  changeDirectory, commitStart, enclosingWorkspace, resolveStart, type StartSelection,
  type TerminalActiveSession, type TerminalAgentPreset, type TerminalStartIntent,
} from './terminal-start.ts'
import { permissionCatalog, permissionRevision, setDefaultPermission, setSessionPermission } from './terminal-permissions.ts'
import { listTerminalSessions, loadTerminalSession } from './terminal-sessions.ts'
import { terminalCompletions, terminalComposerScope, validateTerminalReferences } from './terminal-composer.ts'
import { resolveTerminalSubmission } from './terminal-commands.ts'
import { listTerminalConnectors, prepareConnectorPrompt, runMcpCommand } from './terminal-connectors.ts'
import { TerminalMcpResources } from './terminal-mcp-resources.ts'
import { runTerminalAgents, runTerminalTeam } from './terminal-delegation.ts'
import { runTerminalPlugins } from './terminal-plugins.ts'
import { ensureTerminalHost } from './terminal-supervisor.ts'
import { applyTerminalActivity, type TerminalActivityItem } from './terminal-activity.ts'
import { answerContinuedQuestion, answerTerminalQuestions, chooseTerminalModel } from './terminal-interactions.ts'
import { TerminalAssets } from './terminal-assets.ts'
import { TerminalAutomation } from './terminal-automation.ts'
import { openTerminalBrowser, requestTerminalBrowser } from './terminal-browser.ts'
import { preparePluginReferences } from './terminal-plugin-catalog.ts'
import { runTerminalWorktree } from './terminal-worktrees.ts'

const LOCAL_COMMANDS = new Set([
  'help', 'commands', 'sessions', 'resume', 'new', 'history', 'fork', 'rename', 'archive', 'unarchive',
  'pin', 'unpin', 'clear', 'workspace', 'cd', 'agent', 'agents', 'team', 'mode', 'permission',
  'activity', 'model', 'questions', 'mcp', 'connectors', 'plugins', 'exit', 'quit',
  'files', 'attach', 'diff', 'export', 'browser', 'worktree',
  'jobs', 'schedule', 'terminal',
])

const INITIAL_VIEW: CliViewState = {
  items: [], busy: false, sessionId: '', permission: '', inputLocked: true,
  stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0,
    inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
}

function createView() {
  const listeners = new Set<() => void>()
  let state = INITIAL_VIEW
  function update(next: Partial<CliViewState>): void {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  return {
    activity: new Map<string, TerminalActivityItem>(),
    modelSteps: new Map<string, number>(),
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update,
    notice(text: string) { update({ items: [...state.items, { kind: 'notice', text }] }) },
  }
}

interface TerminalFlags {
  cwd?: string
  mode?: string
  choose?: boolean
  permission?: string
  resume?: string | true
  foregroundHost?: boolean
}

function parseTerminalFlags(args: readonly string[]): TerminalFlags | undefined {
  const command = new Command()
    .name('dsh cli')
    .description('Start a brand-new interactive session on the DSH Host.')
    .option('--choose', 'select a workspace and Agent before opening chat')
    .option('--cwd <path>', 'initial working directory')
    .option('-m, --mode <preset>', 'primary Agent preset')
    .option('--permission <preset>', 'permission preset for this session')
    .option('--resume [session]', 'resume the latest or a named session')
    .option('--foreground-host', 'start an isolated Host that ends with the terminal')
    .option('--verbose', 'show additional diagnostics when the Host reports an error')
    .addHelpText('after', '\nExamples:\n  dsh cli --resume               resume the latest session in the workspace\n  dsh cli --mode code            start with the code Agent preset\n')
    .exitOverride()
  try {
    command.parse(args, { from: 'user' })
    return command.opts<TerminalFlags>()
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return undefined
    throw error
  }
}

async function directory(input: string, base: string): Promise<string> {
  const path = input.replace(/^"(.*)"$/u, '$1')
  if (path.trim() === '') throw new Error('Choose an existing working directory')
  const canonical = await realpath(resolve(base, expandHomePath(path)))
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${canonical}`)
  return canonical
}

async function roster(host: TerminalHost): Promise<readonly TerminalAgentPreset[]> {
  return requireHostResult(await host.remote.agentPresets.list()).presets
}

function agentOptions(presets: readonly TerminalAgentPreset[]) {
  return presets.map(preset => ({
    id: preset.id,
    label: preset.name ?? preset.id,
    ...(preset.broken === undefined ? {} : { detail: preset.broken, disabled: true }),
  }))
}

function permissionOptions(options: TerminalPermissionCatalog['options']) {
  return options.filter(option => option.value !== 'custom').map(option => ({
    id: option.value, label: option.name,
    ...(option.description === undefined ? {} : { detail: option.description }),
  }))
}

async function confirmFullAccess(io: InteractiveIo, preset: string): Promise<boolean> {
  if (preset !== 'danger-full-access') return true
  const answer = await io.choose({
    title: 'Enable full access?',
    detail: 'Tools will be allowed to operate outside the workspace.',
    fields: [{ label: 'Full access', initial: 'cancel', options: [
      { id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: 'I understand, enable full access' },
    ] }],
  })
  return answer.kind === 'chosen' && answer.values[0] === 'confirm'
}

async function answerApproval(
  io: InteractiveIo, request: TerminalApprovalRequest, target?: string,
): Promise<TerminalApprovalOutcome> {
  try {
    const choice = await io.choose({
      title: `Approve tool ${request.toolName}?`,
      detail: [request.reason, target].filter(Boolean).join('\n'),
      fields: [{ label: 'Decision', initial: 'deny', options: [
        { id: 'deny', label: 'Deny' }, { id: 'allow', label: 'Allow once' },
      ] }],
    }, request.signal)
    if (request.signal.aborted || choice.kind === 'cancel') return 'cancelled'
    return choice.kind === 'chosen' && choice.values[0] === 'allow' ? 'allowed-once' : 'rejected'
  } catch {
    // A conflicting open menu cannot grant an action.
    return 'unavailable'
  }
}

async function pickDirectory(io: InteractiveIo, host: TerminalHost, start: string): Promise<string | undefined> {
  let path = start
  while (!host.signal.aborted) {
    const listing = requireHostResult(await host.remote.directoryPicker.list(path, host.signal))
    const options = [
      { id: '', label: 'Use this directory', detail: listing.path },
      ...(dirname(listing.path) === listing.path ? [] : [{ id: dirname(listing.path), label: 'Parent directory' }]),
      ...listing.entries.map(entry => ({ id: entry.path, label: entry.name })),
    ]
    const response = await io.choose({
      title: 'Browse folders',
      fields: [{ label: 'Directory', initial: '', options }],
    })
    if (response.kind !== 'chosen') return undefined
    const destination = response.values[0]
    if (!destination) return listing.path
    path = destination
  }
}

async function chooseStart(
  io: InteractiveIo, host: TerminalHost, initial: StartSelection, failure?: string,
): Promise<StartSelection | undefined> {
  let draft = initial
  let problem = failure
  while (!host.signal.aborted) {
    const [workspaces, presets, catalog] = await Promise.all([
      host.listWorkspaces(host.signal), roster(host), permissionCatalog(host),
    ])
    const options = [
      { id: 'current', label: 'Current directory', detail: draft.cwd },
      ...workspaces.map(workspace => ({
        id: workspace.workspaceId, label: workspace.title, detail: workspace.path,
      })),
      { id: 'browse', label: 'Browse folders' },
      { id: 'paste', label: 'Enter a path' },
    ]
    const response = await io.choose({
      title: 'Choose workspace and Agent',
      ...(problem === undefined ? {} : { detail: problem }),
      fields: [
        { label: 'Workspace', initial: 'current', options },
        { label: 'Agent', initial: draft.agentPreset ?? '', options: agentOptions(presets) },
        { label: 'Permissions', initial: draft.permission ?? catalog.defaultPreset, options: permissionOptions(catalog.options) },
      ],
    })
    if (response.kind !== 'chosen') return undefined
    const [choice, agentPreset, requestedPermission] = response.values
    const workspace = workspaces.find(item => item.workspaceId === choice)
    let target = workspace?.path ?? draft.cwd
    try {
      if (choice === 'browse') {
        const selected = await pickDirectory(io, host, target)
        if (selected === undefined) continue
        target = selected
      } else if (choice === 'paste') {
        const answer = await io.choose({
          title: 'Enter working directory',
          fields: [{ label: 'Path', path: true, initial: target }],
        })
        if (answer.kind !== 'chosen' || answer.values[0] === undefined) continue
        target = await directory(answer.values[0], draft.cwd)
      }
      const decision = resolveStart({
        cwd: target,
        choose: false,
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(requestedPermission === undefined ? {} : { permission: requestedPermission }),
      }, workspaces, presets)
      return decision.selection
    } catch (error) {
      problem = message(error)
      draft = {
        ...draft,
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(requestedPermission === undefined ? {} : { permission: requestedPermission }),
      }
    }
  }
}

async function resumeSession(
  host: TerminalHost, workspaces: readonly TerminalWorkspace[], cwd: string, choice: TerminalFlags['resume'],
): Promise<TerminalActiveSession | undefined> {
  if (choice === undefined || choice === 'fresh') return undefined
  const latest = choice === true || choice === 'latest'
  const owner = latest
    ? enclosingWorkspace(cwd, workspaces)
    : workspaces.find(workspace => workspace.sessionIds.includes(choice))
  if (owner === undefined) {
    if (latest) return undefined
    throw new Error(`Session ${choice} is not in this Host's workspaces`)
  }
  let sessionId: string
  if (latest) {
    const { items } = requireHostResult(await host.remote.session.list({}, host.signal))
    const previous = items
      .filter(item => item.origin !== 'subagent' && owner.sessionIds.includes(item.sessionId))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (previous === undefined) return undefined
    sessionId = previous.sessionId
  } else {
    sessionId = choice
  }
  return loadTerminalSession(host, sessionId, host.signal)
}

async function chooseSession(
  io: InteractiveIo, host: TerminalHost, scope: string | undefined, query?: string, archived = false,
): Promise<string | undefined> {
  let search = query
  while (!host.signal.aborted) {
    const choices = await listTerminalSessions(host, {
      ...(scope === undefined ? {} : { scope }),
      ...(search === undefined ? {} : { query: search }),
      archived,
    }, host.signal)
    const options = choices.map(item => ({
      id: item.address.sessionId,
      label: item.title + (item.running ? ' (running)' : ''),
      detail: item.needsMigration ? 'Requires Host migration' : item.detail,
      disabled: item.needsMigration,
    }))
    const result = await io.choose({
      title: archived ? 'Choose an archived session' : 'Choose a session',
      fields: [{ label: 'Session', initial: options.find(item => !item.disabled)?.id ?? ':search', options: [
        ...options,
        { id: ':search', label: 'Search across workspaces' },
      ] }],
    }, host.signal)
    if (result.kind !== 'chosen') return undefined
    const id = result.values[0]
    if (id !== ':search') return id
    const input = await io.choose({
      title: 'Search sessions',
      fields: [{ label: 'Text or path', initial: search ?? '', path: true }],
    }, host.signal)
    if (input.kind !== 'chosen') return undefined
    search = input.values[0]
  }
  return undefined
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toolTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const args = record(JSON.parse(value))
    const target = args.command ?? args.file_path ?? args.path
    return typeof target === 'string' ? target : undefined
  } catch {
    return undefined
  }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join('')
  const block = record(value)
  if (typeof block.type === 'string' && block.type !== 'text') return ''
  if (typeof block.text === 'string') return block.text
  return messageText(block.content ?? block.message ?? block.parts ?? '')
}

function showEvent(view: ReturnType<typeof createView>, event: TerminalSessionEvent): void {
  const { items, stats } = view.getSnapshot()
  const data = record(event.data)
  let item: CliViewItem | undefined
  const stepKey = JSON.stringify([data.turn, data.step])
  switch (event.type) {
    case 'turn/start':
      view.update({ busy: true })
      return
    case 'turn/end': {
      view.update({ busy: false, stats: { ...stats, turns: stats.turns + 1 } })
      const reason = record(data.reason)
      if (reason.kind === 'aborted') view.notice('Turn cancelled')
      if (reason.kind === 'error') {
        const failure = record(reason.error)
        const detail = [failure.code, failure.message].filter(value => typeof value === 'string' && value.length > 0).join(' · ')
        view.notice(detail === '' ? 'Turn failed' : `Turn failed · ${detail}`)
      }
      return
    }
    case 'step/start':
      if (event.time !== undefined) view.modelSteps.set(stepKey, event.time)
      return
    case 'step/end':
      view.modelSteps.delete(stepKey)
      view.update({ stats: { ...stats, steps: stats.steps + 1 } })
      return
    case 'user/message':
    case 'assistant/message': {
      if (event.type === 'assistant/message') {
        const usage = record(data.usage)
        const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
        const start = view.modelSteps.get(stepKey)
        const first = Array.isArray(data.stream) ? data.stream.map(record)
          .find(chunk => chunk.type === 'text-chunks' || chunk.type === 'reasoning-chunks' || chunk.type === 'tool-call-chunks') : undefined
        const observed = start !== undefined && typeof first?.time0 === 'number'
        view.update({ stats: {
          ...stats, inputTokens: stats.inputTokens + number(usage.inputTokens),
          outputTokens: stats.outputTokens + number(usage.outputTokens),
          cacheReadTokens: stats.cacheReadTokens + number(usage.cacheReadTokens),
          llmMs: stats.llmMs + (start === undefined || event.time === undefined ? 0 : Math.max(0, event.time - start)),
          ttftMs: stats.ttftMs + (observed ? Math.max(0, number(first?.time0) - start) : 0),
          ttftSteps: stats.ttftSteps + Number(observed),
        } })
      }
      if (event.type === 'user/message' && record(data.source).kind !== 'user') return
      const text = messageText(data.content ?? data.message ?? data.text ?? data.parts)
      if (text === '') return
      item = event.type === 'user/message' ? { kind: 'user', text } : { kind: 'assistant', text, streaming: false }
      break
    }
    case 'tool/call':
    case 'tool/result': {
      const activity = applyTerminalActivity(view.activity, event)
      if (activity === undefined) return
      const card: CliViewItem = {
        kind: 'tool', callId: activity.key, name: activity.name,
        state: activity.state === 'succeeded' ? 'done' : activity.state === 'failed' ? 'error' : activity.state,
        ...(activity.diagnostic === undefined ? {} : { error: activity.diagnostic }),
        ...(activity.durationMs === undefined ? {} : { durationMs: activity.durationMs }),
        ...(activity.output === undefined ? {} : { output: activity.output }),
      }
      const exists = items.some(row => row.kind === 'tool' && row.callId === activity.key)
      const next = exists ? items.map(row => row.kind === 'tool' && row.callId === activity.key ? card : row) : [...items, card]
      view.update({ items: next, stats: { ...stats, toolMs: stats.toolMs + (activity.durationMs ?? 0) } })
      return
    }
    case 'goal/change':
      if (typeof data.operation === 'string') view.notice(`Goal · ${data.operation}`)
      return
    case 'compaction/end':
      view.notice(typeof data.error === 'string' ? 'Context compaction failed' : 'Context compacted')
      return
    case 'tool-workflow/run-start':
      view.notice(`Workflow ${String(data.name ?? data.runId ?? '')} · started`)
      return
    case 'tool-workflow/run-end':
      view.notice(`Workflow ${String(data.runId ?? '')} · ${String(data.stopReason ?? 'ended')}`)
      return
    case 'workspace/changes':
      view.notice(`Workspace changes · turn ${String(data.turn ?? '')} · /diff`)
      return
    default:
      return
  }
  view.update({ items: [...items, item] })
}

/**
 * Start the foreground terminal, select a workspace and drive Host sessions.
 * @param args - terminal flags after launcher options.
 * @param patches - configured Host overlays.
 * @param callerCwd - directory of the invoking shell.
 */
export async function runTerminal(args: readonly string[], patches: readonly string[], callerCwd: string): Promise<void> {
  const flags = parseTerminalFlags(args)
  if (flags === undefined) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Workspace selection requires an interactive terminal')
  const cwd = await directory(flags.cwd ?? callerCwd, callerCwd)
  const intent: TerminalStartIntent = {
    cwd, choose: flags.choose === true, explicitCwd: flags.cwd !== undefined,
    ...(flags.mode === undefined ? {} : { agentPreset: flags.mode }),
    ...(flags.permission === undefined ? {} : { permission: flags.permission }),
  }
  const controller = new AbortController()
  const view = createView()
  let current: TerminalActiveSession | undefined
  let host: TerminalHost | undefined
  let follow: AbortController | undefined
  let consuming: Promise<void> | undefined
  let historyBefore: number | undefined
  let detachApprovals: (() => void) | undefined
  let openPermissions: (() => Promise<void>) | undefined
  let cancelOperation: (() => void) | undefined
  const pendingToolTargets = new Map<string, string>()
  const mcpResources = new TerminalMcpResources()
  const unacknowledged = new Map<string, { text: string; requestId: string }>()
  const presetAttempts = new Map<string, {
    draft: string
    preset: string
    permission: string
    sessionId: string
    requestId: string
  }>()
  let approvalTarget: string | undefined
  const io = createInteractiveIo({
    view,
    async completion(match, signal) {
      return host === undefined || current === undefined ? [] : terminalCompletions(host, current, match, mcpResources, signal)
    },
    onCancel() {
      if (cancelOperation !== undefined) { cancelOperation(); return }
      if (current !== undefined && host !== undefined) {
        void host.remote.session.cancel({ sessionId: current.sessionId })
          .then(requireHostResult).catch(error => view.notice(message(error)))
      }
    },
    onExit() {
      if (cancelOperation !== undefined) cancelOperation()
      else controller.abort()
    },
    onCyclePermission() { void openPermissions?.().catch(error => view.notice(message(error))) },
  })
  try {
    const open = flags.foregroundHost === true ? openTerminalHost : ensureTerminalHost
    const activeHost = await open({ cwd: callerCwd, signal: controller.signal, patchFiles: patches })
    host = activeHost
    activeHost.signal.addEventListener('abort', () => io.dispose(), { once: true })
    const { remote, signal } = activeHost
    const assets = new TerminalAssets(activeHost)
    const automation = new TerminalAutomation(activeHost, io, view.notice)
    detachApprovals = activeHost.answerApprovals(
      () => approvalTarget ?? current?.sessionId,
      request => answerApproval(io, request, request.callId === undefined ? undefined : pendingToolTargets.get(request.callId)),
      (items, lifetime) => answerTerminalQuestions(io, items, lifetime),
    )

    async function projection(sessionId: string) {
      const result = requireHostResult(await remote.session.projections({ sessionId }, signal))
      if (result === null || result.kind === 'migration-required') throw new Error('Session state is unavailable')
      return result.values
    }

    async function enqueuePrompt(sessionId: string, text: string, withAttachments = false): Promise<void> {
      const attachments = withAttachments ? assets.pending(sessionId).map(item => item.part) : []
      const identity = JSON.stringify([text, ...attachments])
      const open = unacknowledged.get(sessionId)
      const requestId = open?.text === identity ? open.requestId : randomUUID()
      unacknowledged.set(sessionId, { text: identity, requestId })
      requireHostResult(await remote.session.prompt({
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }, ...attachments],
      }, signal))
      unacknowledged.delete(sessionId)
      if (withAttachments) assets.clear(sessionId)
    }

    async function selectPermissions(arg?: string): Promise<void> {
      const session = current
      if (session === undefined) return
      const catalog = await permissionCatalog(activeHost)
      let changeDefault = arg === 'default'
      if (arg === undefined) {
        const scope = await io.choose({
          title: 'Permission settings',
          fields: [{ label: 'Change', initial: 'session', options: [
            { id: 'session', label: 'This session' }, { id: 'default', label: 'Default for future sessions' },
          ] }],
        })
        if (scope.kind !== 'chosen') return
        changeDefault = scope.values[0] === 'default'
      }
      const revision = changeDefault ? await permissionRevision(activeHost) : undefined
      let preset = arg
      if (arg === undefined || arg === 'default') {
        const choice = await io.choose({
          title: changeDefault ? 'Default for future sessions' : 'Permissions for this session',
          fields: [{
            label: 'Preset',
            initial: changeDefault ? catalog.defaultPreset : view.getSnapshot().permission,
            options: permissionOptions(changeDefault ? catalog.defaultOptions : catalog.options),
          }],
        })
        if (choice.kind !== 'chosen') return
        preset = choice.values[0]
      }
      if (preset === undefined || current?.sessionId !== session.sessionId || !await confirmFullAccess(io, preset)) return
      if (revision === undefined) {
        view.update({ permission: await setSessionPermission(activeHost, session.sessionId, preset) })
      } else {
        const saved = await setDefaultPermission(activeHost, preset, revision)
        view.notice(`Default for future sessions: ${saved}`)
      }
    }
    openPermissions = selectPermissions

    async function attach(session: TerminalActiveSession): Promise<void> {
      const state = await projection(session.sessionId)
      automation.detach()
      follow?.abort()
      await consuming
      follow = new AbortController()
      const streamSignal = AbortSignal.any([signal, follow.signal])
      const attached = state.workingDirectory ? { ...session, cwd: state.workingDirectory } : session
      current = attached
      historyBefore = undefined
      let lastSeq = -1
      const display = (event: TerminalSessionEvent): void => {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
        mcpResources.observe(session.sessionId, event)
        assets.observe(session.sessionId, event)
        showEvent(view, event)
      }
      pendingToolTargets.clear()
      view.activity.clear()
      view.modelSteps.clear()
      view.update({
        sessionId: attached.sessionId, project: attached.workspace.title, cwd: attached.cwd,
        permission: state.permissions?.currentValue ?? '', mode: state.agentPreset ?? session.agentPreset,
        items: [], stats: INITIAL_VIEW.stats, busy: false, inputLocked: false,
      })
      consuming = (async () => {
        for await (const frame of remote.session.follow({ address: { kind: 'session', sessionId: session.sessionId }, activate: true }, streamSignal)) {
          if (streamSignal.aborted) break
          if (frame.type === 'snapshot') {
            historyBefore = frame.hasMore ? frame.records[0]?.event.seq : undefined
            for (const entry of frame.records) display(entry.event)
          } else if (frame.type === 'event') {
            const { type, data } = frame.event
            const fields = record(data)
            if (type === 'working-directory/change' && typeof fields.cwd === 'string' && current?.sessionId === session.sessionId) {
              current = { ...current, cwd: fields.cwd }
              view.update({ cwd: fields.cwd })
            }
            if (type === 'tool/call' && typeof fields.callId === 'string') {
              const target = toolTarget(fields.arguments)
              if (target !== undefined) pendingToolTargets.set(fields.callId, target)
            } else if (type === 'tool/result') {
              const id = record(fields.message).toolCallId
              if (typeof id === 'string') pendingToolTargets.delete(id)
            }
            display(frame.event)
          }
        }
      })().catch((error) => {
        if (!streamSignal.aborted) {
          view.notice(message(error))
          io.dispose()
        }
      })
    }

    async function newSession(selection: StartSelection, candidate = `session-${randomUUID()}`): Promise<void> {
      if (selection.permission !== undefined && !await confirmFullAccess(io, selection.permission)) {
        throw new Error('Permission selection cancelled')
      }
      const session = await commitStart(activeHost, selection, candidate)
      if (selection.permission !== undefined) await setSessionPermission(activeHost, session.sessionId, selection.permission)
      await attach(session)
    }

    async function sendToPreset(draft: CliSubmission, source: TerminalActiveSession): Promise<boolean> {
      const selected = draft.selections.filter(item => item.kind === 'agent')
      if (selected.length === 0) return false
      if (assets.pending(source.sessionId).length > 0) {
        throw new Error('Open the target Agent session before attaching files to it.')
      }
      if (draft.selections.some(item => item.kind === 'connector')) {
        throw new Error('Open the target Agent session, then pick its MCP connector.')
      }
      if (draft.selections.some(item => item.kind === 'plugin')) {
        throw new Error('Open the target Agent session, then pick its plugin contributions.')
      }
      const choice = selected[0]
      const mentions = [...draft.text.matchAll(/\S+/gu)].filter(match => match[0].startsWith('@agent:'))
      const mention = mentions[0]
      if (selected.length !== 1 || choice === undefined || mentions.length !== 1 || mention?.[0] !== choice.insert) {
        throw new Error('Pick one Agent for this message')
      }
      const text = (draft.text.slice(0, mention.index) + draft.text.slice(mention.index + mention[0].length)).trim()
      if (text === '') throw new Error('Add a message for the selected Agent')
      const preset = (await roster(activeHost)).find(item => item.id === choice.id && item.broken === undefined)
      if (preset === undefined) throw new Error('The selected Agent is no longer available')
      let pending = presetAttempts.get(source.sessionId)
      let target: TerminalActiveSession
      if (pending === undefined) {
        const { defaultPreset } = await permissionCatalog(activeHost)
        const answer = await io.choose({
          title: 'Send to a new Agent session?',
          detail: `${preset.name ?? preset.id} · ${source.cwd} · ${defaultPreset}`,
          fields: [{ label: 'Action', initial: 'cancel', options: [
            { id: 'cancel', label: 'Keep draft' }, { id: 'send', label: 'Send' },
          ] }],
        }, signal)
        if (answer.kind !== 'chosen' || answer.values[0] !== 'send' || !await confirmFullAccess(io, defaultPreset)) {
          io.restoreSubmission(draft)
          return true
        }
        pending = {
          draft: draft.text, preset: preset.id, permission: defaultPreset,
          sessionId: `session-${randomUUID()}`, requestId: randomUUID(),
        }
        presetAttempts.set(source.sessionId, pending)
        target = await commitStart(activeHost, {
          workspacePath: source.workspace.path, cwd: source.cwd, agentPreset: preset.id,
        }, pending.sessionId)
        if (target.sessionId !== pending.sessionId) throw new Error('The Host returned an unexpected target session')
        if ((await projection(target.sessionId)).permissions?.currentValue !== defaultPreset) {
          await setSessionPermission(activeHost, target.sessionId, defaultPreset)
        }
      } else {
        if (pending.draft !== draft.text || pending.preset !== preset.id) {
          throw new Error(`Check pending Agent session ${pending.sessionId} before sending a different draft`)
        }
        target = await loadTerminalSession(activeHost, pending.sessionId, signal)
      }
      const state = await projection(target.sessionId)
      if (target.workspace.workspaceId !== source.workspace.workspaceId || target.cwd !== source.cwd
        || state.agentPreset !== preset.id || state.permissions?.currentValue !== pending.permission) {
        throw new Error(`Agent session ${target.sessionId} changed. Check its workspace, directory and permissions before sending.`)
      }
      await validateTerminalReferences(activeHost, target, draft.selections, signal)
      const skill = draft.selections.find(item => item.kind === 'skill')
      const skills = skill !== undefined || /^[/$][a-z0-9]/u.test(text)
        ? requireHostResult(await remote.skills.list({ sessionId: target.sessionId }, signal)).skills
        : []
      const routed = resolveTerminalSubmission({
        text, sessionId: target.sessionId,
        ...(skill === undefined ? {} : { skill: { name: skill.id, sessionId: target.sessionId } }),
      }, { skills, commands: [] })
      approvalTarget = target.sessionId
      try {
        requireHostResult(await remote.session.prompt({
          sessionId: target.sessionId, requestId: pending.requestId, mode: 'queue',
          content: [{ type: 'text', text: routed.text }],
        }, signal))
        presetAttempts.delete(source.sessionId)
        await attach(target).catch(error => view.notice(`Sent to ${target.sessionId}. ${message(error)}`))
      } finally { approvalTarget = undefined }
      return true
    }

    const [workspaces, presets] = await Promise.all([activeHost.listWorkspaces(signal), roster(activeHost)])
    const resumed = flags.choose ? undefined : await resumeSession(activeHost, workspaces, cwd, flags.resume)
    if (resumed !== undefined) {
      await attach(resumed)
    } else {
      const decision = resolveStart(intent, workspaces, presets)
      let selection = decision.selection
      let show = decision.kind === 'choose'
      let failure: string | undefined
      let attempt: { path: string; id: string } | undefined
      while (!signal.aborted) {
        if (show) {
          const chosen = await chooseStart(io, activeHost, selection, failure)
          if (chosen === undefined) return
          selection = chosen
        }
        try {
          if (attempt?.path !== selection.workspacePath) {
            attempt = { path: selection.workspacePath, id: `session-${randomUUID()}` }
          }
          await newSession(selection, attempt.id)
          break
        } catch (error) {
          show = true
          failure = message(error)
        }
      }
    }

    while (current !== undefined && !signal.aborted) {
      const submission = await io.nextSubmission()
      if (submission === null) break
      const session: TerminalActiveSession = current
      const line = submission.text
      const split = /^(\/[^\s]+)(?:\s+(.*))?$/u.exec(line.trim())
      const action = split?.[1]
      const arg = split?.[2]
      try {
        if (submission.sessionId !== session.sessionId
          || submission.selections.some(item => item.scope !== terminalComposerScope(session))) {
          throw new Error('The draft belongs to another terminal context. Pick its references again.')
        }
        if (await sendToPreset(submission, session)) continue
        const selectedSkill = submission.selections.find(item => item.kind === 'skill')
        const isLocal = action !== undefined && LOCAL_COMMANDS.has(action.slice(1))
        const isCandidate = selectedSkill !== undefined || (!isLocal && /^\s*[/$][a-z0-9]/u.test(line))
        const [skills, commands] = isCandidate ? await Promise.all([
          activeHost.remote.skills.list({ sessionId: session.sessionId }, signal),
          selectedSkill === undefined && action !== undefined ? remote.commands.list(session.sessionId) : undefined,
        ]) : [undefined, undefined]
        const routed = resolveTerminalSubmission({
          text: line, sessionId: session.sessionId,
          ...(selectedSkill === undefined ? {} : { skill: { name: selectedSkill.id, sessionId: session.sessionId } }),
        }, {
          skills: skills === undefined ? [] : requireHostResult(skills).skills,
          commands: commands === undefined ? [] : requireHostResult(commands),
          local: LOCAL_COMMANDS,
        })
        if (routed.kind === 'prompt') {
          const [text] = await Promise.all([
            prepareConnectorPrompt(activeHost, session.sessionId, routed.text, submission.selections, mcpResources, signal),
            validateTerminalReferences(activeHost, session, submission.selections, signal),
          ])
          const prepared = await preparePluginReferences(activeHost, session.sessionId, text, submission.selections, signal)
          await enqueuePrompt(session.sessionId, prepared, true)
          continue
        }
        if (routed.kind === 'host-command') {
          const result = requireHostResult(await remote.commands.execute(session.sessionId, routed.text, [], signal))
          view.notice(result?.result.text ?? `Command /${routed.command.name} is unavailable`)
          continue
        }
        if (action === '/exit' || action === '/quit') break
        switch (action) {
          case '/help':
            view.notice('/sessions [query]  /resume [id]  /new  /workspace  /cd [path]  /history  /fork  /rename  /archive  /unarchive  /pin  /unpin  /agent  /agents  /team  /permission  /mcp  /plugins  /clear  /exit')
            view.notice('/files [list|view|search]  /attach [path|clear]  /diff [file-number [page]]  /export <output.md|output.zip>')
            view.notice('/worktree  /browser')
            view.notice('/jobs [id|follow|stop|detach]  /schedule [create|pause|resume|run|history]  /terminal [new|list|close|id]')
            break
          case '/jobs':
            view.notice(await automation.jobs(session.sessionId, arg ?? ''))
            break
          case '/schedule':
            view.notice(await automation.schedule(session.sessionId, arg ?? ''))
            break
          case '/terminal':
            view.notice(await automation.terminal(session.sessionId, arg ?? ''))
            break
          case '/files': {
            const result = await assets.files(session, io, arg ?? '', signal)
            if (result === undefined) break
            if ('notice' in result) {
              view.notice(result.notice)
              break
            }
            const path = relative(session.cwd, result.path).replaceAll('\\', '/')
            const mention = '@' + (/\s|"/u.test(path) ? JSON.stringify(path) : path)
            io.restoreSubmission({
              text: mention + ' ', sessionId: session.sessionId,
              selections: [{ id: path, kind: 'file', pathKind: result.kind, scope: terminalComposerScope(session), label: path, insert: mention }],
            })
            break
          }
          case '/attach': {
            if (arg === undefined) {
              const pending = assets.pending(session.sessionId)
              view.notice(pending.length ? pending.map(item => item.name).join('\n') : 'Usage: /attach <workspace path>')
              break
            }
            const upload = new AbortController()
            cancelOperation = () => { upload.abort(new Error('Attachment cancelled')) }
            view.update({ inputLocked: true })
            try {
              view.notice(await assets.attach(session, arg, AbortSignal.any([signal, upload.signal]), view.notice))
            } finally {
              cancelOperation = undefined
              view.update({ inputLocked: false })
            }
            break
          }
          case '/diff':
            view.notice(await assets.diff(session.sessionId, arg ?? ''))
            break
          case '/export':
            view.notice(await assets.export(session, arg ?? ''))
            break
          case '/worktree':
            view.notice(await runTerminalWorktree(activeHost, io, session, await projection(session.sessionId), arg ?? ''))
            break
          case '/browser':
            if (flags.foregroundHost) throw new Error('Browser handoff requires the shared Host. Restart dsh without --foreground-host.')
            await openTerminalBrowser(await requestTerminalBrowser(session.sessionId))
            view.notice(`Opened browser handoff for ${session.sessionId}`)
            break
          case '/plugins':
            view.notice(await runTerminalPlugins(activeHost, io, {
              notice: view.notice,
              trackInstall(cancel) {
                cancelOperation = cancel
                view.update({ inputLocked: true })
                return () => {
                  cancelOperation = undefined
                  view.update({ inputLocked: false })
                }
              },
            }, session.cwd, arg))
            break
          case '/team':
            view.notice(await runTerminalTeam(activeHost, session.sessionId, arg))
            break
          case '/model':
            view.notice(await chooseTerminalModel(activeHost, io, session.sessionId, arg))
            break
          case '/questions':
            view.notice(await answerContinuedQuestion(activeHost, io, session.sessionId))
            break
          case '/activity': {
            const rows = [...view.activity.values()]
            const id = (row: TerminalActivityItem): string => `${row.callId}@${row.turn}.${row.step}`
            const [selected, pageText, extra] = arg?.trim().split(/\s+/u) ?? []
            if (selected === undefined) {
              view.notice(rows.length === 0 ? 'No tool activity in the current view.' : rows.slice(-24).map(row =>
                `${id(row)} · ${row.name} · ${row.state}${row.durationMs === undefined ? '' : ` · ${row.durationMs} ms`}`).join('\n'))
              break
            }
            const matches = rows.filter(row => id(row) === selected || row.callId === selected)
            const entry = matches[0]
            const page = Number(pageText ?? '1')
            if (extra !== undefined || !Number.isSafeInteger(page) || page < 1) { view.notice('Usage: /activity [call-id [page]]'); break }
            if (entry === undefined || matches.length !== 1) { view.notice('Choose a unique call from /activity'); break }
            const full = [entry.arguments, entry.output].filter(Boolean).join('\n\n')
            const pages = Math.max(1, Math.ceil(full.length / 1600))
            if (page > pages) { view.notice(`This call has ${pages} page(s)`); break }
            view.notice(`${entry.name} · ${entry.state} · ${page}/${pages}\n${full.slice((page - 1) * 1600, page * 1600)}`)
            break
          }
          case '/agents': {
            const result = await runTerminalAgents(activeHost, io, session.sessionId, arg, unacknowledged)
            view.notice(result.text)
            if (result.history !== undefined) {
              const history = createView()
              for (const event of result.history) showEvent(history, event)
              view.update({ items: [...view.getSnapshot().items, ...history.getSnapshot().items] })
            }
            break
          }
          case '/mcp':
          case '/connectors': {
            const [, resourceAction, serverId] = /^(resources|templates)\s+(\S+)$/u.exec(arg ?? '') ?? []
            if (serverId === undefined) {
              view.notice(await runMcpCommand(activeHost, io, arg, session.cwd))
              break
            }
            const servers = await listTerminalConnectors(activeHost, session.sessionId, signal)
            const server = servers.find(row => row.id === serverId && row.resources)
            if (server === undefined) throw new Error('MCP resource tools are unavailable for that connector in this session.')
            if (resourceAction === 'resources') mcpResources.begin(session.sessionId, server)
            const tool = resourceAction === 'templates' ? 'list_mcp_resource_templates' : 'list_mcp_resources'
            await enqueuePrompt(session.sessionId,
              `List ${resourceAction} on MCP server ${JSON.stringify(server.id)} using ${tool}. Summarize the available names and URIs.`)
            break
          }
          case '/sessions':
          case '/resume': {
            const id = action === '/resume' && arg
              ? arg
              : await chooseSession(io, activeHost, session.workspace.workspaceId, arg)
            if (id !== undefined && id !== session.sessionId) await attach(await loadTerminalSession(activeHost, id, signal))
            break
          }
          case '/new':
            await newSession({ workspacePath: session.workspace.path, cwd: session.cwd,
              ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }) })
            break
          case '/history': {
            if (historyBefore === undefined) { view.notice('No earlier history'); break }
            const page = requireHostResult(await remote.session.page({
              address: { kind: 'session', sessionId: session.sessionId }, beforeSeq: historyBefore,
            }, signal))
            const history = createView()
            for (const entry of page.records) showEvent(history, entry.event)
            historyBefore = page.hasMore ? page.records[0]?.event.seq : undefined
            view.update({ items: [...history.getSnapshot().items, ...view.getSnapshot().items] })
            break
          }
          case '/fork': {
            const fork = requireHostResult(await remote.session.fork({ sessionId: session.sessionId, allowMigration: false }))
            await attach(await loadTerminalSession(activeHost, fork.sessionId, signal))
            break
          }
          case '/rename': {
            if (!arg) { view.notice('Usage: /rename <title>'); break }
            const renamed = requireHostResult(await remote.session.rename({ sessionId: session.sessionId, title: arg }))
            view.notice(`Session renamed to ${renamed.title}`)
            break
          }
          case '/archive': {
            const sessionId = arg || session.sessionId
            const result = await remote.workspace.archiveSession({ sessionId })
            if (!result.ok && result.error.code === 'workspace/session-active') {
              const answer = await io.choose({
                title: 'Stop active work and archive this session?',
                fields: [{ label: 'Archive', initial: 'cancel', options: [
                  { id: 'cancel', label: 'Keep session' }, { id: 'stop', label: 'Stop work and archive' },
                ] }],
              }, signal)
              if (answer.kind !== 'chosen' || answer.values[0] !== 'stop') break
              requireHostResult(await remote.workspace.archiveSession({ sessionId, stopActivity: true }))
            } else {
              requireHostResult(result)
            }
            view.notice(`Archived session ${sessionId}`)
            break
          }
          case '/unarchive': {
            const sessionId = arg || await chooseSession(io, activeHost, undefined, undefined, true)
            if (sessionId === undefined) break
            requireHostResult(await remote.workspace.unarchiveSession({ sessionId }))
            view.notice(`Restored session ${sessionId}`)
            break
          }
          case '/pin':
          case '/unpin': {
            const sessionId = arg || session.sessionId
            requireHostResult(await (action === '/pin'
              ? remote.workspace.pinSession({ sessionId })
              : remote.workspace.unpinSession({ sessionId })))
            view.notice(`${action === '/pin' ? 'Pinned' : 'Unpinned'} session ${sessionId}`)
            break
          }
          case '/clear':
            view.update({ items: [] })
            break
          case '/commands': {
            const commands = requireHostResult(await remote.commands.list(session.sessionId))
            view.notice(commands.map(command => `/${command.name}  ${command.description ?? ''}`).join('\n'))
            break
          }
          case '/workspace': {
            const selection = await chooseStart(io, activeHost, {
              cwd: session.cwd, workspacePath: session.workspace.path,
              ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
            })
            if (selection === undefined) break
            const owner = (await activeHost.listWorkspaces(signal)).find(item => item.path === selection.workspacePath)
            if (!owner?.sessionIds.some(id => id !== session.sessionId)) {
              await newSession(selection)
              break
            }
            const answer = await io.choose({
              title: 'Open workspace',
              fields: [{ label: 'Session', initial: 'existing', options: [
                { id: 'existing', label: 'Choose an existing session' }, { id: 'new', label: 'Create a new session' },
              ] }],
            }, signal)
            if (answer.kind !== 'chosen') break
            if (answer.values[0] === 'new') await newSession(selection)
            else {
              const id = await chooseSession(io, activeHost, owner.workspaceId)
              if (id !== undefined && id !== session.sessionId) await attach(await loadTerminalSession(activeHost, id, signal))
            }
            break
          }
          case '/cd': {
            const target = arg === undefined ? await pickDirectory(io, activeHost, session.cwd) : await directory(arg, session.cwd)
            if (target === undefined) break
            const nextCwd = await changeDirectory(activeHost, session.sessionId, target)
            current = { ...session, cwd: nextCwd }
            view.update({ cwd: nextCwd })
            break
          }
          case '/agent':
          case '/mode': {
            const presets = await roster(activeHost)
            const response = arg === undefined
              ? await io.choose({ title: 'Choose primary Agent', fields: [{ label: 'Agent', initial: session.agentPreset ?? '', options: agentOptions(presets) }] })
              : { kind: 'chosen' as const, values: [arg] }
            if (response.kind !== 'chosen' || response.values[0] === undefined) break
            const agentPreset = response.values[0]
            const result = await remote.agentPresets.select(session.sessionId, agentPreset)
            if (!result.ok && result.error.code === 'agent-preset/locked') {
              const followup = await io.choose({
                title: 'Open a new session with this Agent?',
                fields: [{ label: 'Session', initial: 'cancel', options: [
                  { id: 'cancel', label: 'Keep this session' }, { id: 'new', label: 'Open a new session' },
                ] }],
              })
              if (followup.kind === 'chosen' && followup.values[0] === 'new') {
                await newSession({ workspacePath: session.workspace.path, cwd: session.cwd, agentPreset })
              }
            } else {
              requireHostResult(result)
              const installed = (await projection(session.sessionId)).agentPreset
              if (typeof installed === 'string') {
                current = { ...session, agentPreset: installed }
                view.update({ mode: installed })
              }
            }
            break
          }
          case '/permission':
            await selectPermissions(arg)
            break
        }
      } catch (error) {
        if (!signal.aborted) {
          view.notice(message(error))
          io.restoreSubmission(submission)
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    follow?.abort()
    io.dispose()
    detachApprovals?.()
    await host?.dispose()
    await consuming
  }
}
