import { defineConfig } from 'vitest/config'

// Unit tests cover everything that does not need the `vscode` module. Code that does is covered
// by the integration tests that run inside a real VS Code (`npm run test:integration`).
export default defineConfig({
  test: {
    name: 'vscode-extension',
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
