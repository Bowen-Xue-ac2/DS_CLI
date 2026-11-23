import { describe, expect, it } from 'vitest'
import { applyCompletion, findTrigger } from '../src/completion.ts'

describe('terminal input completion', () => {
  it('reads the query at the cursor and preserves the rest of the draft', () => {
    expect(findTrigger('read @src', 9)).toEqual({ trigger: '@', start: 5, end: 9, query: 'src' })
    const draft = 'read @src-old after'
    const target = findTrigger(draft, 9)
    expect(target).toEqual({ trigger: '@', start: 5, end: 13, query: 'src' })
    if (target === undefined) throw new Error('Completion range was missing')
    expect(applyCompletion(draft, target, '@"src/中文 file.ts"')).toBe('read @"src/中文 file.ts" after')
  })

  it('handles quoted paths and keeps ordinary text outside the chooser', () => {
    expect(findTrigger('@"中文 文件', 8)).toEqual({ trigger: '@', start: 0, end: 7, query: '中文 文件' })
    expect(findTrigger('name@example.org', 16)).toBeUndefined()
    expect(findTrigger('read \\@src', 10)).toBeUndefined()
    expect(findTrigger('read /tmp/file', 14)).toBeUndefined()
    expect(findTrigger('/rev', 4)?.trigger).toBe('/')
    expect(findTrigger('$rev', 4)?.trigger).toBe('$')
  })
})
