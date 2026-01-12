import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Increase timeout for tests that scan large directories
    testTimeout: 60000,
    // Allow more time for beforeAll hooks (model scanning)
    hookTimeout: 120000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src/renderer'),
    },
  },
})
