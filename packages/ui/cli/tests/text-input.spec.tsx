/** The input keypress fold: coalesced Enter, backspace/delete, history, submit. */

import * as React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { CliCompletionItem, CliCompletionSource } from '../src/completion.ts'
import { applyKeypress, CliTextInput } from '../src/text-input.tsx'

describe('applyKeypress', () => {
  it('submits on Enter when non-empty and ignores an empty value', () => {
    // Enter also resets the cursor to the start, ready for the next input.
    expect(applyKeypress('', { return: true }, 'hi', 2)).toEqual({ submit: 'hi', offset: 0 })
    expect(applyKeypress('', { return: true }, '', 0)).toEqual({})
  })

  it('handles the coalesced-Enter chunk "o\\r" as text plus Enter', () => {
    const edit = applyKeypress('o\r', {}, '', 0)
    expect(edit).toEqual({ value: 'o', offset: 1, submit: 'o' })
  })

  it('deletes the character before the cursor on both backspace and delete', () => {
    // Backspace byte → key.backspace
    expect(applyKeypress('\b', { backspace: true }, 'ab', 2)).toEqual({ value: 'a', offset: 1 })
    // DEL byte in tmux/SSH → key.delete
    expect(applyKeypress('\x7f', { delete: true }, 'ab', 2)).toEqual({ value: 'a', offset: 1 })
    // Delete at the start is a no-op
    expect(applyKeypress('\x7f', { delete: true }, 'ab', 0)).toEqual({})
  })

  it('moves the cursor with arrow keys and clamps at the ends', () => {
    expect(applyKeypress('', { leftArrow: true }, 'ab', 2)).toEqual({ offset: 1 })
    expect(applyKeypress('', { rightArrow: true }, 'ab', 1)).toEqual({ offset: 2 })
    expect(applyKeypress('', { leftArrow: true }, 'ab', 0)).toEqual({ offset: 0 })
  })

  it('navigates history on up/down and falls through to the current value', () => {
    expect(applyKeypress('', { upArrow: true }, 'current', 7, c => c === 'current' ? 'older' : undefined))
      .toEqual({ value: 'older', offset: 5 })
    expect(applyKeypress('', { downArrow: true }, 'older', 5, undefined, () => 'current'))
      .toEqual({ value: 'current', offset: 7 })
    expect(applyKeypress('', { upArrow: true }, 'current', 7)).toEqual({})
  })

  it('inserts printable input at the cursor', () => {
    expect(applyKeypress('x', {}, 'ab', 1)).toEqual({ value: 'axb', offset: 2 })
  })

  it('keeps a multiline paste in the draft until Enter', () => {
    const paste = 'Open the file\nAnd summarize it.'
    expect(applyKeypress(paste, {}, '', 0)).toEqual({ value: paste, offset: paste.length })
    expect(applyKeypress('', { return: true }, paste, paste.length)).toEqual({ submit: paste, offset: 0 })
  })

  it('ignores SGR mouse wheel events instead of inserting them', () => {
    // The scroll region consumes the wheel; the input must not insert the raw
    // escape sequence. ink strips the leading ESC, so the input is `[<…M`.
    expect(applyKeypress('[<64;10;20M', {}, 'ab', 1)).toEqual({})
    expect(applyKeypress('[<65;10;20M', {}, 'ab', 1)).toEqual({})
  })

  it('ignores chunked mouse sequence fragments too', () => {
    // A slow stdin can deliver the SGR mouse escape in pieces; each fragment
    // must not reach the input as printable text.
    expect(applyKeypress('[<', {}, 'ab', 1)).toEqual({})
    expect(applyKeypress('65;10;20M', {}, 'ab', 1)).toEqual({})
    expect(applyKeypress('10;20M', {}, 'ab', 1)).toEqual({})
  })
})

function fileChoice(label: string, scope: string): readonly CliCompletionItem[] {
  return [{ id: label, kind: 'file', label, insert: '@' + label, scope }]
}

describe('completion lifetime', () => {
  it('cancels an in-flight lookup on Escape and preserves the draft', async () => {
    const reply = Promise.withResolvers<readonly CliCompletionItem[]>()
    const completion = vi.fn<CliCompletionSource>(() => reply.promise)
    const submit = vi.fn()
    const rendered = render(
      <CliTextInput value="@draft" onChange={() => {}} onSubmit={submit} completion={completion} completionScope="a" />,
    )
    try {
      await vi.waitFor(() => {
        expect(completion).toHaveBeenCalledTimes(1)
        expect(rendered.stdin.listenerCount('readable')).toBeGreaterThan(0)
      })
      const signal = completion.mock.calls[0]?.[1]
      rendered.stdin.write('\x1b')
      await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
      reply.resolve(fileChoice('late-file', 'a'))
      await reply.promise
      expect(rendered.lastFrame()).toContain('@draft')
      expect(rendered.lastFrame()).not.toContain('late-file')
      expect(submit).not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
    }
  })

  it('discards a late result from the previous session while another menu owns input', async () => {
    const old = Promise.withResolvers<readonly CliCompletionItem[]>()
    const completion = vi.fn<CliCompletionSource>().mockReturnValueOnce(old.promise)
      .mockResolvedValue(fileChoice('workspace-b', 'b'))
    const submit = vi.fn()
    const pick = vi.fn()
    const input = (scope: string, focus: boolean) => (
      <CliTextInput value="@workspace" onChange={() => {}} onSubmit={submit} completion={completion}
        completionScope={scope} onCompletion={pick} focus={focus}
      />
    )
    const rendered = render(input('a', true))
    try {
      await vi.waitFor(() => { expect(completion).toHaveBeenCalledTimes(1) })
      rendered.rerender(input('b', true))
      await vi.waitFor(() => { expect(rendered.lastFrame()).toContain('workspace-b') })
      expect(completion.mock.calls[0]?.[1].aborted).toBe(true)
      old.resolve(fileChoice('workspace-a', 'a'))
      await old.promise
      rendered.rerender(input('b', false))
      await vi.waitFor(() => { expect(rendered.lastFrame()).not.toContain('workspace-b') })
      expect(rendered.lastFrame()).not.toContain('workspace-a')
      rendered.stdin.write('\t')
      rendered.stdin.write('\r')
      expect(pick).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
    }
  })
})
