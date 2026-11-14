import type { AppView } from './protocol.js'

export interface Limits { maxAwake: number; memoryBudgetBytes: number | null; graceMs: number }

/**
 * The apps to sleep, in order. Over the limit means more than `maxAwake` apps awake or waking, or
 * their RSS above the budget. Only awake, unpinned, idle apps whose last activity (request or wake)
 * is past the grace period qualify, oldest first; when none does the limit is left exceeded (it is soft).
 */
export function chooseVictims(apps: AppView[], limits: Limits, now: number): string[] {
  const up = apps.filter((a) => a.state === 'awake' || a.state === 'waking')
  let count = up.length
  let rss = up.reduce((sum, a) => sum + a.rssBytes, 0)
  const over = () => count > limits.maxAwake || (limits.memoryBudgetBytes !== null && rss > limits.memoryBudgetBytes)

  const candidates = up
    .filter((a) => a.state === 'awake' && !a.pinned && a.inFlight === 0
      && (a.lastActiveAt === null || now - a.lastActiveAt >= limits.graceMs))
    .sort((x, y) => (x.lastActiveAt ?? -Infinity) - (y.lastActiveAt ?? -Infinity))

  const victims: string[] = []
  for (const a of candidates) {
    if (!over()) break
    victims.push(a.id)
    count--
    rss -= a.rssBytes
  }
  return victims
}
