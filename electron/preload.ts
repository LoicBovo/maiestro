import { contextBridge, ipcRenderer } from 'electron'
import type { Agent, AgentEvent, Project, ProjectPRs, SpawnOptions } from './daemon/types'

export interface TerminalAttach {
  buffer: string
  seq: number
}

const api = {
  listAgents: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list'),
  spawnAgent: (opts: SpawnOptions): Promise<Agent> => ipcRenderer.invoke('agents:spawn', opts),
  stopAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:stop', id),
  removeAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:remove', id),
  renameAgent: (id: string, name: string): Promise<Agent> =>
    ipcRenderer.invoke('agents:rename', id, name),
  relaunchAgent: (id: string, options?: SpawnOptions['options']): Promise<Agent> =>
    ipcRenderer.invoke('agents:relaunch', id, options),
  decidePermission: (
    agentId: string,
    toolUseId: string,
    decision: 'allow' | 'deny',
    message?: string,
  ): Promise<void> => ipcRenderer.invoke('agents:permission', agentId, toolUseId, decision, message),
  getEvents: (agentId: string): Promise<AgentEvent[]> => ipcRenderer.invoke('agents:events', agentId),
  attachTerminal: (agentId: string): Promise<TerminalAttach | null> =>
    ipcRenderer.invoke('terminal:attach', agentId),
  writeTerminal: (agentId: string, data: string): Promise<void> =>
    ipcRenderer.invoke('terminal:write', agentId, data),
  resizeTerminal: (agentId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', agentId, cols, rows),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  createProject: (name: string, dirs: string[]): Promise<Project> =>
    ipcRenderer.invoke('projects:create', name, dirs),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  listProjectPRs: (projectId: string): Promise<ProjectPRs> =>
    ipcRenderer.invoke('projects:open-prs', projectId),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory'),
  onAgentsChanged: (cb: (agents: Agent[]) => void): (() => void) => {
    const listener = (_e: unknown, agents: Agent[]) => cb(agents)
    ipcRenderer.on('agents:changed', listener)
    return () => ipcRenderer.removeListener('agents:changed', listener)
  },
  onProjectsChanged: (cb: (projects: Project[]) => void): (() => void) => {
    const listener = (_e: unknown, projects: Project[]) => cb(projects)
    ipcRenderer.on('projects:changed', listener)
    return () => ipcRenderer.removeListener('projects:changed', listener)
  },
  onAgentEvent: (cb: (ev: AgentEvent) => void): (() => void) => {
    const listener = (_e: unknown, ev: AgentEvent) => cb(ev)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  onTerminalData: (cb: (agentId: string, data: string, seq: number) => void): (() => void) => {
    const listener = (_e: unknown, agentId: string, data: string, seq: number) =>
      cb(agentId, data, seq)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
}

contextBridge.exposeInMainWorld('maiestro', api)

export type MaiestroApi = typeof api
