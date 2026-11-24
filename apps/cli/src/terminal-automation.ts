/** Local views over official background jobs, schedules and durable user shells. @module @deepseek-ai/dsh/terminal-automation */
import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import type { InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type TerminalHost } from './terminal-host.ts'
import { streamTerminalShell } from './terminal-shell.ts'

/** Watches are disposable views. Host jobs and shells have their own lifetimes. */
export class TerminalAutomation {
  private watching?: AbortController
  private readonly offsets = new Map<string, number>()

  constructor(private readonly host: TerminalHost, private readonly io: InteractiveIo, private readonly notice: (text: string) => void) {}

  detach(): void {
    this.watching?.abort()
  }

  async jobs(sessionId: string, input: string): Promise<string> {
    const [action, second, third] = input.split(/\s+/u)
    if (action === 'detach') {
      this.detach()
      return 'Detached from Job output'
    }
    const { job } = this.host.remote
    const snapshotLife = new AbortController()
    const snapshot = job.list({ sessionId }, AbortSignal.any([this.host.signal, snapshotLife.signal]))[Symbol.asyncIterator]()
    const rows = await snapshot.next().finally(() => {
      snapshotLife.abort()
      void snapshot.return?.().catch(() => {})
    })
    const visible = rows.done === true ? [] : rows.value.jobs
    if (!action) return visible.map(row => [row.id, row.status, row.label, row.progress ?? row.detail, `offset ${row.output.total}`]
      .filter(Boolean).join(' · ')).join('\n') || 'No jobs visible in this session'
    const id = action === 'stop' || action === 'follow' ? second : action
    const row = visible.find(item => item.id === id)
    if (row === undefined) throw new Error('Job is unavailable in this session')
    if (action === 'stop') {
      if (!await confirm(this.io, `Stop Job ${row.id} · ${row.label}?`, this.host.signal)) return 'Job stop cancelled'
      const result = requireHostResult(await job.kill({ sessionId, jobId: row.id }))
      return `${row.id} · stop ${result.outcome}`
    }
    const offsetArg = action === 'follow' ? third : second
    const key = JSON.stringify([sessionId, row.id])
    const start = offsetArg === undefined ? this.offsets.get(key) : Number(offsetArg)
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0 || start > row.output.total)) {
      throw new Error(`Choose a byte offset between 0 and ${row.output.total}`)
    }
    this.detach()
    const watch = new AbortController()
    this.watching = watch
    const signal = AbortSignal.any([this.host.signal, watch.signal])
    const request = { sessionId, jobId: row.id, ...(start === undefined ? {} : { from: start }) }
    void (async () => {
      for await (const frame of job.follow(request, signal)) {
        if (signal.aborted) break
        if (frame.type === 'opened') {
          this.notice(`${row.id} · ${frame.job.status} · reading from byte ${frame.from}`)
          if (action !== 'follow' && frame.from >= row.output.total) break
        } else if (frame.type === 'output') {
          this.offsets.set(key, frame.next)
          const output = stripVTControlCharacters(frame.chunks.map(chunk => chunk.text).join('')).slice(-8_000)
          this.notice(`${row.id} → byte ${frame.next}${frame.lossy ? ' · older output evicted' : ''}\n${output}`)
          if (action !== 'follow' && frame.next >= row.output.total) break
        } else {
          this.notice(`${row.id} · ${frame.job.status}${frame.job.detail ? ` · ${frame.job.detail}` : ''}`)
        }
      }
    })().catch((error: unknown) => { if (!signal.aborted) this.notice(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (this.watching === watch) delete this.watching })
    return `${row.id} · ${row.status}${row.detail ? ` · ${row.detail}` : ''}`
  }

  async schedule(sessionId: string, input: string): Promise<string> {
    const { schedule } = this.host.remote
    const signal = this.host.signal
    const [action, id, before] = input.split(/\s+/u)
    if (action === 'create') {
      if (id !== undefined && id !== 'after' && id !== 'every') throw new Error('Usage: /schedule create [after|every [seconds]]')
      const selected = await this.io.choose({
        title: id === 'every' ? 'Schedule a recurring message in this session' : 'Schedule a message in this session',
        fields: [
          { label: 'Title', initial: '', text: true },
          { label: id === 'every' ? 'Interval in seconds' : 'Seconds from now', initial: before ?? '60', text: true },
          { label: 'Message', initial: '', text: true },
        ],
      }, signal)
      if (selected.kind !== 'chosen') return 'Schedule creation cancelled'
      const [title = '', seconds, prompt = ''] = selected.values
      const after = Number(seconds)
      if (!title.trim() || !prompt.trim() || !Number.isSafeInteger(after) || after < 1) {
        throw new Error('Enter a title, a message and a positive whole number of seconds')
      }
      const row = requireHostResult(await schedule.create({
        title, prompt, timing: id === 'every' ? { kind: 'every', every_seconds: after } : { kind: 'after', after_seconds: after },
        target: { kind: 'session', sessionId },
      }, signal))
      return `Schedule ${row.id} · ${row.status}`
    }
    const catalog = requireHostResult(await schedule.catalog())
    if (!action) return catalog.map(row => `${row.id} · ${row.status} · ${row.title ?? ''} · ${row.target.sessionId ?? row.target.kind}`)
      .join('\n') || 'No scheduled tasks'
    if (action !== 'pause' && action !== 'resume' && action !== 'run' && action !== 'history') {
      throw new Error('Usage: /schedule [create|pause <id>|resume <id>|run <id>|history <id> [cursor]]')
    }
    const row = catalog.find(entry => entry.id === id)
    if (row === undefined) throw new Error('Scheduled task was not found')
    if (action === 'history') {
      const page = requireHostResult(await schedule.history({ id: row.id, limit: 20, ...(before === undefined ? {} : { before }) }))
      if ('code' in page) throw new Error(page.code)
      const rows = page.records.map(record => `${record.deliveredAt} · ${record.targetSessionId} · ${record.messageId}`)
      if (page.nextBefore !== undefined) rows.push(`Next: /schedule history ${row.id} ${page.nextBefore}`)
      return rows.join('\n') || 'No recorded deliveries'
    }
    if (!await confirm(this.io, `${action} schedule ${row.id} · ${row.title ?? ''}?`, signal)) return 'Schedule change cancelled'
    const result = requireHostResult(action === 'run'
      ? await schedule.run({ id: row.id }, signal)
      : await schedule.edit({ id: row.id, action: 'update', patch: { active: action === 'resume' },
        expectedUpdatedAt: row.updatedAt ?? null }, signal))
    if ('code' in result) throw new Error(result.code)
    return `Schedule ${result.id} · ${result.status}`
  }

  async terminal(sessionId: string, input: string): Promise<string> {
    const { terminal } = this.host.remote
    const signal = this.host.signal
    const [, action = '', selectedId] = /^(\S+)(?:\s+(.*))?$/u.exec(input) ?? []
    const existing = requireHostResult(await terminal.list(sessionId))
    if (action === 'list') return existing.map(row => `${row.id} · ${row.state} · ${row.cwd}`).join('\n') || 'No retained terminals'
    if (action === 'close') {
      const row = existing.find(entry => entry.id === selectedId)
      if (row === undefined) throw new Error('Terminal is unavailable in this session')
      if (!await confirm(this.io, `Close shell ${row.title} · ${row.id}?`, signal)) return 'Shell close cancelled'
      requireHostResult(await terminal.close(sessionId, row.id))
      return `Closed shell ${row.id}`
    }
    let id = action === 'new' ? undefined : action || undefined
    if (!action) {
      const answer = await this.io.choose({
        title: 'Persistent shell',
        fields: [{ label: 'Terminal', initial: 'new', options: [
          { id: 'new', label: 'New shell' },
          ...existing.map(row => ({ id: row.id, label: row.title, detail: `${row.state} · ${row.cwd}` })),
        ] }],
      }, signal)
      if (answer.kind !== 'chosen') return 'Shell selection cancelled'
      if (answer.values[0] !== 'new') id = answer.values[0]
    }
    if (id === undefined) {
      const shells = requireHostResult(await terminal.shells(sessionId, signal))
      let shellPath: string | undefined
      if (selectedId === undefined) {
        const answer = await this.io.choose({
          title: 'Open a user shell',
          fields: [{ label: 'Shell', initial: '', options: [
            { id: '', label: 'System default' },
            ...shells.map(shell => ({ id: shell.path, label: shell.name, detail: shell.path })),
          ] }],
        }, signal)
        if (answer.kind !== 'chosen') return 'Shell creation cancelled'
        shellPath = answer.values[0]
      } else {
        const selected = shells.find(shell => shell.name === selectedId || shell.path === selectedId)
        if (selected === undefined) throw new Error('Shell is unavailable in this execution environment')
        shellPath = selected.path
      }
      id = requireHostResult(await terminal.create(sessionId, {
        id: randomUUID(), cols: process.stdout.columns || 80, rows: process.stdout.rows || 24,
        ...(shellPath ? { shellPath } : {}),
      }, signal)).id
    } else if (!existing.some(row => row.id === id)) {
      throw new Error('Terminal is unavailable in this session')
    }
    const terminalId = id
    await this.io.withTerminal(() => streamTerminalShell(this.host, sessionId, terminalId))
    return `Detached from shell ${terminalId}`
  }
}

async function confirm(io: InteractiveIo, title: string, signal: AbortSignal): Promise<boolean> {
  const answer = await io.choose({ title, fields: [{ label: 'Confirm', initial: 'cancel', options: [
    { id: 'cancel', label: 'Cancel' }, { id: 'yes', label: 'Confirm' },
  ] }] }, signal)
  return answer.kind === 'chosen' && answer.values[0] === 'yes'
}
