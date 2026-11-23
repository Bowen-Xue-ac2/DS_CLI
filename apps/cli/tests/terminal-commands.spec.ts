import { expect, it } from 'vitest'
import { resolveTerminalSubmission } from '../src/terminal-commands.ts'

const catalog = {
  skills: [{ name: 'review', description: 'Review a change' }],
  commands: [{ name: 'review', acceptsAttachments: false }],
}

it('routes an explicitly selected skill ahead of a same-name command', () => {
  expect(resolveTerminalSubmission({
    text: '/review updates', sessionId: 'current', skill: { name: 'review', sessionId: 'current' },
  }, catalog)).toEqual({ kind: 'prompt', text: '/review updates' })
  expect(resolveTerminalSubmission({ text: '/review updates', sessionId: 'current' }, catalog))
    .toEqual({ kind: 'host-command', command: catalog.commands[0], text: '/review updates' })
})

it('supports an exact skill alias and preserves other dollar expressions', () => {
  expect(resolveTerminalSubmission({ text: '$review updates', sessionId: 'current' }, catalog))
    .toEqual({ kind: 'prompt', text: '/review updates' })
  for (const text of ['echo $HOME', '$5', '$missing', 'read /tmp/file']) {
    expect(resolveTerminalSubmission({ text, sessionId: 'current' }, catalog)).toEqual({ kind: 'prompt', text })
  }
})

it('requires repicking after a session switch or a removed skill', () => {
  const selected = { text: '/review updates', sessionId: 'current', skill: { name: 'review', sessionId: 'before' } }
  expect(() => resolveTerminalSubmission(selected, catalog)).toThrow('selected Skill')
  expect(() => resolveTerminalSubmission({ ...selected, skill: { name: 'review', sessionId: 'current' } }, {
    ...catalog, skills: [],
  })).toThrow('selected Skill')
})
