/**
 * End-to-end smoke test: starts a real daemon (temp data dir), spawns real
 * claude and vibe agents over HTTP, and verifies the full lifecycle:
 *   claude: running -> blocked (permission) -> approve -> done
 *   vibe:   running -> blocked (tool_denied) -> stopped
 *   vibe:   running -> done (simple task)
 * plus auth and projects persistence. Run: npm run smoke
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from './daemon'
import type { Agent } from './types'

async function main(): Promise<void> {
const dir = mkdtempSync(join(tmpdir(), 'maiestro-smoke-'))
const daemon = new Daemon({ dataDir: dir })
await daemon.start()

const base = daemon.url
const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + daemon.token }

async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + (await res.text()))
  return res.json()
}

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''))
  if (!cond) failures++
}

async function waitFor(
  pred: (agents: Agent[]) => Agent | undefined,
  timeoutMs: number,
  label: string,
): Promise<Agent> {
  const start = Date.now()
  for (;;) {
    const agents = (await api('/api/agents')).agents as Agent[]
    const found = pred(agents)
    if (found) return found
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for ' + label)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

console.log('daemon at ' + base + ' (data dir ' + dir + ')')

// --- Test 1: claude blocked -> approve -> done ------------------------------
const { project } = await api('/api/projects', 'POST', { name: 'smoke', dirs: [dir, tmpdir()] })
check('project created', !!project?.id && project.dirs?.[0] === dir)
const target = join(dir, 'smoke-claude.txt')
const { agent: a1 } = await api('/api/agents', 'POST', {
  tool: 'claude',
  task: 'Run this exact bash command: touch ' + target,
  projectId: project.id,
})
check('claude agent spawned', !!a1?.id)
check('claude agent belongs to the project', a1?.projectId === project.id)
check('agent cwd defaults to the project main folder', a1?.cwd === dir, 'cwd=' + a1?.cwd)

const blocked = await waitFor(
  (ags) => ags.find((a) => a.id === a1.id && a.status === 'blocked'),
  120_000,
  'claude blocked',
)
check('claude became blocked', true)
check(
  'pending permission is the Bash call',
  blocked.pendingPermission?.toolName === 'Bash',
  JSON.stringify(blocked.pendingPermission?.toolName),
)

await api('/api/agents/' + a1.id + '/permission', 'POST', {
  toolUseId: blocked.pendingPermission!.toolUseId,
  decision: 'allow',
})
const done = await waitFor(
  (ags) => ags.find((a) => a.id === a1.id && a.status === 'done'),
  120_000,
  'claude done',
)
check('claude done after approve', true, 'cost $' + done.costUsd)
check('file created by claude', existsSync(target))
const evs1 = (await api('/api/agents/' + a1.id + '/events')).events
check('claude events include tool_use', evs1.some((e: any) => e.type === 'tool_use'))
check('claude events include done', evs1.some((e: any) => e.type === 'done'))

// --- Test 2: vibe ask agent -> blocked -> stop ------------------------------
const vtarget = join(dir, 'smoke-vibe.txt')
const { agent: a2 } = await api('/api/agents', 'POST', {
  tool: 'vibe',
  task: 'Use your file tools to create ' + vtarget + ' containing exactly: smoke',
  cwd: dir,
  options: { vibeAgent: 'ask' },
})
await waitFor(
  (ags) => ags.find((a) => a.id === a2.id && a.status === 'blocked'),
  150_000,
  'vibe blocked',
)
check('vibe became blocked (tool_denied)', true)
const evs2 = (await api('/api/agents/' + a2.id + '/events')).events
check('vibe events include blocked', evs2.some((e: any) => e.type === 'blocked'))
check('vibe blocked event names the tool', evs2.find((e: any) => e.type === 'blocked')?.text.includes('file_system.write_file'), evs2.find((e: any) => e.type === 'blocked')?.text)
await api('/api/agents/' + a2.id + '/stop', 'POST')
await waitFor(
  (ags) => ags.find((a) => a.id === a2.id && a.status === 'stopped'),
  15_000,
  'vibe stopped',
)
check('vibe stopped by user', true)

// --- Test 3: vibe simple task -> done ---------------------------------------
const { agent: a3 } = await api('/api/agents', 'POST', {
  tool: 'vibe',
  task: 'Reply with exactly the word OK and nothing else',
  cwd: dir,
})
check('vibe agent is solo', a3?.projectId == null)
const a3final = await waitFor(
  (ags) => ags.find((a) => a.id === a3.id && (a.status === 'done' || a.status === 'error')),
  150_000,
  'vibe done',
)
check('vibe simple task done', a3final.status === 'done', 'status=' + a3final.status)

// --- Test 4: projects + auth --------------------------------------------------
const projects = (await api('/api/projects')).projects
check('projects persisted', projects.some((p: any) => p.id === project.id), JSON.stringify(projects.map((p: any) => p.name)))
await api('/api/projects/' + project.id, 'DELETE')
const afterDelete = (await api('/api/agents')).agents as Agent[]
check('project agents become solo after delete', afterDelete.find((a) => a.id === a1.id)?.projectId == null)
const projectsAfter = (await api('/api/projects')).projects
check('project deleted', !projectsAfter.some((p: any) => p.id === project.id))
const unauth = await fetch(base + '/api/agents')
check('unauthorized request rejected', unauth.status === 401)

console.log(failures === 0 ? 'SMOKE OK' : 'SMOKE FAILED: ' + failures + ' failure(s)')
await daemon.stopAll()
process.exit(failures === 0 ? 0 : 1)
}

void main()
