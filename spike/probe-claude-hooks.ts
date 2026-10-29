/**
 * Probe: verify Claude Code fires hooks in an interactive PTY session when the
 * hook config comes from `--settings`, and capture the payload shapes.
 * Run: npx tsx spike/probe-claude-hooks.ts
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'

function hookCmd(file: string): string {
  return `cat >> ${JSON.stringify(file)} && echo >> ${JSON.stringify(file)}`
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hooks-'))
  const hooksFile = join(dir, 'hooks.jsonl')
  // cwd must be a folder already trusted by claude (`hasTrustDialogAccepted`
  // in ~/.claude.json), otherwise the interactive trust dialog blocks the run.
  const cwd = '/Users/loicbovo/Documents/code/perso/maiestro'

  const events = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop']
  const settings = JSON.stringify({
    permissions: { ask: ['Bash'] },
    hooks: Object.fromEntries(
      events.map((ev) => [ev, [{ hooks: [{ type: 'command', command: hookCmd(hooksFile) }] }]]),
    ),
  })
  console.log('settings arg length: ' + settings.length)

  const term = pty.spawn(
    '/Users/loicbovo/.local/bin/claude',
    ['--permission-mode', 'manual', '--settings', settings, 'Run the shell command `echo maiestro-probe` and report its output.'],
    {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })

  let out = ''
  let trusted = false
  let approved = false
  term.onData((c) => {
    out += c
    if (!trusted && out.includes('trust this folder')) {
      trusted = true
      setTimeout(() => term.write('\u001b[B'), 300) // select "Yes, I trust this folder"
      setTimeout(() => term.write('\r'), 600)
    }
    // manual permission mode: answer the "do you want to proceed" prompt
    if (trusted && !approved && out.includes('proceed')) {
      approved = true
      setTimeout(() => term.write('\r'), 500)
    }
  })

  const start = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    if (existsSync(hooksFile)) {
      const raw = readFileSync(hooksFile, 'utf8')
      if (raw.includes('"Stop"')) {
        console.log('got Stop event after ' + ((Date.now() - start) / 1000).toFixed(1) + 's')
        break
      }
    }
    if (Date.now() - start > 150_000) {
      console.log('TIMEOUT waiting for Stop hook. output tail:')
      console.log(out.slice(-2000))
      break
    }
  }

  if (existsSync(hooksFile)) {
    const lines = readFileSync(hooksFile, 'utf8').split('\n').filter(Boolean)
    console.log('hook events (' + lines.length + '):')
    for (const l of lines) {
      try {
        const d = JSON.parse(l)
        console.log(
          '  ' +
            d.hook_event_name +
            ' — session_id=' +
            (d.session_id ?? '-') +
            ' message=' +
            JSON.stringify(d.message ?? '').slice(0, 100) +
            ' tool=' +
            (d.tool_name ?? '-'),
        )
      } catch {
        console.log('  [unparseable] ' + l.slice(0, 120))
      }
    }
  } else {
    console.log('NO hooks file — hooks did not fire')
  }

  term.kill()
  await new Promise((r) => setTimeout(r, 500))
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

void main()
