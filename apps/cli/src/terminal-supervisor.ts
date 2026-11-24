/** Own one detached rc.5 Host per terminal profile and authenticate its control channel. @module @deepseek-ai/dsh/terminal-supervisor */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { access, open, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  openTerminalHostCredentials, prepareTerminalHostDirectory, processExists, publishTerminalHostState,
  readTerminalHostState, sealTerminalHostCredentials, terminalHostPaths, terminalHostProof, verifyTerminalSupervisor,
} from './terminal-host-state.ts'
import {
  connectTerminalHost, requireHostResult, runtimeManifest, startTerminalHostProcess, type OpenTerminalHostOptions, type TerminalHost,
  type TerminalHostProcess,
} from './terminal-host.ts'
import { redirectToTerminalBrowser, TerminalBrowserGrants, terminalBrowserSession } from './terminal-browser.ts'

interface LaunchRequest {
  readonly cwd: string
  readonly patches: readonly string[]
  readonly runtime: string
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** @param request - resolved Host launch configuration from the terminal. */
export async function serveTerminalHost(request: LaunchRequest): Promise<void> {
  const paths = terminalHostPaths(process.env)
  await prepareTerminalHostDirectory(paths.directory)
  try {
    const lease = await open(paths.lease, 'wx', 0o600)
    await lease.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  const endpoint = { version: 1, generation: randomUUID(), supervisorPid: process.pid,
    runtime: request.runtime, patches: request.patches } as const
  const controlToken = randomBytes(32).toString('base64url')
  const expected = Buffer.from('Bearer ' + controlToken)
  const stopping = Promise.withResolvers<void>()
  const controller = new AbortController()
  const grants = new TerminalBrowserGrants()
  let launchUrl: URL | undefined
  const control = createServer((incoming, outgoing) => {
    if (incoming.headers.host !== `127.0.0.1:${incoming.socket.localPort}`) {
      outgoing.writeHead(404).end()
      return
    }
    const path = incoming.url ?? ''
    const readyUrl = launchUrl
    const identityPrefix = '/identity/' + endpoint.generation + '/'
    if (incoming.method === 'GET' && path.startsWith(identityPrefix) && readyUrl !== undefined) {
      const challenge = path.slice(identityPrefix.length)
      if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
        outgoing.writeHead(404).end()
        return
      }
      outgoing.writeHead(200, { 'cache-control': 'no-store', 'content-length': 43 })
        .end(terminalHostProof(controlToken, endpoint.generation, challenge))
      return
    }
    const browser = /^\/browser\/(session-[\da-f-]+)\/([\w-]{43})$/u.exec(path)
    if (incoming.method === 'GET' && browser?.[1] !== undefined && browser[2] !== undefined && readyUrl !== undefined) {
      if (!grants.consume(browser[2], browser[1])) {
        outgoing.writeHead(404, { 'cache-control': 'no-store' }).end()
        return
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      void redirectToTerminalBrowser(outgoing, readyUrl, browser[1], signal).catch(() => { outgoing.writeHead(502).end() })
      return
    }
    const auth = Buffer.from(incoming.headers.authorization ?? '')
    if (incoming.method !== 'POST' || readyUrl === undefined
      || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      outgoing.writeHead(404).end()
      return
    }
    if (path === '/stop/' + endpoint.generation) {
      outgoing.writeHead(202).end(() => { stopping.resolve() })
      return
    }
    const prefix = '/open/' + endpoint.generation + '/'
    const sessionId = path.startsWith(prefix) ? path.slice(prefix.length) : ''
    if (!terminalBrowserSession.test(sessionId)) {
      outgoing.writeHead(404).end()
      return
    }
    void (async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
      const peer = await connectTerminalHost({ cwd: request.cwd, signal }, readyUrl)
      try {
        const { items } = requireHostResult(await peer.remote.session.list({}, signal))
        const session = items.find(row => row.sessionId === sessionId && row.origin !== 'subagent')
        if (session === undefined || session.formatStatus === 'migration-required') {
          outgoing.writeHead(404).end()
          return
        }
        const grant = grants.issue(sessionId)
        outgoing.writeHead(201, { 'cache-control': 'no-store', 'content-type': 'text/plain' }).end(grant)
      } finally { await peer.detach() }
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(503).end() })
  })
  const stop = (): void => { stopping.resolve(); controller.abort() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let host: TerminalHostProcess | undefined
  try {
    await publishTerminalHostState(paths.state, { ...endpoint, phase: 'starting' })
    if (request.runtime !== await runtimeManifest(process.env)) throw new Error('The pinned runtime changed during startup')
    host = await startTerminalHostProcess({
      cwd: request.cwd, patchFiles: request.patches, signal: controller.signal,
    }, true)
    launchUrl = await host.ready
    await new Promise<void>((done, fail) => {
      control.once('error', fail)
      control.listen(0, '127.0.0.1', done)
    })
    const address = control.address()
    if (address === null || typeof address === 'string') throw new Error('The supervisor control endpoint did not bind')
    const credentials = await sealTerminalHostCredentials({ launchUrl: launchUrl.href, controlToken }, controller.signal)
    await publishTerminalHostState(paths.state, {
      ...endpoint, phase: 'ready', pid: host.pid, controlPort: address.port, credentials,
    })
    await Promise.race([host.exited, stopping.promise])
  } finally {
    let closed: Promise<void> | undefined
    if (control.listening) {
      closed = new Promise<void>((done) => { control.close(() => { done() }) })
      control.closeAllConnections()
    }
    try {
      await host?.stop()
      await closed
    } finally {
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
      await rm(paths.state, { force: true })
      await rm(paths.lease, { force: true })
    }
  }
}

/** Reuse the profile's Host, or start one detached supervisor and attach a peer.
 * @param options - caller directory, overlays, environment and lifetime.
 * @returns a client peer whose disposal leaves the supervisor running.
 */
export async function ensureTerminalHost(options: OpenTerminalHostOptions): Promise<TerminalHost> {
  const env = options.env ?? process.env
  const paths = terminalHostPaths(env)
  const runtime = await runtimeManifest(env)
  const patches = (options.patchFiles ?? []).map(file => resolve(options.cwd, file))
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(65_000)])
  let launched = false
  let launchExited = false
  while (!signal.aborted) {
    const state = await readTerminalHostState(paths.state)
    if (state !== undefined) {
      if (!processExists(state.supervisorPid)) throw new Error('Stale terminal Host state. Inspect dsh host status.')
      if (state.runtime !== runtime || JSON.stringify(state.patches) !== JSON.stringify(patches)) {
        throw new Error('The running terminal Host uses a different runtime or patch set. Use dsh host stop before restarting it.')
      }
      if (state.phase === 'ready') {
        if (!processExists(state.pid)) throw new Error('The recorded terminal Host process is unavailable.')
        const { launchUrl, controlToken } = await openTerminalHostCredentials(state.credentials, signal)
        if (!await verifyTerminalSupervisor(state, controlToken, signal)) {
          throw new Error('The terminal Host supervisor no longer matches its published state. Inspect dsh host status.')
        }
        return connectTerminalHost({ ...options, env }, new URL(launchUrl))
      }
    } else if (!await exists(paths.lease)) {
      if (launchExited) throw new Error('The terminal Host supervisor exited during startup.')
      if (!launched) {
        const helper = fileURLToPath(new URL('./terminal-supervisor-main.js', import.meta.url))
        const request = { cwd: options.cwd, patches, runtime }
        const child = spawn(process.execPath, [helper, '--serve', JSON.stringify(request)], {
          env, cwd: options.cwd, detached: true, windowsHide: true, stdio: 'ignore',
        })
        launched = true
        child.once('error', () => { launchExited = true })
        child.once('exit', () => { launchExited = true })
        child.unref()
      }
    }
    await delay(150, undefined, { signal })
  }
  signal.throwIfAborted()
  throw new Error('Timed out waiting for the terminal Host supervisor')
}

/** Print safe supervisor status or send an authenticated stop request for this exact generation.
 * @param action - local status or stop command.
 * @param confirmed - true only when the caller used --yes.
 * @param env - caller environment and profile selection.
 */
export async function runTerminalHostCommand(
  action: 'status' | 'stop', confirmed: boolean, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = terminalHostPaths(env)
  const state = await readTerminalHostState(paths.state)
  if (state === undefined) {
    console.log(JSON.stringify({ status: await exists(paths.lease) ? 'waiting-for-state' : 'stopped' }))
    return
  }
  let live = processExists(state.supervisorPid) && (state.phase === 'starting' || processExists(state.pid))
  const statusSignal = AbortSignal.timeout(10_000)
  const credentials = live && state.phase === 'ready' ? await openTerminalHostCredentials(state.credentials, statusSignal) : undefined
  if (credentials !== undefined && state.phase === 'ready') {
    live = await verifyTerminalSupervisor(state, credentials.controlToken, statusSignal)
  }
  if (action === 'status' || !live || state.phase !== 'ready') {
    console.log(JSON.stringify({ status: live ? state.phase : 'stale', generation: state.generation,
      ...(state.phase === 'ready' ? { pid: state.pid } : {}) }))
    if (action === 'stop' && (!live || state.phase !== 'ready')) process.exitCode = 1
    return
  }
  if (!confirmed) {
    if (!process.stdin.isTTY) throw new Error('Use dsh host stop --yes to confirm a noninteractive stop.')
    const reader = createInterface({ input: process.stdin, output: process.stderr })
    try {
      if ((await reader.question(`Stop terminal Host ${state.generation}? [y/N] `)).toLowerCase() !== 'y') return
    } finally { reader.close() }
  }
  if (credentials === undefined) throw new Error('The terminal Host supervisor has no authenticated state')
  const signal = AbortSignal.timeout(25_000)
  if (!await verifyTerminalSupervisor(state, credentials.controlToken, signal)) {
    throw new Error('The terminal Host supervisor changed before stopping')
  }
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/stop/${state.generation}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + credentials.controlToken }, redirect: 'error', signal,
  })
  await response.body?.cancel()
  if (response.status !== 202) throw new Error('The supervisor refused the stop request for this generation')
  for (;;) {
    const current = await readTerminalHostState(paths.state)
    if (current === undefined ? !await exists(paths.lease) : current.generation !== state.generation) break
    await delay(100, undefined, { signal })
  }
  console.log(JSON.stringify({ status: 'stopped', generation: state.generation }))
}
