import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// test/dev.test.ts spawns the built CLI, so build it once before any test runs.
export default function setup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url))
  execFileSync('pnpm', ['build'], { cwd: root, stdio: 'ignore' })
}
