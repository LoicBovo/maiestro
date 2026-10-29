import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, AgentEvent, Project } from './types'

export interface DaemonConfig {
  port: number
  token: string
}

/**
 * JSON-file persistence. Deliberately dependency-free (no native SQLite):
 * agents.json is small, events.jsonl is append-only.
 */
export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path(name), 'utf8')) as T
    } catch {
      return fallback
    }
  }

  /**
   * Crash-safe write: a partial write lands in the temp file, so a crash or
   * force-quit can never truncate the real file and wipe the saved state.
   */
  private writeJson(name: string, data: unknown): void {
    const tmp = this.path(name + '.tmp')
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, this.path(name))
  }

  loadAgents(): Agent[] {
    return this.readJson<Agent[]>('agents.json', [])
  }

  saveAgents(agents: Agent[]): void {
    this.writeJson('agents.json', agents)
  }

  appendEvent(ev: AgentEvent): void {
    appendFileSync(this.path('events.jsonl'), JSON.stringify(ev) + '\n')
  }

  readEvents(agentId?: string): AgentEvent[] {
    if (!existsSync(this.path('events.jsonl'))) return []
    const out: AgentEvent[] = []
    for (const line of readFileSync(this.path('events.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as AgentEvent
        if (!agentId || ev.agentId === agentId) out.push(ev)
      } catch {
        // skip unparseable line
      }
    }
    return out
  }

  /** Rewrites events.jsonl without the given agent's events. */
  deleteEvents(agentId: string): void {
    if (!existsSync(this.path('events.jsonl'))) return
    const kept = this.readEvents().filter((ev) => ev.agentId !== agentId)
    const tmp = this.path('events.jsonl.tmp')
    writeFileSync(tmp, kept.map((ev) => JSON.stringify(ev) + '\n').join(''))
    renameSync(tmp, this.path('events.jsonl'))
  }

  loadProjects(): Project[] {
    return this.readJson<Project[]>('projects.json', [])
  }

  saveProjects(projects: Project[]): void {
    this.writeJson('projects.json', projects)
  }

  loadConfig(): DaemonConfig | null {
    return this.readJson<DaemonConfig | null>('config.json', null)
  }

  saveConfig(cfg: DaemonConfig): void {
    this.writeJson('config.json', cfg)
  }
}
