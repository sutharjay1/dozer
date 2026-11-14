import { spawn } from 'node:child_process'
import { constants } from 'node:os'

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** Runs the real Next with `args`, stdio inherited and signals forwarded; resolves its exit code. */
export function runNext(nextBin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [nextBin, ...args], { cwd, env, stdio: 'inherit' })
    const forward = (sig: NodeJS.Signals) => { try { child.kill(sig) } catch { /* already gone */ } }
    for (const sig of FORWARDED) process.on(sig, forward)
    const done = (code: number) => {
      for (const sig of FORWARDED) process.off(sig, forward)
      resolve(code)
    }
    child.once('error', (err) => {
      process.stderr.write(`dozer: could not run next (${err.message})\n`)
      done(1)
    })
    child.once('exit', (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)))
  })
}
