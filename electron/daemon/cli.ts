/**
 * Standalone daemon entry (no Electron): `npm run daemon`.
 * Runs the same Daemon the Electron app uses, with console notifications
 * (set MAIESTRO_OS_NOTIFY=1 to also fire macOS notifications).
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from './daemon'

function osNotify(title: string, body: string): void {
  if (process.env.MAIESTRO_OS_NOTIFY !== '1') return
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  spawn('osascript', ['-e', 'display notification "' + esc(body) + '" with title "' + esc(title) + '"'], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

async function main(): Promise<void> {
  const dataDir = process.env.MAIESTRO_HOME ?? join(homedir(), '.maiestro')
  const daemon = new Daemon({
    dataDir,
    notify: (title, body) => {
      console.log('[notify]', title, '—', body)
      osNotify(title, body)
    },
  })
  await daemon.start()
  console.log('maiestro daemon listening on ' + daemon.url)
  console.log('data dir: ' + dataDir)
  console.log('token: ' + daemon.token)

  const shutdown = () => {
    console.log('shutting down...')
    void daemon.stopAll().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
