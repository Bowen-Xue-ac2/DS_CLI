/**
 * Own the pinned local DSH Host and a single authenticated terminal client.
 * @module @deepseek-ai/dsh/terminal-host
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { open, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileFunction } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import { terminalConnectorRemote, type TerminalConnector } from './terminal-connector-remote.ts'
import type { TerminalPluginsRemote } from './terminal-plugin-remote.ts'
import type { TerminalAutomationRemote } from './terminal-automation-remote.ts'
import type { TerminalForgeRemote } from './terminal-worktrees.ts'
import { prepareTerminalHostDirectory, terminalHostPaths } from './terminal-host-state.ts'
import type { TerminalAgentPreset } from './terminal-start.ts'
import type { TerminalCommandDescriptor, TerminalSkillDescriptor } from './terminal-commands.ts'

const RUNTIME_VERSION = '0.2.2-rc.5'
const STARTUP_TIMEOUT_MS = 60_000

/** Selected fields from the official Host's workspace projection. */
export interface TerminalWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly updatedAt: string
}

/** Outcome of adopting an existing directory as a workspace. */
export interface TerminalWorkspaceRegistration {
  readonly workspace: TerminalWorkspace
  readonly created: boolean
}

/** Host Remote business result after the official client decodes its envelope. */
export type HostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** JSON values accepted by the Host Settings mutation API. */
export type TerminalSettingsValue =
  | string | number | boolean | null | readonly TerminalSettingsValue[]
  | { readonly [key: string]: TerminalSettingsValue }

interface TerminalSettingsNamespace {
  readonly ns: string
  readonly revision: number
  readonly value?: TerminalSettingsValue
}

interface WorkspaceBaseline {
  readonly items: readonly TerminalWorkspace[]
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
}

interface WorkspaceRemote {
  create(request: { path: string }): Promise<HostResult<TerminalWorkspaceRegistration>>
  follow(signal: AbortSignal): AsyncIterable<
    | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
    | { readonly type: 'replace' | 'upsert' | 'remove' | 'order' | 'archived' | 'pinned' }
  >
  archiveSession(request: { sessionId: string; stopActivity?: boolean }): Promise<HostResult<unknown>>
  unarchiveSession(request: { sessionId: string }): Promise<HostResult<unknown>>
  pinSession(request: { sessionId: string }): Promise<HostResult<unknown>>
  unpinSession(request: { sessionId: string }): Promise<HostResult<unknown>>
}

/** Address of a primary session in the Host journal. */
export interface TerminalSessionAddress {
  readonly kind: 'session'
  readonly sessionId: string
}

type TerminalHistoryAddress =
  | TerminalSessionAddress
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: string
    readonly childSessionId: string
    readonly mode: 'one-shot' | 'continuable' | 'unknown'
  }

/** Fields required by the terminal from the Host's session catalogue. */
export interface TerminalSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly formatStatus?: 'current' | 'migration-required'
  readonly origin?: 'subagent'
  readonly running?: boolean
  readonly agentAvailable?: boolean
  readonly cwd?: string
  readonly projections?: { readonly values: { readonly title?: string } }
}

/** Host projection read by the terminal before enabling chat. */
export interface TerminalSessionProjection {
  readonly kind: 'sequenced' | 'migration-required'
  readonly values: {
    readonly agentPreset?: string | null
    readonly workingDirectory?: string | null
    readonly permissions?: { readonly currentValue: string }
    readonly subagentCatalog?: readonly TerminalSubagent[]
    readonly subagentTiming?: { readonly lastTurnCompleted?: boolean }
    readonly agentTeam?: TerminalAgentTeam
    readonly forgeWorktree?: {
      readonly path: string
      readonly branch: string
      readonly baseCommit: string
      readonly repositoryRoot: string
    } | null
    readonly userQuestions?: {
      readonly active: readonly {
        readonly callId: string
        readonly state: 'open' | 'continued'
        readonly questions: readonly TerminalQuestion[]
      }[]
    }
  }
}

/** One direct child in the Host projection of its parent. */
export interface TerminalSubagent {
  readonly id: string
  readonly label?: string
  readonly name?: string
  readonly mode: 'one-shot' | 'continuable' | 'external' | 'unknown'
}

interface TerminalAgentTeam {
  readonly enabled?: boolean
  readonly failure?: string
  readonly tasks: readonly {
    readonly id: string
    readonly subject: string
    readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
    readonly ownerId?: string
    readonly ownerName?: string
    readonly blockedBy: readonly string[]
  }[]
}

/** Committed event from the official session journal. */
export interface TerminalSessionEvent {
  readonly seq: number
  readonly time?: number
  readonly type: string
  readonly data: unknown
}

/** Prompt attachments are receipts scoped by the official Host to a receiving Agent. */
export type TerminalPromptPart = { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly receiptId: string }

interface TerminalWorkspaceEntry {
  readonly type: 'file' | 'directory' | 'other'
}

/** Opening snapshot and subsequent committed records from a Host stream. */
export type TerminalSessionFrame =
  | { readonly type: 'snapshot'; readonly records: readonly TerminalSessionEntry[]; readonly hasMore: boolean }
  | { readonly type: 'event'; readonly event: TerminalSessionEvent }

interface TerminalSessionEntry {
  readonly type: 'event'
  readonly event: TerminalSessionEvent
}

/** Native directory browser result. */
export interface TerminalDirectoryListing {
  readonly path: string
  readonly entries: readonly { readonly name: string; readonly path: string }[]
}

/** Native preset labels and values available in the current Host. */
export interface TerminalPermissionCatalog {
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly defaultOptions: TerminalPermissionCatalog['options']
  readonly defaultPreset: string
}

/** An approval addressed to the currently active session. */
export interface TerminalApprovalRequest {
  readonly toolName: string
  readonly reason?: string
  readonly callId?: string
  readonly signal: AbortSignal
}

/** One answer for a single native approval request. */
export type TerminalApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One native question offered to an attached terminal Peer. */
export interface TerminalQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'approval' | 'plan-review'; readonly approve: string; readonly reject?: string }
}

interface TerminalQuestionRequest {
  readonly questions: readonly TerminalQuestion[]
  readonly signal?: AbortSignal
  readonly wait?: { readonly callId: string; readonly timed?: boolean }
}

/** User-selected labels and optional text from a native question. */
export interface TerminalQuestionAnswer {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}

/** Exact provider and model selected by the Host. */
export interface TerminalModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface TerminalModelCatalog {
  readonly default: TerminalModelRoute
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly reasoning?: {
        readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
        readonly defaultEffort?: string
      }
    }[]
  }[]
}

/** Official Remote operations used by the terminal after the Gateway decodes them. */
export interface ClientRemote extends TerminalPluginsRemote, TerminalAutomationRemote, TerminalForgeRemote {
  $mount(contribution: unknown): Promise<() => Promise<void>>
  readonly terminalConnectors: {
    list(sessionId: string, signal: AbortSignal): Promise<HostResult<readonly TerminalConnector[]>>
  }
  readonly workspace: WorkspaceRemote
  readonly agentPresets: {
    list(): Promise<HostResult<{ readonly presets: readonly TerminalAgentPreset[] }>>
    select(sessionId: string, agentPreset: string): Promise<HostResult<unknown>>
  }
  readonly directoryPicker: {
    list(path: string, signal: AbortSignal): Promise<HostResult<TerminalDirectoryListing>>
  }
  readonly session: {
    create(request: { workspaceId: string; sessionId: string; agentPreset?: string }):
    Promise<HostResult<{ readonly sessionId: string; readonly agentPreset?: string }>>
    follow(request: { address: TerminalSessionAddress; activate?: boolean }, signal: AbortSignal): AsyncIterable<TerminalSessionFrame>
    projections(request: { sessionId: string }, signal: AbortSignal):
    Promise<HostResult<TerminalSessionProjection | null>>
    modelCatalog(): Promise<HostResult<TerminalModelCatalog>>
    selectModel(request: TerminalModelRoute & { sessionId: string }): Promise<HostResult<{ readonly selected: TerminalModelRoute }>>
    list(request: Record<string, never>, signal: AbortSignal):
    Promise<HostResult<{ readonly items: readonly TerminalSessionSummary[] }>>
    search(request: { query: string }, signal: AbortSignal):
    Promise<HostResult<{ readonly items: readonly { readonly sessionId: string; readonly snippet: string }[] }>>
    page(request: { address: TerminalSessionAddress; beforeSeq: number }, signal: AbortSignal):
    Promise<HostResult<{ readonly records: readonly TerminalSessionEntry[]; readonly hasMore: boolean }>>
    events(request: { address: TerminalHistoryAddress; maxMessages: number }, signal: AbortSignal):
    Promise<HostResult<{ readonly records: readonly TerminalSessionEntry[]; readonly hasMore: boolean }>>
    fork(request: { sessionId: string; allowMigration: false }):
    Promise<HostResult<{ readonly sessionId: string }>>
    rename(request: { sessionId: string; title: string }): Promise<HostResult<{ readonly title: string }>>
    prompt(request: { sessionId: string; requestId: string; mode: 'queue'; content: readonly TerminalPromptPart[] },
      signal: AbortSignal): Promise<HostResult<{ readonly accepted: true }>>
    cancel(request: { sessionId: string }): Promise<HostResult<unknown>>
  }
  readonly commands: {
    list(sessionId: string): Promise<HostResult<readonly TerminalCommandDescriptor[]>>
    execute(sessionId: string, line: string, attachments: readonly never[], signal: AbortSignal):
    Promise<HostResult<{ readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | null>>
  }
  readonly subagents: {
    prompt(request: { childSessionId: string; requestId: string; delivery: 'queue'; content: readonly { type: 'text'; text: string }[] },
      signal: AbortSignal): Promise<HostResult<{ readonly messageId: string }>>
    interruptByUser(childSessionId: string): Promise<HostResult<{ readonly accepted: true }>>
  }
  readonly agentTeams: {
    setEnabled(sessionId: string, enabled: boolean, signal: AbortSignal): Promise<HostResult<void>>
  }
  readonly userQuestions: {
    attachWait(sessionId: string, callId: string, signal: AbortSignal): AsyncIterable<{ readonly remainingMs: number }>
    answer(sessionId: string, callId: string, answer: TerminalQuestionAnswer): Promise<HostResult<boolean>>
  }
  readonly skills: {
    list(request: { sessionId: string }, signal: AbortSignal):
    Promise<HostResult<{ readonly skills: readonly TerminalSkillDescriptor[] }>>
  }
  readonly fileReferences: {
    list(sessionId: string, query: string, signal: AbortSignal):
    Promise<HostResult<readonly { readonly path: string; readonly kind: 'file' | 'directory' }[]>>
  }
  readonly workspaceFiles: {
    stat(sessionId: string, path: string, signal: AbortSignal): Promise<HostResult<unknown>>
    list(sessionId: string, path: string, signal: AbortSignal): Promise<HostResult<{
      readonly path: string
      readonly entries: readonly (TerminalWorkspaceEntry & { readonly name: string })[]
      readonly truncated: boolean
    }>>
    search(sessionId: string, request: {
      readonly query: string
      readonly excludedPaths: readonly string[]
      readonly includeHidden: boolean
      readonly respectGitignore: boolean
    }, signal: AbortSignal): Promise<HostResult<{
      readonly matches: readonly (TerminalWorkspaceEntry & { readonly path: string })[]
      readonly truncated: boolean
      readonly incomplete: boolean
    }>>
    read(sessionId: string, path: string, range: { offset: number; limit: number }, signal: AbortSignal):
    Promise<HostResult<{ readonly text: string; readonly eof: boolean }>>
    readBytes(sessionId: string, path: string, options: { range: { length: number } }, signal: AbortSignal):
    Promise<HostResult<{ readonly data: Uint8Array; readonly bytes: number; readonly eof: boolean }>>
  }
  readonly sessionReferenceResolver: {
    candidates(sessionId: string, query: string, signal: AbortSignal):
    Promise<HostResult<readonly {
      readonly sessionId: string
      readonly label: string
      readonly displayTitle?: string
      readonly mention: string
    }[]>>
  }
  readonly permissionPresets: { catalog(): Promise<HostResult<TerminalPermissionCatalog>> }
  readonly mcpManager: {
    watch(signal: AbortSignal): AsyncIterable<readonly {
      readonly name: string
      readonly configured: boolean
      readonly status: { readonly state: string }
    }[]>
    probe(name: string, signal: AbortSignal): Promise<HostResult<{
      readonly closeConfirmed: boolean
      readonly cleanupError?: string
    } & (
      | { readonly ok: true; readonly toolNames: readonly string[]; readonly truncated: boolean }
      | { readonly ok: false; readonly stage: 'connect' | 'list' }
    )>>
    restart(name: string): Promise<HostResult<void>>
  }
  readonly settings: {
    describe(): Promise<HostResult<{
      readonly writable: boolean
      readonly namespaces: readonly TerminalSettingsNamespace[]
    }>>
    mutate(namespace: string, operations: readonly { op: 'set'; path: readonly string[]; value: TerminalSettingsValue }[], revision: number):
    Promise<HostResult<TerminalSettingsNamespace>>
  }
  $on(event: 'approval/request', listener: (request: TerminalApprovalRequest, next: () => Promise<TerminalApprovalOutcome>) =>
  Promise<TerminalApprovalOutcome>): () => void
  $on(event: 'user-questions/request', listener: (request: TerminalQuestionRequest, next: () => Promise<TerminalQuestionAnswer>) =>
  Promise<TerminalQuestionAnswer>): () => void
  $on(event: 'plugin-manager/install-state', listener: (progress: {
    readonly requestId: string
    readonly phase: 'installing' | 'cancelling' | 'applying'
    readonly attempt?: { readonly index: number; readonly total: number }
  }) => void): () => void
}

interface ConnectionGeneration {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

interface ClientPlugin {
  readonly inject: string[]
  apply(ctx: Context): void | Promise<() => Promise<void>>
}

interface TerminalCarrier {
  installConnection(ctx: Context, options: {
    interactions: 'answer'
    transport: {
      streamBaseUrl: string
      fetch: (input: string | URL, init: RequestInit) => Promise<Response>
      createWebSocket: (url: string) => unknown
    }
  }): void
}

interface SocketFactory {
  new(url: string, options: { headers: Record<string, string> }): { once(event: 'close', listener: () => void): void }
}

/** Caller-owned inputs for a foreground Host. */
export interface OpenTerminalHostOptions {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly patchFiles?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

/** Remote operations and lifetime of a single terminal-owned Host. */
export interface TerminalHost {
  readonly remote: ClientRemote
  readonly signal: AbortSignal
  /** Read or upload via the authenticated HTTP routes served by the same local Host. */
  requestResource(input: string, init?: RequestInit): Promise<Response>
  /** Close only this authenticated peer. */
  detach(): Promise<void>
  /** @param path - existing Host directory to adopt. @returns the registration receipt. */
  registerWorkspace(path: string): Promise<TerminalWorkspaceRegistration>
  /** @param signal - cancellation of the workspace read. @returns the complete opening workspace list. */
  listWorkspaces(signal: AbortSignal): Promise<readonly TerminalWorkspace[]>
  /** @param active - current session identity. @param answer - human decision handler. @returns its disposer. */
  answerApprovals(active: () => string | undefined, answer: (request: TerminalApprovalRequest) => Promise<TerminalApprovalOutcome>,
    questions?: (items: readonly TerminalQuestion[], signal: AbortSignal) => Promise<TerminalQuestionAnswer | undefined>):
  () => void
  /** Close the client and await exit of the Host started by this invocation. */
  dispose(): Promise<void>
}

async function loadDependency<T>(lookup: NodeJS.Require, id: string): Promise<T> {
  return await import(pathToFileURL(lookup.resolve(id)).href) as T
}

async function loadForgeRemote(fromRuntime: NodeJS.Require): Promise<unknown> {
  let bundle: string
  try { bundle = fromRuntime.resolve('@deepseek-ai/dsh-experimental-forge-bundle/package.json') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
  const dependency = await loadDependency<{ readonly default: unknown }>(
    createRequire(bundle), '@deepseek-ai/dsh-experimental-client-ui-forge/remote',
  )
  return dependency.default
}

async function loadRemotes(lookup: NodeJS.Require): Promise<ClientPlugin> {
  // This release ships Connection and Gateway as Node entries. Remotes ships
  // the same generated descriptors in a loader factory requiring only its
  // package dependencies. Give it a local loader without changing Node globals.
  const id = '@deepseek-ai/dsh-api-remotes'
  const file = lookup.resolve(id + '/client')
  const require = createRequire(file)
  const entry = compileFunction(await readFile(file, 'utf8'), ['window'], { filename: file })
  let plugin: ClientPlugin | undefined
  entry({
    __ModuleLoader__: {
      load(factory: { id: string; factory(require: NodeJS.Require): ClientPlugin }) {
        if (factory.id !== id || plugin !== undefined) throw new Error('Unexpected DSH Remote client registration')
        plugin = factory.factory(require)
      },
    },
  })
  if (plugin === undefined) throw new Error('DSH Remote client did not register')
  return plugin
}

function waitUntilAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((done, fail) => {
    const abort = (): void => { fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(done, fail).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

function startupUrl(child: ChildProcess, signal: AbortSignal): Promise<URL> {
  if (child.stdout === null) throw new Error('DSH Host stdout is unavailable')
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
  return waitUntilAbortable(new Promise<URL>((resolveUrl, rejectUrl) => {
    stdout.on('line', (line) => {
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)\s*$/u.exec(line)
      if (match?.[1] === undefined) return
      const url = new URL(match[1])
      if (url.searchParams.has('token')) resolveUrl(url)
    })
    stdout.once('close', () => { rejectUrl(new Error('DSH Host exited before publishing its local connection')) })
  }), signal).finally(() => { stdout.close() })
}

async function apiPeerCookie(launchUrl: URL, signal: AbortSignal): Promise<string> {
  const exchange = new URL('/connect', launchUrl.origin)
  exchange.searchParams.set('token', launchUrl.searchParams.get('token') ?? '')
  exchange.searchParams.set('interactions', 'answer')
  const response = await fetch(exchange, { redirect: 'manual', signal })
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0]
  await response.body?.cancel()
  if (response.status !== 302 || cookie === undefined) {
    throw new Error(`DSH Host rejected the terminal connection (HTTP ${response.status})`)
  }
  return cookie
}

/** @param callerEnv - launch environment. @returns the resolved pinned Host manifest. */
export async function runtimeManifest(callerEnv: NodeJS.ProcessEnv): Promise<string> {
  const configured = callerEnv.DS_CLI_RUNTIME_DIR
  const runtime = configured === undefined
    ? new URL('../runtime/', import.meta.url)
    : pathToFileURL(resolve(configured) + '/')
  const manifest = new URL('node_modules/ds-cli-runtime/package.json', runtime)
  try {
    return await realpath(manifest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error('The pinned DSH Host is missing. Install it in apps/cli/runtime or set DS_CLI_RUNTIME_DIR.')
  }
}

/**
 * Inspect the pinned runtime without creating or loading a Host profile.
 * @param env - caller environment supplying the optional runtime directory.
 * @returns the pinned Host version and the installed version, if readable.
 */
export async function describeTerminalRuntime(env: NodeJS.ProcessEnv): Promise<{ expected: string; installed: string | null }> {
  try {
    const manifest = JSON.parse(await readFile(await runtimeManifest(env), 'utf8')) as { version?: unknown }
    return { expected: RUNTIME_VERSION, installed: typeof manifest.version === 'string' ? manifest.version : null }
  } catch {
    return { expected: RUNTIME_VERSION, installed: null }
  }
}

async function ready(generation: ConnectionGeneration, signal: AbortSignal): Promise<void> {
  if (generation.getSnapshot() !== undefined) return
  let unsubscribe = (): void => {}
  try {
    await waitUntilAbortable(new Promise<void>((resolveReady) => {
      unsubscribe = generation.subscribe(() => {
        if (generation.getSnapshot() !== undefined) resolveReady()
      })
    }), signal)
  } finally {
    unsubscribe()
  }
}

/** A process running the pinned official Host before any API peer attaches. */
export interface TerminalHostProcess {
  readonly pid: number
  readonly signal: AbortSignal
  readonly ready: Promise<URL>
  readonly exited: Promise<void>
  stop(): Promise<void>
}

/** Start the official Host process with detached stdin and drained diagnostics.
 * @param options - working directory, lifetime and overlays.
 * @param supervised - use a private Node IPC channel for graceful supervisor stop.
 * @returns the process and its owned lifecycle.
 */
export async function startTerminalHostProcess(options: OpenTerminalHostOptions, supervised = false): Promise<TerminalHostProcess> {
  options.signal.throwIfAborted()
  const callerEnv = options.env ?? process.env
  const manifestPath = await runtimeManifest(callerEnv)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; bin: { dsh: string } }
  if (manifest.version !== RUNTIME_VERSION) throw new Error(`Expected DSH Host ${RUNTIME_VERSION}, found ${manifest.version}`)
  const cwd = resolve(options.cwd)
  const life = new AbortController()
  const signal = AbortSignal.any([options.signal, life.signal])
  signal.throwIfAborted()
  const child = spawn(process.execPath, [
    ...(supervised ? ['--import', new URL('./terminal-host-stop-hook.js', import.meta.url).href] : []),
    resolve(dirname(manifestPath), manifest.bin.dsh),
    'web',
    '--patch', fileURLToPath(new URL('../config/terminal-host.patch.yml', import.meta.url)),
    ...(options.patchFiles ?? []).flatMap(file => ['--patch', resolve(cwd, file)]),
    '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], {
    cwd, env: { ...callerEnv, DSH_HOME: terminalHostPaths(callerEnv).home },
    stdio: ['ignore', 'pipe', 'pipe', ...(supervised ? ['ipc' as const] : [])], windowsHide: true,
  })
  // Drain the server's own diagnostics without exposing its launch token.
  child.stderr?.resume()
  child.stdout?.resume()
  child.on('error', (error) => { life.abort(error) })
  const exited = new Promise<void>((done) => {
    child.once('close', (code, reason) => {
      life.abort(new Error(`DSH Host exited (${code ?? reason})`))
      done()
    })
  })
  const readySignal = AbortSignal.any([signal, AbortSignal.timeout(STARTUP_TIMEOUT_MS)])
  const opened = startupUrl(child, readySignal)
  if (child.pid === undefined) {
    await opened.catch(() => {})
    throw new Error('Could not start the DSH Host process')
  }
  let stopping: Promise<void> | undefined
  return {
    pid: child.pid, signal, ready: opened, exited,
    stop() {
      stopping ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) { await exited; return }
        if (!supervised || !child.connected) { child.kill(); await exited; return }
        const deadline = setTimeout(() => child.kill(), 10_000)
        deadline.unref()
        try {
          child.send('ds-cli-terminal-stop', (error) => { if (error != null) child.kill() })
          await exited
        } finally { clearTimeout(deadline) }
      })()
      return stopping
    },
  }
}

/** Attach one client to an existing pinned Host.
 * @param options - peer lifetime and runtime resolution.
 * @param url - authenticated local launch URL from the Host owner.
 * @returns a peer whose disposer leaves the Host running.
 */
export async function connectTerminalHost(options: OpenTerminalHostOptions, url: URL): Promise<TerminalHost> {
  options.signal.throwIfAborted()
  const fromRuntime = createRequire(await runtimeManifest(options.env ?? process.env))
  const fromWeb = createRequire(fromRuntime.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const fromBase = createRequire(fromRuntime.resolve('@deepseek-ai/dsh-base/package.json'))
  const fromGateway = createRequire(fromBase.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
  const [{ Context: RuntimeContext }, typert, carrier, gateway, remotes] = await Promise.all([
    loadDependency<{ Context: new() => Context }>(fromRuntime, '@deepseek-ai/cordis'),
    loadDependency<ClientPlugin>(fromBase, '@deepseek-ai/dsh-typert-registry/client'),
    loadDependency<TerminalCarrier>(fromWeb, '@deepseek-ai/dsh-client-connection/client'),
    loadDependency<ClientPlugin>(fromBase, '@deepseek-ai/dsh-api-gateway/client'),
    loadRemotes(fromWeb),
  ])
  const { WebSocket } = fromGateway('ws') as { WebSocket: SocketFactory }
  const life = new AbortController()
  const signal = AbortSignal.any([options.signal, life.signal])
  const startup = AbortSignal.any([signal, AbortSignal.timeout(STARTUP_TIMEOUT_MS)])
  const ctx = new RuntimeContext()
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposal ??= ctx.fiber.dispose()
    life.abort(new Error('Terminal Host peer closed'))
    return disposal
  }
  try {
    const cookie = await apiPeerCookie(url, startup)
    function requestResource(input: string | URL, init: RequestInit = {}): Promise<Response> {
      const resource = new URL(input, url.origin)
      if (resource.origin !== url.origin || resource.username || resource.password) {
        throw new Error('DSH Remote request has the wrong origin')
      }
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      return fetch(resource, {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
      })
    }
    await ctx.plugin(typert)
    carrier.installConnection(ctx, {
      interactions: 'answer',
      transport: {
        streamBaseUrl: `${url.origin}/`,
        fetch: requestResource,
        createWebSocket(address) {
          const target = new URL(address)
          if (target.protocol !== 'ws:' || target.host !== url.host) throw new Error('DSH Remote socket has the wrong origin')
          const socket = new WebSocket(address, { headers: { Cookie: cookie } })
          socket.once('close', () => { life.abort(new Error('Disconnected from the DSH Host')) })
          return socket
        },
      },
    })
    await ctx.plugin(gateway)
    await ctx.plugin(remotes)
    const remote = ctx.get('remote') as unknown as ClientRemote
    await remote.$mount(terminalConnectorRemote)
    const forge = await loadForgeRemote(fromRuntime)
    if (forge !== undefined) await remote.$mount(forge)
    const { generation } = ctx.get('connection') as unknown as { generation: ConnectionGeneration }
    await ready(generation, startup)
    return {
      remote, signal, requestResource, dispose, detach: dispose,
      answerApprovals(active, answer, questions) {
        const registry = ctx.get('typert') as unknown as {
          contexts: {
            registerClient(key: 'agent', adapter: {
              identity(candidate: Context): string | undefined
              resolve(id: string): Context | undefined
            }): () => void
          }
        }
        const unregister = registry.contexts.registerClient('agent', {
          identity: candidate => candidate === ctx ? active() : undefined,
          resolve: id => id === active() ? ctx : undefined,
        })
        const remove = remote.$on('approval/request', async (request, next) => {
          const sessionId = active()
          if (sessionId === undefined) return next()
          if (request.signal.aborted) return 'cancelled'
          const decision = await answer(request)
          return request.signal.aborted || active() !== sessionId ? 'cancelled' : decision
        })
        const removeQuestions = questions === undefined ? undefined : remote.$on('user-questions/request', async (request, next) => {
          const sessionId = active()
          if (sessionId === undefined) return next()
          const hold = new AbortController()
          const lifetime = AbortSignal.any([signal, hold.signal, ...(request.signal === undefined ? [] : [request.signal])])
          const claim = request.wait?.timed === true
            ? remote.userQuestions.attachWait(sessionId, request.wait.callId, lifetime)[Symbol.asyncIterator]()
            : undefined
          let closed: Promise<unknown> | undefined
          let answered = false
          try {
            const opening = await claim?.next()
            if (opening?.done === true || lifetime.aborted) return await next()
            if (claim !== undefined) closed = claim.next().finally(() => { hold.abort() })
            void closed?.catch(() => {})
            const decision = await questions(request.questions, lifetime)
            if (decision === undefined || lifetime.aborted || active() !== sessionId) {
              hold.abort()
              return await next()
            }
            answered = true
            return decision
          } finally {
            if (!answered) {
              hold.abort()
              await claim?.return?.().catch(() => {})
            } else if (closed !== undefined) {
              void closed.then(() => claim?.return?.(), () => claim?.return?.()).catch(() => {})
            }
          }
        })
        return () => { remove(); removeQuestions?.(); unregister() }
      },
      async registerWorkspace(path) {
        return requireHostResult(await remote.workspace.create({ path }))
      },
      async listWorkspaces(readSignal) {
        for await (const frame of remote.workspace.follow(AbortSignal.any([readSignal, signal]))) {
          if (frame.type === 'baseline') return frame.value.items
          throw new Error('The Host workspace stream did not start with a baseline')
        }
        throw new Error('The Host workspace stream closed before its initial state')
      },
    }
  } catch (error) {
    const failure: unknown = signal.aborted ? signal.reason
      : new Error('Could not connect to the DSH Host', { cause: error })
    await dispose()
    throw failure
  }
}

/** Start and own a foreground Host for isolated runs.
 * @param options - working directory, cancellation and overlays.
 * @returns an authenticated peer whose disposer also stops the Host process.
 */
export async function openTerminalHost(options: OpenTerminalHostOptions): Promise<TerminalHost> {
  const paths = terminalHostPaths(options.env ?? process.env)
  await prepareTerminalHostDirectory(paths.directory)
  try {
    const lease = await open(paths.lease, 'wx', 0o600)
    await lease.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another terminal Host owns this profile. Choose a separate DSH_HOME for a foreground run.')
    }
    throw error
  }
  let processHandle: TerminalHostProcess | undefined
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try { await processHandle?.stop() } finally { await rm(paths.lease, { force: true }) }
    })()
    return stopping
  }
  try {
    processHandle = await startTerminalHostProcess(options)
    const peer = await connectTerminalHost({ ...options, signal: processHandle.signal }, await processHandle.ready)
    return { ...peer, async dispose() { try { await peer.detach() } finally { await stop() } } }
  } catch (error) {
    await stop()
    throw error
  }
}

/**
 * Read a decoded Host business response or report its domain error.
 * @param response - decoded response from the official Remote client.
 * @returns the Host's business value.
 */
export function requireHostResult<T>(response: HostResult<T>): T {
  if (!response.ok) throw new Error(`${response.error.message} (${response.error.code})`)
  return response.value
}
