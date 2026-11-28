/** Persist unsent composer text per Host profile and Session. @module @deepseek-ai/dsh/terminal-drafts */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

interface StoredDraft {
  text: string
  revision: string
}

async function readDraft(path: string): Promise<StoredDraft | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string'
    || !('revision' in parsed) || typeof parsed.revision !== 'string') {
    throw new Error('Invalid saved terminal draft')
  }
  return { text: parsed.text, revision: parsed.revision }
}

/** The terminal's draft writer. Clearing a draft is conditional on its last observed revision. */
export class TerminalDrafts {
  private readonly revisions = new Map<string, StoredDraft>()
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly directory: string, private readonly report: (error: unknown) => void) {}

  private path(sessionId: string): string {
    return join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  }

  /** @param sessionId - attached Session. @returns unsent text, if saved. */
  async load(sessionId: string): Promise<string | undefined> {
    try {
      await this.writes.get(sessionId)
      const draft = await readDraft(this.path(sessionId))
      if (draft === undefined) this.revisions.delete(sessionId)
      else this.revisions.set(sessionId, draft)
      return draft?.text
    } catch (error) {
      this.report(error)
      return undefined
    }
  }

  /** @param sessionId - Session displayed by the composer. @param text - the new unsent text. */
  save(sessionId: string, text: string): void {
    if (!sessionId) return
    const path = this.path(sessionId)
    const next = (this.writes.get(sessionId) ?? Promise.resolve()).then(async () => {
      const previous = this.revisions.get(sessionId)
      if (text === (previous?.text ?? '')) return
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await withFileLock(path, async () => {
        if (text) {
          const draft = { text, revision: randomUUID() }
          await writeFileAtomic(path, JSON.stringify(draft), { mode: 0o600 })
          this.revisions.set(sessionId, draft)
        } else {
          if ((await readDraft(path))?.revision === previous?.revision) await rm(path, { force: true })
          this.revisions.delete(sessionId)
        }
      })
    }).catch((error) => { this.report(error) })
    this.writes.set(sessionId, next)
    void next.then(() => {
      if (this.writes.get(sessionId) === next) this.writes.delete(sessionId)
    })
  }

  /** Wait for writes already staged by the composer. */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values())
  }
}
