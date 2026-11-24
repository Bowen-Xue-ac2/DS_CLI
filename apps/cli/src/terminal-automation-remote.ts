/** Client shapes from the pinned Job, Schedule and Terminal controllers. @module @deepseek-ai/dsh/terminal-automation-remote */
import type { HostResult } from './terminal-host.ts'

interface JobRow {
  readonly id: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly output: { readonly total: number; readonly earliest: number }
}

type JobFrame = { readonly type: 'opened'; readonly job: JobRow; readonly from: number }
  | { readonly type: 'output'; readonly chunks: readonly { readonly text: string }[]; readonly next: number; readonly lossy?: true }
  | { readonly type: 'status'; readonly job: JobRow }

interface ScheduleRow {
  readonly id: string
  readonly title?: string
  readonly status: 'active' | 'paused' | 'ended'
  readonly updatedAt?: string
  readonly target: { readonly kind: string; readonly sessionId?: string }
}

type ScheduleResult = ScheduleRow | { readonly id: string; readonly code: string }

interface ScheduleHistory {
  readonly id: string
  readonly records: readonly {
    readonly deliveredAt: string
    readonly targetSessionId: string
    readonly messageId: string
  }[]
  readonly nextBefore?: string
}

export interface TerminalShellRow {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
}

export type TerminalShellInput = { readonly type: 'write'; readonly sequence: number; readonly data: string; readonly typed: true }
  | { readonly type: 'resize'; readonly sequence: number; readonly cols: number; readonly rows: number }

type TerminalShellFrame = { readonly type: 'snapshot'; readonly screen: string; readonly writable: boolean; readonly info: TerminalShellRow }
  | { readonly type: 'output'; readonly data: string }
  | { readonly type: 'state'; readonly writable: boolean; readonly info: TerminalShellRow }
  | { readonly type: 'ack'; readonly sequence: number; readonly refusal?: 'read-only' | 'not-running' }

export interface TerminalAutomationRemote {
  readonly job: {
    list(request: { sessionId: string }, signal: AbortSignal): AsyncIterable<{ readonly type: 'rows'; readonly jobs: readonly JobRow[] }>
    follow(request: { sessionId: string; jobId: string; from?: number }, signal: AbortSignal): AsyncIterable<JobFrame>
    kill(request: { sessionId: string; jobId: string }): Promise<HostResult<{ readonly outcome: 'requested' | 'already-finished' }>>
  }
  readonly schedule: {
    catalog(): Promise<HostResult<readonly ScheduleRow[]>>
    create(request: {
      title: string
      prompt: string
      timing: { kind: 'after'; after_seconds: number } | { kind: 'every'; every_seconds: number }
      target: { kind: 'session'; sessionId: string }
    }, signal: AbortSignal): Promise<HostResult<ScheduleRow>>
    run(request: { id: string }, signal: AbortSignal): Promise<HostResult<ScheduleResult>>
    edit(request: {
      id: string
      action: 'update'
      patch: { active: boolean }
      expectedUpdatedAt: string | null
    }, signal: AbortSignal): Promise<HostResult<ScheduleResult>>
    history(request: { id: string; limit: number; before?: string }): Promise<HostResult<ScheduleHistory | { readonly code: string }>>
  }
  readonly terminal: {
    list(sessionId: string): Promise<HostResult<readonly TerminalShellRow[]>>
    shells(sessionId: string, signal: AbortSignal): Promise<HostResult<readonly { readonly path: string; readonly name: string }[]>>
    create(sessionId: string, request: { id: string; cols: number; rows: number; shellPath?: string }, signal: AbortSignal):
    Promise<HostResult<TerminalShellRow>>
    close(sessionId: string, id: string): Promise<HostResult<void>>
    attach(sessionId: string, id: string, signal: AbortSignal): AsyncIterable<TerminalShellFrame> & {
      send(input: TerminalShellInput): void
    }
  }
}
