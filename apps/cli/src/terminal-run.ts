/**
 * Interactive terminal entry that drives the same sessions as the official Host.
 * @module @deepseek-ai/dsh/terminal-run
 */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Command, CommanderError } from 'commander'
import {
  createInteractiveIo, type CliViewItem, type CliViewState, type InteractiveIo,
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
import { terminalCompletions, terminalComposerScope } from './terminal-composer.ts'
import { resolveTerminalSubmission } from './terminal-commands.ts'

const LOCAL_COMMANDS = new Set([
  'help', 'commands', 'sessions', 'resume', 'new', 'history', 'fork', 'rename', 'archive', 'unarchive',
  'pin', 'unpin', 'clear', 'workspace', 'cd', 'agent', 'mode', 'permission', 'exit', 'quit',
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
  switch (event.type) {
    case 'turn/start':
      view.update({ busy: true })
      return
    case 'turn/end':
      view.update({ busy: false, stats: { ...stats, turns: stats.turns + 1 } })
      return
    case 'step/end':
      view.update({ stats: { ...stats, steps: stats.steps + 1 } })
      return
    case 'user/message':
    case 'assistant/message': {
      if (event.type === 'user/message' && record(data.source).kind !== 'user') return
      const text = messageText(data.content ?? data.message ?? data.text ?? data.parts)
      if (text === '') return
      item = event.type === 'user/message' ? { kind: 'user', text } : { kind: 'assistant', text, streaming: false }
      break
    }
    case 'tool/call': {
      const { callId, name } = data
      if (typeof callId !== 'string' || typeof name !== 'string') return
      item = { kind: 'tool', callId, name, state: 'running' }
      break
    }
    case 'tool/result': {
      const result = record(data.message)
      const callId = result.toolCallId
      const state = result.isError === true ? 'error' : 'done'
      view.update({ items: items.map(item => item.kind === 'tool' && item.callId === callId ? { ...item, state } : item) })
      return
    }
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
  const pendingToolTargets = new Map<string, string>()
  const unacknowledged = new Map<string, { text: string; requestId: string }>()
  const io = createInteractiveIo({
    view,
    async completion(match, signal) {
      return host === undefined || current === undefined ? [] : terminalCompletions(host, current, match, signal)
    },
    onCancel() {
      if (current !== undefined && host !== undefined) {
        void host.remote.session.cancel({ sessionId: current.sessionId })
          .then(requireHostResult).catch(error => view.notice(message(error)))
      }
    },
    onExit() { controller.abort() },
    onCyclePermission() { void openPermissions?.().catch(error => view.notice(message(error))) },
  })
  try {
    const activeHost = await openTerminalHost({ cwd: callerCwd, signal: controller.signal, patchFiles: patches })
    host = activeHost
    activeHost.signal.addEventListener('abort', () => io.dispose(), { once: true })
    const { remote, signal } = activeHost
    detachApprovals = activeHost.answerApprovals(
      () => current?.sessionId,
      request => answerApproval(io, request, request.callId === undefined ? undefined : pendingToolTargets.get(request.callId)),
    )

    async function projection(sessionId: string) {
      const result = requireHostResult(await remote.session.projections({ sessionId }, signal))
      if (result === null || result.kind === 'migration-required') throw new Error('Session state is unavailable')
      return result.values
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
      follow?.abort()
      await consuming
      follow = new AbortController()
      const streamSignal = AbortSignal.any([signal, follow.signal])
      current = session
      historyBefore = undefined
      let lastSeq = -1
      const display = (event: TerminalSessionEvent): void => {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
        showEvent(view, event)
      }
      pendingToolTargets.clear()
      view.update({
        sessionId: session.sessionId, project: session.workspace.title, cwd: session.cwd,
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
          const open = unacknowledged.get(session.sessionId)
          const requestId = open?.text === routed.text ? open.requestId : randomUUID()
          unacknowledged.set(session.sessionId, { text: routed.text, requestId })
          const request = {
            sessionId: session.sessionId, requestId, mode: 'queue' as const,
            content: [{ type: 'text' as const, text: routed.text }],
          }
          requireHostResult(await remote.session.prompt(request, signal))
          unacknowledged.delete(session.sessionId)
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
            view.notice('/sessions [query]  /resume [id]  /new  /workspace  /cd [path]  /history  /fork  /rename  /archive  /unarchive  /pin  /unpin  /agent  /permission  /clear  /exit')
            break
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
