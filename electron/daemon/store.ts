import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  private writeJson(name: string, data: unknown): void {
    writeFileSync(this.path(name), JSON.stringify(data, null, 2))
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
    writeFileSync(
      this.path('events.jsonl'),
      kept.map((ev) => JSON.stringify(ev) + '\n').join(''),
    )
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
