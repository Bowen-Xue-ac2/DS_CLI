import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32').each(['pwsh.exe', 'bash.exe'] as const)(
  '%s separates a selected Skill from a same-name registered command',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'dscli-skill-'))
    const cwd = join(root, 'work')
    const home = join(root, 'home')
    const skill = join(cwd, '.agents', 'skills', 'ds-cli-cwd')
    await mkdir(skill, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: ds-cli-cwd\ndescription: Scoped review fixture\n---\n\nSKILL_INSTRUCTIONS_SENTINEL\n')
    const key = 'ds-cli-skill-fixture'
    const server = await startMockLlmServer({ apiKey: key, sequence: ['success'], repeatLast: true, successText: 'SKILL_TURN_FINISHED' })
    let pty: ReturnType<typeof launch> | undefined
    try {
      const env = await terminalFixtureEnv(home, server.baseURL, key)
      pty = launch(shell, cwd, await shellEnvironment(root, { ...env, DSH_AGENTS_HOME: join(root, 'agents') }),
        '--cwd . --permission read-only')
      await pty.until('read-only on')
      const slash = pty.mark()
      pty.send('/')
      await pty.until('/session · Open a saved session', slash)
      await pty.until('/usage · Show token', slash)
      await pty.until('/status · Show workspace', slash)
      await pty.until('/ps · List active jobs', slash)
      expect(pty.output(slash)).not.toContain('Scoped review fixture')
      pty.send('sta')
      await pty.until('› /status', slash)
      pty.send('\r')
      await pty.until('Last request model (none yet)', slash)
      const skillMenu = pty.mark()
      pty.send('$')
      await pty.until('Browse skills', skillMenu)
      pty.send('\r')
      await pty.until('$all:', skillMenu)
      await pty.until('Scoped review fixture', skillMenu)
      const filtered = pty.mark()
      pty.send('ds-cli-cw')
      await pty.until('› $ds-cli-cwd', filtered)
      pty.send('\r')
      await pty.until('❯ $ds-cli-cwd', skillMenu)
      expect(server.requests).toHaveLength(0)
      pty.send('Check the fixture.\r')
      await pty.until('SKILL_TURN_FINISHED')
      expect(JSON.stringify(server.requests.map(request => request.body))).toContain('SKILL_INSTRUCTIONS_SENTINEL')
      const afterTurn = pty.mark()
      pty.send('/ds-cli-cwd\r')
      await pty.until(cwd, afterTurn)
      expect(server.requests).toHaveLength(1)
      const beforeAlias = pty.mark()
      pty.send('$ds-cli-cwd Check the alias.\r')
      await vi.waitFor(() => expect(server.requests).toHaveLength(2), { timeout: 12_000 })
      await pty.until('Check the alias.', beforeAlias)
      await pty.until('SKILL_TURN_FINISHED', beforeAlias)
      expect(server.requests).toHaveLength(2)
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
    } finally {
      await pty?.stop()
      await server.close()
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    }
  },
)

it.runIf(process.platform === 'win32')('resolves identical names from the current workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-skill-scope-'))
  const paths = [join(root, '项目 A'), join(root, '项目 B')]
  const model = await startMockLlmServer({
    apiKey: 'scope-fixture', sequence: ['success', 'success'], successText: 'WORKSPACE_SKILL_USED',
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, 'scope-fixture'))
    for (const [index, cwd] of paths.entries()) {
      const skill = join(cwd, '.agents', 'skills', 'scope-check')
      const sentinel = 'WORKSPACE_SKILL_' + index
      await mkdir(skill, { recursive: true })
      execFileSync('git', ['init', '-q'], { cwd })
      await writeFile(join(cwd, 'scope-note.txt'), 'FILE_IN_' + sentinel)
      await writeFile(join(skill, 'SKILL.md'), `---\nname: scope-check\ndescription: ${sentinel}\n---\n\nUse ${sentinel}.\n`)
      pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
      await pty.until(cwd)
      await pty.until('read-only on')
      pty.send('Inspect @scope-note')
      await pty.until('scope-note.txt · File')
      pty.send('\t')
      await pty.until('❯ Inspect @scope-note.txt')
      const clear = pty.mark()
      pty.send('\x15')
      await pty.until('❯\r', clear)
      pty.send('$does-not-exist-here')
      await pty.until('No matching options')
      const noMatch = pty.mark()
      pty.send('\x15')
      await pty.until('❯\r', noMatch)
      const pick = pty.mark()
      pty.send('$scope-check')
      await pty.until(sentinel, pick)
      pty.send('\t')
      await pty.until('❯ $scope-check', pick)
      expect(model.requests).toHaveLength(index)
      pty.send('Check the selected workspace.\r')
      await pty.until('WORKSPACE_SKILL_USED', pick)
      const request = JSON.stringify(model.requests[index]?.body)
      expect(request).toContain(sentinel)
      expect(request).not.toContain('WORKSPACE_SKILL_' + (1 - index))
      pty.send('/exit\r')
      expect(await pty.exit()).toBe(0)
    }
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 120_000)
