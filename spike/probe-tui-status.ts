/**
 * Probe: spawn a terminal-mode vibe agent through the real daemon and verify
 * the turn-completion status fix: the agent must flip to `done` when the vibe
 * TUI emits its OSC 7501 state=done marker, while the CLI is still open.
 * Run: npx tsx spike/probe-tui-status.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../electron/daemon/daemon'

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'maiestro-tui-'))
  const daemon = new Daemon({ dataDir: dir })
  await daemon.start()
  console.log('daemon at ' + daemon.url)

  const agent = await daemon.spawnAgent({
    tool: 'vibe',
    task: 'Reply with exactly: OK',
    cwd: dir,
    options: { mode: 'terminal' },
  })
  console.log('spawned ' + agent.id + ' (terminal mode)')

  const start = Date.now()
  for (;;) {
    const a = daemon.registry.getAgent(agent.id)
    if (!a) throw new Error('agent disappeared')
    if (a.status === 'done') {
      console.log(
        'PASS - status is done after ' + ((Date.now() - start) / 1000).toFixed(1) + 's, while the CLI is still open',
      )
      break
    }
    if (a.status === 'error' || a.status === 'stopped') {
      throw new Error('unexpected status ' + a.status)
    }
    if (Date.now() - start > 120_000) throw new Error('timeout: still ' + a.status)
    await new Promise((r) => setTimeout(r, 1000))
  }

  const events = daemon.getEvents(agent.id)
  console.log('events:')
  for (const ev of events) console.log('  ' + ev.type + ' - ' + ev.text.slice(0, 100))
  await daemon.stopAll()
  process.exit(0)
}

void main()
