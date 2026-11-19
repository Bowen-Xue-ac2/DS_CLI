import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TerminalWorkspace } from '../src/terminal-host.ts'
import { resolveStart } from '../src/terminal-start.ts'

const project = resolve('项目 A')
const nested = resolve(project, 'worktree')
const subdir = resolve(project, 'src')
const neighbor = resolve('项目 A-tools')

const workspaces: readonly TerminalWorkspace[] = [
  { workspaceId: 'outer', title: 'Project A', path: project, sessionIds: [], updatedAt: '' },
  { workspaceId: 'nested', title: 'Worktree', path: nested, sessionIds: [], updatedAt: '' },
]
const roster = [
  { id: 'standard', isDefault: true },
  { id: 'code', isDefault: false },
  { id: 'broken', isDefault: false, broken: 'cannot load preset' },
]

describe('terminal startup choices', () => {
  it('opens known roots and subdirectories with the closest registered workspace', () => {
    expect(resolveStart({ cwd: project, choose: false }, workspaces, roster)).toMatchObject({
      kind: 'chat', selection: { workspacePath: project, cwd: project, agentPreset: 'standard' },
    })
    expect(resolveStart({ cwd: subdir, choose: false }, workspaces, roster)).toMatchObject({
      kind: 'chat', selection: { workspacePath: project, cwd: subdir, agentPreset: 'standard' },
    })
    expect(resolveStart({ cwd: resolve(nested, 'src'), choose: false }, workspaces, roster)).toMatchObject({
      kind: 'chat', selection: { workspacePath: nested, agentPreset: 'standard' },
    })
  })

  it('preselects the physical caller directory for the first visit without conflating neighboring names', () => {
    expect(resolveStart({ cwd: neighbor, choose: false }, workspaces, roster)).toMatchObject({
      kind: 'choose', selection: { workspacePath: neighbor, cwd: neighbor, agentPreset: 'standard' },
    })
  })

  it('opens the chooser on request while keeping explicitly named agent and permission', () => {
    expect(resolveStart({
      cwd: subdir, choose: true, agentPreset: 'code', permission: 'read-only',
    }, workspaces, roster)).toMatchObject({
      kind: 'choose', selection: { workspacePath: project, cwd: subdir, agentPreset: 'code', permission: 'read-only' },
    })
  })

  it('asks for a healthy preset when the Host default is broken and rejects an explicitly broken preset', () => {
    const unavailableDefault = [
      { id: 'standard', isDefault: true, broken: 'cannot load preset' },
      { id: 'code', isDefault: false },
    ]
    expect(resolveStart({ cwd: project, choose: false }, workspaces, unavailableDefault).kind).toBe('choose')
    expect(() => resolveStart({ cwd: project, choose: false, agentPreset: 'broken' }, workspaces, roster))
      .toThrow('cannot load preset')
  })
})
