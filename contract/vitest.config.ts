import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['contract/**/*.test.ts'], testTimeout: 20000, hookTimeout: 120000, fileParallelism: false },
})
