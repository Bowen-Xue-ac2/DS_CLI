/** Keyboard handlers for native model selection and structured questions. @module @deepseek-ai/dsh/terminal-interactions */
import type { CliMenuOption, InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import {
  requireHostResult, type TerminalHost, type TerminalQuestion, type TerminalQuestionAnswer,
} from './terminal-host.ts'

/** Select a model and reasoning effort offered by the Host.
 * @param host - authenticated Host.
 * @param io - terminal chooser.
 * @param sessionId - current session receiving the selection.
 * @param args - optional provider/model and reasoning-effort ID.
 * @returns the Host's effective selection or a cancellation receipt.
 */
export async function chooseTerminalModel(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, sessionId: string, args?: string,
): Promise<string> {
  const { remote, signal } = host
  const catalog = requireHostResult(await remote.session.modelCatalog())
  const candidates = catalog.groups.flatMap(provider => provider.models.map(model => ({
    id: `${provider.id}/${model.id}`, label: model.name, detail: provider.name,
    provider: provider.id, model,
  })))
  if (candidates.length === 0) return 'The Host has no models available.'
  const [requestedRoute, requestedEffort, extra] = args?.trim().split(/\s+/u) ?? []
  let route = requestedRoute
  let effort = requestedEffort
  if (extra !== undefined) return 'Usage: /model [provider/model [reasoning-effort]]'
  if (route === undefined) {
    const reply = await io.choose({
      title: 'Choose model',
      fields: [{ label: 'Model', initial: `${catalog.default.provider}/${catalog.default.model}`, options: candidates }],
    }, signal)
    if (reply.kind !== 'chosen') return 'Model selection cancelled'
    route = reply.values[0]
  }
  const matches = candidates.filter(row => row.id === route || row.model.id === route)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) return 'Choose a unique model from /model.'
  const reasoning = selected.model.reasoning
  if (effort === undefined && reasoning !== undefined && reasoning.efforts.length > 0) {
    const reply = await io.choose({
      title: 'Choose reasoning effort',
      fields: [{ label: 'Reasoning', initial: '', options: [
        { id: '', label: reasoning.defaultEffort === undefined ? 'Model default' : `Default · ${reasoning.defaultEffort}` },
        ...reasoning.efforts.map(choice => ({ id: choice.id, label: choice.name,
          ...(choice.description === undefined ? {} : { detail: choice.description }) })),
      ] }],
    }, signal)
    if (reply.kind !== 'chosen') return 'Model selection cancelled'
    effort = reply.values[0] || undefined
  }
  if (effort !== undefined && !reasoning?.efforts.some(choice => choice.id === effort)) return 'That reasoning effort is unavailable.'
  const result = requireHostResult(await remote.session.selectModel({
    sessionId, provider: selected.provider, model: selected.model.id,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  })).selected
  return `Model: ${result.provider}/${result.model}${result.reasoningEffort === undefined ? '' : ' · ' + result.reasoningEffort}`
}

/** Read one answer batch through the active terminal, without sending draft keys into chat.
 * @param io - terminal menu.
 * @param questions - native question IDs, prompts, options and presentation intents.
 * @param signal - native interaction lifetime.
 * @returns the same IDs and selected labels, or undefined when the user cancelled.
 */
export async function answerTerminalQuestions(
  io: Pick<InteractiveIo, 'choose'>, questions: readonly TerminalQuestion[], signal: AbortSignal,
): Promise<TerminalQuestionAnswer | undefined> {
  const answers: TerminalQuestionAnswer['answers'][number][] = []
  for (const question of questions) {
    const options: CliMenuOption[] = (question.options ?? []).map((option, index) => ({
      id: String(index), label: option.label, ...(option.description === undefined ? {} : { detail: option.description }),
    }))
    const heading = { title: question.question, ...(question.detail === undefined ? {} : { detail: question.detail }) }
    const selected = new Set<string>()
    let custom: string | undefined
    for (;;) {
      const fixed = question.intent !== undefined
      const initial = fixed ? options.find(option => option.label === question.intent?.reject
        || (question.intent?.kind === 'plan-review' && option.label !== question.intent.approve))?.id ?? ''
        : question.multiSelect === true ? 'done' : options[0]?.id ?? 'other'
      const choices = options.map(option => ({
        ...option, label: question.multiSelect === true ? `${selected.has(option.label) ? '[x]' : '[ ]'} ${option.label}` : option.label,
      }))
      if (!fixed && options.length > 0) choices.push({ id: 'other', label: 'Other' })
      if (question.multiSelect === true) choices.unshift({ id: 'done', label: 'Done' })
      const answer = await io.choose({
        ...heading, fields: options.length === 0 ? [{ label: 'Answer', initial: '', path: true }]
          : [{ label: 'Answer', initial, options: choices }],
      }, signal)
      if (answer.kind !== 'chosen' || signal.aborted) return undefined
      const value = answer.values[0] ?? ''
      if (options.length === 0) { custom = value; break }
      if (value === 'done') break
      if (value === 'other' && !fixed) {
        const free = await io.choose({ ...heading, fields: [{ label: 'Other', initial: custom ?? '', path: true }] }, signal)
        if (free.kind !== 'chosen' || signal.aborted) return undefined
        custom = free.values[0]
      }
      const option = options.find(item => item.id === value)
      if (option !== undefined) {
        if (selected.has(option.label)) selected.delete(option.label)
        else selected.add(option.label)
      }
      if (question.multiSelect !== true) break
    }
    answers.push({ id: question.id, selected: [...selected], ...(custom === undefined ? {} : { custom }) })
  }
  return { answers }
}

/** Answer a continued question from the current Session's durable projection.
 * @param host - authenticated terminal Host.
 * @param io - chooser for one continued question.
 * @param sessionId - current owning Session.
 * @returns the Host's queue receipt or current availability.
 */
export async function answerContinuedQuestion(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, sessionId: string,
): Promise<string> {
  const { remote, signal } = host
  const state = requireHostResult(await remote.session.projections({ sessionId }, signal))
  const questions = state?.values.userQuestions?.active.filter(row => row.state === 'continued') ?? []
  const first = questions[0]
  if (first === undefined) return 'No continued questions in this session.'
  const choice = await io.choose({
    title: 'Pending questions',
    fields: [{ label: 'Question', initial: first.callId, options: questions.map(row => ({
      id: row.callId, label: row.questions[0]?.question ?? row.callId,
    })) }],
  }, signal)
  const selection = choice.kind === 'chosen' ? questions.find(row => row.callId === choice.values[0]) : undefined
  if (selection === undefined) return 'Question selection cancelled.'
  const answer = await answerTerminalQuestions(io, selection.questions, signal)
  if (answer === undefined || signal.aborted) return 'Question left unanswered.'
  return requireHostResult(await remote.userQuestions.answer(sessionId, selection.callId, answer))
    ? 'Answer queued in this session.' : 'That question has already settled.'
}
