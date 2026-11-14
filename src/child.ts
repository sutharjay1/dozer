import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ChildHandle { pid: number; hiddenPort: number; exited: Promise<number | null> }

export class TreeSurvivedError extends Error {
  constructor(public pids: number[]) {
    super(`process tree survived SIGKILL: ${pids.join(', ')}`)
    this.name = 'TreeSurvivedError'
  }
}

export function resolveNextBin(appDir: string, env: NodeJS.ProcessEnv): string {
  if (env.NAPDEV_NEXT_BIN) return env.NAPDEV_NEXT_BIN
  try {
    return createRequire(join(appDir, 'package.json')).resolve('next/dist/bin/next')
  } catch {
    throw new Error(`could not resolve next from ${appDir}; install next there or set NAPDEV_NEXT_BIN`)
  }
}

// In the bundle this module lives inside dist/cli.cjs; run from source (tests), the built CLI is used.
const SELF = fileURLToPath(import.meta.url)
export const GUARD_CLI = SELF.endsWith('.cjs') ? SELF : join(dirname(SELF), '..', 'dist', 'cli.cjs')

/**
 * Starts Next under a guard process (see guard.ts) that leads a new process group; the handle's
 * pid is the guard's, which is also the group id. The guard kills the group if this process dies.
 */
export function spawnChild(o: {
  nextBin: string; cwd: string; env: NodeJS.ProcessEnv; passthrough: string[]
  hiddenPort: number; publicPort: number; onOutput(text: string): void
}): ChildHandle {
  const env: NodeJS.ProcessEnv = { ...o.env, NAPDEV_PUBLIC_PORT: String(o.publicPort), PORT: String(o.hiddenPort) }
  const child = spawn(
    process.execPath,
    [GUARD_CLI, '__guard', o.nextBin, 'dev', ...o.passthrough, '--port', String(o.hiddenPort), '--hostname', '127.0.0.1'],
    { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  // held open and never written: it ends only when this process dies
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8').on('data', (d: string) => o.onOutput(d))
  child.stderr.setEncoding('utf8').on('data', (d: string) => o.onOutput(d))
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null))
    child.once('close', (code) => resolve(code))
  })
  return { pid: child.pid ?? -1, hiddenPort: o.hiddenPort, exited }
}

export function waitReady(hiddenPort: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    let poll: NodeJS.Timeout | undefined
    let inflight: http.ClientRequest | undefined
    const finish = (err?: unknown) => {
      if (done) return
      done = true
      clearTimeout(poll)
      clearTimeout(deadline)
      inflight?.destroy()
      signal.removeEventListener('abort', onAbort)
      if (err === undefined) resolve()
      else reject(err)
    }
    const onAbort = () => finish(signal.reason ?? new Error('aborted'))
    const deadline = setTimeout(
      () => finish(new Error(`next did not become ready on port ${hiddenPort} within ${timeoutMs}ms`)),
      timeoutMs,
    )
    const attempt = () => {
      if (done) return
      // A connect that is accepted may take seconds to answer while Next compiles; wait it out.
      const req = http.get(
        { host: '127.0.0.1', port: hiddenPort, path: '/', agent: false, timeout: 5_000 },
        (res) => { res.resume(); finish() },
      )
      inflight = req
      const retry = () => { req.destroy(); if (!done) poll = setTimeout(attempt, 100) }
      req.once('timeout', retry)
      req.once('error', retry)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    attempt()
  })
}

export const psRunner = {
  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('ps', args, { maxBuffer: 64 * 1024 * 1024 }, (e, out) => {
        if (e) return reject(new Error(`ps failed: ${e.message}`))
        // ps always lists at least itself's caller; empty output is never valid.
        if (!out.trim()) return reject(new Error('ps printed nothing'))
        resolve(out)
      })
    })
  },
}

async function groupMembers(pgid: number): Promise<number[]> {
  const out = await psRunner.run(['-A', '-o', 'pid=,pgid=,stat='])
  const pids: number[] = []
  for (const line of out.split('\n')) {
    const [p, g, st] = line.trim().split(/\s+/)
    if (!p || Number(g) !== pgid || (st ?? '').startsWith('Z')) continue
    pids.push(Number(p))
  }
  return pids
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pgid, sig) } catch { /* group already gone */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function stopTree(pid: number, termGraceMs = 5_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  const own = Number((await psRunner.run(['-o', 'pgid=', '-p', String(process.pid)])).trim())
  if (pid === own) return // never signal our own process group
  signalGroup(pid, 'SIGTERM')
  const graceEnd = Date.now() + termGraceMs
  while (Date.now() < graceEnd) {
    if ((await groupMembers(pid)).length === 0) return
    await sleep(50)
  }
  signalGroup(pid, 'SIGKILL')
  const recheckEnd = Date.now() + 2_000
  let left: number[] = []
  while (Date.now() < recheckEnd) {
    left = await groupMembers(pid)
    if (left.length === 0) return
    signalGroup(pid, 'SIGKILL')
    await sleep(50)
  }
  left = await groupMembers(pid)
  if (left.length) throw new TreeSurvivedError(left)
}

export async function treeRssBytes(pid: number): Promise<number> {
  const out = await psRunner.run(['-A', '-o', 'pgid=,rss=,stat='])
  let kb = 0
  for (const line of out.split('\n')) {
    const [g, r, st] = line.trim().split(/\s+/)
    if (Number(g) === pid && !(st ?? '').startsWith('Z') && Number.isFinite(Number(r))) kb += Number(r)
  }
  return kb * 1024
}
