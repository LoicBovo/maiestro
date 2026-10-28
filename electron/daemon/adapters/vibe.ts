import { spawnLineProcess, type LineProcess } from '../process'
import type { Agent, AgentEventType, SpawnOptions } from '../types'
import type { AdapterContext } from './claude'

const DEFAULT_MAX_TURNS = 25

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('')
}

function handleLine(agent: Agent, line: string, ctx: AdapterContext, policy: string): void {
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    // vibe occasionally writes non-JSON lines (e.g. a trailing "Error:")
    ctx.emit(agent.id, 'log', line.slice(0, 300))
    return
  }
  switch (d.type) {
    case 'message':
      if (d.role === 'assistant') {
        const text = textOf(d.content)
        if (text) {
          ctx.emit(agent.id, 'message', text)
          ctx.registry.updateAgent(agent.id, { lastMessage: text.slice(0, 200) })
        }
      }
      break
    case 'effect': {
      const title: string = d.title ?? d.detail?.toolName ?? 'effect'
      const state = d.state ?? {}
      if (state.status === 'failed') {
        const code = state.error?.code
        if (code === 'tool_denied') {
          // headless vibe auto-denies approvals when the policy asks; the run
          // keeps going, so flag it blocked and let the user stop/relaunch
          ctx.emit(
            agent.id,
            'blocked',
            'Permission denied for ' + title + ' (approval policy: ' + policy + ')',
            d,
          )
          const a = ctx.registry.getAgent(agent.id)
          if (a && a.status === 'running') ctx.registry.setStatus(agent.id, 'blocked')
        } else {
          ctx.emit(agent.id, 'log', '[tool error] ' + title + ': ' + (state.error?.message ?? code ?? 'failed'))
        }
      } else {
        const summary: string = d.detail?.display?.summary ?? title
        ctx.emit(agent.id, 'tool_use', summary, d.detail?.input)
      }
      break
    }
    case 'callback': {
      const out = d.state?.output
      if (out?.type === 'approval' && out?.decision?.type === 'deny') {
        ctx.emit(agent.id, 'log', 'Approval auto-denied by headless policy')
      }
      break
    }
    default:
      // reasoning and anything else: too noisy for the log
      break
  }
}

/**
 * Spawns `vibe -p <task>` in headless streaming mode. Vibe never blocks on
 * input in headless mode — denials surface as failed effects (tool_denied),
 * which we report as `blocked`. Returns the running process.
 */
export function startVibeAgent(agent: Agent, opts: SpawnOptions, ctx: AdapterContext): LineProcess {
  const policy = opts.options?.vibeAgent ?? 'smart-approve'
  const args = [
    '-p', opts.task,
    '--output', 'streaming',
    '--workdir', agent.cwd,
    '--agent', policy,
    '--max-turns', String(opts.options?.maxTurns ?? DEFAULT_MAX_TURNS),
  ]
  // vibe headless blocks reading stdin when stdin is an open pipe — ignore it
  // so the agent streams output immediately instead of waiting for EOF.
  const proc = spawnLineProcess('vibe', args, { cwd: agent.cwd, stdin: 'ignore' })
  ctx.registry.updateAgent(agent.id, { pid: proc.pid })

  proc.onLine((line) => handleLine(agent, line, ctx, policy))
  proc.onStderr((line) => ctx.emit(agent.id, 'log', '[stderr] ' + line.slice(0, 300)))
  proc.onExit((code) => {
    const a = ctx.registry.getAgent(agent.id)
    if (!a || a.status === 'stopped') return
    if (code === 0) {
      ctx.emit(agent.id, 'done', a.lastMessage ?? 'process exited')
      ctx.registry.setStatus(agent.id, 'done')
    } else {
      ctx.emit(agent.id, 'error', 'vibe exited with code ' + code)
      ctx.registry.setStatus(agent.id, 'error')
    }
  })
  return proc
}
