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
  state: GateState; inFlight: number; lastHttpAt: number | null; rssBytes: number
}

export type GateMsg = { t: 'hello'; v: number; app: Omit<AppView, 'state' | 'inFlight' | 'lastHttpAt' | 'rssBytes'> }
  | { t: 'report'; state: GateState; inFlight: number; lastHttpAt: number | null; rssBytes: number }
/** `welcome` acknowledges a hello of the same version; a gate counts as connected only after it. */
export type CoordMsg = { t: 'sleep'; reason: 'evicted' | 'manual' } | { t: 'wake' } | { t: 'reject'; reason: 'version' }
  | { t: 'welcome'; v: number }
/** target: an app id, or '*' for every app */
export type CliMsg = { t: 'list' } | { t: 'sleep'; target: string } | { t: 'wake'; target: string }
export type CliReply = { t: 'apps'; apps: AppView[] } | { t: 'ok'; count: number }

export const encode = (msg: GateMsg | CoordMsg | CliMsg | CliReply): string => JSON.stringify(msg) + '\n'

/** Splits a stream into JSON lines; lines that do not parse go to `onBad`. */
export function lineReader(onMessage: (msg: Record<string, unknown>) => void, onBad: (line: string) => void = () => {}):
  (chunk: string) => void {
  let partial = ''
  return (chunk) => {
    const parts = (partial + chunk).split('\n')
    partial = parts.pop() ?? ''
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
