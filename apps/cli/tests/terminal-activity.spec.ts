import { expect, it } from 'vitest'
import { projectTerminalActivity } from '../src/terminal-activity.ts'

it('joins out-of-order call and result frames once and uses the committed timing', () => {
  const start = { seq: 4, time: 100, type: 'tool/call', data: {
    callId: 'shared', name: 'read', turn: 1, step: 1, arguments: '{"path":"source.txt","description":"Read the fixture"}',
  } }
  const finish = { seq: 5, time: 138, type: 'tool/result', data: {
    turn: 1, step: 1, message: { toolCallId: 'shared', content: [{ type: 'text', text: 'FILE_RESULT' }] },
  } }
  const [item, ...duplicates] = projectTerminalActivity([finish, start, finish, start])
  expect(duplicates).toEqual([])
  expect(item).toMatchObject({ callId: 'shared', name: 'read', state: 'succeeded', durationMs: 38, output: 'FILE_RESULT',
    summary: 'Read the fixture' })
})

it('keeps repeated provider call IDs in separate steps and records cancellation and denial', () => {
  const start = (seq: number, step: number) => ({ seq, time: 100, type: 'tool/call', data: {
    callId: 'same-provider-id', name: 'pwsh', turn: 1, step, arguments: '{"token":"fixture-secret"}',
  } })
  const result = (seq: number, step: number, code: string) => ({ seq, time: 155, type: 'tool/result', data: {
    turn: 1, step, message: { toolCallId: 'same-provider-id', isError: true, content: [] }, error: { code },
  } })
  const rows = projectTerminalActivity([result(4, 2, 'TOOL_DENIED'), start(1, 1), start(3, 2), result(2, 1, 'ABORTED')])
  expect(rows.map(row => row.state)).toEqual(['cancelled', 'failed'])
  expect(rows[1]?.diagnostic).toBe('TOOL_DENIED')
  expect(rows[0]?.arguments).toContain('[redacted]')
  expect(JSON.stringify(rows).includes('fixture-secret')).toBe(false)
})
