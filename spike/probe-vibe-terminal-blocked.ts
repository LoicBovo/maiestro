/**
 * Probe: end-to-end check of the terminal-mode notification pipeline.
 * Starts the real daemon (temp data dir), spawns a real vibe TUI agent under
 * the `ask` policy, types the task into the embedded terminal, and verifies
 * that the TUI's `state=blocked:kind=permission` marker turns the agent
 * `blocked` and fires a notification (captured through DaemonOptions.notify).
 * Run: npx tsx spike/probe-vibe-terminal-blocked.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../electron/daemon/daemon'

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'maiestro-probe-'))
  const notifications: string[] = []
  let lastStatus = ''
  const transitions: string[] = []
  const daemon = new Daemon({
    dataDir: dir,
    notify: (title, body, urgent) => notifications.push((urgent ? '[URGENT] ' : '') + title + ' — ' + body),
  })
  await daemon.start()

  const agent = await daemon.spawnAgent({
    tool: 'vibe',
    task: '',
    options: { mode: 'terminal', vibeAgent: 'ask' },
  })
  console.log('spawned terminal vibe agent ' + agent.id + ' (data dir ' + dir + ')')

  // let the TUI boot, then type the task and submit it
  await new Promise((r) => setTimeout(r, 10_000))
  daemon.writeTerminal(agent.id, 'Use your file tools to create ' + join(dir, 'probe-e2e.txt') + ' containing exactly: hi\r')
  console.log('task submitted to the embedded terminal')

  const deadline = Date.now() + 180_000
  for (;;) {
    const a = daemon.registry.getAgent(agent.id)!
    if (a.status !== lastStatus) {
      lastStatus = a.status
      transitions.push(a.status)
      console.log('status -> ' + a.status)
    }
    if (a.status === 'blocked' || a.status === 'error' || Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 2_000))
  }

  console.log('transitions: ' + transitions.join(' -> '))
  console.log('notifications:')
  for (const n of notifications) console.log('  ' + n)
  const ok = transitions.includes('blocked') && notifications.some((n) => n.startsWith('[URGENT] Agent blocked'))
  console.log(ok ? 'PROBE OK' : 'PROBE FAILED')
  await daemon.stopAgent(agent.id)
  await daemon.stopAll()
  process.exit(ok ? 0 : 1)
}

void main()
