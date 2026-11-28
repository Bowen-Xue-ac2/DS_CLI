/** Owner-scoped state and Windows credential protection for the terminal supervisor. @module @deepseek-ai/dsh/terminal-host-state */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

interface HostIdentity {
  readonly version: 1
  readonly generation: string
  readonly supervisorPid: number
  readonly runtime: string
  readonly patches: readonly string[]
}

/** The supervisor writes starting state before launching the Host and seals credentials before publishing readiness. */
export type TerminalHostState = HostIdentity & (
  { readonly phase: 'starting' } |
  { readonly phase: 'ready'; readonly pid: number; readonly controlPort: number; readonly credentials: string }
)

export type TerminalReadyState = Extract<TerminalHostState, { phase: 'ready' }>

/** Credentials used by trusted peers to exchange a Host token or to stop this supervisor generation. */
export interface TerminalHostCredentials {
  readonly launchUrl: string
  readonly controlToken: string
}

/** Locate the runtime files in the same home as the pinned official Host.
 * @param env - launching environment, including a user-selected DSH home.
 * @returns profile, lock and state paths.
 */
export function terminalHostPaths(env: NodeJS.ProcessEnv) {
  const home = resolve(resolveDshHome(undefined, env), 'ds-cli-host-0.2')
  const directory = join(home, '.terminal-host')
  return { home, directory, lease: join(directory, 'lease'), state: join(directory, 'state.json'),
    recovery: join(directory, 'recovery') }
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** @param path - fixed supervisor state file. @returns metadata or undefined if the supervisor has not published state. */
export async function readTerminalHostState(path: string): Promise<TerminalHostState | undefined> {
  let data: string
  try { data = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { throw new Error('Invalid terminal Host state') }
  if (parsed === null || typeof parsed !== 'object') throw new Error('Invalid terminal Host state')
  const state = parsed as Partial<TerminalHostState>
  if (state.version !== 1 || typeof state.generation !== 'string' || !/^[a-f\d-]{36}$/u.test(state.generation)
    || !validPid(state.supervisorPid) || typeof state.runtime !== 'string'
    || !Array.isArray(state.patches) || !state.patches.every(file => typeof file === 'string')) {
    throw new Error('Invalid terminal Host state')
  }
  if (state.phase === 'starting') return state as TerminalHostState
  if (state.phase === 'ready' && validPid(state.pid) && validPid(state.controlPort) && state.controlPort <= 65_535
    && typeof state.credentials === 'string' && state.credentials.length <= 24_000) return state as TerminalHostState
  throw new Error('Invalid terminal Host state')
}

/** @param directory - fixed supervisor directory. */
export async function prepareTerminalHostDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
}

/** @param path - fixed supervisor state file. @param state - single generation holding the lease. */
export async function publishTerminalHostState(path: string, state: TerminalHostState): Promise<void> {
  const temporary = path + '.' + randomUUID()
  try {
    await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

/** @param pid - already-validated process identity from the lease. @returns whether a process currently holds that ID. */
export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

/** Bind the proof to a state generation and a fresh caller-selected challenge. */
export function terminalHostProof(token: string, generation: string, challenge: string): string {
  return createHmac('sha256', token).update(generation + '/' + challenge).digest('base64url')
}

/** Verify the live supervisor on its recorded port before sending any credential there. */
export async function verifyTerminalSupervisor(state: TerminalReadyState, token: string, signal: AbortSignal): Promise<boolean> {
  const challenge = randomBytes(32).toString('base64url')
  const identity = `http://127.0.0.1:${state.controlPort}/identity/${state.generation}/${challenge}`
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(2_500)])
  try {
    const response = await fetch(identity, { redirect: 'error', signal: lifetime })
    if (response.status !== 200 || response.headers.get('content-length') !== '43') {
      await response.body?.cancel()
      return false
    }
    const actual = Buffer.from(await response.text())
    const expected = Buffer.from(terminalHostProof(token, state.generation, challenge))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    signal.throwIfAborted()
    return false
  }
}

async function protectWindows(
  operation: 'Protect' | 'Unprotect', data: Buffer, signal: AbortSignal,
): Promise<Buffer> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Security; '
    + '$cipherInput = [Convert]::FromBase64String([Console]::In.ReadToEnd()); '
    + `$cipherOutput = [Security.Cryptography.ProtectedData]::${operation}($cipherInput, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + '[Console]::Out.Write([Convert]::ToBase64String($cipherOutput))'
  return new Promise<Buffer>((done, fail) => {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal: lifetime,
    })
    let output = ''
    child.stdout.setEncoding('ascii')
    child.stdout.on('data', (text: string) => { output += text })
    const failure = (): void => { fail(new Error('Windows could not read or protect the terminal Host credentials')) }
    child.on('error', failure)
    child.stdin.on('error', failure)
    child.once('close', (code) => {
      if (code !== 0 || output.length === 0 || output.length > 24_000) failure()
      else done(Buffer.from(output, 'base64'))
    })
    child.stdin.end(data.toString('base64'))
  })
}

/** @param credentials - local credentials. @param signal - supervisor lifetime. @returns protected state payload. */
export async function sealTerminalHostCredentials(credentials: TerminalHostCredentials, signal: AbortSignal): Promise<string> {
  const data = Buffer.from(JSON.stringify(credentials))
  return (process.platform === 'win32' ? await protectWindows('Protect', data, signal) : data).toString('base64')
}

/** @param payload - owner-scoped state payload. @param signal - peer lifetime. @returns validated local credentials. */
export async function openTerminalHostCredentials(payload: string, signal: AbortSignal): Promise<TerminalHostCredentials> {
  const bytes = Buffer.from(payload, 'base64')
  const decoded = process.platform === 'win32' ? await protectWindows('Unprotect', bytes, signal) : bytes
  let decodedValue: unknown
  try { decodedValue = JSON.parse(decoded.toString('utf8')) } catch {
    throw new Error('Invalid terminal Host credentials')
  }
  if (decodedValue === null || typeof decodedValue !== 'object') throw new Error('Invalid terminal Host credentials')
  const { launchUrl, controlToken } = decodedValue as Partial<TerminalHostCredentials>
  if (typeof launchUrl !== 'string' || typeof controlToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(controlToken)) {
    throw new Error('Invalid terminal Host credentials')
  }
  const url = new URL(launchUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || !url.searchParams.get('token')
    || url.username !== '' || url.password !== '') throw new Error('Invalid terminal Host endpoint')
  return { launchUrl, controlToken }
}
