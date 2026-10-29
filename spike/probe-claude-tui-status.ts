/**
 * Probe: spawn a terminal-mode claude agent through the real daemon and verify
 * status tracking works via the Claude Code hooks: the agent must flip to
 * `blocked` on a permission prompt, then `done` when the turn completes, while
 * the CLI is still open for follow-ups.
 * Run: npx tsx spike/probe-claude-tui-status.ts
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../electron/daemon/daemon'

// must be a folder claude already trusts, else the trust dialog blocks the run
const CWD = '/Users/loicbovo/Documents/code/perso/maiestro'

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'maiestro-claude-tui-'))
  let out = ''
  const daemon = new Daemon({
    dataDir: dir,
    onTerminalData: (_id, chunk) => {
      out += chunk
    },
  })
  await daemon.start()
  console.log('daemon at ' + daemon.url)

  const agent = await daemon.spawnAgent({
    tool: 'claude',
    task: 'Run the shell command `echo maiestro-probe` and report its output.',
    cwd: CWD,
    options: { mode: 'terminal' },
  })
  console.log('spawned ' + agent.id + ' (terminal mode)')

  const statuses: string[] = ['running']
  let approved = false
  const start = Date.now()
  for (;;) {
    const a = daemon.registry.getAgent(agent.id)
    if (!a) throw new Error('agent disappeared')
    if (statuses[statuses.length - 1] !== a.status) {
      statuses.push(a.status)
      console.log('status -> ' + a.status + ' (+' + ((Date.now() - start) / 1000).toFixed(1) + 's)')
    }
    if (a.status === 'done' && a.sessionId) {
      console.log('PASS - done while CLI still open; sessionId=' + a.sessionId)
      console.log('transitions: ' + statuses.join(' -> '))
      break
    }
    if (a.status === 'error' || a.status === 'stopped') {
      console.log('unexpected status ' + a.status + '; terminal tail:')
      console.log(out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-1500))
      process.exit(1)
    }
    if (!approved && out.includes('proceed')) {
      approved = true
      console.log('permission prompt detected - sending Enter to approve')
      daemon.writeTerminal(agent.id, '\r')
    }
    if (Date.now() - start > 150_000) {
      console.log('TIMEOUT - still ' + a.status + '; terminal tail:')
      console.log(out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-1500))
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const events = daemon.getEvents(agent.id)
  console.log('events:')
  for (const ev of events) console.log('  ' + ev.type + ' - ' + ev.text.slice(0, 100))

  const hookFile = join(dir, 'bin', 'claude-hooks-' + agent.id + '.json')
  console.log('hook settings file present (should be true, CLI still open): ' + existsSync(hookFile))
  if (existsSync(hookFile)) {
    console.log('  hooks wired: ' + Object.keys(JSON.parse(readFileSync(hookFile, 'utf8')).hooks).join(', '))
  }

  await daemon.stopAll()
  await new Promise((r) => setTimeout(r, 500))
  console.log('hook settings file removed after exit: ' + !existsSync(hookFile))
  process.exit(0)
}

void main()
