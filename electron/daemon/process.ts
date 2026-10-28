import { spawn, type ChildProcess } from 'node:child_process'

export interface LineProcess {
  pid: number
  write(data: string): void
  kill(): void
  onLine(cb: (line: string) => void): void
  onStderr(cb: (line: string) => void): void
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

/**
 * Spawns a child process with pipes and exposes stdout/stderr as line
 * streams. kill() sends SIGTERM, escalating to SIGKILL after a grace period.
 */
export function spawnLineProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: 'pipe' | 'ignore' },
): LineProcess {
  const proc: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
  })

  const lineCbs: Array<(line: string) => void> = []
  const stderrCbs: Array<(line: string) => void> = []
  const exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  let killed = false
  let exited = false

  let outBuf = ''
  let errBuf = ''
  proc.stdout?.on('data', (c: Buffer) => {
    outBuf += c.toString('utf8')
    let i: number
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i)
      outBuf = outBuf.slice(i + 1)
      if (line.trim()) lineCbs.forEach((cb) => cb(line))
    }
  })
  proc.stderr?.on('data', (c: Buffer) => {
    errBuf += c.toString('utf8')
    let i: number
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i)
      errBuf = errBuf.slice(i + 1)
      if (line.trim()) stderrCbs.forEach((cb) => cb(line))
    }
  })

  proc.on('error', (err) => {
    stderrCbs.forEach((cb) => cb('spawn error: ' + err.message))
    if (!exited) {
      exited = true
      exitCbs.forEach((cb) => cb(null, null))
    }
  })
  proc.on('exit', (code, signal) => {
    if (exited) return
    exited = true
    exitCbs.forEach((cb) => cb(code, signal))
  })

  return {
    pid: proc.pid ?? -1,
    write(data: string) {
      proc.stdin?.write(data)
    },
    kill() {
      if (killed || exited) return
      killed = true
      try {
        proc.kill('SIGTERM')
      } catch {
        // already gone
      }
      setTimeout(() => {
        if (!exited) {
          try {
            proc.kill('SIGKILL')
          } catch {
            // already gone
          }
        }
      }, 3000).unref?.()
    },
    onLine(cb) {
      lineCbs.push(cb)
    },
    onStderr(cb) {
      stderrCbs.push(cb)
    },
    onExit(cb) {
      exitCbs.push(cb)
    },
  }
}
