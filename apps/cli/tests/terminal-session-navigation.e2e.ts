import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'

const hostEntry = new URL('../lib/terminal-host.js', import.meta.url).href
const sessionEntry = new URL('../lib/terminal-sessions.js', import.meta.url).href

it('lists and reopens named sessions from the correct workspace without creating a new session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-cli-navigation-'))
  const a = join(root, '项目 A')
  const b = join(root, '项目 B')
  await Promise.all([mkdir(a), mkdir(b)])
  const key = 'ds-cli-navigation-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success', 'stall'], repeatLast: true, successText: 'NAVIGATION_RESULT' })
  const env = await terminalFixtureEnv(join(root, 'home'), model.baseURL, key)
  try {
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', `
      const { openTerminalHost, requireHostResult } = await import(${JSON.stringify(hostEntry)})
      const { listTerminalSessions, loadTerminalSession } = await import(${JSON.stringify(sessionEntry)})
      const { setTimeout: delay } = await import('node:timers/promises')
      const signal = AbortSignal.timeout(50_000)
      const host = await openTerminalHost({ cwd: process.cwd(), signal })
      try {
        const a = (await host.registerWorkspace(${JSON.stringify(a)})).workspace
        const b = (await host.registerWorkspace(${JSON.stringify(b)})).workspace
        for (const [workspace, sessionId, title] of [[a, 'session-nav-a', 'Refactor A'], [b, 'session-nav-b', 'Release B']]) {
          requireHostResult(await host.remote.session.create({ workspaceId: workspace.workspaceId, sessionId }))
          requireHostResult(await host.remote.session.rename({ sessionId, title }))
        }
        const before = await listTerminalSessions(host, { scope: a.workspaceId }, signal)
        const search = await listTerminalSessions(host, { scope: a.workspaceId, query: 'release' }, signal)
        const reopened = await loadTerminalSession(host, search[0].address.sessionId, signal)
        const count = requireHostResult(await host.remote.session.list({}, signal)).items.length
        const address = { kind: 'session', sessionId: reopened.sessionId }
        const stream = host.remote.session.follow({ address, activate: true }, signal)[Symbol.asyncIterator]()
        await stream.next()
        const send = (requestId, text) => host.remote.session.prompt({
          sessionId: reopened.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }],
        }, signal)
        requireHostResult(await send('nav-first', 'NAVIGATION_FIRST_MESSAGE'))
        let finishedSeq
        while (finishedSeq === undefined) {
          const next = await stream.next()
          if (next.done) throw new Error('Session stream ended before turn completion')
          if (next.value.type === 'event' && next.value.event.type === 'turn/end') finishedSeq = next.value.event.seq
        }
        await stream.return()
        const page = requireHostResult(await host.remote.session.page({ address, beforeSeq: finishedSeq }, signal))
        const fork = requireHostResult(await host.remote.session.fork({ sessionId: reopened.sessionId, allowMigration: false }))
        const branch = await loadTerminalSession(host, fork.sessionId, signal)
        requireHostResult(await send('nav-second', 'KEEP_THIS_TURN_RUNNING'))
        for (;;) {
          signal.throwIfAborted()
          const { items } = requireHostResult(await host.remote.session.list({}, signal))
          if (items.some(item => item.sessionId === reopened.sessionId && item.running)) break
          await delay(30, undefined, { signal })
        }
        const denied = await host.remote.workspace.archiveSession({ sessionId: reopened.sessionId })
        requireHostResult(await host.remote.workspace.archiveSession({ sessionId: reopened.sessionId, stopActivity: true }))
        const archive = await listTerminalSessions(host, { archived: true }, signal)
        requireHostResult(await host.remote.workspace.unarchiveSession({ sessionId: reopened.sessionId }))
        requireHostResult(await host.remote.workspace.pinSession({ sessionId: reopened.sessionId }))
        const pinned = await listTerminalSessions(host, {}, signal)
        console.log(JSON.stringify({ before, search, reopened, count, branch, page, denied, archive, pinned }))
      } finally {
        await host.dispose()
      }
    `], { cwd: a, env, timeout: 55_000 })
    const { before, search, reopened, count, branch, page, denied, archive, pinned } = JSON.parse(stdout)
    expect(before).toEqual([expect.objectContaining({ address: { kind: 'session', sessionId: 'session-nav-a' }, title: 'Refactor A' })])
    expect(search).toEqual([expect.objectContaining({ address: { kind: 'session', sessionId: 'session-nav-b' }, title: 'Release B' })])
    expect(reopened).toMatchObject({ sessionId: 'session-nav-b', workspace: { path: b }, cwd: b })
    expect(count).toBe(2)
    expect(branch.workspace.path).toBe(b)
    expect(branch.sessionId).not.toBe(reopened.sessionId)
    expect(page.records.some((record: { event: { type: string } }) => record.event.type === 'user/message')).toBe(true)
    expect(denied).toMatchObject({ ok: false, error: { code: 'workspace/session-active' } })
    expect(archive).toEqual([expect.objectContaining({ address: { kind: 'session', sessionId: reopened.sessionId } })])
    expect(pinned[0]).toMatchObject({ address: { kind: 'session', sessionId: reopened.sessionId } })
  } finally {
    await model.close()
    await rm(root, { recursive: true, force: true })
  }
})
