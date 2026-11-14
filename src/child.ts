import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import { join } from 'node:path'

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

export function spawnChild(o: {
  nextBin: string; cwd: string; env: NodeJS.ProcessEnv; passthrough: string[]
  hiddenPort: number; publicPort: number; onOutput(text: string): void
}): ChildHandle {
  const child = spawn(
    process.execPath,
    [o.nextBin, 'dev', ...o.passthrough, '--port', String(o.hiddenPort), '--hostname', '127.0.0.1'],
    {
      cwd: o.cwd,
      env: { ...o.env, NAPDEV_PUBLIC_PORT: String(o.publicPort), PORT: String(o.hiddenPort) },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
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
    const finish = (err?: unknown) => {
      if (done) return
      done = true
      clearTimeout(poll)
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
      if (err === undefined) resolve()
      else reject(err)
    }
    const onAbort = () => finish(signal.reason ?? new Error('aborted'))
    const deadline = setTimeout(
      () => finish(new Error(`next did not become ready on port ${hiddenPort} within ${timeoutMs}ms`)),
      timeoutMs,
    )
    let poll: NodeJS.Timeout = setTimeout(() => {}, 0)
    const attempt = () => {
      if (done) return
      const req = http.get(
        { host: '127.0.0.1', port: hiddenPort, path: '/', agent: false, timeout: 500 },
        (res) => { res.resume(); finish() },
      )
      const retry = () => { req.destroy(); if (!done) poll = setTimeout(attempt, 100) }
      req.once('timeout', retry)
      req.once('error', retry)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    attempt()
  })
}

function ps(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', args, { maxBuffer: 16 * 1024 * 1024 }, (_e, out) => resolve(out ?? ''))
  })
}

async function groupMembers(pgid: number): Promise<number[]> {
  const out = await ps(['-axo', 'pid=,pgid='])
  const pids: number[] = []
  for (const line of out.split('\n')) {
    const [p, g] = line.trim().split(/\s+/).map(Number)
    if (p !== undefined && g === pgid && Number.isFinite(p)) pids.push(p)
  }
  return pids
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pgid, sig) } catch { /* group already gone */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function stopTree(pid: number, termGraceMs = 5_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  const own = Number((await ps(['-o', 'pgid=', '-p', String(process.pid)])).trim())
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
  const out = await ps(['-axo', 'pgid=,rss='])
  let kb = 0
  for (const line of out.split('\n')) {
    const [g, r] = line.trim().split(/\s+/).map(Number)
    if (g === pid && r !== undefined && Number.isFinite(r)) kb += r
  }
  return kb * 1024
}
