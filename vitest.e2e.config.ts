import { defineConfig } from 'vitest/config'

// Real Next.js 16 apps; local only and slow (see test/e2e/harness.ts). Run with `pnpm test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'spikes/**', 'test/e2e/apps/**'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    silent: false, // the measured numbers are printed as [e2e] lines
  },
})
