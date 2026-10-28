import type { Agent } from './types'

export type NotifyFn = (title: string, body: string) => void

function shortTask(agent: Agent): string {
  const t = agent.task.length > 60 ? agent.task.slice(0, 57) + '...' : agent.task
  return t
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
    const label = '[' + agent.tool + '] ' + shortTask(agent)
    const project = this.projectName(agent.projectId) ?? 'solo'
    switch (to) {
      case 'blocked':
        this.notify('Agent blocked — ' + project, label + ' needs a decision')
        break
      case 'done':
        this.notify('Agent done — ' + project, label)
        break
      case 'error':
        this.notify('Agent error — ' + project, label + (agent.lastMessage ? ': ' + agent.lastMessage.slice(0, 120) : ''))
        break
      default:
        break
    }
  }
}
