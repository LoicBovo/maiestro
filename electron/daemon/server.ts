import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Daemon } from './daemon'
import type { SpawnOptions } from './types'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * Local HTTP API, bound to 127.0.0.1, bearer-token authenticated.
 * Used by the Electron renderer (via IPC, not HTTP), by hook scripts of
 * externally-started agents, and by the MCP permission shim.
 */
export class Server {
  private http = createServer((req, res) => {
    void this.handle(req, res).catch((err) => {
      sendJson(res, 500, { error: String(err?.message ?? err) })
    })
  })

  constructor(private daemon: Daemon) {}

  async listen(preferredPort: number, tries = 20): Promise<number> {
    for (let i = 0; i < tries; i++) {
      const port = preferredPort + i
      try {
        await new Promise<void>((resolve, reject) => {
          this.http.once('error', reject)
          this.http.listen(port, '127.0.0.1', () => resolve())
        })
        return port
      } catch {
        // port busy, try the next one
      }
    }
    throw new Error('no free port found')
  }

  close(): void {
    this.http.close()
  }

  private authed(req: IncomingMessage): boolean {
    return req.headers.authorization === 'Bearer ' + this.daemon.token
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true, port: this.daemon.port })
      return
    }
    if (!this.authed(req)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    const agentMatch = path.match(/^\/api\/agents\/([0-9a-f-]+)(\/(events|stop|relaunch|permission))?$/)
    if (method === 'GET' && path === '/api/agents') {
      sendJson(res, 200, { agents: this.daemon.registry.listAgents() })
      return
    }
    if (method === 'POST' && path === '/api/agents') {
      const opts = (await readBody(req)) as SpawnOptions
      const agent = await this.daemon.spawnAgent(opts)
      sendJson(res, 201, { agent })
      return
    }
    if (agentMatch && method === 'GET' && !agentMatch[2]) {
      const agent = this.daemon.registry.getAgent(agentMatch[1])
      if (!agent) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      sendJson(res, 200, { agent })
      return
    }
    if (agentMatch && method === 'GET' && agentMatch[3] === 'events') {
      sendJson(res, 200, { events: this.daemon.getEvents(agentMatch[1]) })
      return
    }
    if (agentMatch && method === 'POST' && agentMatch[3] === 'stop') {
      await this.daemon.stopAgent(agentMatch[1])
      sendJson(res, 200, { agent: this.daemon.registry.getAgent(agentMatch[1]) })
      return
    }
    if (agentMatch && method === 'POST' && agentMatch[3] === 'relaunch') {
      const body = await readBody(req)
      const agent = await this.daemon.relaunchAgent(agentMatch[1], body?.options)
      sendJson(res, 201, { agent })
      return
    }
    if (agentMatch && method === 'POST' && agentMatch[3] === 'permission') {
      const body = await readBody(req)
      this.daemon.decidePermission(agentMatch[1], body.toolUseId, body.decision, body.message)
      sendJson(res, 200, { ok: true })
      return
    }
    if (agentMatch && method === 'DELETE' && !agentMatch[2]) {
      this.daemon.removeAgent(agentMatch[1])
      sendJson(res, 200, { ok: true })
      return
    }
    const projectMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)$/)
    if (method === 'GET' && path === '/api/projects') {
      sendJson(res, 200, { projects: this.daemon.listProjects() })
      return
    }
    if (method === 'POST' && path === '/api/projects') {
      const body = await readBody(req)
      try {
        const dirs = Array.isArray(body?.dirs) ? body.dirs.map(String) : []
        const project = this.daemon.createProject(String(body?.name ?? ''), dirs)
        sendJson(res, 201, { project })
      } catch (err) {
        sendJson(res, 400, { error: String((err as Error)?.message ?? err) })
      }
      return
    }
    if (projectMatch && method === 'DELETE') {
      this.daemon.deleteProject(projectMatch[1])
      sendJson(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/internal/permission-request') {
      // called by the MCP shim; held open until the user decides
      const body = await readBody(req)
      let answered = false
      req.on('close', () => {
        if (!answered) {
          answered = true
          this.daemon.registry.cancelPermission(String(body?.toolUseId ?? ''))
        }
      })
      const decision = await this.daemon.registry.requestPermission({
        agentId: String(body?.agentId ?? ''),
        toolUseId: String(body?.toolUseId ?? ''),
        toolName: String(body?.toolName ?? ''),
        input: (body?.input ?? {}) as Record<string, unknown>,
      })
      answered = true
      sendJson(res, 200, decision)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }
}
