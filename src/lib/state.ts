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

const PRS_PANE_KEY = 'maiestro:prsPaneOpen'

/** Whether the Open PRs pane is expanded (persisted across launches). */
export const prsPaneOpen = writable(true)

/** Opens/closes the Open PRs pane and resizes the window accordingly. */
export function togglePrsPane(open: boolean): void {
  prsPaneOpen.set(open)
  try {
    localStorage.setItem(PRS_PANE_KEY, String(open))
  } catch {
    // storage unavailable — keep the in-memory state only
  }
  void api.setPrsPane(open)
}

/** Restores the persisted pane state and syncs the window size to match. */
export function restorePrsPane(): void {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(PRS_PANE_KEY)
  } catch {
    // ignore — fall back to open
  }
  prsPaneOpen.set(saved !== 'false')
  void api.setPrsPane(saved !== 'false')
}

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

function matchesFilter(a: Agent, filter: ProjectFilter): boolean {
  return (
    filter === 'all' || (filter === 'solo' ? a.projectId == null : a.projectId === filter)
  )
}

/**
 * Switches the project filter and makes the agent view follow: the latest
 * (most recently started) agent of the new filter is selected, unless the
 * current selection already matches. Selection is cleared when no agent matches.
 */
export function setProjectFilter(filter: ProjectFilter): void {
  projectFilter.set(filter)
  const list = get(agents)
  const sel = list.find((a) => a.id === get(selectedId))
  if (sel && matchesFilter(sel, filter)) return
  const latest = list
    .filter((a) => matchesFilter(a, filter))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]
  if (latest) selectAgent(latest.id)
  else selectedId.set(null)
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
  if (get(projectFilter) === id) setProjectFilter('all')
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
      setProjectFilter('all')
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
