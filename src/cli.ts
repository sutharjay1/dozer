import { resolveNextBin } from './child.js'
import { runDev } from './commands/dev.js'
import { runCoordinator } from './coordinator/server.js'
import { runNext } from './passthrough.js'

const USAGE = 'usage: napdev next dev [next dev options]\n'

async function main(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  if (argv[0] === '__coordinator') return runCoordinator(env) // hidden: started by the first gate
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

process.stdout.on('error', () => {}) // a closed pipe must not crash napdev while Next is running
main(process.argv.slice(2), process.env, process.cwd()).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`napdev: ${(err as Error)?.stack ?? String(err)}\n`)
    process.exit(1)
  },
)
