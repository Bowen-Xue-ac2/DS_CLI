/** Files, attachment receipts and review routes on the terminal's current Host. @module @deepseek-ai/dsh/terminal-assets */
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { stripVTControlCharacters } from 'node:util'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type HostResult, type TerminalHost, type TerminalPromptPart, type TerminalSessionEvent } from './terminal-host.ts'
import type { TerminalActiveSession } from './terminal-start.ts'

const MAX_ATTACHMENT = 2 * 1024 * 1024
const MAX_ATTACHMENTS = 8
const IMAGE_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'],
])

interface AttachmentReceipt {
  readonly name: string
  readonly part: Extract<TerminalPromptPart, { type: 'file' }>
}

/** Pending receipts stay with the Session that uploaded them until its prompt is acknowledged. */
export class TerminalAssets {
  private readonly receipts = new Map<string, readonly AttachmentReceipt[]>()
  private readonly changes = new Map<string, number>()

  constructor(private readonly host: TerminalHost) {}

  pending(sessionId: string): readonly AttachmentReceipt[] {
    return this.receipts.get(sessionId) ?? []
  }

  clear(sessionId: string): void {
    this.receipts.delete(sessionId)
  }

  observe(sessionId: string, event: TerminalSessionEvent): void {
    if (event.type === 'workspace/changes' && event.seq > (this.changes.get(sessionId) ?? -1)) {
      this.changes.set(sessionId, event.seq)
    }
  }

  async attach(session: TerminalActiveSession, input: string, signal: AbortSignal, notice: (value: string) => void): Promise<string> {
    if (input === 'clear') {
      this.clear(session.sessionId)
      return 'Pending attachments cleared'
    }
    const pending = this.pending(session.sessionId)
    if (pending.length >= MAX_ATTACHMENTS) throw new Error('This draft already has eight pending attachments')
    const path = assetPath(session, input)
    const name = basename(path)
    const { data, bytes, eof } = requireHostResult(await this.host.remote.workspaceFiles.readBytes(
      session.sessionId, path, { range: { length: MAX_ATTACHMENT } }, signal,
    ))
    if (!eof || bytes > MAX_ATTACHMENT) throw new Error('Attachment exceeds the 2 MiB terminal limit')
    signal.throwIfAborted()
    notice(`Uploading ${name} (${bytes} bytes)…`)
    const mediaType = IMAGE_TYPES.get(name.split('.').at(-1)?.toLowerCase() ?? '')
    const query = new URLSearchParams({ sessionId: session.sessionId, name })
    if (mediaType !== undefined) query.set('mediaType', mediaType)
    const response = await this.host.requestResource(`/api/session/uploadFileBinary?${query}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([Uint8Array.from(data)]), signal,
    })
    if (!response.ok) throw new Error(`Host upload failed (HTTP ${response.status}); use /attach to retry`)
    const receipt = requireHostResult(await response.json() as HostResult<{ receiptId: string }>)
    if (typeof receipt.receiptId !== 'string' || receipt.receiptId === '') throw new Error('Host did not issue an attachment receipt')
    this.receipts.set(session.sessionId, [...pending, { name, part: { type: 'file', receiptId: receipt.receiptId } }])
    return `Attached ${name} to this session's next message`
  }

  async files(session: TerminalActiveSession, io: InteractiveIo, argument: string, signal: AbortSignal):
  Promise<{ notice: string } | { path: string; kind: 'file' | 'directory' } | undefined> {
    const request = /^(list|search|view)(?:\s+(.*))?$/u.exec(argument)
    const mode = request?.[1] ?? (argument === '' ? 'list' : 'search')
    const input = request?.[2] ?? (request === null ? argument : '')
    const { workspaceFiles } = this.host.remote
    if (mode === 'view') {
      const path = assetPath(session, input)
      const page = requireHostResult(await workspaceFiles.read(session.sessionId, path, { offset: 1, limit: 100 }, signal))
      return { notice: `${input}\n${bounded(page.text)}${page.eof ? '' : '\nShowing the first 100 lines.'}` }
    }
    let directory = assetPath(session, mode === 'list' ? input : '')
    for (;;) {
      const result = mode === 'search'
        ? requireHostResult(await workspaceFiles.search(session.sessionId, {
          query: input, excludedPaths: [], includeHidden: false, respectGitignore: true,
        }, signal))
        : requireHostResult(await workspaceFiles.list(session.sessionId, directory, signal))
      const rows = 'matches' in result ? result.matches.map(entry => ({
        path: resolve(session.workspace.path, entry.path), name: entry.path, type: entry.type,
      })) : result.entries.map(entry => ({
        path: resolve(directory, entry.name), name: entry.name, type: entry.type,
      }))
      const visible = rows.filter(row => row.type !== 'other').slice(0, 100)
      if (visible.length === 0) return { notice: 'No workspace files found' }
      const choice = await io.choose({
        title: result.truncated || rows.length > visible.length ? 'Workspace files (first results)' : 'Workspace files',
        fields: [{ label: mode === 'search' ? input : directory, initial: '', options: [
          { id: '', label: 'Back to chat' },
          ...visible.map(row => ({ id: row.path, label: row.name + (row.type === 'directory' ? '/' : '') })),
        ] }],
      }, signal)
      const selected = choice.kind === 'chosen' && visible.find(row => row.path === choice.values[0])
      if (!selected) return
      if (selected.type === 'file' || (mode === 'search' && selected.type === 'directory')) {
        return { path: selected.path, kind: selected.type }
      }
      directory = selected.path
    }
  }

  async diff(sessionId: string, argument: string): Promise<string> {
    const seq = this.changes.get(sessionId)
    if (seq === undefined) return 'The Host has no workspace change summary for this session'
    const [file, page] = argument ? argument.split(/\s+/u).map(Number) : []
    const query = new URLSearchParams({ sessionId, seq: String(seq) })
    if (file === undefined) {
      const summary = await this.json('/api/changes.summary', query) as {
        turn: number
        total: number
        added: number
        deleted: number
        files: readonly { display: string; added: number; deleted: number; binary?: boolean; oversized?: boolean }[]
      }
      if (!Array.isArray(summary.files)) throw new Error('Host returned an invalid workspace change summary')
      const rows = summary.files.map((entry, index) =>
        `${index + 1}. ${entry.display} +${entry.added} -${entry.deleted}${entry.binary ? ' (binary)' : entry.oversized ? ' (oversized)' : ''}`)
      return bounded([`Turn ${summary.turn}: ${summary.total} changed files +${summary.added} -${summary.deleted}`, ...rows].join('\n'))
    }
    if (!Number.isSafeInteger(file) || file < 1 || (page !== undefined && (!Number.isSafeInteger(page) || page < 1))) {
      throw new Error('Usage: /diff [file-number [page]]')
    }
    query.set('index', String(file - 1))
    const result = await this.json('/api/changes.diff', query) as {
      kind: string
      display: string
      coarse?: boolean
      hunks?: readonly { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: readonly string[] }[]
    }
    if (result.kind !== 'text' || !Array.isArray(result.hunks)) return bounded(`${result.display}: ${result.kind}`)
    const lines = result.hunks.flatMap(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines])
    const start = ((page ?? 1) - 1) * 80
    return bounded([`${result.display}${result.coarse ? ' (coarse comparison)' : ''} · page ${page ?? 1}/${Math.max(1, Math.ceil(lines.length / 80))}`,
      ...lines.slice(start, start + 80)].join('\n'))
  }

  async export(session: TerminalActiveSession, argument: string): Promise<string> {
    if (!argument) throw new Error('Usage: /export <output.md|output.zip>')
    const path = resolve(session.cwd, expandHomePath(argument))
    const extension = path.split('.').at(-1)?.toLowerCase()
    if (extension !== 'md' && extension !== 'zip') throw new Error('Choose an output path ending in .md or .zip')
    const query = new URLSearchParams({ sessionId: session.sessionId })
    const route = extension === 'md' ? '/api/session.markdown' : '/api/session.export'
    const response = await this.host.requestResource(`${route}?${query}`)
    if (!response.ok || response.body === null) throw new Error(`Host export failed (HTTP ${response.status})`)
    await pipeline(response.body, createWriteStream(path, { flags: 'wx' }), { signal: this.host.signal })
    return `Exported session to ${path}`
  }

  private async json(path: string, query: URLSearchParams): Promise<unknown> {
    const response = await this.host.requestResource(`${path}?${query}`)
    if (!response.ok) throw new Error(`Host workspace review unavailable (HTTP ${response.status})`)
    return response.json()
  }
}

function assetPath(session: TerminalActiveSession, input: string): string {
  const path = resolve(session.cwd, expandHomePath(input))
  const scoped = relative(session.workspace.path, path)
  if (isAbsolute(scoped) || scoped === '..' || scoped.startsWith('..' + sep)) {
    throw new Error('Path is outside this session workspace')
  }
  return path
}

function bounded(value: string): string {
  const clean = stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '')
  return clean.length <= 8_000 ? clean : clean.slice(0, 8_000) + '\n… Output truncated'
}
