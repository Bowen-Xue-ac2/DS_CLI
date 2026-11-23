import { execFileSync } from 'node:child_process'
import { defineConfig } from 'tsdown'

function buildRevision(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * The dsh CLI ships the `bin` entry and the terminal Host adapter.
 * The root tsdown builds only `lib/types/index.js`, so this override points at
 * `lib/types/bin.js` instead; its reachable mode modules bundle with it.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/terminal-host.js', 'lib/types/terminal-start.js', 'lib/types/terminal-cwd.js', 'lib/types/terminal-permissions.js', 'lib/types/terminal-sessions.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  define: { __DS_CLI_BUILD_REVISION__: JSON.stringify(buildRevision()) },
  fixedExtension: false,
  dts: false,
  clean: false,
})
