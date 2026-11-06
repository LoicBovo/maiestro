import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from './store'
import type { Agent, AgentEvent } from './types'

function newStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), 'maiestro-store-test-')))
}

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: 'a1',
  tool: 'claude',
  task: 'do the thing',
  name: null,
  cwd: '/tmp',
  branch: null,
  projectId: null,
  status: 'running',
  pid: null,
  sessionId: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  lastMessage: null,
  costUsd: null,
  pendingPermission: null,
  options: {},
  ...patch,
})

test('agents round-trip through the JSON file', () => {
  const s = newStore()
  s.saveAgents([agent()])
  assert.deepEqual(s.loadAgents(), [agent()])
})

test('missing files load as empty, corrupt files load as fallback', () => {
  const s = newStore()
  assert.deepEqual(s.loadAgents(), [])
  assert.equal(s.loadConfig(), null)
  writeFileSync(join(s.dir, 'projects.json'), '{not json')
  assert.deepEqual(s.loadProjects(), [])
})

test('config round-trips and is written with 0600 permissions', () => {
  const s = newStore()
  s.saveConfig({ port: 49377, token: 'secret'.repeat(6) })
  const cfg = s.loadConfig()
  assert.ok(cfg)
  assert.equal(cfg!.port, 49377)
  assert.equal(cfg!.token, 'secret'.repeat(6))
  const mode = statSync(join(s.dir, 'config.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('events append, read back per agent, and delete per agent', () => {
  const s = newStore()
  const ev = (id: string, n: number): AgentEvent => ({
    id: 'ev' + n,
    agentId: id,
    ts: '2026-01-01T00:00:0' + n + '.000Z',
    type: 'log',
    text: 'line ' + n,
  })
  s.appendEvent(ev('a1', 1))
  s.appendEvent(ev('a2', 2))
  s.appendEvent(ev('a1', 3))
  assert.deepEqual(s.readEvents().map((e) => e.id), ['ev1', 'ev2', 'ev3'])
  assert.deepEqual(s.readEvents('a1').map((e) => e.id), ['ev1', 'ev3'])
  s.deleteEvents('a1')
  assert.deepEqual(s.readEvents().map((e) => e.id), ['ev2'])
  assert.deepEqual(s.readEvents('a1'), [])
})

test('a corrupt event line is skipped, not fatal', () => {
  const s = newStore()
  s.appendEvent({ id: 'ev1', agentId: 'a1', ts: '', type: 'log', text: 'ok' })
  appendFileSync(join(s.dir, 'events.jsonl'), 'garbage\n')
  s.appendEvent({ id: 'ev2', agentId: 'a1', ts: '', type: 'log', text: 'after' })
  assert.deepEqual(s.readEvents().map((e) => e.id), ['ev1', 'ev2'])
})

test('writes go through a temp file and leave no temp behind', () => {
  const s = newStore()
  s.saveAgents([agent()])
  assert.ok(existsSync(join(s.dir, 'agents.json')))
  assert.ok(!existsSync(join(s.dir, 'agents.json.tmp')))
  assert.deepEqual(s.loadAgents(), JSON.parse(readFileSync(join(s.dir, 'agents.json'), 'utf8')))
})
