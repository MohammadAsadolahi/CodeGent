import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'browser-extension',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts']
  }
})
