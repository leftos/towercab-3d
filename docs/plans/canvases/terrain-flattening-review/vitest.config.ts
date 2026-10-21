import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, '../..'),
  test: {
    environment: 'node',
    include: ['.tmp/tc3d-193/**/*.test.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
  resolve: { alias: { '@': resolve(__dirname, '../../src/renderer') } },
})
