import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'spikes/**', 'test/e2e/**'],
    globalSetup: ['test/global-setup.ts'],
  },
})
