import { askCoordinator } from '../coordinator/client.js'
import type { AppView } from '../coordinator/protocol.js'
import { napdevHome } from '../config.js'

export type Match = { kind: 'one'; app: AppView } | { kind: 'many'; apps: AppView[] } | { kind: 'none' }

/** An id (exact), else an exact name, else a case-insensitive substring of the name; all case-insensitive. */
export function matchApps(apps: AppView[], query: string): Match {
  const q = query.toLowerCase()
  const byId = apps.find((a) => a.id === query)
  if (byId) return { kind: 'one', app: byId }
  const exact = apps.filter((a) => a.name.toLowerCase() === q)
  if (exact.length === 1) return { kind: 'one', app: exact[0]! }
  const found = exact.length ? exact : apps.filter((a) => a.name.toLowerCase().includes(q))
  if (found.length === 0) return { kind: 'none' }
  return found.length === 1 ? { kind: 'one', app: found[0]! } : { kind: 'many', apps: found }
}

const names = (apps: AppView[]): string => apps.map((a) => a.name).sort().map((n) => n + '\n').join('')

const fail = (text: string): number => {
  process.stderr.write(text)
  return 1
}

async function control(verb: 'sleep' | 'wake', argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const all = verb === 'sleep' && argv.length === 1 && argv[0] === '--all'
  const query = argv[0]
  if (!all && (argv.length !== 1 || !query || query.startsWith('-'))) {
    return fail(`usage: napdev sleep <name> | --all\n       napdev wake <name>\n`)
  }
  const home = napdevHome(env)
  if (all) {
    const reply = await askCoordinator({ t: 'sleep', target: '*' }, home)
    if (reply === null) return fail('No napdev apps are running.\n')
    if (reply.t !== 'ok') return fail('napdev: could not sleep apps\n')
    process.stdout.write(`Asleep: ${reply.count} app(s)\n`)
    return 0
  }
  const listed = await askCoordinator({ t: 'list' }, home)
  if (listed?.t !== 'apps' || listed.apps.length === 0) return fail('No napdev apps are running.\n')
  const m = matchApps(listed.apps, query!)
  if (m.kind === 'none') return fail(`No napdev app matches "${query}". Running apps:\n${names(listed.apps)}`)
  if (m.kind === 'many') return fail(`"${query}" matches several apps:\n${names(m.apps)}`)
  const done = `${verb === 'sleep' ? 'Asleep' : 'Awake'}: ${m.app.name}\n`
  // already there: the coordinator would answer count 0, but the goal state holds
  if (verb === 'sleep' ? m.app.state === 'asleep' : m.app.state !== 'asleep') {
    process.stdout.write(done)
    return 0
  }
  const reply = await askCoordinator({ t: verb, target: m.app.id }, home)
  if (reply?.t !== 'ok' || reply.count < 1) return fail(`napdev: could not ${verb} ${m.app.name}\n`)
  process.stdout.write(done)
  return 0
}

export const runSleep = (argv: string[], env: NodeJS.ProcessEnv) => control('sleep', argv, env)
export const runWake = (argv: string[], env: NodeJS.ProcessEnv) => control('wake', argv, env)
