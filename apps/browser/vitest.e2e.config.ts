import { defineConfig } from 'vitest/config'

// Real Chromium + real extension + real hub. Slower than the unit tests, so it runs separately:
//   npm run test:e2e --workspace @codegent/browser-extension
export default defineConfig({
  test: {
    name: 'browser-e2e',
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
