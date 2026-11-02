/**
 * Probe: capture the raw TUI output of an interactive vibe session running
 * under the `ask` policy, to see which OSC 7501 state markers the TUI emits
 * when it needs a permission decision (blocked:kind=permission /
 * blocked:kind=question).
 * Run: npx tsx spike/probe-vibe-blocked.ts   (writes spike/samples/vibe-blocked.txt)
 */
import * as pty from 'node-pty'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out: string[] = []
const term = pty.spawn(
  'vibe',
  ['Use your file tools to create ' + join(process.cwd(), 'spike', 'samples', 'probe-ask.txt') + ' containing exactly: hi', '--agent', 'ask'],
  {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
      string,
      string
    >,
  },
)

term.onData((chunk) => {
  out.push(chunk)
  process.stdout.write('.')
})

setTimeout(() => {
  term.kill()
  const file = join(process.cwd(), 'spike', 'samples', 'vibe-blocked.txt')
  writeFileSync(file, out.join(''))
  console.log('\nsaved ' + out.join('').length + ' chars to ' + file)
}, 90_000)
