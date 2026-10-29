import type { Agent } from './types'

export type NotifyFn = (title: string, body: string) => void

function shortTask(agent: Agent): string {
  const t = agent.task.length > 60 ? agent.task.slice(0, 57) + '...' : agent.task
  return t
}

/** Identifies the agent in a notification: the user-given name if any. */
function label(agent: Agent): string {
  return '[' + agent.tool + '] ' + (agent.name ?? shortTask(agent))
}

/**
 * Turns agent status transitions into OS notifications.
 * The actual delivery mechanism (Electron Notification, osascript, console)
 * is injected by the host.
 */
export class Notifier {
  constructor(private notify: NotifyFn, private projectName: (id: string | null) => string | null = () => null) {}

  onStatus(agent: Agent, from: string, to: string): void {
    if (from === to) return
    const tag = label(agent)
    const project = this.projectName(agent.projectId) ?? 'solo'
    switch (to) {
      case 'blocked':
        this.notify('Agent blocked — ' + project, tag + ' needs a decision')
        break
      case 'done':
        this.notify('Agent done — ' + project, tag)
        break
      case 'error':
        this.notify('Agent error — ' + project, tag + (agent.lastMessage ? ': ' + agent.lastMessage.slice(0, 120) : ''))
        break
      default:
        break
    }
  }
}
