import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * CLI names the daemon spawns, resolved to an absolute path. Multiple CLIs
 * exist per role (e.g. `claude` installed by npm) but each has one canonical
 * name in Maiestro.
 */
export type CliTool = 'claude' | 'vibe'

/**
 * Locations added to PATH so the CLI is found even when the app is launched
 * from Finder/Dock without the user's shell profile (mainly macOS; harmless
 * elsewhere when the dirs don't exist).
 */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * Resolves the CLI to an absolute path so agents launch even when the Electron
 * main process has a sparser PATH than an interactive shell. Both the
 * headless and the terminal adapters spawn through this.
 */
export function resolveCli(tool: CliTool): string {
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    join(homedir(), '.local', 'bin'),
    ...EXTRA_PATH,
  ]
  for (const dir of dirs) {
    const p = join(dir, tool)
    try {
      statSync(p)
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not there / not executable — keep looking
    }
  }
  // fall back to a bare name and hope the shell finds it
  return tool
}
