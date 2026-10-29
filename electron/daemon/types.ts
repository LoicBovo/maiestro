export type AgentTool = 'claude' | 'vibe'

export type AgentStatus = 'running' | 'blocked' | 'done' | 'error' | 'stopped'

export interface PendingPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

/** A user-defined pool that groups agents and terminals around one codebase. */
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
  /** user-given label; null means the agent is only identified by its task */
  name: string | null
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
  /** transient: a permission request awaiting a user decision (Claude) */
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
  /** human-readable one-liner for the log view */
  text: string
  /** structured payload (tool input, raw event, ...) */
  data?: unknown
}

export interface SpawnOptions {
  tool: AgentTool
  task: string
  /** optional user-given label for the agent */
  name?: string
  cwd: string
  /** null or omitted: open the agent solo (no project) */
  projectId?: string | null
  options?: {
    /** where the agent runs: headless pipes (tracked in the GUI) or an
     *  embedded interactive terminal rendered in the agent's detail pane */
    mode?: 'headless' | 'terminal'
    /** vibe approval policy: ask | plan | accept-edits | smart-approve | auto-approve */
    vibeAgent?: string
    maxTurns?: number
    model?: string
  }
}

export interface PermissionRequest {
  agentId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
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

export type TerminalStatus = 'running' | 'exited'

/** An interactive CLI pane (PTY-backed shell) attached to a project. */
export interface TerminalSession {
  id: string
  projectId: string | null
  title: string
  cwd: string
  pid: number | null
  createdAt: string
  status: TerminalStatus
  exitCode: number | null
}

export interface TerminalSpawnOptions {
  projectId?: string | null
  cwd: string
  title?: string
  shell?: string
  cols?: number
  rows?: number
}
