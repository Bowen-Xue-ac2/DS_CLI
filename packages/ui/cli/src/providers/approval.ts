/**
 * Approval notices for compatibility profiles. The Host terminal owns the
 * interactive approval menu. Other profiles delegate to their own answerers.
 * @module @deepseek-ai/dsh-cli-ui/providers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'

/** The view surface the answerer needs; structural so the renderer stays free of the driver. */
interface NoticeView {
  notice(text: string): void
}

/**
 * Install the approval answerer for the given view store.
 * @param ctx - Cordis context carrying the approval service.
 * @param view - the REPL view store that surfaces the ask.
 * @returns a disposer removing the listener.
 */
export function installCliApproval(ctx: Context, view: NoticeView): () => void {
  return ctx.on('approval/request', (request: ApprovalRequest, next) => {
    view.notice(
      `[approval] ${request.toolName}${request.reason !== undefined ? `: ${request.reason}` : ''} — approval required`,
    )
    return next() as Promise<ApprovalOutcome>
  })
}
