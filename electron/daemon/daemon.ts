import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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

/** Scrollback kept per embedded-terminal agent (chars). */
const TERMINAL_BUFFER_MAX = 256_000

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
  }

  async stopAll(): Promise<void> {
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
    if (!opts.task?.trim()) throw new Error('task is required')
    if (opts.tool !== 'claude' && opts.tool !== 'vibe') throw new Error('unknown tool: ' + opts.tool)
    const project = opts.projectId ? this.registry.getProject(opts.projectId) : undefined
    const cwd = opts.cwd?.trim() || project?.dirs[0] || homedir()
    const agent: Agent = {
      id: randomUUID(),
      tool: opts.tool,
      task: opts.task,
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
    return agent
  }

  async stopAgent(id: string): Promise<void> {
    const agent = this.registry.getAgent(id)
    if (!agent) throw new Error('agent not found')
    this.registry.cancelPermissions(id)
    this.procs.get(id)?.kill()
    this.registry.setStatus(id, 'stopped', { pendingPermission: null })
    this.emit(id, 'log', 'Stopped by user')
  }

  async relaunchAgent(id: string, optionsOverride?: SpawnOptions['options']): Promise<Agent> {
    const old = this.registry.getAgent(id)
    if (!old) throw new Error('agent not found')
    return this.spawnAgent({
      tool: old.tool,
      task: old.task,
      cwd: old.cwd,
      projectId: old.projectId,
      options: { ...old.options, ...optionsOverride },
    })
  }

  decidePermission(agentId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string): void {
    const ok = this.registry.decidePermission(toolUseId, decision, message)
    if (!ok) throw new Error('no pending permission with id ' + toolUseId)
    this.emit(agentId, 'log', 'Permission ' + decision + ' (' + toolUseId.slice(0, 12) + '...)')
  }

  /** Stops the agent if needed and removes it (and its events) from the console. */
  removeAgent(id: string): void {
    const agent = this.registry.getAgent(id)
    if (!agent) throw new Error('agent not found')
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
