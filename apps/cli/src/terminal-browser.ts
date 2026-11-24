/** One-use, session-bound browser handoff for the official local Host. @module @deepseek-ai/dsh/terminal-browser */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { connectTerminalHost, requireHostResult } from './terminal-host.ts'
import {
  openTerminalHostCredentials, processExists, readTerminalHostState, terminalHostPaths, verifyTerminalSupervisor,
} from './terminal-host-state.ts'

const GRANT_TTL_MS = 45_000
export const terminalBrowserSession = /^session-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu

/** Each token is bound to its original Session and can be consumed once. */
export class TerminalBrowserGrants {
  private readonly grants = new Map<string, { sessionId: string; expiresAt: number }>()

  issue(sessionId: string, now = Date.now()): string {
    if (!terminalBrowserSession.test(sessionId)) throw new Error('Invalid browser Session identity')
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token)
    }
    if (this.grants.size >= 32) throw new Error('Too many pending browser handoffs')
    const token = randomBytes(32).toString('base64url')
    this.grants.set(token, { sessionId, expiresAt: now + GRANT_TTL_MS })
    return token
  }

  consume(token: string, sessionId: string, now = Date.now()): boolean {
    const grant = this.grants.get(token)
    if (grant === undefined || grant.sessionId !== sessionId) return false
    this.grants.delete(token)
    return grant.expiresAt > now
  }
}

/** Trade the already-consumed grant for the Host's normal browser cookie without forwarding the startup URL. */
export async function redirectToTerminalBrowser(
  response: ServerResponse, launchUrl: URL, sessionId: string, signal: AbortSignal,
): Promise<void> {
  const upstream = await fetch(launchUrl, { redirect: 'manual', signal })
  const cookies = upstream.headers.getSetCookie()
  await upstream.body?.cancel()
  if (upstream.status !== 303 || cookies.length !== 1) throw new Error('Host did not authorize the browser')
  const target = new URL('/', launchUrl.origin)
  target.hash = 'dsh-cli=' + sessionId
  response.writeHead(303, {
    'location': target.href, 'set-cookie': cookies, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
  }).end()
}

/** Request a short-lived handoff for an existing Session. */
export async function requestTerminalBrowser(
  sessionId?: string, env: NodeJS.ProcessEnv = process.env,
): Promise<URL> {
  const paths = terminalHostPaths(env)
  const state = await readTerminalHostState(paths.state)
  if (state?.phase !== 'ready' || !processExists(state.supervisorPid) || !processExists(state.pid)) {
    throw new Error('Start dsh to open the shared web view')
  }
  const signal = AbortSignal.timeout(20_000)
  const credentials = await openTerminalHostCredentials(state.credentials, signal)
  if (!await verifyTerminalSupervisor(state, credentials.controlToken, signal)) {
    throw new Error('The terminal Host supervisor no longer matches its published state')
  }
  let id = sessionId
  if (id === undefined) {
    const peer = await connectTerminalHost({ cwd: process.cwd(), signal, env }, new URL(credentials.launchUrl))
    try {
      const { items } = requireHostResult(await peer.remote.session.list({}, signal))
      id = items.filter(row => row.origin !== 'subagent' && row.formatStatus !== 'migration-required')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId
    } finally { await peer.detach() }
  }
  if (id === undefined || !terminalBrowserSession.test(id)) throw new Error('Select an existing Session with --session <id>')
  const endpoint = `http://127.0.0.1:${state.controlPort}`
  const result = await fetch(`${endpoint}/open/${state.generation}/${id}`, {
    method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + credentials.controlToken }, signal,
  })
  if (result.status !== 201) {
    await result.body?.cancel()
    throw new Error(`Browser handoff unavailable for session ${id} (HTTP ${result.status})`)
  }
  const token = await result.text()
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('Supervisor did not issue a valid browser grant')
  return new URL(`/browser/${id}/${token}`, endpoint)
}

/** Start the OS URL handler for a supervisor-issued loopback URL. */
export async function openTerminalBrowser(url: URL): Promise<void> {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/browser/')) {
    throw new Error('Browser handoff must address the local supervisor')
  }
  const application = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(application, [url.href], { stdio: 'ignore', detached: true, windowsHide: true })
  await once(child, 'spawn')
  child.unref()
}
