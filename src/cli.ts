import { resolveNextBin } from './child.js'
import { runSleep, runWake } from './commands/control.js'
import { runDev } from './commands/dev.js'
import { runInit } from './commands/init.js'
import { runStatus } from './commands/status.js'
import { runCoordinator } from './coordinator/server.js'
import { runGuard } from './guard.js'
import { runNext } from './passthrough.js'

const USAGE = `usage: napdev next dev [next dev options]
       napdev status [--json]
       napdev sleep <name> | --all
       napdev wake <name>
       napdev init [--yes]
`

async function main(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  if (argv[0] === '__guard') return runGuard(argv.slice(1)) // hidden: leads an awake Next's process group
  if (argv[0] === '__coordinator') return runCoordinator(env) // hidden: started by the first gate
  if (argv[0] === 'status') return runStatus(argv.slice(1), env)
  if (argv[0] === 'sleep') return runSleep(argv.slice(1), env)
  if (argv[0] === 'init') return runInit(argv.slice(1), env, cwd)
  if (argv[0] === 'wake') return runWake(argv.slice(1), env)
  if (argv[0] !== 'next') {
    process.stderr.write(USAGE)
    return 1
  }
  if (argv[1] === 'dev' && env.NAPDEV !== '0') return runDev(argv.slice(2), env, cwd)
  let nextBin: string
  try {
    nextBin = resolveNextBin(cwd, env)
  } catch {
    process.stderr.write(`napdev: could not find next in ${cwd}\n`)
    return 1
  }
  return runNext(nextBin, argv.slice(1), cwd, env)
}

// a closed pipe or terminal (EPIPE, EIO) must not crash napdev while Next is running
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
main(process.argv.slice(2), process.env, process.cwd()).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`napdev: ${(err as Error)?.stack ?? String(err)}\n`)
    process.exit(1)
  },
)
