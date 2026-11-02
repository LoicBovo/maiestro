/**
 * Probe: end-to-end check that a terminal-mode vibe turn still completes:
 * the TUI's `state=done` marker must turn the agent `done` and fire the
 * "Agent done" notification (regression check for the OSC 7501 regex change).
 * Run: npx tsx spike/probe-vibe-terminal-done.ts
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
    options: { mode: 'terminal' },
  })

  await new Promise((r) => setTimeout(r, 10_000))
  daemon.writeTerminal(agent.id, 'Reply with exactly the word OK and nothing else\r')

  const deadline = Date.now() + 180_000
  for (;;) {
    const a = daemon.registry.getAgent(agent.id)!
    if (a.status !== lastStatus) {
      lastStatus = a.status
      transitions.push(a.status)
      console.log('status -> ' + a.status)
    }
    if (a.status === 'done' || a.status === 'error' || Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 2_000))
  }

  console.log('transitions: ' + transitions.join(' -> '))
  console.log('notifications:')
  for (const n of notifications) console.log('  ' + n)
  const ok = transitions.includes('done') && notifications.some((n) => n.startsWith('Agent done'))
  console.log(ok ? 'PROBE OK' : 'PROBE FAILED')
  await daemon.stopAgent(agent.id)
  await daemon.stopAll()
  process.exit(ok ? 0 : 1)
}

void main()
