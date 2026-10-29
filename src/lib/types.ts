export type AgentTool = 'claude' | 'vibe'

export type AgentStatus = 'running' | 'blocked' | 'done' | 'error' | 'stopped'

export interface PendingPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

/** A user-defined group of agents. */
export interface Project {
  id: string
  name: string
  /** working directories of the project; dirs[0] is the main folder */
  dirs: string[]
  createdAt: string
}

export interface Agent {
  id: string
  tool: AgentTool
  task: string
  cwd: string
  /** git branch of cwd at spawn time; null when cwd is not a git repo */
  branch: string | null
  /** the project this agent belongs to; null means the agent is open solo */
  projectId: string | null
  status: AgentStatus
  pid: number | null
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  lastMessage: string | null
  costUsd: number | null
  pendingPermission: PendingPermission | null
  options: SpawnOptions['options']
}

export type AgentEventType =
  | 'tool_use'
  | 'tool_result'
  | 'message'
  | 'blocked'
  | 'done'
  | 'error'
  | 'log'

export interface AgentEvent {
  id: string
  agentId: string
  ts: string
  type: AgentEventType
  text: string
  data?: unknown
}

export interface SpawnOptions {
  tool: AgentTool
  task: string
  cwd: string
  /** null or omitted: open the agent solo (no project) */
  projectId?: string | null
  options?: {
    mode?: 'headless' | 'terminal'
    vibeAgent?: string
    maxTurns?: number
    model?: string
  }
}

/** An open pull request in one of a project's repositories (via `gh`). */
export interface PullRequest {
  /** "owner/repo" of the GitHub repository */
  repo: string
  number: number
  title: string
  /** head branch the PR wants to merge */
  branch: string
  author: string
  url: string
  isDraft: boolean
  updatedAt: string
  /** project directory this PR was found in */
  dir: string
}

/** Result of scanning a project's directories for open pull requests. */
export interface ProjectPRs {
  projectId: string
  prs: PullRequest[]
  /** per-directory failures (no `gh`, not a repo, no auth, ...) */
  errors: { dir: string; message: string }[]
}

/** Scrollback snapshot returned when the renderer attaches to an embedded terminal. */
export interface TerminalAttach {
  buffer: string
  /** sequence number of the last chunk in `buffer` */
  seq: number
}
