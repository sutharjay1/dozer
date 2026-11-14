import { spawnChild, stopTree, waitReady, type ChildHandle } from './child.js'
import { WakeFailedError } from './gate.js'
import { findHiddenPort } from './port.js'

// The gate's wake timeout is the real limit; this only stops waitReady from polling forever.
const READY_LIMIT_MS = 24 * 3_600_000

export interface ChildLauncher {
  startChild(signal: AbortSignal): Promise<ChildHandle>
  stopChild(child: ChildHandle): Promise<void>
}

export function createChildLauncher(o: {
  nextBin: string; cwd: string; env: NodeJS.ProcessEnv; passthrough: string[]
  publicPort: number
  /** Output of the child on `hiddenPort`; several children can briefly overlap (a late stop). */
  onOutput(text: string, hiddenPort: number): void
  /** Called right after each spawn, before any of its output arrives. */
  onSpawn?(child: ChildHandle): void
}): ChildLauncher {
  return {
    async startChild(signal) {
      signal.throwIfAborted()
      const hiddenPort = await findHiddenPort()
      signal.throwIfAborted()
      const child = spawnChild({ ...o, hiddenPort, onOutput: (text) => o.onOutput(text, hiddenPort) })
      o.onSpawn?.(child)
      try {
        await Promise.race([
          waitReady(hiddenPort, READY_LIMIT_MS, signal),
          child.exited.then((code) => {
            throw new WakeFailedError(`next exited with code ${code} before it was ready`)
          }),
        ])
        return child
      } catch (err) {
        // the caller only learns of the failure once nothing from this child is left running
        await stopTree(child.pid).catch(() => {})
        throw err
      }
    },
    stopChild: (child) => stopTree(child.pid),
  }
}
