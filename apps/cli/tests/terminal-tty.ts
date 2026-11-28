import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { expect, vi } from 'vitest'

export const consumer = process.env.DS_CLI_TEST_INSTALL_DIR
const appRoot = consumer === undefined
  ? new URL('../', import.meta.url)
  : pathToFileURL(join(consumer, 'node_modules', '@deepseek-ai', 'dsh') + '/')
export const terminalHost = new URL('lib/terminal-host.js', appRoot).href
const terminalBin = fileURLToPath(new URL('lib/bin.js', appRoot))
const fromRuntime = createRequire(new URL('runtime/package.json', appRoot))
const fromCli = createRequire(fromRuntime.resolve('ds-cli-runtime/package.json'))
const fromBase = createRequire(fromCli.resolve('@deepseek-ai/dsh-base/package.json'))
const requirePty = createRequire(fromBase.resolve('@deepseek-ai/dsh-subprocess-local/package.json'))

interface Pty {
  onData(receive: (data: string) => void): void
  onExit(receive: (status: { readonly exitCode: number }) => void): void
  write(text: string): void
  resize(columns: number, rows: number): void
  kill(): void
  readonly pid: number
}

function executable(name: string): string {
  const matches = execFileSync('where.exe', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)
  const gitBash = name === 'bash.exe' ? matches.find(path => /\\Git\\(?:bin|usr\\bin)\\bash\.exe$/iu.test(path)) : undefined
  const path = gitBash ?? matches[0]
  if (!path) throw new Error(`Missing ${name} for terminal acceptance`)
  return path
}

export function launch(
  shell: 'pwsh.exe' | 'bash.exe', cwd: string, vars: Record<string, string>, args = '', mode: 'foreground' | 'shared' = 'foreground',
) {
  const { spawn } = requirePty('node-pty') as { spawn(path: string, args: string[], options: object): Pty }
  const terminalArgs = (mode === 'foreground' ? '--foreground-host ' : '') + args
  const command = shell === 'pwsh.exe'
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Set-Location -LiteralPath $env:DS_CLI_CASE_DIR; (Get-Command dsh).Source; dsh ${terminalArgs}`]
    : ['--noprofile', '--norc', '-c', `cd -- "$DS_CLI_CASE_DIR" && command -v dsh && dsh ${terminalArgs}`]
  const env = { ...vars, DS_CLI_CASE_DIR: cwd.replaceAll('\\', '/') }
  const pty = spawn(executable(shell), command, { cols: 162, rows: 40, cwd, env, name: 'xterm-256color' })
  let output = ''
  let closed = false
  pty.onData((data) => { output += data })
  const exited = new Promise<number>((done) => {
    pty.onExit((event) => { closed = true; done(event.exitCode) })
  })
  return {
    output: (since = 0) => stripVTControlCharacters(output.slice(since)),
    mark: () => output.length,
    until: async (text: string, since = 0, timeout = 18_000) => {
      await vi.waitFor(() => {
        expect(stripVTControlCharacters(output.slice(since)).slice(-5_000), `${shell} was waiting for ${text}`).toContain(text)
      }, { timeout, interval: 30 })
    },
    send: (text: string) => { pty.write(text) },
    resize: (columns: number, rows: number) => { pty.resize(columns, rows) },
    hangup: () => { pty.kill() },
    exit: async () => {
      if (!closed) {
        const detached = AbortSignal.timeout(8_000)
        await Promise.race([
          exited,
          new Promise(resolve => detached.addEventListener('abort', resolve, { once: true })),
        ])
      }
      if (!closed) throw new Error(`${shell} did not exit. Terminal output:\n${stripVTControlCharacters(output).slice(-1500)}`)
      return exited
    },
    stop: async () => {
      if (closed) return
      try { execFileSync('taskkill.exe', ['/pid', String(pty.pid), '/t', '/f'], { stdio: 'ignore' }) }
      catch { if (!closed) pty.kill() }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 500))])
    },
  }
}

export async function shellEnvironment(root: string, env: Record<string, string>): Promise<Record<string, string>> {
  const bin = consumer === undefined ? join(root, 'shim') : join(consumer, 'node_modules', '.bin')
  if (consumer === undefined) {
    await mkdir(bin)
    await writeFile(join(bin, 'dsh.ps1'), '& $env:DS_CLI_TEST_NODE $env:DS_CLI_TEST_BIN @args\nexit $LASTEXITCODE\n')
    await writeFile(join(bin, 'dsh'), '#!/usr/bin/env bash\nexec "$DS_CLI_TEST_NODE" "$DS_CLI_TEST_BIN" "$@"\n', { mode: 0o755 })
  }
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].toLowerCase() !== 'path' && entry[1] !== undefined),
  )
  return {
    ...parentEnv, ...env, PATH: bin + delimiter + (process.env.PATH ?? process.env.Path ?? ''),
    DS_CLI_TEST_NODE: process.execPath.replaceAll('\\', '/'),
    DS_CLI_TEST_BIN: terminalBin.replaceAll('\\', '/'),
  }
}
