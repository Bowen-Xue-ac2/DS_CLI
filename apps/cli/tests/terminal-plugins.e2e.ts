import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { terminalFixtureEnv } from './terminal-fixture.ts'
import { launch, shellEnvironment } from './terminal-tty.ts'

it.runIf(process.platform === 'win32')('inspects, installs, disables and removes a local plugin from the live Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-plugins-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  const bundle = join(root, 'fixture-bundle')
  const incompatible = join(root, 'fixture-incompatible')
  const broken = join(root, 'fixture-broken')
  const skills = join(bundle, 'skills')
  const packageName = 'dscli-fixture-bundle'
  await Promise.all([mkdir(cwd), mkdir(incompatible), mkdir(broken), mkdir(join(skills, 'fixture-skill'), { recursive: true })])
  const key = 'plugin-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success'] })
  let pty: ReturnType<typeof launch> | undefined
  let duplicate: ReturnType<typeof launch> | undefined
  let stop: (() => Promise<unknown>) | undefined
  try {
    const env = await terminalFixtureEnv(home, model.baseURL, key)
    await Promise.all([
      writeFile(join(bundle, 'package.json'), JSON.stringify({
        name: packageName, version: '1.0.0', type: 'module', description: 'DS CLI plugin fixture',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })),
      writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'dscli-fixture-command', name: './fixture.mjs' },
        { id: 'dscli-fixture-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: {
          providerName: 'dscli-fixture', includeDefaultRoots: false, customSkillDirs: [skills], watch: false,
        } },
      ] }])),
      writeFile(join(bundle, 'fixture.mjs'), `
export const name = 'dscli-fixture-command'
export const inject = ['commands']
export function apply(ctx) {
  return ctx.commands.register({
    name: 'fixture', definitionId: '${packageName}#fixture', description: 'Show the fixture result',
    handler() { return { kind: 'success', text: 'PLUGIN_COMMAND_SENTINEL' } },
  })
}
`),
      writeFile(join(skills, 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture Skill.\n---\nUse the fixture data.\n'),
      writeFile(join(incompatible, 'package.json'), JSON.stringify({
        name: 'dscli-incompatible-bundle', version: '1.0.0', type: 'module', engines: { dsh: '<0.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })),
      writeFile(join(incompatible, 'cordis.patch.yml'), '[]\n'),
      writeFile(join(broken, 'package.json'), JSON.stringify({
        name: 'dscli-hmr-broken', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } },
      })),
      writeFile(join(broken, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'fixture-broken-entry', name: './broken.mjs' }] }])),
      writeFile(join(broken, 'broken.mjs'), 'export function apply() { throw new Error("FIXTURE_HOT_ACTIVATION_FAILED") }\n'),
    ])
    const spec = 'file:' + bundle.replaceAll('\\', '/')
    const profile = join(home, 'ds-cli-host-0.2', 'profiles', 'web', 'package.json')
    const shellEnv = await shellEnvironment(root, env)
    stop = () => execa(process.execPath, [shellEnv.DS_CLI_TEST_BIN!, 'host', 'stop', '--yes'], { cwd, env: shellEnv, timeout: 30000 })
    pty = launch('pwsh.exe', cwd, shellEnv, '--cwd . --mode standard --permission read-only', 'shared')
    await pty.until('read-only on', 0, 40_000)
    pty.send(`/plugins inspect ${spec}\r`)
    await pty.until('dscli-fixture-bundle@1.0.0')
    expect(await readFile(profile, 'utf8')).not.toContain(packageName)
    pty.send(`/plugins install ${spec}\r`)
    await pty.until('Install dscli-fixture-bundle@1.0.0?')
    const cancel = pty.mark()
    pty.send('\x1b')
    await pty.until('Install cancelled', cancel)
    expect(await readFile(profile, 'utf8')).not.toContain(packageName)
    const install = pty.mark()
    duplicate = launch('bash.exe', cwd, shellEnv, '--cwd . --mode standard --permission read-only', 'shared')
    await duplicate.until('read-only on', 0, 35_000)
    duplicate.send(`/plugins install ${spec}\r`)
    await duplicate.until('Install dscli-fixture-bundle@1.0.0?')
    pty.send(`/plugins install ${spec}\r`)
    await pty.until('Install dscli-fixture-bundle@1.0.0?', install)
    pty.send('\x1b[B')
    duplicate.send('\x1b[B')
    await pty.until('● Install', install)
    await duplicate.until('● Install')
    const concurrent = duplicate.mark()
    pty.send('\r')
    duplicate.send('\r')
    await pty.until('dscli-fixture-bundle · install applied', install)
    const second = duplicate
    await vi.waitFor(() => {
      expect(second.output(concurrent)).toMatch(/dscli-fixture-bundle · install|already.installed|operation.in.progress/iu)
    }, { timeout: 15_000 })
    const selected = JSON.parse(await readFile(profile, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(selected.dsh.profile.bundles.filter(name => name === packageName)).toEqual([packageName])
    duplicate.send('/exit\r')
    expect(await duplicate.exit()).toBe(0)
    pty.send('/fixture\r')
    await pty.until('PLUGIN_COMMAND_SENTINEL', install)
    const plugin = pty.mark()
    pty.send('@plugin:dscli-fixture')
    await pty.until('dscli-fixture-bundle · /fixture', plugin)
    pty.send('\x1b')
    const clearPlugin = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', clearPlugin)
    const skill = pty.mark()
    pty.send('$fixture-s')
    await pty.until('$fixture-skill', skill)
    pty.send('\x1b')
    const clear = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', clear)
    const disable = pty.mark()
    pty.send(`/plugins disable ${packageName}\r`)
    await pty.until('Disable dscli-fixture-bundle?', disable)
    pty.send('\x1b[B')
    await pty.until('● Disable', disable)
    pty.send('\r')
    await pty.until('dscli-fixture-bundle · enable applied', disable)
    const disabled = pty.mark()
    pty.send('/fixture\r')
    await pty.until('Unknown slash command or Skill: /fixture', disabled)
    await pty.until('❯ /fixture', disabled)
    const clearDisabled = pty.mark()
    pty.send('\x15')
    await pty.until('❯\r', clearDisabled)
    const remove = pty.mark()
    pty.send(`/plugins uninstall ${packageName}\r`)
    await pty.until('Uninstall dscli-fixture-bundle?', remove)
    pty.send('\x1b[B')
    await pty.until('● Uninstall', remove)
    pty.send('\r')
    await pty.until('dscli-fixture-bundle · remove applied', remove)
    expect(await readFile(profile, 'utf8')).not.toContain(packageName)
    const failure = pty.mark()
    pty.send(`/plugins install file:${incompatible.replaceAll('\\', '/')}\r`)
    await pty.until('Install dscli-incompatible-bundle@1.0.0?', failure)
    pty.send('\x1b[B')
    await pty.until('● Install', failure)
    pty.send('\r')
    await pty.until('incompatible-version', failure)
    expect(await readFile(profile, 'utf8')).not.toContain('dscli-incompatible-bundle')
    const brokenInstall = pty.mark()
    pty.send(`/plugins install file:${broken.replaceAll('\\', '/')}\r`)
    await pty.until('Install dscli-hmr-broken@1.0.0?', brokenInstall)
    pty.send('\x1b[B')
    await pty.until('● Install', brokenInstall)
    pty.send('\r')
    await pty.until('dscli-hmr-broken · install', brokenInstall)
    const terminal = pty
    await vi.waitFor(() => {
      expect(terminal.output(brokenInstall)).toMatch(/FIXTURE_HOT_ACTIVATION_FAILED|install failed|restart-required|activation failed/iu)
    }, { timeout: 8_000 })
    const stored = await readFile(profile, 'utf8')
    if (stored.includes('dscli-hmr-broken')) {
      const details = pty.mark()
      pty.send('/plugins detail dscli-hmr-broken\r')
      await pty.until('fixture-broken-entry', details)
      expect(pty.output(details)).not.toMatch(/fixture-broken-entry[^\r\n]* · active/u)
    }
    expect(model.requests).toHaveLength(0)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await duplicate?.stop()
    await stop?.().catch(() => {})
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 180_000)

it.runIf(process.platform === 'win32')('enables and reads an explicitly configured plugin marketplace through the native Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-market-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const key = 'market-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success'] })
  let hits = 0
  const index = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      format: 1, title: 'Local Plugin Index',
      plugins: [{ name: 'market-fixture-bundle', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }] }],
    }))
  })
  let pty: ReturnType<typeof launch> | undefined
  try {
    await new Promise<void>((ready, reject) => {
      index.once('error', reject)
      index.listen(0, '127.0.0.1', ready)
    })
    const address = index.address()
    if (address === null || typeof address === 'string') throw new Error('Index listener was not allocated')
    const url = `http://127.0.0.1:${address.port}/index.json`
    const env = await shellEnvironment(root, await terminalFixtureEnv(join(root, 'home'), model.baseURL, key))
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    pty.send(`/plugins source-add ${url}\r`)
    await pty.until('Enable the official custom marketplace bundle?')
    pty.send('\x1b')
    await pty.until('Marketplace enable cancelled')
    expect(hits).toBe(0)
    const confirmed = pty.mark()
    pty.send(`/plugins source-add ${url}\r`)
    await pty.until('Enable the official custom marketplace bundle?', confirmed)
    pty.send('\x1b[B')
    await pty.until('● Enable marketplace', confirmed)
    pty.send('\r')
    await pty.until('Add marketplace source?', confirmed)
    pty.send('\x1b[B')
    await pty.until('● Add source', confirmed)
    pty.send('\r')
    await pty.until('Marketplace source saved', confirmed)
    expect(hits).toBe(0)
    pty.send('/plugins discover\r')
    await pty.until('Plugin discovery')
    pty.send('\r')
    await pty.until('market-fixture-bundle@1.0.0 · not-installed')
    expect(hits).toBe(1)
    expect(model.requests).toHaveLength(0)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await new Promise<void>((resolve) => { index.close(() => { resolve() }) })
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 100_000)

it.runIf(process.platform === 'win32')('reports a Host restart requirement and loads the persisted bundle on the next launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscli-plugin-restart-'))
  const cwd = join(root, 'work')
  const home = join(root, 'home')
  const bundle = join(root, 'restart-bundle')
  await Promise.all([mkdir(cwd), mkdir(bundle)])
  await Promise.all([
    writeFile(join(bundle, 'package.json'), JSON.stringify({
      name: 'dscli-restart-fixture', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } },
    })),
    writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'fixture-restart-command', name: './fixture.mjs' }] }])),
    writeFile(join(bundle, 'fixture.mjs'), `
export const name = 'fixture-restart-command'
export const inject = ['commands']
export function apply(ctx) {
  return ctx.commands.register({
    name: 'restart-fixture', description: 'Read the restarted fixture',
    handler() { return { kind: 'success', text: 'RESTARTED_PLUGIN_SENTINEL' } },
  })
}
`),
  ])
  const key = 'restart-fixture'
  const model = await startMockLlmServer({ apiKey: key, sequence: ['success'] })
  let pty: ReturnType<typeof launch> | undefined
  try {
    const fixture = await terminalFixtureEnv(home, model.baseURL, key)
    const overlay = join(home, 'ds-cli-host-0.2', 'cordis.patch.yml')
    const patch = JSON.parse(await readFile(overlay, 'utf8')) as unknown[]
    await writeFile(overlay, JSON.stringify([...patch, { id: 'hmr', disabled: true }]))
    const env = await shellEnvironment(root, fixture)
    pty = launch('pwsh.exe', cwd, env, '--cwd . --mode standard --permission read-only')
    await pty.until('read-only on')
    const id = pty.output().match(/session-[\da-f-]{36}/u)?.[0]
    expect(id).toBeDefined()
    const spec = 'file:' + bundle.replaceAll('\\', '/')
    pty.send(`/plugins install ${spec}\r`)
    await pty.until('Install dscli-restart-fixture@1.0.0?')
    pty.send('\x1b[B')
    await pty.until('● Install')
    pty.send('\r')
    await pty.until('dscli-restart-fixture · install restart-required')
    await pty.until('Host restart required')
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
    pty = launch('pwsh.exe', cwd, env, `--resume ${id}`)
    await pty.until('read-only on')
    pty.send('/restart-fixture\r')
    await pty.until('RESTARTED_PLUGIN_SENTINEL')
    expect(model.requests).toHaveLength(0)
    pty.send('/exit\r')
    expect(await pty.exit()).toBe(0)
  } finally {
    await pty?.stop()
    await model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
  }
}, 110_000)
