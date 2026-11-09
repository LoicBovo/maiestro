import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from './registry'
import { Store } from './store'
import type { Agent } from './types'

function newRegistry(): Registry {
  return new Registry(new Store(mkdtempSync(join(tmpdir(), 'maiestro-registry-test-'))))
}

const agent = (id: string, patch: Partial<Agent> = {}): Agent => ({
  id,
  tool: 'claude',
  task: 'do the thing',
  name: null,
  cwd: '/tmp',
  branch: null,
  projectId: null,
  status: 'running',
  pid: null,
  sessionId: null,
  startedAt: '2026-01-01T00:00:0' + id + '.000Z',
  endedAt: null,
  lastMessage: null,
  costUsd: null,
  pendingPermission: null,
  options: {},
  ...patch,
})

test('persisted running agents load as stopped (they died with the last daemon)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maiestro-registry-migrate-'))
  const store = new Store(dir)
  store.saveAgents([
    agent('1', { status: 'running', lastMessage: 'mid-run' }),
    agent('2', { status: 'blocked', lastMessage: null }),
    agent('3', { status: 'done', lastMessage: 'all good' }),
  ])
  const r = new Registry(store)
  const agents = r.listAgents()
  assert.equal(agents.find((a) => a.id === '1')?.status, 'stopped')
  assert.ok(agents.find((a) => a.id === '1')?.lastMessage?.includes('daemon restarted'))
  assert.equal(agents.find((a) => a.id === '2')?.status, 'stopped')
  // an agent that was not mid-run keeps its last message
  assert.equal(agents.find((a) => a.id === '3')?.lastMessage, 'all good')
  // and the migration is persisted
  const persisted = new Store(dir).loadAgents()
  assert.equal(persisted.find((a) => a.id === '1')?.status, 'stopped')
  assert.equal(persisted.find((a) => a.id === '2')?.status, 'stopped')
  assert.equal(persisted.find((a) => a.id === '3')?.status, 'done')
})

test('a persisted pending permission is dropped on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maiestro-registry-pending-'))
  const store = new Store(dir)
  store.saveAgents([
    agent('1', {
      status: 'blocked',
      pendingPermission: { toolUseId: 'tu1', toolName: 'Bash', input: {} },
    }),
  ])
  const r = new Registry(store)
  assert.equal(r.getAgent('1')?.pendingPermission, null)
})

test('legacy single-cwd projects migrate to dirs and persist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maiestro-registry-legacy-'))
  const store = new Store(dir)
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify([{ id: 'p1', name: 'old', cwd: '/repo', createdAt: '2026-01-01T00:00:00.000Z' }]),
  )
  const r = new Registry(store)
  assert.deepEqual(r.getProject('p1')?.dirs, ['/repo'])
  const saved = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8'))
  assert.deepEqual(saved[0].dirs, ['/repo'])
})

test('listAgents pins shells first, newest first otherwise', () => {
  const r = newRegistry()
  r.addAgent(agent('1', { startedAt: '2026-01-01T00:00:01.000Z' }))
  r.addAgent(agent('2', { startedAt: '2026-01-02T00:00:01.000Z' }))
  r.addAgent(agent('3', { tool: 'shell', startedAt: '2026-01-01T00:00:01.000Z' }))
  assert.deepEqual(
    r.listAgents().map((a) => a.id),
    ['3', '2', '1'],
  )
})

test('setStatus records endedAt only on terminal statuses and emits transitions', () => {
  const r = newRegistry()
  r.addAgent(agent('1'))
  const transitions: Array<{ from: string; to: string }> = []
  r.on('status', ({ from, to }) => transitions.push({ from: from as string, to: to as string }))
  r.setStatus('1', 'blocked', { pendingPermission: null })
  assert.equal(r.getAgent('1')?.endedAt, null)
  r.setStatus('1', 'done')
  assert.ok(r.getAgent('1')?.endedAt)
  // same-status call applies the extras without a transition
  r.setStatus('1', 'done', { lastMessage: 'final' })
  assert.deepEqual(transitions, [
    { from: 'running', to: 'blocked' },
    { from: 'blocked', to: 'done' },
  ])
})

test('createProject validates, dedupes and emits; deleteProject detaches agents', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'maiestro-registry-proj-')))
  const r = new Registry(store)
  assert.throws(() => r.createProject('  ', ['/a']))
  assert.throws(() => r.createProject('name', [' ']))
  assert.throws(() => r.createProject('name', ['/a'], 'shell'))
  const p = r.createProject('name', ['/a', '/a', ' /b '], 'vibe')
  assert.deepEqual(p.dirs, ['/a', '/b'])
  assert.equal(p.preferredTool, 'vibe')
  assert.deepEqual(store.loadProjects()[0].dirs, ['/a', '/b'])
  assert.equal(store.loadProjects()[0].preferredTool, 'vibe')
  // no preference recorded by default
  const p2 = r.createProject('other', ['/c'])
  assert.equal(p2.preferredTool, null)
  // update replaces dirs and the preference; undefined keeps the preference
  assert.equal(r.updateProject(p.id, ['/a'], null).preferredTool, null)
  assert.equal(r.updateProject(p.id, ['/a'], 'claude').preferredTool, 'claude')
  assert.equal(r.updateProject(p.id, ['/a']).preferredTool, 'claude')
  assert.throws(() => r.updateProject(p.id, ['/a'], 'codex'))
  r.addAgent(agent('1', { projectId: p.id }))
  r.deleteProject(p.id)
  assert.equal(r.getProject(p.id), undefined)
  assert.equal(r.getAgent('1')?.projectId, null)
  assert.throws(() => r.updateProject(p.id, ['/a']))
})

test('permission request blocks the agent, decision resolves and unblocks it', async () => {
  const r = newRegistry()
  r.addAgent(agent('1'))
  const decision = r.requestPermission({
    agentId: '1',
    toolUseId: 'tu1',
    toolName: 'Bash',
    input: { command: 'rm -rf /' },
  })
  assert.equal(r.getAgent('1')?.status, 'blocked')
  assert.equal(r.getAgent('1')?.pendingPermission?.toolName, 'Bash')
  assert.equal(r.decidePermission('nope', 'allow'), false)
  assert.ok(r.decidePermission('tu1', 'allow'))
  assert.deepEqual(await decision, { behavior: 'allow', updatedInput: { command: 'rm -rf /' } })
  assert.equal(r.getAgent('1')?.status, 'running')
  assert.equal(r.getAgent('1')?.pendingPermission, null)
})

test('permission denial passes the message and unblocks the agent', async () => {
  const r = newRegistry()
  r.addAgent(agent('1'))
  const decision = r.requestPermission({
    agentId: '1',
    toolUseId: 'tu1',
    toolName: 'Bash',
    input: {},
  })
  r.decidePermission('tu1', 'deny', 'not today')
  assert.deepEqual(await decision, { behavior: 'deny', message: 'not today' })
  assert.equal(r.getAgent('1')?.status, 'running')
})

test('cancelPermissions denies every pending request of the agent', async () => {
  const r = newRegistry()
  r.addAgent(agent('1'))
  const decisions = [
    r.requestPermission({ agentId: '1', toolUseId: 'tu1', toolName: 'A', input: {} }),
    r.requestPermission({ agentId: '1', toolUseId: 'tu2', toolName: 'B', input: {} }),
  ]
  r.cancelPermissions('1')
  for (const d of await Promise.all(decisions)) {
    assert.deepEqual(d, { behavior: 'deny', message: 'Agent stopped' })
  }
})
