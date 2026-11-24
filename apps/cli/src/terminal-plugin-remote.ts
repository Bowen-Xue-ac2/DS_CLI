/** Profile plugin operations exposed by the native rc.5 Host. @module @deepseek-ai/dsh/terminal-plugin-remote */
import type { HostResult } from './terminal-host.ts'

export interface TerminalPluginBundle {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly source?: string
  readonly official: boolean
  readonly enabled: boolean
  readonly installed: boolean
  readonly removable: boolean
  readonly availability: 'installation' | 'profile' | 'missing'
  readonly error?: { readonly code: string }
  readonly rows: readonly { readonly rowId: string; readonly moduleName: string; readonly entryId?: string }[]
}

interface PluginEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
  readonly readOnlyReason?: string
  readonly patchId?: string
}

interface PluginChange {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly restartReason?: string
  readonly stage: 'install' | 'enable' | 'remove'
  readonly target: string
  readonly bundle?: string
  readonly version?: string
  readonly error?: { readonly code: string }
  readonly warnings?: readonly string[]
  readonly pendingBuilds?: readonly string[]
}

type PluginInspection =
  | { readonly status: 'refused'; readonly problem: string; readonly reason: string }
  | {
    readonly status: 'accepted'
    readonly kind: string
    readonly name?: string
    readonly version?: string
    readonly description?: string
    readonly bundle: boolean | null
    readonly registry: string
    readonly host?: string
  }

/** The parts of the native plugin Remote contracts used by the terminal. */
export interface TerminalPluginsRemote {
  readonly pluginInventory: {
    list(): Promise<HostResult<{ readonly managementAvailable?: boolean; readonly entries: readonly PluginEntry[] }>>
  }
  readonly pluginManager: {
    listBundles(): Promise<HostResult<readonly TerminalPluginBundle[]>>
    listPlugins(): Promise<HostResult<readonly PluginEntry[]>>
    inspect(spec: string, options: undefined, signal: AbortSignal): Promise<HostResult<PluginInspection>>
    installBundle(spec: string, options: {
      requestId: string
      saveExact: true
      registry: string
      expected?: { name: string; version: string }
      approvedBuilds?: readonly string[]
    }): Promise<HostResult<PluginChange>>
    cancelInstall(requestId: string): Promise<HostResult<{ readonly status: 'cancelled' | 'too-late' | 'not-running' }>>
    updateBundle(name: string, version: string, options: { requestId: string; spec?: string }):
    Promise<HostResult<{ readonly result: PluginChange; readonly restore?: PluginChange }>>
    setBundleEnabled(name: string, enabled: boolean): Promise<HostResult<PluginChange>>
    setPluginEnabled(id: string, enabled: boolean): Promise<HostResult<PluginChange>>
    removeBundle(name: string): Promise<HostResult<PluginChange>>
  }
  readonly pluginMarket: {
    listIndexes(): Promise<HostResult<readonly { readonly url: string }[]>>
    setIndexes(urls: readonly string[]): Promise<HostResult<void>>
    search(url: string, request: {
      readonly text?: string
      readonly sort: { readonly kind: 'index' | 'relevance' }
      readonly offset: number
      readonly limit: number
    }): Promise<HostResult<{
      readonly entries: readonly {
        readonly name: string
        readonly defaultVersion?: string
        readonly installation: { readonly status: string }
      }[]
      readonly total: number
    }>>
  }
}

export type { PluginChange }
