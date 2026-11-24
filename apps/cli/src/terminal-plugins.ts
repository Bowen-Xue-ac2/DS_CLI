/** Profile plugin management over the native indexes, Settings and installer. @module @deepseek-ai/dsh/terminal-plugins */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CliMenuOption, InteractiveIo } from '@deepseek-ai/dsh-cli-ui'
import { requireHostResult, type TerminalHost, type TerminalSettingsValue } from './terminal-host.ts'
import type { PluginChange, TerminalPluginBundle } from './terminal-plugin-remote.ts'

const HELP = 'Usage: /plugins [list | official | discover [query] | detail <bundle> | inspect <spec> | install <spec> | update <bundle> <version> | enable <bundle-or-entry> | disable <bundle-or-entry> | uninstall <bundle> | configure <entry> <json-file> | source-add <url>]'

interface PluginFeedback {
  notice(text: string): void
  trackInstall(cancel: () => void): () => void
}

async function choose(io: Pick<InteractiveIo, 'choose'>, signal: AbortSignal, title: string,
  label: string, options: readonly CliMenuOption[],
): Promise<string | undefined> {
  const first = options[0]
  if (first === undefined) return undefined
  const answer = await io.choose({ title, fields: [{ label, initial: first.id, options }] }, signal)
  return answer.kind === 'chosen' ? answer.values[0] : undefined
}

async function confirm(io: Pick<InteractiveIo, 'choose'>, signal: AbortSignal, title: string,
  label: string, detail?: string,
): Promise<boolean> {
  const answer = await io.choose({
    title, ...(detail === undefined ? {} : { detail }),
    fields: [{ label: 'Action', initial: 'cancel', options: [{ id: 'cancel', label: 'Cancel' }, { id: 'approve', label }] }],
  }, signal)
  return answer.kind === 'chosen' && answer.values[0] === 'approve'
}

function bundleText(bundle: TerminalPluginBundle): string {
  return [bundle.name + (bundle.version === undefined ? '' : '@' + bundle.version),
    bundle.enabled ? 'enabled' : 'disabled', bundle.availability, bundle.error?.code].filter(Boolean).join(' · ')
}

function changeText(result: PluginChange, operation = result.stage): string {
  return [
    `${result.bundle ?? result.target} · ${operation} ${result.application}`,
    operation === result.stage ? undefined : `Host stage: ${result.stage}`,
    result.error?.code,
    result.restartReason === undefined ? undefined : `Host restart required (${result.restartReason}).`,
    result.pendingBuilds?.length ? `Build scripts awaiting approval: ${result.pendingBuilds.join(', ')}` : undefined,
    ...(result.warnings ?? []),
  ].filter(Boolean).join('\n')
}

async function trackedChange<T>(
  host: TerminalHost, feedback: PluginFeedback, apply: (requestId: string) => Promise<T>,
): Promise<T> {
  const requestId = randomUUID()
  const { remote } = host
  feedback.notice('Applying plugin change…')
  const detach = remote.$on('plugin-manager/install-state', (state) => {
    if (state.requestId !== requestId) return
    const attempt = state.attempt === undefined ? '' : ` (${state.attempt.index}/${state.attempt.total})`
    feedback.notice(`Plugin change: ${state.phase}${attempt}`)
  })
  let cancel: Promise<void> | undefined
  const untrack = feedback.trackInstall(() => {
    cancel ??= remote.pluginManager.cancelInstall(requestId).then((receipt) => {
      feedback.notice(`Plugin cancellation: ${requireHostResult(receipt).status}`)
    }).catch(() => { feedback.notice('The Host could not confirm plugin cancellation.') })
  })
  try { return await apply(requestId) } finally {
    await cancel
    untrack()
    detach()
  }
}

function packageSpec(spec: string, cwd: string): string {
  const value = spec.replace(/^(["'])(.*)\1$/u, '$2')
  const local = /^(file|link):(.+)$/u.exec(value)
  return local?.[2] === undefined ? value : `${local[1]}:${resolve(cwd, local[2]).replaceAll('\\', '/')}`
}

async function inspectOrInstall(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, feedback: PluginFeedback,
  spec: string, install: boolean,
): Promise<string> {
  const { remote, signal } = host
  const inspection = requireHostResult(await remote.pluginManager.inspect(spec, undefined, signal))
  if (inspection.status === 'refused') return `Plugin inspection refused (${inspection.problem}): ${inspection.reason}`
  const identity = inspection.name === undefined ? spec
    : inspection.name + (inspection.version === undefined ? '' : '@' + inspection.version)
  const detail = [inspection.kind, inspection.host ?? inspection.registry,
    inspection.bundle === true ? 'bundle' : undefined, inspection.description].filter(Boolean).join(' · ')
  if (!install) return `${identity} · ${detail}`
  if (!await confirm(io, signal, `Install ${identity}?`, 'Install', detail)) return 'Install cancelled'
  const expected = inspection.name === undefined || inspection.version === undefined ? undefined
    : { name: inspection.name, version: inspection.version }
  const apply = async (approvedBuilds?: readonly string[]) => requireHostResult(await trackedChange(host, feedback, requestId =>
    remote.pluginManager.installBundle(spec, {
      requestId, registry: inspection.registry, saveExact: true,
      ...(expected === undefined ? {} : { expected }),
      ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
    })))
  const first = await apply()
  const builds = first.pendingBuilds
  if (builds === undefined || builds.length === 0 || !await confirm(io, signal, 'Allow dependency build scripts?',
    'Allow scripts and retry', builds.join(', '))) return changeText(first, 'install')
  return changeText(await apply(builds), 'install')
}

async function discover(host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, query?: string): Promise<string> {
  const indexes = requireHostResult(await host.remote.pluginMarket.listIndexes())
  if (indexes.length === 0) return 'No marketplace source configured. Use /plugins source-add <url>.'
  const url = await choose(io, host.signal, 'Plugin discovery', 'Index', indexes.map(index => ({ id: index.url, label: index.url })))
  if (url === undefined) return 'Discovery cancelled'
  const results = requireHostResult(await host.remote.pluginMarket.search(url, {
    ...(query === undefined ? {} : { text: query }), sort: { kind: query === undefined ? 'index' : 'relevance' },
    offset: 0, limit: 15,
  }))
  return [`${results.total} matching plugins`, ...results.entries.map(entry =>
    `${entry.name}${entry.defaultVersion === undefined ? '' : '@' + entry.defaultVersion} · ${entry.installation.status}`)].join('\n')
}

async function enableMarketplace(host: TerminalHost, io: Pick<InteractiveIo, 'choose'>): Promise<string | undefined> {
  const { remote, signal } = host
  const name = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
  const bundles = requireHostResult(await remote.pluginManager.listBundles())
  const bundle = bundles.find(row => row.name === name)
  if (bundle?.enabled !== false) return
  if (bundle.availability === 'missing' || bundle.error !== undefined) {
    return 'Marketplace bundle unavailable. Check /plugins official for installation and platform requirements.'
  }
  if (!await confirm(io, signal, 'Enable the official custom marketplace bundle?', 'Enable marketplace')) {
    return 'Marketplace enable cancelled'
  }
  const result = requireHostResult(await remote.pluginManager.setBundleEnabled(name, true))
  if (result.application !== 'applied') return changeText(result)
}

/** Open the terminal profile manager or run an explicit management command.
 * @param host - authenticated terminal Host.
 * @param io - keyboard chooser for explicit decisions.
 * @param feedback - install state and cancellation binding for the terminal.
 * @param cwd - current directory used for local package and config paths.
 * @param args - subcommand and arguments from the local route.
 * @returns the next displayed result.
 */
export async function runTerminalPlugins(
  host: TerminalHost, io: Pick<InteractiveIo, 'choose'>, feedback: PluginFeedback, cwd: string, args?: string,
): Promise<string> {
  const { remote, signal } = host
  const selected = args === undefined ? await choose(io, signal, 'Plugins', 'View', [
    { id: 'list', label: 'Installed' }, { id: 'official', label: 'Official' }, { id: 'discover', label: 'Discover' },
    { id: 'detail', label: 'Details' },
  ]) : args
  if (selected === undefined) return 'Plugin menu cancelled'
  const [, action, argument] = /^(\S+)(?:\s+(.+))?$/su.exec(selected) ?? []
  if ((action === 'inspect' || action === 'install') && argument !== undefined) {
    return inspectOrInstall(host, io, feedback, packageSpec(argument, cwd), action === 'install')
  }
  if (action === 'discover') {
    const unavailable = await enableMarketplace(host, io)
    return unavailable ?? discover(host, io, argument)
  }
  if (action === 'source-add' && argument !== undefined) {
    const unavailable = await enableMarketplace(host, io)
    if (unavailable !== undefined) return unavailable
    const sources = requireHostResult(await remote.pluginMarket.listIndexes())
    if (sources.some(source => source.url === argument)) return 'Marketplace source already configured'
    if (!await confirm(io, signal, 'Add marketplace source?', 'Add source', argument)) return 'Source change cancelled'
    requireHostResult(await remote.pluginMarket.setIndexes([...sources.map(source => source.url), argument]))
    return 'Marketplace source saved'
  }
  const bundles = requireHostResult(await remote.pluginManager.listBundles())
  if (action === 'official' || action === 'list') {
    const entries = action === 'official' ? bundles.filter(bundle => bundle.official)
      : bundles.filter(bundle => bundle.installed || bundle.enabled)
    const inventory = requireHostResult(await remote.pluginInventory.list())
    return [inventory.managementAvailable === false ? 'Plugin profile is read-only' : 'Plugin profile',
      ...entries.map(bundleText)].join('\n')
  }
  if (action === 'detail') {
    const name = argument ?? await choose(io, signal, 'Plugin detail', 'Bundle', bundles.map(bundle => ({
      id: bundle.name, label: bundle.name, detail: bundleText(bundle),
    })))
    const bundle = bundles.find(item => item.name === name)
    if (bundle === undefined) return 'Bundle detail unavailable'
    const inventory = requireHostResult(await remote.pluginInventory.list())
    const byId = new Map(inventory.entries.map(row => [row.entryId, row]))
    return [
      bundleText(bundle), bundle.description, bundle.source,
      ...bundle.rows.map((row) => {
        const entry = row.entryId === undefined ? undefined : byId.get(row.entryId)
        return [row.entryId ?? row.rowId, row.moduleName, entry?.fiberPhase ?? 'inactive', entry?.readOnlyReason].filter(Boolean).join(' · ')
      }),
    ].filter(Boolean).join('\n')
  }
  if (argument === undefined) return HELP
  if (action === 'enable' || action === 'disable') {
    const bundle = bundles.find(item => item.name === argument)
    const row = bundle === undefined ? requireHostResult(await remote.pluginManager.listPlugins())
      .find(item => item.entryId === argument) : undefined
    if (bundle === undefined && row === undefined) return 'Unknown bundle or plugin entry'
    if (row?.readOnlyReason !== undefined) return `Plugin entry is read-only (${row.readOnlyReason})`
    const enable = action === 'enable'
    const label = enable ? 'Enable' : 'Disable'
    if (!await confirm(io, signal, `${label} ${argument}?`, label)) return `${label} cancelled`
    return changeText(requireHostResult(await (bundle === undefined
      ? remote.pluginManager.setPluginEnabled(argument, enable) : remote.pluginManager.setBundleEnabled(argument, enable))))
  }
  if (action === 'uninstall') {
    if (bundles.find(bundle => bundle.name === argument)?.removable !== true) return 'This bundle cannot be uninstalled from the profile'
    if (!await confirm(io, signal, `Uninstall ${argument}?`, 'Uninstall')) return 'Uninstall cancelled'
    return changeText(requireHostResult(await remote.pluginManager.removeBundle(argument)))
  }
  if (action === 'update') {
    const [name, version, spec] = argument.split(/\s+/u)
    if (name === undefined || version === undefined) return HELP
    if (!await confirm(io, signal, `Update ${name} to ${version}?`, 'Update', spec)) return 'Update cancelled'
    const result = requireHostResult(await trackedChange(host, feedback, requestId =>
      remote.pluginManager.updateBundle(name, version, { requestId, ...(spec === undefined ? {} : { spec }) })))
    return [changeText(result.result), result.restore === undefined ? undefined : 'Restore: ' + changeText(result.restore)]
      .filter(Boolean).join('\n')
  }
  if (action === 'configure') {
    const [, ns, path] = /^(\S+)\s+(.+)$/u.exec(argument) ?? []
    if (ns === undefined || path === undefined) return HELP
    const settings = requireHostResult(await remote.settings.describe())
    const namespace = settings.namespaces.find(row => row.ns === ns)
    if (!settings.writable || namespace === undefined) return 'Plugin settings are unavailable or read-only'
    let values: TerminalSettingsValue
    try {
      values = JSON.parse(await readFile(resolve(cwd, path.replace(/^(["'])(.*)\1$/u, '$2')), { encoding: 'utf8', signal })) as TerminalSettingsValue
    } catch {
      signal.throwIfAborted()
      return 'Could not read a plugin configuration object from that JSON file.'
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return 'Expected a plugin configuration object'
    if (!await confirm(io, signal, `Save plugin settings for ${ns}?`, 'Save')) return 'Plugin settings cancelled'
    const operations = Object.entries(values).map(([key, value]) => ({ op: 'set' as const, path: [key], value }))
    const result = await remote.settings.mutate(ns, operations, namespace.revision)
    return result.ok ? `${ns}: configuration saved` : `Plugin settings rejected (${result.error.code})`
  }
  return HELP
}
