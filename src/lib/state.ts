import { derived, get, writable } from 'svelte/store'
import { api } from './api'
import type { Agent, AgentEvent, AgentStatus, AgentTool, Project } from './types'

/** 'all' = every agent, 'solo' = agents without a project, otherwise a project id */
export type ProjectFilter = 'all' | 'solo' | string

export const agents = writable<Agent[]>([])
export const projects = writable<Project[]>([])
export const eventsByAgent = writable<Record<string, AgentEvent[]>>({})
export const selectedId = writable<string | null>(null)
export const projectFilter = writable<ProjectFilter>('all')
export const toolFilter = writable<'all' | AgentTool>('all')
export const statusFilter = writable<'all' | AgentStatus>('all')

export const selectedAgent = derived(
  [agents, selectedId],
  ([$agents, $selectedId]) => $agents.find((a) => a.id === $selectedId) ?? null,
)

export const selectedEvents = derived(
  [eventsByAgent, selectedId],
  ([$events, $selectedId]) => ($selectedId ? $events[$selectedId] ?? [] : []),
)

export const visibleAgents = derived(
  [agents, projectFilter, toolFilter, statusFilter],
  ([$agents, $project, $tool, $status]) =>
    $agents.filter(
      (a) =>
        ($project === 'all' ||
          ($project === 'solo' ? a.projectId == null : a.projectId === $project)) &&
        ($tool === 'all' || a.tool === $tool) &&
        ($status === 'all' || a.status === $status),
    ),
)

export function projectName(id: string | null): string | null {
  if (id == null) return null
  return get(projects).find((p) => p.id === id)?.name ?? null
}

export function selectAgent(id: string): void {
  selectedId.set(id)
  api.getEvents(id).then((events) => {
    eventsByAgent.update((m) => ({ ...m, [id]: events }))
  })
}

/** Stops the agent if needed and removes it (and its events) from the console. */
export async function removeAgent(id: string): Promise<void> {
  const agent = get(agents).find((a) => a.id === id)
  if (agent && (agent.status === 'running' || agent.status === 'blocked')) {
    try {
      await api.stopAgent(id)
    } catch {
      // it may have exited on its own in the meantime; removal proceeds
    }
  }
  await api.removeAgent(id)
  agents.update((list) => list.filter((a) => a.id !== id))
  eventsByAgent.update((m) => {
    const { [id]: _gone, ...rest } = m
    return rest
  })
  if (get(selectedId) === id) selectedId.set(null)
}

/** Renames an agent; the agents store refreshes via the agents:changed push. */
export async function renameAgent(id: string, name: string): Promise<void> {
  await api.renameAgent(id, name)
}

export async function createProject(name: string, dirs: string[]): Promise<void> {
  const project = await api.createProject(name, dirs)
  projects.update((list) => [...list, project])
}

export async function deleteProject(id: string): Promise<void> {
  await api.deleteProject(id)
  projects.update((list) => list.filter((p) => p.id !== id))
  if (get(projectFilter) === id) projectFilter.set('all')
}

export async function init(): Promise<void> {
  const [list, projectList] = await Promise.all([api.listAgents(), api.listProjects()])
  agents.set(list)
  projects.set(projectList)
  if (list.length > 0 && !list.some((a) => a.id === get(selectedId))) {
    selectAgent(list[0].id)
  }
  api.onAgentsChanged((next) => {
    agents.set(next)
    const sel = next.find((a) => a.id === get(selectedId))
    if (sel && !get(eventsByAgent)[sel.id]) selectAgent(sel.id)
  })
  api.onProjectsChanged((next) => {
    projects.set(next)
    const filter = get(projectFilter)
    if (filter !== 'all' && filter !== 'solo' && !next.some((p) => p.id === filter)) {
      projectFilter.set('all')
    }
  })
  api.onAgentEvent((ev) => {
    eventsByAgent.update((m) => {
      const arr = m[ev.agentId] ?? []
      if (arr.some((e) => e.id === ev.id)) return m
      return { ...m, [ev.agentId]: [...arr, ev] }
    })
  })
}
