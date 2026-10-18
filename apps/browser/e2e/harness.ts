import { Hub } from '@codegent/hub'
import {
  newId,
  PROTOCOL_VERSION,
  type JobEvent,
  type JobRequest
} from '@codegent/protocol'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Worker } from 'playwright-core'
import WebSocket from 'ws'
import { findChromium, startMock, type MockChatGpt } from './mock-chatgpt'
// @ts-expect-error - plain .mjs build script without type declarations
import { buildExtension } from '../scripts/build.mjs'

export { MockChatGpt, type ReplyPlan } from './mock-chatgpt'

export const E2E_PORTS = [47695, 47696]
const DEBUG_PORT = 47698

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
  // CODEGENT_MINIFY=1 runs everything against the minified build that is released.
  await buildExtension({
    outDir: extensionDir,
    hubPorts: E2E_PORTS,
    minify: process.env.CODEGENT_MINIFY === '1'
  })

  const { mock, ...mockServer } = await startMock()

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
