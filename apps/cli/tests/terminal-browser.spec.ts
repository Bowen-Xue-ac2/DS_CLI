import { expect, it } from 'vitest'
import { TerminalBrowserGrants } from '../src/terminal-browser.ts'

it('binds a grant to one Session, expires it, and consumes a valid redemption once', () => {
  const grants = new TerminalBrowserGrants()
  const first = 'session-12345678-1111-2222-3333-123456789abc'
  const other = 'session-12345678-1111-2222-3333-123456789abd'
  const token = grants.issue(first, 1_000)
  expect(grants.consume(token, other, 1_001)).toBe(false)
  expect(grants.consume(token, first, 1_002)).toBe(true)
  expect(grants.consume(token, first, 1_003)).toBe(false)
  const expired = grants.issue(first, 2_000)
  expect(grants.consume(expired, first, 47_000)).toBe(false)
})
