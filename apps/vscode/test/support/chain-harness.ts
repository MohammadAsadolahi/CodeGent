// Starts the "outside world" of the full-chain test: a Chromium with the real browser extension
// loaded, and a pretend chatgpt.com that every tab of that Chromium talks to. Run by
// scripts/integration.mjs (in Node, not inside VS Code).
import { chromium } from 'playwright-core'
import { findChromium, startMock } from '../../../browser/e2e/mock-chatgpt'

export interface Chain {
  /** HTTPS port of the pretend chatgpt.com (its control endpoints live under /__mock/control). */
  mockPort: number
  close(): Promise<void>
}

export const startChain = async (options: {
  /** The unpacked browser extension (built for the test hub ports). */
  extensionDir: string
  profileDir: string
  /** Source of the mock page script. */
  mockPageEntry: string
}): Promise<Chain> => {
  const mock = await startMock(options.mockPageEntry)
  const context = await chromium.launchPersistentContext(options.profileDir, {
    executablePath: findChromium(),
    headless: false,
    viewport: { width: 1000, height: 700 },
    args: [
      '--headless=new',
      `--disable-extensions-except=${options.extensionDir}`,
      `--load-extension=${options.extensionDir}`,
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${mock.port}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling'
    ]
  })
  // The extension's service worker starting is the sign that it loaded.
  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent('serviceworker', { timeout: 20_000 })
  }
  return {
    mockPort: mock.port,
    close: async () => {
      await context.close().catch(() => undefined)
      await mock.close()
    }
  }
}
