import type {
  Agent,
  AgentEvent,
  Project,
  ProjectPRs,
  SpawnOptions,
  TerminalAttach,
} from './types'

interface MaiestroApi {
  listAgents(): Promise<Agent[]>
  spawnAgent(opts: SpawnOptions): Promise<Agent>
  stopAgent(id: string): Promise<void>
  removeAgent(id: string): Promise<void>
  renameAgent(id: string, name: string): Promise<Agent>
  relaunchAgent(id: string, options?: SpawnOptions['options']): Promise<Agent>
  decidePermission(
    agentId: string,
    toolUseId: string,
    decision: 'allow' | 'deny',
    message?: string,
  ): Promise<void>
  getEvents(agentId: string): Promise<AgentEvent[]>
  attachTerminal(agentId: string): Promise<TerminalAttach | null>
  writeTerminal(agentId: string, data: string): Promise<void>
  resizeTerminal(agentId: string, cols: number, rows: number): Promise<void>
  listProjects(): Promise<Project[]>
  createProject(name: string, dirs: string[]): Promise<Project>
  deleteProject(id: string): Promise<void>
  listProjectPRs(projectId: string): Promise<ProjectPRs>
  openExternal(url: string): Promise<void>
  pickDirectory(): Promise<string | null>
  onAgentsChanged(cb: (agents: Agent[]) => void): () => void
  onAgentEvent(cb: (ev: AgentEvent) => void): () => void
  onProjectsChanged(cb: (projects: Project[]) => void): () => void
  onTerminalData(cb: (agentId: string, data: string, seq: number) => void): () => void
}

declare global {
  interface Window {
    maiestro: MaiestroApi
  }
}

export const api: MaiestroApi = window.maiestro
