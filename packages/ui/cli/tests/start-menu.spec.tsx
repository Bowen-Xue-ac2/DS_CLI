import * as React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { StartMenu, type CliMenu } from '../src/start-menu.tsx'

const menu: CliMenu = {
  title: 'Choose workspace and Agent',
  fields: [
    { label: 'Workspace', initial: 'here', options: [
      { id: 'here', label: 'Current directory', detail: '项目 A/src' },
      { id: 'past', label: 'Registered project' },
    ] },
    { label: 'Agent', initial: 'standard', options: [
      { id: 'standard', label: 'Standard' },
      { id: 'code', label: 'Code' },
      { id: 'broken', label: 'Unavailable profile', detail: 'Plugin unavailable', disabled: true },
    ] },
  ],
}

describe('terminal chooser', () => {
  it('shows the current directory, the default Agent, and the reason an option is unavailable', () => {
    const rendered = render(<StartMenu menu={menu} onClose={() => {}} />)
    try {
      const frame = rendered.lastFrame()
      expect(frame).toContain('Choose workspace and Agent')
      expect(frame).toContain('项目 A/src')
      expect(frame).toContain('Standard')
      expect(frame).toContain('Plugin unavailable')
      expect(frame).toContain('Enter')
    } finally {
      rendered.unmount()
    }
  })

  it('moves between fields, confirms the collected options once and ignores repeated Enter', async () => {
    const chosen = vi.fn()
    const rendered = render(<StartMenu menu={menu} onClose={chosen} />)
    try {
      await vi.waitFor(() => { expect(rendered.stdin.listenerCount('readable')).toBeGreaterThan(0) })
      rendered.stdin.write('\x1b[B')
      rendered.stdin.write('\t')
      rendered.stdin.write('\x1b[B')
      rendered.stdin.write('\r')
      rendered.stdin.write('\r')
      await vi.waitFor(() => { expect(chosen).toHaveBeenCalledWith({ kind: 'chosen', values: ['past', 'code'] }) })
      expect(chosen).toHaveBeenCalledTimes(1)
    } finally {
      rendered.unmount()
    }
  })

  it('returns cancellation for Escape before accepting a choice', async () => {
    const chosen = vi.fn()
    const rendered = render(<StartMenu menu={menu} onClose={chosen} />)
    try {
      await vi.waitFor(() => { expect(rendered.stdin.listenerCount('readable')).toBeGreaterThan(0) })
      rendered.stdin.write('\x1b')
      await vi.waitFor(() => { expect(chosen).toHaveBeenCalledWith({ kind: 'escape' }) })
    } finally {
      rendered.unmount()
    }
  })
})
