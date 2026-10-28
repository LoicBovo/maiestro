import { spawnLineProcess, type LineProcess } from '../process'
import type { Registry } from '../registry'
import type { Agent, AgentEventType, SpawnOptions } from '../types'

export interface AdapterContext {
  registry: Registry
  emit: (agentId: string, type: AgentEventType, text: string, data?: unknown) => void
  shimPath: string
  daemonUrl: string
  daemonToken: string
  /** daemon data dir — the terminal adapter writes wrapper scripts there */
  dataDir: string
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>
    if (typeof i.command === 'string') return i.command
    if (typeof i.file_path === 'string') return String(i.file_path)
    if (typeof i.pattern === 'string') return String(i.pattern)
    if (typeof i.prompt === 'string') return i.prompt.slice(0, 120)
    try {
      return JSON.stringify(input).slice(0, 200)
    } catch {
      return String(input)
    }
  }
  return String(input)
}

function handleLine(agent: Agent, line: string, ctx: AdapterContext): void {
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    ctx.emit(agent.id, 'log', line.slice(0, 500))
    return
  }
  const registry = ctx.registry
  switch (d.type) {
    case 'system':
      // init carries session_id; hook_started/hook_response/commands_changed/
      // thinking_tokens/permission_denied are verbose-mode noise
      if (d.subtype === 'init' && d.session_id) {
        registry.updateAgent(agent.id, { sessionId: d.session_id })
      }
      break
    case 'assistant':
      for (const c of d.message?.content ?? []) {
        if (c?.type === 'text' && c.text) {
          ctx.emit(agent.id, 'message', c.text)
        } else if (c?.type === 'tool_use') {
          ctx.emit(agent.id, 'tool_use', c.name + ': ' + summarizeInput(c.input), c)
        }
      }
      break
    case 'user':
      for (const c of d.message?.content ?? []) {
        if (c?.type === 'tool_result') {
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
          ctx.emit(agent.id, 'tool_result', (c.is_error ? '[error] ' : '') + text.slice(0, 500), c)
        }
      }
      break
    case 'result': {
      const ok = d.subtype === 'success' && !d.is_error
      const finalText: string = typeof d.result === 'string' ? d.result : ''
      registry.updateAgent(agent.id, {
        costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : agent.costUsd,
        sessionId: d.session_id ?? agent.sessionId,
        lastMessage: finalText.slice(0, 200) || null,
      })
      if (ok) {
        ctx.emit(agent.id, 'done', finalText || 'done', d)
        registry.setStatus(agent.id, 'done')
      } else {
        ctx.emit(agent.id, 'error', finalText || String(d.subtype), d)
        registry.setStatus(agent.id, 'error')
      }
      break
    }
    default:
      // rate_limit_event and anything else: ignore
      break
  }
}

/**
 * Spawns `claude -p <task>` with stream-json output and the MCP permission
 * shim wired in, so permission requests become `blocked` states the user can
 * answer from the GUI. Returns the running process.
 */
export function startClaudeAgent(agent: Agent, opts: SpawnOptions, ctx: AdapterContext): LineProcess {
  const args = [
    '-p', opts.task,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'mcp__maiestro__permission_decision',
    '--mcp-config', JSON.stringify({
      mcpServers: {
        maiestro: {
          command: 'node',
          args: [ctx.shimPath],
          env: {
            MAIESTRO_URL: ctx.daemonUrl,
            MAIESTRO_TOKEN: ctx.daemonToken,
            MAIESTRO_AGENT_ID: agent.id,
          },
        },
      },
    }),
  ]
  const proc = spawnLineProcess('claude', args, { cwd: agent.cwd })
  ctx.registry.updateAgent(agent.id, { pid: proc.pid })

  proc.onLine((line) => handleLine(agent, line, ctx))
  proc.onStderr((line) => ctx.emit(agent.id, 'log', '[stderr] ' + line.slice(0, 300)))
  proc.onExit((code) => {
    const a = ctx.registry.getAgent(agent.id)
    if (!a || a.status === 'stopped') return
    ctx.registry.cancelPermissions(agent.id)
    if (a.status === 'blocked') ctx.registry.setStatus(agent.id, 'running', { pendingPermission: null })
    if (code === 0) {
      ctx.emit(agent.id, 'done', a.lastMessage ?? 'process exited')
      ctx.registry.setStatus(agent.id, 'done')
    } else {
      ctx.emit(agent.id, 'error', 'claude exited with code ' + code)
      ctx.registry.setStatus(agent.id, 'error')
    }
  })
  return proc
}
