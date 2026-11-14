// `dozer __guard <nextBin> dev …`: the leader of an awake Next.js process group.
// The gate spawns it in a new session and holds its stdin open without writing. If the gate dies
// in any way (SIGKILL included), stdin ends and the guard SIGKILLs its whole group, Next with it.
// Keep the imports minimal: one guard runs per awake app.
import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:os'

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// Next's workers may hold its stdout open after it exits; do not wait on them for long.
const CLOSE_WAIT_MS = 200

function killGroup(): void {
  try { process.kill(-process.pid, 'SIGKILL') } catch { /* nothing left */ }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * Live members of this guard's group other than itself (the guard leads it: pgid is its pid), or
 * null if ps failed. ps lists itself as a member; it has exited by now, so `alive` drops it.
 */
function others(): number[] | null {
  let out: string
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1_000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return null
  }
  const pids: number[] = []
  for (const line of out.split('\n')) {
    const [p, g, st] = line.trim().split(/\s+/)
    const pid = Number(p)
    if (!p || Number(g) !== process.pid || pid === process.pid || (st ?? '').startsWith('Z') || !alive(pid)) continue
    pids.push(pid)
  }
  return pids
}

/**
 * Next has exited: SIGKILL its leftover workers now instead of leaving them to the gate's stop,
 * which can die during its SIGTERM grace. The guard itself survives to report Next's exit code,
 * unless ps fails: then it takes the whole group down, itself included.
 */
async function killOthers(): Promise<void> {
  const killed = new Set<number>()
  const end = Date.now() + 1_000
  for (;;) {
    const left = others()
    if (left === null) return killGroup()
    const fresh = left.filter((pid) => !killed.has(pid))
    if (fresh.length === 0 || Date.now() >= end) return
    for (const pid of fresh) {
      killed.add(pid)
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
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
      void killOthers().then(() => process.stdout.write('', () => process.stderr.write('', () => resolve(code))))
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
