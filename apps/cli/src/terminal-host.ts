/**
 * Own the pinned local DSH Host and a single authenticated terminal client.
 * @module @deepseek-ai/dsh/terminal-host
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileFunction } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { TerminalAgentPreset } from './terminal-start.ts'

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

interface WorkspaceRemote {
  create(request: { path: string }): Promise<HostResult<TerminalWorkspaceRegistration>>
  follow(signal: AbortSignal): AsyncIterable<
    | { readonly type: 'baseline'; readonly value: { readonly items: readonly TerminalWorkspace[] } }
    | { readonly type: 'replace' | 'upsert' | 'remove' | 'order' | 'archived' | 'pinned' }
  >
}

/** Address of a primary session in the Host journal. */
export interface TerminalSessionAddress {
  readonly kind: 'session'
  readonly sessionId: string
}

/** Fields required by the terminal from the Host's session catalogue. */
export interface TerminalSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly formatStatus?: 'current' | 'migration-required'
  readonly origin?: 'subagent'
}

/** Host projection read by the terminal before enabling chat. */
export interface TerminalSessionProjection {
  readonly kind: 'sequenced' | 'migration-required'
  readonly values: {
    readonly agentPreset?: string | null
    readonly permissions?: { readonly currentValue: string }
  }
}

/** Committed event from the official session journal. */
export interface TerminalSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** Opening snapshot and subsequent committed records from a Host stream. */
export type TerminalSessionFrame =
  | { readonly type: 'snapshot'; readonly records: readonly { readonly type: 'event'; readonly event: TerminalSessionEvent }[] }
  | { readonly type: 'event'; readonly event: TerminalSessionEvent }

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

/** Official Remote operations used by the terminal after the Gateway decodes them. */
export interface ClientRemote {
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
    list(request: Record<string, never>, signal: AbortSignal):
    Promise<HostResult<{ readonly items: readonly TerminalSessionSummary[] }>>
    prompt(request: { sessionId: string; requestId: string; mode: 'queue'; content: readonly { type: 'text'; text: string }[] },
      signal: AbortSignal): Promise<HostResult<{ readonly accepted: true }>>
    cancel(request: { sessionId: string }): Promise<HostResult<unknown>>
  }
  readonly commands: {
    execute(sessionId: string, line: string, attachments: readonly never[], signal: AbortSignal):
    Promise<HostResult<{ readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | null>>
  }
  readonly permissionPresets: { catalog(): Promise<HostResult<TerminalPermissionCatalog>> }
  readonly settings: {
    describe(): Promise<HostResult<{
      readonly writable: boolean
      readonly namespaces: readonly { readonly ns: string; readonly revision: number }[]
    }>>
    mutate(namespace: string, operations: readonly { op: 'set'; path: readonly string[]; value: string }[], revision: number):
    Promise<HostResult<unknown>>
  }
  $on(event: 'approval/request', listener: (request: TerminalApprovalRequest, next: () => Promise<TerminalApprovalOutcome>) =>
  Promise<TerminalApprovalOutcome>): () => void
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
  /** @param path - existing Host directory to adopt. @returns the registration receipt. */
  registerWorkspace(path: string): Promise<TerminalWorkspaceRegistration>
  /** @param signal - cancellation of the workspace read. @returns the complete opening workspace list. */
  listWorkspaces(signal: AbortSignal): Promise<readonly TerminalWorkspace[]>
  /** @param active - current session identity. @param answer - human decision handler. @returns its disposer. */
  answerApprovals(active: () => string | undefined, answer: (request: TerminalApprovalRequest) => Promise<TerminalApprovalOutcome>):
  () => void
  /** Close the client and await exit of the Host started by this invocation. */
  dispose(): Promise<void>
}

async function loadDependency<T>(lookup: NodeJS.Require, id: string): Promise<T> {
  return await import(pathToFileURL(lookup.resolve(id)).href) as T
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

async function runtimeManifest(callerEnv: NodeJS.ProcessEnv): Promise<string> {
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

/**
 * Start the official runtime in a child process and attach a Node Remote client.
 * @param options - caller directory, cancellation, and optional Host overlays.
 * @returns the authenticated terminal Host and its disposer.
 */
export async function openTerminalHost(options: OpenTerminalHostOptions): Promise<TerminalHost> {
  options.signal.throwIfAborted()
  const callerEnv = options.env ?? process.env
  const manifestPath = await runtimeManifest(callerEnv)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; bin: { dsh: string } }
  if (manifest.version !== RUNTIME_VERSION) throw new Error(`Expected DSH Host ${RUNTIME_VERSION}, found ${manifest.version}`)
  const fromRuntime = createRequire(manifestPath)
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
  const cwd = resolve(options.cwd)
  const home = resolve(resolveDshHome(undefined, callerEnv), 'ds-cli-host-0.2')
  const life = new AbortController()
  const signal = AbortSignal.any([options.signal, life.signal])
  const deadline = AbortSignal.timeout(STARTUP_TIMEOUT_MS)
  const startup = AbortSignal.any([signal, deadline])
  const ctx = new RuntimeContext()
  signal.throwIfAborted()
  const child = spawn(process.execPath, [
    resolve(dirname(manifestPath), manifest.bin.dsh),
    'web',
    '--patch', fileURLToPath(new URL('../config/terminal-host.patch.yml', import.meta.url)),
    ...(options.patchFiles ?? []).flatMap(file => ['--patch', resolve(cwd, file)]),
    '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], {
    cwd, env: { ...callerEnv, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      life.abort(new Error('Terminal Host closed'))
      try {
        await ctx.fiber.dispose()
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await exited
      }
    })()
    return disposal
  }

  let phase: 'starting' | 'connecting to' = 'starting'
  try {
    const url = await startupUrl(child, startup)
    phase = 'connecting to'
    const cookie = await apiPeerCookie(url, startup)
    await ctx.plugin(typert)
    carrier.installConnection(ctx, {
      interactions: 'answer',
      transport: {
        streamBaseUrl: `${url.origin}/`,
        fetch(input, init) {
          const resource = new URL(input, url.origin)
          if (resource.origin !== url.origin) throw new Error('DSH Remote request has the wrong origin')
          const headers = new Headers(init.headers)
          headers.set('cookie', cookie)
          return fetch(resource, {
            ...init,
            headers,
            redirect: 'error',
            signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
          })
        },
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
    const { generation } = ctx.get('connection') as unknown as { generation: ConnectionGeneration }
    await ready(generation, startup)
    const remote = ctx.get('remote') as unknown as ClientRemote
    return {
      remote, signal, dispose,
      answerApprovals(active, answer) {
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
          if (active() === undefined) return next()
          if (request.signal.aborted) return 'cancelled'
          return answer(request)
        })
        return () => { remove(); unregister() }
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
    const failure: unknown = signal.aborted ? signal.reason : deadline.aborted
      ? new Error(`Timed out ${phase} the DSH Host after ${STARTUP_TIMEOUT_MS / 1_000}s`)
      : phase === 'connecting to' ? new Error('Could not connect to the DSH Host', { cause: error }) : error
    await dispose()
    throw failure
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
