import { join } from 'node:path'
import type { GateState } from '../gate.js'

export const PROTOCOL_VERSION = 1

// sun_path holds 104 bytes on macOS (108 on Linux), including the terminating NUL.
// Longer paths are silently truncated by the OS, so they are refused instead.
export const MAX_SOCKET_PATH_BYTES = 103

/** `<home>/coordinator.sock` */
export function socketPath(home: string): string {
  return join(home, 'coordinator.sock')
}

export function socketPathUsable(path: string): boolean {
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES
}

export interface AppView {
  id: string; name: string; cwd: string; publicPort: number; pid: number; pinned: boolean
  /** the gate's own grace period; the policy judges each app by it */
  graceMs: number
  state: GateState; inFlight: number; lastHttpAt: number | null
  /** max(lastHttpAt, when the current child became ready): what the policy's age and grace use */
  lastActiveAt: number | null
  rssBytes: number
}

export type GateMsg = { t: 'hello'; v: number; app: Omit<AppView, 'state' | 'inFlight' | 'lastHttpAt' | 'lastActiveAt' | 'rssBytes'> }
  | { t: 'report'; state: GateState; inFlight: number; lastHttpAt: number | null; lastActiveAt: number | null; rssBytes: number
      /** set on the report that answers an eviction the gate refused */
      refused?: true }
/** `welcome` acknowledges a hello of the same version; a gate counts as connected only after it. */
export type CoordMsg = { t: 'sleep'; reason: 'evicted' | 'manual' } | { t: 'wake' } | { t: 'reject'; reason: 'version' }
  | { t: 'welcome'; v: number }
/** target: an app id, or '*' for every app */
export type CliMsg = { t: 'list' } | { t: 'sleep'; target: string } | { t: 'wake'; target: string }
export type CliReply = { t: 'apps'; apps: AppView[] } | { t: 'ok'; count: number }

export const encode = (msg: GateMsg | CoordMsg | CliMsg | CliReply): string => JSON.stringify(msg) + '\n'

export const MAX_LINE_BYTES = 64 * 1024

/**
 * Splits a stream into JSON lines; lines that do not parse go to `onBad`. A line longer than
 * MAX_LINE_BYTES calls `onOverflow` and everything after it is ignored.
 */
export function lineReader(onMessage: (msg: Record<string, unknown>) => void, onBad: (line: string) => void = () => {},
  onOverflow: () => void = () => {}): (chunk: string) => void {
  let partial = ''
  let overflowed = false
  return (chunk) => {
    if (overflowed) return
    const parts = (partial + chunk).split('\n')
    partial = parts.pop() ?? ''
    if (Buffer.byteLength(partial) > MAX_LINE_BYTES || parts.some((l) => Buffer.byteLength(l) > MAX_LINE_BYTES)) {
      overflowed = true
      partial = ''
      onOverflow()
      return
    }
    for (const line of parts) {
      if (!line.trim()) continue
      let msg: unknown
      try { msg = JSON.parse(line) } catch { onBad(line); continue }
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && typeof (msg as { t?: unknown }).t === 'string') {
        onMessage(msg as Record<string, unknown>)
      } else {
        onBad(line)
      }
    }
  }
}
