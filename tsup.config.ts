import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  // CommonJS: on Node 22 an ESM entry costs ~14 MB more RSS per gate process (spec goal 1: < 60 MB)
  format: ['cjs'],
  shims: true,
  platform: 'node',
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
