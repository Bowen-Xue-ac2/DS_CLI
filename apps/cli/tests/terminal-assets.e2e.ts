import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII='

it.runIf(process.platform === 'win32')('uses official uploads, export and turn changes in a workspace with spaces and Chinese paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-assets-'))
  const cwd = join(root, '项目 workspace')
  await mkdir(cwd)
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE')
  await writeFile(join(cwd, 'notes 说明.txt'), 'ATTACHMENT_TEXT_SENTINEL\n')
  await writeFile(join(cwd, 'tiny 图片.png'), Buffer.from(PNG, 'base64'))
  await writeFile(join(cwd, 'changed.txt'), 'before\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  git('add', 'changed.txt')
  const indexBefore = await readFile(join(cwd, '.git', 'index'))
  await writeFile(join(cwd, 'changed.txt'), 'before\nUSER_UNCOMMITTED\n')

  const key = 'assets-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'],
    toolCalls: { 1: { name: 'pwsh', arguments: JSON.stringify({
      command: 'Add-Content -LiteralPath changed.txt -Value HOST_DIFF_SENTINEL',
      description: 'Modify the tracked fixture', sandbox_permissions: 'workspace-write', justification: 'Fixture check',
    }) } },
    successText: 'ASSET_FLOW_DONE',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key, true))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    const sessionId = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(sessionId).toBeDefined()
    pty.send('/files view notes 说明.txt\r')
    await pty.until('ATTACHMENT_TEXT_SENTINEL')
    let mark = pty.mark()
    pty.send('/attach ../outside.txt\r')
    await pty.until('Path is outside this session workspace', mark)
    await pty.until('❯ /attach ../outside.txt', mark)
    mark = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', mark)
    pty.send('/attach notes 说明.txt\r')
    await pty.until('Attached notes 说明.txt')
    pty.send('/attach tiny 图片.png\r')
    await pty.until('Attached tiny 图片.png')
    expect(model.requests).toHaveLength(0)
    mark = pty.mark()
    pty.send('/new\r')
    await pty.until('No messages yet', mark)
    pty.send('/attach\r')
    await pty.until('Usage: /attach <workspace path>', mark)
    mark = pty.mark()
    pty.send(`/resume ${sessionId}\r`)
    await pty.until(sessionId!, mark)
    pty.send('/attach\r')
    await pty.until('tiny 图片.png', mark)
    pty.send('Use both attachments in this fixture.\r')
    await pty.until('Approve tool pwsh?')
    pty.send('\x1b[B')
    await pty.until('● Allow once')
    pty.send('\r')
    await pty.until('ASSET_FLOW_DONE')
    const request = model.requests[0]?.body as { messages: { role: string; content: unknown }[] }
    const supplied = request.messages.find(entry => entry.role === 'user')?.content as { type: string; text?: string }[]
    const attachment = supplied.find(part => part.text?.includes('[File "notes 说明.txt"'))?.text
    const saved = attachment?.match(/saved at ("(?:[^"\\]|\\.)*")/u)?.[1]
    expect(saved).toBeDefined()
    expect(await readFile(JSON.parse(saved!) as string, 'utf8')).toBe('ATTACHMENT_TEXT_SENTINEL\n')
    expect(JSON.stringify(supplied)).toContain('data:image/png;base64,')
    const edited = await readFile(join(cwd, 'changed.txt'), 'utf8')
    expect(edited).toContain('HOST_DIFF_SENTINEL')
    expect(edited).toContain('USER_UNCOMMITTED')
    expect(await readFile(join(cwd, '.git', 'index'))).toEqual(indexBefore)
    await pty.until('Workspace changes · turn 1')
    mark = pty.mark()
    pty.send('/diff\r')
    await pty.until('1. changed.txt +1 -0', mark)
    mark = pty.mark()
    pty.send('/diff 1\r')
    await pty.until('+HOST_DIFF_SENTINEL', mark)
    pty.send('/export transcript.md\r')
    await pty.until('Exported session to')
    expect(await readFile(join(cwd, 'transcript.md'), 'utf8')).toContain('ASSET_FLOW_DONE')
    mark = pty.mark()
    pty.send('/export transcript.zip\r')
    await pty.until('Exported session to', mark)
    const zip = await readFile(join(cwd, 'transcript.zip'))
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 120_000)

it.runIf(process.platform === 'win32')('reports the Host result outside Git and refuses an oversized attachment before upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-no-git-assets-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'too-large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1))
  const key = 'no-git-assets-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], successText: 'PLAIN_WORKSPACE_DONE',
    toolCalls: { 1: { name: 'write', arguments: JSON.stringify({ file_path: 'note.txt', content: 'NO_GIT_WRITE\n' }) } },
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission workspace-write')
    await pty.until('workspace-write on')
    pty.send('/attach too-large.bin\r')
    await pty.until('Attachment exceeds the 2 MiB terminal limit')
    await pty.until('❯ /attach too-large.bin')
    expect(model.requests).toHaveLength(0)
    const clear = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', clear)
    pty.send('Write one file in the plain workspace.\r')
    await pty.until('PLAIN_WORKSPACE_DONE')
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('NO_GIT_WRITE\n')
    pty.send('/diff\r')
    await pty.until('The Host has no workspace change summary for this session')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 90_000)

it.runIf(process.platform === 'win32')('keeps the turn usable when the pinned Host times out a Git snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-slow-git-'))
  const cwd = join(root, 'work')
  const bin = join(root, 'bin')
  await Promise.all([mkdir(cwd), mkdir(bin)])
  const source = join(root, 'SlowGit.cs')
  await writeFile(source, `
using System;
using System.IO;
using System.Threading;
class Git {
  static int Main(string[] args) {
    if (args.Length > 1 && args[0] == "rev-parse" && args[1] == "--show-toplevel") {
      File.WriteAllText("git-invoked.txt", "started");
      Thread.Sleep(25000);
      File.WriteAllText("git-invoked.txt", "finished");
    }
    Console.Error.WriteLine("not a git repository");
    return 128;
  }
}
`)
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', `/out:${join(bin, 'git.exe')}`, source], { windowsHide: true })
  const key = 'slow-git-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], successText: 'SLOW_GIT_TURN_FINISHED',
    toolCalls: { 1: { name: 'write', arguments: JSON.stringify({ file_path: 'note.txt', content: 'TURN_SURVIVED\n' }) } },
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, { ...env, PATH: bin + delimiter + env.PATH }, '--cwd . --mode standard --permission workspace-write')
    await pty.until('workspace-write on')
    pty.send('Write one file while the Git probe stalls.\r')
    await pty.until('SLOW_GIT_TURN_FINISHED')
    expect(await readFile(join(cwd, 'git-invoked.txt'), 'utf8')).toBe('started')
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('TURN_SURVIVED\n')
    pty.send('/diff\r')
    await pty.until('The Host has no workspace change summary for this session')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 95_000)

it.runIf(process.platform === 'win32')('uses optional Forge to open and leave a Host-managed Git worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-worktree-'))
  const cwd = join(root, 'source project')
  await mkdir(cwd)
  const path = join(cwd, 'tracked.txt')
  await writeFile(path, 'ORIGINAL_CHECKOUT\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  git('add', 'tracked.txt')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture baseline')
  const key = 'forge-fixture'
  const model = await startMockLlmServer({
    apiKey: key, sequence: ['tool_call_success', 'success'], successText: 'WORKTREE_FIXTURE_DONE',
    toolCalls: { 1: { name: 'write', arguments: JSON.stringify({ file_path: 'tracked.txt', content: 'WORKTREE_ONLY\n' }) } },
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission workspace-write')
    await pty.until('workspace-write on')
    const bundle = '@deepseek-ai/dsh-experimental-forge-bundle'
    pty.send(`/plugins enable ${bundle}\r`)
    await pty.until(`Enable ${bundle}?`)
    pty.send('\x1b[B')
    await pty.until('● Enable')
    pty.send('\r')
    await pty.until(`${bundle} · enable applied`)
    pty.send('/worktree create\r')
    await pty.until('Confirm worktree action: create')
    pty.send('\x1b[B')
    await pty.until('● Confirm')
    pty.send('\r')
    await pty.until('Host recorded the worktree request')
    expect(model.requests).toHaveLength(0)
    pty.send('Write within the Host worktree.\r')
    await pty.until('WORKTREE_FIXTURE_DONE', 0, 35_000)
    let mark = pty.mark()
    pty.send('/worktree\r')
    await pty.until('Worktree: ', mark)
    const worktree = pty.output(mark).match(/Worktree: ([^\r\n]+)/u)?.[1]?.trim()
    expect(worktree).toBeDefined()
    expect(worktree).not.toBe(cwd)
    expect(await readFile(join(worktree!, 'tracked.txt'), 'utf8')).toBe('WORKTREE_ONLY\n')
    expect(await readFile(path, 'utf8')).toBe('ORIGINAL_CHECKOUT\n')
    mark = pty.mark()
    pty.send('/worktree diff uncommitted\r')
    await pty.until('Git scope: uncommitted', mark)
    await pty.until('tracked.txt', mark)
    mark = pty.mark()
    pty.send('/worktree project\r')
    await pty.until('Confirm worktree action: project', mark)
    pty.send('\x1b[B')
    await pty.until('● Confirm', mark)
    pty.send('\r')
    await pty.until('Host switched the working directory to the project', mark)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 120_000)
