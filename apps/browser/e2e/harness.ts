import { build } from 'esbuild'
import { Hub } from '@codegent/hub'
import {
  newId,
  PROTOCOL_VERSION,
  type JobEvent,
  type JobRequest
} from '@codegent/protocol'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Worker } from 'playwright-core'
import selfsigned from 'selfsigned'
import WebSocket from 'ws'
// @ts-expect-error - plain .mjs build script without type declarations
import { buildExtension } from '../scripts/build.mjs'

export const E2E_PORTS = [47695, 47696]
const DEBUG_PORT = 47698
const here = path.dirname(fileURLToPath(import.meta.url))

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export const waitUntil = async <T>(
  probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  what: string,
  timeoutMs = 20_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value as T
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

// ── locating a Chromium build that can load extensions ─────────────────────────────────────────
const findChromium = (): string => {
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

// ── the mock ChatGPT, served by intercepting requests ────────────────────────────────────────────
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

// ── a scripted VS Code stand-in ─────────────────────────────────────────────────────────────────
export class TestEditor {
  readonly events = new Map<string, JobEvent[]>()
  peers: Array<{ id: string; name: string; chatgptTabs: number; profile?: string }> = []
  private socket!: WebSocket
  private listeners: Array<() => void> = []

  private constructor(
    readonly id: string,
    private port: number
  ) {}

  static async connect(port: number, id = newId()): Promise<TestEditor> {
    const editor = new TestEditor(id, port)
    await editor.open()
    return editor
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}/ws?role=editor&id=${this.id}&protocol=${PROTOCOL_VERSION}`
      this.socket = new WebSocket(url)
      this.socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ping') this.socket.send(JSON.stringify({ type: 'pong' }))
        if (message.type === 'peers') this.peers = message.browsers
        if (message.type === 'event') {
          const list = this.events.get(message.jobId) ?? []
          list.push(message.event)
          this.events.set(message.jobId, list)
        }
        this.listeners.forEach((l) => l())
      })
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
  }

  /** Reconnect with the same identity (as a reloaded VS Code window does). */
  async reconnect(port = this.port): Promise<void> {
    this.socket.terminate()
    this.port = port
    await this.open()
  }

  close(): void {
    this.socket.terminate()
  }

  job(overrides: Partial<JobRequest> & { text: string }): JobRequest {
    return {
      jobId: newId(),
      sessionId: newId(),
      editorId: this.id,
      newChat: true,
      chatUrl: 'https://chatgpt.com/',
      autoSubmit: true,
      timeoutMs: 45_000,
      ...overrides
    }
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  start(job: JobRequest): void {
    this.send({ type: 'job', job })
  }

  async waitForEvent(
    jobId: string,
    predicate: (e: JobEvent) => boolean,
    what: string,
    timeoutMs = 30_000
  ): Promise<JobEvent> {
    return waitUntil(
      () => this.events.get(jobId)?.find(predicate),
      `${what} (events so far: ${JSON.stringify(this.events.get(jobId) ?? [])})`,
      timeoutMs
    )
  }

  /** Runs a job to its terminal event. */
  async run(job: JobRequest, timeoutMs = 40_000): Promise<JobEvent> {
    this.start(job)
    return this.waitForEvent(
      job.jobId,
      (e) => e.kind === 'completed' || e.kind === 'failed',
      'a terminal event',
      timeoutMs
    )
  }

  kinds(jobId: string): string[] {
    return (this.events.get(jobId) ?? []).map((e) =>
      e.kind === 'progress' ? `progress:${e.stage}` : e.kind
    )
  }
}

// ── the whole world ───────────────────────────────────────────────────────────────────────────────
export interface World {
  hub: Hub
  /** Everything the hub logged (rejections, connections …). */
  hubLog: string[]
  context: BrowserContext
  editor: TestEditor
  mock: MockChatGpt
  extensionId: string
  serviceWorker: () => Worker
  restartHub: () => Promise<void>
  /** Terminates the extension's service worker, as Chromium does when it considers it idle. */
  killServiceWorker: () => Promise<void>
  close: () => Promise<void>
}

export const startWorld = async (): Promise<World> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-e2e-'))
  const extensionDir = path.join(root, 'extension')
  await buildExtension({ outDir: extensionDir, hubPorts: E2E_PORTS })

  const bundle = await build({
    entryPoints: [path.join(here, 'mock', 'mock-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome116',
    logLevel: 'warning'
  })
  const mock = new MockChatGpt(bundle.outputFiles[0]!.text)
  const mockServer = await mock.listen()

  const hubLog: string[] = []
  const makeHub = () =>
    new Hub({
      port: E2E_PORTS[0]!,
      idleExitMs: 0,
      version: 'e2e',
      log: (line) => hubLog.push(line)
    })
  let hub = makeHub()
  await hub.start()

  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    executablePath: findChromium(),
    headless: false,
    viewport: { width: 1000, height: 700 },
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${mockServer.port}`,
      '--ignore-certificate-errors',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling'
    ]
  })

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 20_000 }))
  const extensionId = new URL(worker.url()).host

  const editor = await TestEditor.connect(E2E_PORTS[0]!)
  await waitUntil(() => editor.peers.length === 1, 'the extension to connect to the hub')

  const world: World = {
    hub,
    hubLog,
    context,
    editor,
    mock,
    extensionId,
    serviceWorker: () =>
      context.serviceWorkers().find((w) => w.url().includes(extensionId))!,
    async restartHub() {
      await hub.stop()
      hub = makeHub()
      await hub.start()
      world.hub = hub
    },
    async killServiceWorker() {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
      try {
        const session = await browser.newBrowserCDPSession()
        const { targetInfos } = await session.send('Target.getTargets')
        const target = targetInfos.find(
          (t) =>
            t.type === 'service_worker' &&
            t.url.startsWith(`chrome-extension://${extensionId}/`)
        )
        if (!target) throw new Error('extension service worker target not found')
        await session.send('Target.closeTarget', { targetId: target.targetId })
      } finally {
        await browser.close().catch(() => undefined)
      }
    },
    async close() {
      editor.close()
      await context.close().catch(() => undefined)
      await hub.stop().catch(() => undefined)
      await mockServer.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  return world
}
