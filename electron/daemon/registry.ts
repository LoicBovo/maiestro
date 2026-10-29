import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Store } from './store'
import type {
  Agent,
  AgentEvent,
  AgentStatus,
  PendingPermission,
  PermissionRequest,
  Project,
} from './types'

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000

interface PendingEntry {
  req: PermissionRequest
  resolve: (d: PermissionDecision) => void
  timer: NodeJS.Timeout
}

/**
 * In-memory agent registry. Single source of truth for the GUI; persists
 * through Store. Emits:
 *  - 'agents'  : agent records changed (any field)
 *  - 'event'   : a new AgentEvent was appended
 *  - 'status'  : { agent, from, to } on status transitions (drives notifications)
 */
export class Registry extends EventEmitter {
  private agents = new Map<string, Agent>()
  private projects = new Map<string, Project>()
  private pending = new Map<string, PendingEntry>()

  constructor(private store: Store) {
    super()
    let dirty = false
    for (const a of store.loadAgents()) {
      if (a.projectId == null) a.projectId = null
      // pre-branch persisted agents have no branch recorded
      if (a.branch === undefined) a.branch = null
      // pre-name entries: normalize a missing name to null
      if (a.name == null) a.name = null
      // child processes don't survive a daemon restart
      if (a.status === 'running' || a.status === 'blocked') {
        a.status = 'stopped'
        a.endedAt = a.endedAt ?? new Date().toISOString()
        a.lastMessage = a.lastMessage
          ? a.lastMessage + ' (daemon restarted)'
          : 'daemon restarted'
        dirty = true
      }
      a.pendingPermission = null
      this.agents.set(a.id, a)
    }
    for (const p of store.loadProjects()) this.projects.set(p.id, p)
    let projectsDirty = false
    for (const p of store.loadProjects()) {
      // migrate pre-list entries that only had a single cwd
      if (!p.dirs) {
        const legacy = p as Project & { cwd?: string }
        p.dirs = legacy.cwd ? [legacy.cwd] : []
        projectsDirty = true
      }
      this.projects.set(p.id, p)
    }
    if (projectsDirty) store.saveProjects(this.listProjects())
    if (dirty) store.saveAgents(this.listAgents())
  }

  listProjects(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id)
  }

  createProject(name: string, dirs: string[]): Project {
    const clean = name.trim()
    if (!clean) throw new Error('project name is required')
    const cleanDirs = [...new Set(dirs.map((d) => d?.trim() ?? '').filter(Boolean))]
    if (cleanDirs.length === 0) throw new Error('a main folder is required')
    const project: Project = {
      id: randomUUID(),
      name: clean,
      dirs: cleanDirs,
      createdAt: new Date().toISOString(),
    }
    this.projects.set(project.id, project)
    this.store.saveProjects(this.listProjects())
    this.emit('projects')
    return project
  }

  deleteProject(id: string): void {
    if (!this.projects.delete(id)) return
    for (const a of this.agents.values()) {
      if (a.projectId === id) this.updateAgent(a.id, { projectId: null })
    }
    this.store.saveProjects(this.listProjects())
    this.emit('projects')
  }

  projectName(id: string | null): string | null {
    if (id == null) return null
    return this.projects.get(id)?.name ?? null
  }

  listAgents(): Agent[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  addAgent(agent: Agent): void {
    this.agents.set(agent.id, agent)
    this.persist()
    this.emit('agents')
  }

  updateAgent(id: string, patch: Partial<Agent>): void {
    const a = this.agents.get(id)
    if (!a) return
    Object.assign(a, patch)
    this.persist()
    this.emit('agents')
  }

  /** Drops the agent from the registry (the caller handles the process/events). */
  removeAgent(id: string): boolean {
    const existed = this.agents.delete(id)
    if (!existed) return false
    this.persist()
    this.emit('agents')
    return true
  }

  setStatus(id: string, status: AgentStatus, extra: Partial<Agent> = {}): void {    const a = this.agents.get(id)
    if (!a) return
    const from = a.status
    if (from === status) {
      if (Object.keys(extra).length > 0) this.updateAgent(id, extra)
      return
    }
    if (status === 'done' || status === 'error' || status === 'stopped') {
      extra.endedAt = new Date().toISOString()
    }
    Object.assign(a, extra, { status })
    this.persist()
    this.emit('agents')
    this.emit('status', { agent: a, from, to: status })
  }

  appendEvent(ev: AgentEvent): void {
    this.store.appendEvent(ev)
    this.emit('event', ev)
  }

  /**
   * Called when an agent (via the MCP shim) asks for a permission decision.
   * Marks the agent blocked; resolves once the user decides or on timeout.
   */
  requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const finish = (d: PermissionDecision) => {
        clearTimeout(entry.timer)
        this.pending.delete(req.toolUseId)
        resolve(d)
      }
      const entry: PendingEntry = {
        req,
        resolve: finish,
        timer: setTimeout(() => {
          finish({ behavior: 'deny', message: 'Timed out waiting for a decision' })
          this.setStatus(req.agentId, 'running', { pendingPermission: null })
        }, PERMISSION_TIMEOUT_MS),
      }
      this.pending.set(req.toolUseId, entry)
      const pendingPermission: PendingPermission = {
        toolUseId: req.toolUseId,
        toolName: req.toolName,
        input: req.input,
      }
      this.setStatus(req.agentId, 'blocked', { pendingPermission })
    })
  }

  decidePermission(toolUseId: string, decision: 'allow' | 'deny', message?: string): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    p.resolve(
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: p.req.input }
        : { behavior: 'deny', message: message ?? 'Denied from Maiestro' },
    )
    const agent = this.agents.get(p.req.agentId)
    if (agent) this.setStatus(agent.id, 'running', { pendingPermission: null })
    return true
  }

  cancelPermission(toolUseId: string): void {
    const p = this.pending.get(toolUseId)
    if (p) p.resolve({ behavior: 'deny', message: 'Agent stopped' })
  }

  cancelPermissions(agentId: string): void {
    for (const [toolUseId, p] of [...this.pending]) {
      if (p.req.agentId === agentId) p.resolve({ behavior: 'deny', message: 'Agent stopped' })
    }
  }

  private persist(): void {
    this.store.saveAgents(this.listAgents())
  }
}

export function newEventId(): string {
  return randomUUID()
}
