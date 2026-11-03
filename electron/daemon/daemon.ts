import { randomBytes, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startClaudeAgent, type AdapterContext } from './adapters/claude'
import { startVibeAgent } from './adapters/vibe'
import { startPtyAgent, type PtyProcess } from './adapters/pty'
import { Notifier, type NotifyFn } from './notifier'
import type { LineProcess } from './process'
import { Registry } from './registry'
import { SHIM_SOURCE } from './shim-source'
import { Server } from './server'
import { Store } from './store'
import type { Agent, AgentEvent, AgentEventType, Project, SpawnOptions } from './types'

export interface DaemonOptions {
  dataDir?: string
  notify?: NotifyFn
  onAgentsChanged?: (agents: Agent[]) => void
  onAgentEvent?: (ev: AgentEvent) => void
  onProjectsChanged?: (projects: Project[]) => void
  /** raw output chunk of an embedded-terminal agent, with a sequence number */
  onTerminalData?: (agentId: string, data: string, seq: number) => void
}

const DEFAULT_PORT = 49377

/** Longest agent name kept; longer input is trimmed, not rejected. */
const NAME_MAX = 80

function cleanName(name: string | undefined | null): string | null {
  const clean = (name ?? '').trim().slice(0, NAME_MAX)
  return clean || null
}

/** Scrollback kept per embedded-terminal agent (chars). */
const TERMINAL_BUFFER_MAX = 256_000

/** Label of the pinned shell agent the user cannot close. */
const SHELL_NAME = 'cli'

/** How often the pinned shell's live working directory is captured (ms). */
const SHELL_CWD_POLL_MS = 5000

/**
 * Current working directory of a process, or null when it cannot be
 * determined (lsof on macOS, /proc on Linux). Used to remember where the
 * pinned `cli` shell was left when the app quits.
 */
function processCwd(pid: number): string | null {
  try {
    if (process.platform === 'linux') return readlinkSync('/proc/' + pid + '/cwd')
    if (process.platform === 'darwin') {
      for (const bin of ['/usr/sbin/lsof', 'lsof']) {
        try {
          const out = execFileSync(bin, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
            encoding: 'utf8',
            timeout: 2000,
          })
          const line = out.split('\n').find((l) => l.startsWith('n'))
          if (line) return line.slice(1)
        } catch {
          // candidate lsof path missing — try the next
        }
      }
    }
  } catch {
    // cwd not available — the caller keeps the recorded one
  }
  return null
}

/** Current git branch of a directory, or null when it is not a git repo. */
async function gitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 2000 },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** An embedded terminal (PTY) attached to a terminal-mode agent. */
interface TerminalSession {
  proc: PtyProcess | null
  /** accumulated output so a late-attaching renderer can catch up */
  buffer: string
  /** monotonic chunk counter; lets the renderer dedupe buffer vs live data */
  seq: number
}

/**
 * The maiestro daemon: owns the registry, spawns and supervises agent
 * processes, serves the local HTTP API, and emits change notifications.
 * Runs inside the Electron main process, but is UI-agnostic — the standalone
 * CLI (cli.ts) runs the exact same daemon for headless use and testing.
 */
export class Daemon {
  readonly store: Store
  readonly registry: Registry
  port = 0
  token = ''
  url = ''

  private server: Server
  private notifier: Notifier
  private shimPath: string
  private procs = new Map<string, LineProcess>()
  private terms = new Map<string, TerminalSession>()
  private shellCwdTimer: NodeJS.Timeout | null = null

  constructor(private opts: DaemonOptions = {}) {
    this.store = new Store(opts.dataDir ?? join(homedir(), '.maiestro'))
    this.registry = new Registry(this.store)
    this.notifier = new Notifier(
      opts.notify ?? ((title, body) => console.log('[notify]', title, '—', body)),
      (id) => this.registry.projectName(id),
    )
    this.shimPath = join(this.store.dir, 'bin', 'mcp-permission-shim.cjs')

    this.registry.on('agents', () => opts.onAgentsChanged?.(this.registry.listAgents()))
    this.registry.on('event', (ev) => opts.onAgentEvent?.(ev as AgentEvent))
    this.registry.on('status', ({ agent, from, to }) => this.notifier.onStatus(agent, from, to))
    this.registry.on('projects', () => opts.onProjectsChanged?.(this.registry.listProjects()))

    this.server = new Server(this)
  }

  async start(): Promise<void> {
    let cfg = this.store.loadConfig()
    if (!cfg) {
      cfg = { port: DEFAULT_PORT, token: randomBytes(24).toString('hex') }
      this.store.saveConfig(cfg)
    }
    this.token = cfg.token

    mkdirSync(join(this.store.dir, 'bin'), { recursive: true })
    writeFileSync(this.shimPath, SHIM_SOURCE)

    this.port = await this.server.listen(cfg.port)
    this.url = 'http://127.0.0.1:' + this.port
    if (this.port !== cfg.port) {
      this.store.saveConfig({ port: this.port, token: this.token })
    }
    await this.ensureShellAgent()
    this.shellCwdTimer = setInterval(() => void this.trackShellCwd(), SHELL_CWD_POLL_MS)
  }

  async stopAll(): Promise<void> {
    if (this.shellCwdTimer) {
      clearInterval(this.shellCwdTimer)
      this.shellCwdTimer = null
    }
    // persist where the pinned shell was left so it reopens there
    await this.trackShellCwd()
    // mark it stopped before killing the PTY: the exit handler then skips
    // recording (and notifying) a spurious 'error' on every quit
    for (const a of this.registry.listAgents()) {
      if (a.tool === 'shell') this.registry.setStatus(a.id, 'stopped')
    }
    for (const [id, proc] of this.procs) {
      this.registry.cancelPermissions(id)
      proc.kill()
    }
    this.procs.clear()
    for (const s of this.terms.values()) s.proc?.kill()
    this.terms.clear()
    this.server.close()
  }

  emit(agentId: string, type: AgentEventType, text: string, data?: unknown): void {
    const ev: AgentEvent = {
      id: randomUUID(),
      agentId,
      ts: new Date().toISOString(),
      type,
      text: text.slice(0, 2000),
      data,
    }
    this.registry.appendEvent(ev)
    if (type === 'message' || type === 'blocked' || type === 'error' || type === 'done') {
      this.registry.updateAgent(agentId, { lastMessage: text.slice(0, 200) })
    }
  }

  async spawnAgent(opts: SpawnOptions): Promise<Agent> {
    if (opts.tool !== 'claude' && opts.tool !== 'vibe' && opts.tool !== 'shell') {
      throw new Error('unknown tool: ' + opts.tool)
    }
    const task = opts.task?.trim() ?? ''
    if (!task && opts.options?.mode !== 'terminal') {
      throw new Error('task is required for headless agents')
    }
    const id = randomUUID()
    const project = opts.projectId ? this.registry.getProject(opts.projectId) : undefined
    const cwd = opts.cwd?.trim() || project?.dirs[0] || homedir()
    const agent: Agent = {
      id,
      tool: opts.tool,
      task,
      // no task to identify the agent by: fall back to a generated name
      name: cleanName(opts.name) ?? (task ? null : opts.tool + ' ' + id.slice(0, 8)),
      cwd,
      branch: await gitBranch(cwd),
      projectId: project?.id ?? null,
      status: 'running',
      pid: null,
      sessionId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastMessage: null,
      costUsd: null,
      pendingPermission: null,
      options: opts.options ?? {},
    }
    this.registry.addAgent(agent)
    this.emit(agent.id, 'log', 'Spawned ' + opts.tool + ' in ' + agent.cwd)
    this.startAgentProcess(agent, opts)
    return agent
  }

  /** Starts the agent's CLI process (headless pipes or PTY) and supervises it. */
  private startAgentProcess(agent: Agent, opts: SpawnOptions): void {
    try {
      const ctx = this.adapterCtx()
      const proc =
        opts.options?.mode === 'terminal'
          ? startPtyAgent(agent, opts, ctx, {
              onData: (chunk) => this.pushTerminalData(agent.id, chunk),
            })
          : opts.tool === 'claude'
            ? startClaudeAgent(agent, opts, ctx)
            : startVibeAgent(agent, opts, ctx)
      this.procs.set(agent.id, proc)
      proc.onExit(() => this.procs.delete(agent.id))
      if (opts.options?.mode === 'terminal') {
        const session = this.terms.get(agent.id) ?? { proc: null, buffer: '', seq: 0 }
        session.proc = proc as PtyProcess
        this.terms.set(agent.id, session)
      }
    } catch (e) {
      this.emit(agent.id, 'error', 'Failed to spawn: ' + (e as Error).message)
      this.registry.setStatus(agent.id, 'error')
    }
  }

  async stopAgent(id: string): Promise<void> {
    const agent = this.registry.getAgent(id)
    if (!agent) throw new Error('agent not found')
    this.registry.cancelPermissions(id)
    this.procs.get(id)?.kill()
    this.registry.setStatus(id, 'stopped', { pendingPermission: null })
    this.emit(id, 'log', 'Stopped by user')
  }

  /**
   * The pinned `cli` pane: a plain shell shown in the agent list like an
   * agent, labelled `cli`, that cannot be closed and reopens where it was
   * left. Created once (at the process cwd — home when the app is launched
   * from the Finder with cwd "/") and restarted in its recorded cwd on
   * every daemon start.
   */
  private async ensureShellAgent(): Promise<void> {
    const shell = this.registry.listAgents().find((a) => a.tool === 'shell')
    if (!shell) {
      const cwd = process.cwd() === '/' ? homedir() : process.cwd()
      await this.spawnAgent({
        tool: 'shell',
        name: SHELL_NAME,
        task: '',
        cwd,
        projectId: null,
        options: { mode: 'terminal' },
      })
      return
    }
    if (shell.status === 'running') return
    this.restartShell(shell)
  }

  /** (Re)starts the pinned shell's PTY in its recorded working directory. */
  private restartShell(agent: Agent): void {
    this.registry.setStatus(agent.id, 'running', { endedAt: null, lastMessage: null })
    this.startAgentProcess(agent, {
      tool: 'shell',
      task: '',
      cwd: agent.cwd,
      projectId: agent.projectId,
      options: { ...agent.options, mode: 'terminal' },
    })
  }

  /**
   * Keeps the shell agent's recorded cwd in sync with the live shell process
   * so a restart (or the next app launch) reopens where the user left it.
   */
  private async trackShellCwd(): Promise<void> {
    for (const agent of this.registry.listAgents()) {
      if (agent.tool !== 'shell' || !agent.pid || agent.status !== 'running') continue
      const cwd = processCwd(agent.pid)
      if (!cwd || cwd === agent.cwd) continue
      this.registry.updateAgent(agent.id, { cwd, branch: await gitBranch(cwd) })
    }
  }

  /**
   * Resumes the agent's latest CLI session in place: instead of replaying the
   * original request, the recorded session is reopened with `--resume` and a
   * follow-up prompt. For vibe agents recorded before session tracking
   * existed, falls back to the newest vibe session logged for the agent's
   * working directory.
   */
  async resumeAgent(id: string, message?: string, optionsOverride?: SpawnOptions['options']): Promise<Agent> {
    const agent = this.registry.getAgent(id)
    if (!agent) throw new Error('agent not found')
    if (agent.status === 'running' || agent.status === 'blocked') {
      throw new Error('agent is still running')
    }
    if (agent.tool === 'shell') {
      // the cli pane has no CLI session to resume — just restart the shell
      this.emit(id, 'log', 'Restarting shell in ' + agent.cwd)
      this.restartShell(agent)
      return this.registry.getAgent(id)!
    }
    const sessionId =
      agent.sessionId ?? (agent.tool === 'vibe' ? this.latestVibeSession(agent.cwd) : null)
    if (!sessionId) throw new Error('no recorded session to resume — run the agent once first')
    const prompt = message?.trim() || 'continue'
    this.registry.setStatus(id, 'running', { pendingPermission: null, endedAt: null })
    this.emit(id, 'log', 'Resuming session ' + sessionId.slice(0, 8) + ': ' + prompt)
    this.startAgentProcess(agent, {
      tool: agent.tool,
      task: agent.task,
      cwd: agent.cwd,
      projectId: agent.projectId,
      options: { ...agent.options, ...optionsOverride },
      resumeSessionId: sessionId,
      resumePrompt: prompt,
    })
    return this.registry.getAgent(id)!
  }

  /**
   * Newest vibe session id recorded for a working directory, or null. Covers
   * both session-store layouts (legacy `session_*` dirs and unified-harness
   * `unified/<uuid>` dirs, each with a `meta.json` recording the cwd).
   */
  private latestVibeSession(cwd: string): string | null {
    const norm = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    const sessionDir = join(process.env.VIBE_HOME ?? join(homedir(), '.vibe'), 'logs', 'session')
    const target = norm(cwd)
    let dirs: string[] = []
    try {
      dirs = readdirSync(sessionDir).map((entry) => join(sessionDir, entry))
      dirs.push(...readdirSync(join(sessionDir, 'unified')).map((entry) => join(sessionDir, 'unified', entry)))
    } catch {
      // no vibe session directory
      return null
    }
    let best: { id: string; started: string } | null = null
    for (const dir of dirs) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
        if (typeof meta?.session_id !== 'string') continue
        if (norm(String(meta?.environment?.working_directory ?? '')) !== target) continue
        const started = typeof meta.start_time === 'string' ? meta.start_time : ''
        if (!best || started > best.started) best = { id: meta.session_id, started }
      } catch {
        // not a session dir / unreadable meta — skip it
      }
    }
    return best?.id ?? null
  }

  /** Sets or clears the user-given name of an agent. */
  renameAgent(id: string, name: string): Agent {
    const agent = this.registry.getAgent(id)
    if (!agent) throw new Error('agent not found')
    if (agent.tool === 'shell') throw new Error('the cli pane cannot be renamed')
    const clean = cleanName(name)
    if (clean === agent.name) return agent
    this.registry.updateAgent(id, { name: clean })
    this.emit(id, 'log', clean ? 'Renamed to ' + clean : 'Name cleared')
    return this.registry.getAgent(id)!
  }

  decidePermission(agentId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string): void {
    const ok = this.registry.decidePermission(toolUseId, decision, message)
    if (!ok) throw new Error('no pending permission with id ' + toolUseId)
    this.emit(agentId, 'log', 'Permission ' + decision + ' (' + toolUseId.slice(0, 12) + '...)')
  }

  /**
   * A lifecycle event from a terminal-mode Claude Code agent's hooks (the TUI
   * emits no status markers of its own). Maps hook events to the registry's
   * turn-level status: prompt -> running, permission needed -> blocked, tool
   * ran -> running again, turn complete -> done.
   */
  handleAgentHook(agentId: string, payload: unknown): void {
    const agent = this.registry.getAgent(agentId)
    if (!agent || typeof payload !== 'object' || payload === null) return
    const p = payload as Record<string, unknown>
    const event = typeof p.hook_event_name === 'string' ? p.hook_event_name : ''
    switch (event) {
      case 'SessionStart':
        if (typeof p.session_id === 'string') {
          this.registry.updateAgent(agentId, { sessionId: p.session_id })
        }
        break
      case 'UserPromptSubmit':
        if (agent.status === 'done' || agent.status === 'blocked') {
          this.emit(agentId, 'log', 'turn started')
          this.registry.setStatus(agentId, 'running', { endedAt: null })
        }
        break
      case 'Notification': {
        const message = typeof p.message === 'string' ? p.message : ''
        // only permission requests mean "blocked"; idle notifications don't
        if (message.toLowerCase().includes('permission') && agent.status === 'running') {
          this.emit(agentId, 'blocked', message, payload)
          this.registry.setStatus(agentId, 'blocked')
        }
        break
      }
      case 'PostToolUse':
        // a tool ran, so any permission prompt was answered in the terminal
        if (agent.status === 'blocked') {
          this.registry.setStatus(agentId, 'running', { pendingPermission: null })
        }
        break
      case 'Stop':
        if (agent.status === 'running' || agent.status === 'blocked') {
          this.emit(agentId, 'done', 'turn complete')
          this.registry.setStatus(agentId, 'done')
        }
        break
      default:
        break
    }
  }

  /** Stops the agent if needed and removes it (and its events) from the console. */
  removeAgent(id: string): void {
    const agent = this.registry.getAgent(id)
    if (!agent) throw new Error('agent not found')
    if (agent.tool === 'shell') throw new Error('the cli pane cannot be closed')
    this.registry.cancelPermissions(id)
    this.procs.get(id)?.kill()
    const proc = this.terms.get(id)?.proc
    proc?.kill()
    this.terms.delete(id)
    this.registry.removeAgent(id)
    this.store.deleteEvents(id)
  }

  /**
   * Embedded-terminal plumbing: the renderer attaches when the agent's detail
   * view opens, receives the buffered scrollback plus the last sequence
   * number, and then consumes live chunks with higher sequence numbers.
   */
  attachTerminal(agentId: string): { buffer: string; seq: number } | null {
    const s = this.terms.get(agentId)
    if (!s) return null
    return { buffer: s.buffer, seq: s.seq }
  }

  writeTerminal(agentId: string, data: string): void {
    this.terms.get(agentId)?.proc?.write(data)
  }

  resizeTerminal(agentId: string, cols: number, rows: number): void {
    this.terms.get(agentId)?.proc?.resize(cols, rows)
  }

  private pushTerminalData(agentId: string, chunk: string): void {
    let s = this.terms.get(agentId)
    if (!s) {
      s = { proc: null, buffer: '', seq: 0 }
      this.terms.set(agentId, s)
    }
    s.seq += 1
    s.buffer = (s.buffer + chunk).slice(-TERMINAL_BUFFER_MAX)
    this.opts.onTerminalData?.(agentId, chunk, s.seq)
  }

  getEvents(agentId: string): AgentEvent[] {
    return this.store.readEvents(agentId)
  }

  listProjects(): Project[] {
    return this.registry.listProjects()
  }

  createProject(name: string, dirs: string[]): Project {
    return this.registry.createProject(name, dirs)
  }

  updateProjectDirs(id: string, dirs: string[]): Project {
    return this.registry.updateProjectDirs(id, dirs)
  }

  deleteProject(id: string): void {
    this.registry.deleteProject(id)
  }

  private adapterCtx(): AdapterContext {
    return {
      registry: this.registry,
      emit: (agentId, type, text, data) => this.emit(agentId, type, text, data),
      shimPath: this.shimPath,
      daemonUrl: this.url,
      daemonToken: this.token,
      dataDir: this.store.dir,
    }
  }
}
