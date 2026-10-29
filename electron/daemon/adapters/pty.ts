import { accessSync, chmodSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as pty from 'node-pty'
import type { LineProcess } from '../process'
import type { Agent, SpawnOptions } from '../types'
import type { AdapterContext } from './claude'

/**
 * Resolves the CLI to an absolute path so the embedded terminal works even
 * when the Electron main process has a sparser PATH than an interactive shell.
 */
function resolveCli(tool: 'claude' | 'vibe'): string {
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    join(homedir(), '.local', 'bin'),
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

/**
 * node-pty spawns its `spawn-helper` binary; on some installs (registry
 * mirrors that drop the exec bit) it is not executable, which surfaces as a
 * cryptic "posix_spawnp failed". Restore the bit once, up front.
 */
function ensureSpawnHelperExecutable(): void {
  try {
    const helper = join(
      dirname(require.resolve('node-pty/package.json')),
      'prebuilds',
      process.platform + '-' + process.arch,
      'spawn-helper',
    )
    if (!existsSync(helper)) return
    accessSync(helper, constants.X_OK)
  } catch {
    try {
      const helper = join(
        dirname(require.resolve('node-pty/package.json')),
        'prebuilds',
        process.platform + '-' + process.arch,
        'spawn-helper',
      )
      chmodSync(helper, 0o755)
    } catch {
      // packaged builds bundle the helper differently; nothing to do here
    }
  }
}

/** ANSI escapes (CSI/OSC/other) — TUI redraw noise we strip before mirroring. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/**
 * Semantic state marker emitted by the vibe TUI per turn:
 * `ESC ] 7501 ; state=<working|done> : app=vibe : msg=<base64> ESC \`.
 * The interactive CLI keeps running after a turn completes, so process exit
 * alone can't tell "agent done" from "agent waiting for the next prompt" —
 * these markers can.
 */
const OSC_STATE_RE = /\x1b\]7501;state=(\w+):/g

/** Tail length kept around to match markers split across PTY chunks. */
const OSC_TAIL = 128

/** Minimum status-mirroring interval (ms) — keeps registry/IPC writes bounded. */
const MIRROR_INTERVAL_MS = 500

/** Hook events whose payload the daemon maps to status transitions. */
const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop']

/**
 * Claude Code's TUI emits no machine-readable state markers (unlike vibe's
 * OSC 7501), so terminal-mode status comes from its hooks: a settings file
 * with hooks that POST their stdin payload to the daemon's
 * /internal/agent-hook endpoint. Written per spawn, removed when the PTY exits.
 */
function writeClaudeHookSettings(agentId: string, ctx: AdapterContext): string {
  const command =
    'curl -s -o /dev/null -X POST' +
    " -H 'Authorization: Bearer " + ctx.daemonToken + "'" +
    " -H 'Content-Type: application/json'" +
    " --data-binary @- '" + ctx.daemonUrl + '/internal/agent-hook?agentId=' + agentId + "' || true"
  const settings = {
    hooks: Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', command }] }]]),
    ),
  }
  mkdirSync(join(ctx.dataDir, 'bin'), { recursive: true })
  const file = join(ctx.dataDir, 'bin', 'claude-hooks-' + agentId + '.json')
  writeFileSync(file, JSON.stringify(settings))
  return file
}

export interface PtyHandlers {
  /** raw terminal output (stdout+stderr of the CLI) for the GUI */
  onData: (chunk: string) => void
}

/**
 * A terminal-mode agent handle: the interactive CLI runs inside a PTY owned
 * by this process. The GUI renders it with xterm.js, sends keystrokes through
 * write(), and can resize it. kill() closes the PTY (SIGHUP to the CLI).
 */
export interface PtyProcess extends LineProcess {
  resize(cols: number, rows: number): void
}

class PtyProc implements PtyProcess {
  constructor(private term: pty.IPty) {}

  get pid(): number {
    return this.term.pid
  }

  write(data: string): void {
    try {
      this.term.write(data)
    } catch {
      // terminal already closed
    }
  }

  resize(cols: number, rows: number): void {
    try {
      this.term.resize(cols, rows)
    } catch {
      // terminal already closed
    }
  }

  kill(): void {
    try {
      this.term.kill()
    } catch {
      // already closed
    }
  }

  onLine(): void {}
  onStderr(): void {}
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.term.onExit(({ exitCode }) => cb(exitCode, null))
  }
}

/**
 * Spawns the agent's interactive CLI (claude "task" / vibe "task") in a PTY
 * attached to the GUI: the live CLI is rendered in the agent's detail pane
 * and the user answers its questions right there.
 */
export function startPtyAgent(agent: Agent, opts: SpawnOptions, ctx: AdapterContext, handlers: PtyHandlers): PtyProcess {
  ensureSpawnHelperExecutable()
  const policy = opts.options?.vibeAgent ?? 'smart-approve'
  const cli = resolveCli(agent.tool)
  let hookSettingsFile: string | null = null
  let args: string[]
  if (agent.tool === 'claude') {
    hookSettingsFile = writeClaudeHookSettings(agent.id, ctx)
    args = [opts.task, '--settings', hookSettingsFile]
  } else {
    args = [opts.task, '--agent', policy]
  }

  const term = pty.spawn(cli, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: agent.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  })

  ctx.registry.updateAgent(agent.id, { pid: term.pid })
  ctx.emit(agent.id, 'log', 'Started embedded terminal (' + agent.tool + ')')

  // Mirror the CLI's latest visible output into the agent's lastMessage so
  // the main window keeps showing live status while the agent runs in the
  // embedded terminal (the headless adapters get this from stream events;
  // here the raw TUI output is the only source). TUIs redraw in place, so
  // both \n and \r start a new "line" and the last non-empty one wins.
  let tail = ''
  let lastLine = ''
  let lastMirrorAt = 0
  const mirrorStatus = (chunk: string): void => {
    const a = ctx.registry.getAgent(agent.id)
    if (!a || (a.status !== 'running' && a.status !== 'blocked')) return
    tail = (tail + chunk.replace(ANSI_RE, '')).slice(-4000)
    const line =
      tail
        .split(/[\n\r]/)
        .map((p) => p.trim())
        .filter(Boolean)
        .pop() ?? ''
    if (line.length < 3 || line === lastLine) return
    const now = Date.now()
    if (now - lastMirrorAt < MIRROR_INTERVAL_MS) return
    lastMirrorAt = now
    lastLine = line
    ctx.registry.updateAgent(agent.id, { lastMessage: line.slice(0, 200) })
  }

  // Track turn-level state from the vibe TUI's OSC 7501 markers so a finished
  // turn shows as `done` while the interactive CLI stays open for follow-ups.
  let oscTail = ''
  let lastTuiState = ''
  const handleStateMarkers = (chunk: string): void => {
    const s = oscTail + chunk
    oscTail = s.slice(-OSC_TAIL)
    for (const m of s.matchAll(OSC_STATE_RE)) {
      const state = m[1]
      if (state === lastTuiState) continue
      lastTuiState = state
      const a = ctx.registry.getAgent(agent.id)
      if (!a || a.status === 'stopped' || a.status === 'error') continue
      if (state === 'done' && a.status === 'running') {
        ctx.emit(agent.id, 'done', 'turn complete')
        ctx.registry.setStatus(agent.id, 'done')
      } else if (state === 'working' && a.status === 'done') {
        ctx.emit(agent.id, 'log', 'turn started')
        ctx.registry.setStatus(agent.id, 'running', { endedAt: null })
      }
    }
  }

  term.onData((chunk) => {
    handlers.onData(chunk)
    mirrorStatus(chunk)
    handleStateMarkers(chunk)
  })
  term.onExit(({ exitCode }) => {
    if (hookSettingsFile) rmSync(hookSettingsFile, { force: true })
    const a = ctx.registry.getAgent(agent.id)
    if (!a || a.status === 'stopped') return
    if (exitCode === 0) {
      ctx.emit(agent.id, 'done', 'terminal agent finished')
      ctx.registry.setStatus(agent.id, 'done')
    } else {
      ctx.emit(agent.id, 'error', 'terminal agent exited with code ' + exitCode)
      ctx.registry.setStatus(agent.id, 'error')
    }
  })
  return new PtyProc(term)
}
