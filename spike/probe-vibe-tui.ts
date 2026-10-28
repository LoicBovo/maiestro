/**
 * Probe: capture the raw TUI output of an interactive vibe session around a
 * turn completion, so the terminal adapter can detect the idle state.
 * Run: npx tsx spike/probe-vibe-tui.ts   (writes spike/samples/vibe-tui.txt)
 */
import * as pty from 'node-pty'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out: string[] = []
const term = pty.spawn('vibe', ['Reply with exactly: OK', '--agent', 'smart-approve'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
    string,
    string
  >,
})

term.onData((chunk) => {
  out.push(chunk)
  process.stdout.write('.')
})

setTimeout(() => {
  term.kill()
  const file = join(process.cwd(), 'spike', 'samples', 'vibe-tui.txt')
  writeFileSync(file, out.join(''))
  console.log('\nsaved ' + out.join('').length + ' chars to ' + file)
}, 60_000)
