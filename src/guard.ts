// `dozer __guard <nextBin> dev …`: the leader of an awake Next.js process group.
// The gate spawns it in a new session and holds its stdin open without writing. If the gate dies
// in any way (SIGKILL included), stdin ends and the guard SIGKILLs its whole group, Next with it.
// Keep the imports minimal: one guard runs per awake app.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// Next's workers may hold its stdout open after it exits; do not wait on them for long.
const CLOSE_WAIT_MS = 200

function killGroup(): void {
  try { process.kill(-process.pid, 'SIGKILL') } catch { /* nothing left */ }
}

export function runGuard(argv: string[]): Promise<number> {
  const [nextBin, ...args] = argv
  if (!nextBin) {
    process.stderr.write('dozer: __guard needs the next binary\n')
    return Promise.resolve(1)
  }
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  process.stdin.on('end', killGroup)
  process.stdin.on('error', killGroup)
  process.stdin.resume()

  return new Promise((resolve) => {
    // same process group as the guard (not detached): one group signal reaches every process
    const child = spawn(process.execPath, [nextBin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => process.stdout.write(d))
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d))
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    const forward = (sig: NodeJS.Signals) => { try { child.kill(sig) } catch { /* already gone */ } }
    for (const sig of FORWARDED) process.on(sig, forward)

    let done = false
    const finish = (code: number) => {
      if (done) return
      done = true
      for (const sig of FORWARDED) process.off(sig, forward)
      process.stdin.off('end', killGroup)
      process.stdin.off('error', killGroup)
      process.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      // resolve once what Next printed has been flushed to the gate
      process.stdout.write('', () => process.stderr.write('', () => resolve(code)))
    }
    child.once('error', (err) => {
      process.stderr.write(`dozer: could not run next (${err.message})\n`)
      finish(1)
    })
    child.once('exit', (code, signal) => {
      const status = code ?? 128 + (signal ? constants.signals[signal] : 0)
      const t = setTimeout(() => finish(status), CLOSE_WAIT_MS)
      child.once('close', () => { clearTimeout(t); finish(status) })
    })
  })
}
