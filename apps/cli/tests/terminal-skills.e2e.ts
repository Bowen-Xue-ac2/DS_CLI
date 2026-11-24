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
      pty.send('$ds-cli-cw')
      await pty.until('Scoped review fixture')
      pty.send('\r')
      await pty.until('❯ /ds-cli-cwd')
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
