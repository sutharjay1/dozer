import { askCoordinator } from '../coordinator/client.js'
import type { AppView } from '../coordinator/protocol.js'
import { napdevHome } from '../config.js'
import type { GateState } from '../gate.js'

const USAGE = 'usage: napdev status [--json]\n'
const NONE = 'No napdev apps are running.\n'
const ORDER: Record<GateState, number> = { awake: 0, waking: 1, asleep: 2 }

/** `never`, `<n>s ago` (under a minute), `<n>m ago` (under an hour), else `<n>h ago`. */
export function formatAgo(at: number | null, now: number): string {
  if (at === null) return 'never'
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

/** Whole MB, or `-` for an asleep app or no reading. */
export function formatRss(bytes: number, state: GateState): string {
  return state === 'asleep' || bytes <= 0 ? '-' : `${Math.round(bytes / (1024 * 1024))} MB`
}

/** Awake first, then waking, then asleep; by name within each. */
export function formatTable(apps: AppView[], now: number): string {
  const sorted = [...apps].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const rows = [
    ['NAME', 'STATE', 'PORT', 'RSS', 'LAST REQUEST'],
    ...sorted.map((a) => [a.name, a.pinned ? `${a.state} (pinned)` : a.state, String(a.publicPort),
      formatRss(a.rssBytes, a.state), formatAgo(a.lastHttpAt, now)]),
  ]
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')
}

export async function runStatus(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.some((a) => a !== '--json')) {
    process.stderr.write(USAGE)
    return 1
  }
  const reply = await askCoordinator({ t: 'list' }, napdevHome(env))
  if (reply?.t !== 'apps' || reply.apps.length === 0) {
    process.stdout.write(argv.length ? '[]\n' : NONE)
    return 0
  }
  process.stdout.write(argv.length ? JSON.stringify(reply.apps, null, 2) + '\n' : formatTable(reply.apps, Date.now()) + '\n')
  return 0
}
