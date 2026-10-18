import { defineConfig } from 'vitest/config'

// Unit tests cover everything that does not need the `vscode` module, plus the webview (in jsdom,
// with a fake of the API VS Code gives a webview). Code that needs VS Code itself is covered by the
// integration tests that run inside a real VS Code (`npm run test:integration`).
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    name: 'vscode-extension',
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/webview/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
