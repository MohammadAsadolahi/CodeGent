// The pretend chatgpt.com used by every end-to-end test: a page with a real ProseMirror composer
// served over HTTPS, a reply queue, and a few control endpoints. Kept free of any CodeGent
// package so it can also be used by the VS Code extension's full-chain test.
import { build } from 'esbuild'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import selfsigned from 'selfsigned'

const defaultPageEntry = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock', 'mock-page.ts')

// ── locating a Chromium build that can load extensions ─────────────────────────────────────────
export const findChromium = (): string => {
  if (process.env.CODEGENT_CHROMIUM) return process.env.CODEGENT_CHROMIUM
  try {
    const own = chromium.executablePath()
    if (own && fs.existsSync(own)) return own
  } catch {
    // fall through to scanning the cache
  }
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(
      process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? os.homedir())
        : process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Caches')
          : path.join(os.homedir(), '.cache'),
      'ms-playwright'
    )
  const executables = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-linux64/chrome',
    'chrome-linux/chrome'
  ]
  const builds = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : []
  for (const dir of builds) {
    for (const relative of executables) {
      const candidate = path.join(cache, dir, relative)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error(
    'No Chromium found. Run `npx playwright-core install chromium` or set CODEGENT_CHROMIUM.'
  )
}

// ── the mock ChatGPT ─────────────────────────────────────────────────────────────────────────────
export interface ReplyPlan {
  markdown: string
  chunks?: number
  chunkMs?: number
  hold?: boolean
}

export class MockChatGpt {
  readonly sent: string[] = []
  stopClicks = 0
  loggedOut = false
  private queue: ReplyPlan[] = []
  private released = false

  constructor(private readonly script: string) {}

  queueReply(markdown: string, options: Omit<ReplyPlan, 'markdown'> = {}): void {
    this.queue.push({ markdown, ...options })
  }
  release(): void {
    this.released = true
  }

  respond(request: { path: string; body: string }): {
    status: number
    type: string
    body: string
  } {
    const json = (body: unknown) => ({
      status: 200,
      type: 'application/json',
      body: JSON.stringify(body)
    })
    switch (request.path) {
      case '/__mock.js':
        return { status: 200, type: 'text/javascript', body: this.script }
      case '/__mock/next-reply': {
        const plan = this.queue.shift() ?? { markdown: 'OK' }
        this.released = false
        return json({ chunks: 3, chunkMs: 20, hold: false, ...plan })
      }
      case '/__mock/sent':
        this.sent.push(JSON.parse(request.body || '{}').text)
        return json({})
      case '/__mock/stop':
        this.stopClicks += 1
        return json({})
      case '/__mock/config':
        return json({ loggedOut: this.loggedOut })
      case '/__mock/released':
        return json({ released: this.released })
      // Control endpoints for tests that run in another process.
      case '/__mock/control/queue': {
        const { markdown, ...options } = JSON.parse(request.body || '{}') as ReplyPlan
        this.queueReply(markdown, options)
        return json({})
      }
      case '/__mock/control/release':
        this.release()
        return json({})
      case '/__mock/control/set':
        this.loggedOut = Boolean(JSON.parse(request.body || '{}').loggedOut)
        return json({})
      case '/__mock/control/log':
        return json({
          sent: this.sent,
          stopClicks: this.stopClicks,
          loggedOut: this.loggedOut,
          queued: this.queue.length
        })
      case '/__mock/control/reset':
        this.sent.length = 0
        this.stopClicks = 0
        this.loggedOut = false
        this.queue = []
        this.released = false
        return json({})
      case '/favicon.ico':
        return { status: 204, type: 'image/x-icon', body: '' }
      default:
        return {
          status: 200,
          type: 'text/html',
          body:
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title>' +
            '<style>body{font:14px sans-serif}#prompt-textarea{min-height:40px;border:1px solid #888;padding:6px;white-space:pre-wrap}</style>' +
            '</head><body><script src="/__mock.js"></script></body></html>'
        }
    }
  }

  /**
   * Serves the mock over HTTPS. Chromium is told to resolve chatgpt.com to this server, so every
   * tab — including ones the extension opens itself — gets the mock and nothing reaches the
   * real site.
   */
  async listen(): Promise<{ port: number; close: () => Promise<void> }> {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'chatgpt.com' }], {
      days: 1,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'chatgpt.com' }] }
      ]
    })
    const server = https.createServer(
      { key: pems.private, cert: pems.cert },
      (req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const answer = this.respond({ path: (req.url ?? '/').split('?')[0]!, body })
          res.writeHead(answer.status, {
            'Content-Type': answer.type,
            'Cache-Control': 'no-store'
          })
          res.end(answer.body)
        })
      }
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: (server.address() as AddressInfo).port,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    }
  }
}

/**
 * Builds the mock page script and serves it; the caller owns closing the server. `pageEntry` is the
 * source of the page script (only needed when this module is bundled and cannot find it itself).
 */
export const startMock = async (
  pageEntry: string = defaultPageEntry()
): Promise<{
  mock: MockChatGpt
  port: number
  close: () => Promise<void>
}> => {
  const bundle = await build({
    entryPoints: [pageEntry],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome116',
    logLevel: 'warning'
  })
  const mock = new MockChatGpt(bundle.outputFiles[0]!.text)
  const server = await mock.listen()
  return { mock, ...server }
}
