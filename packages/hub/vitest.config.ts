import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'hub',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
