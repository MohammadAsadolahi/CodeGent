import { ensureHub, type EnsureHubOptions } from '@codegent/hub'
import {
  CLOSE_REPLACED,
  HEARTBEAT_DEAD_AFTER_MS,
  HUB_HOST,
  hubToEditorSchema,
  newId,
  parseJson,
  PROTOCOL_VERSION,
  serialize,
  type BrowserInfo,
  type FoundHub,
  type JobEvent,
  type JobRequest
} from '@codegent/protocol'
import WebSocket from 'ws'

export type ConnectionState = 'offline' | 'connecting' | 'connected'

export interface HubEvent {
  jobId: string
  seq: number
  event: JobEvent
}

/** What the rest of the extension needs from the hub connection (and what tests fake). */
export interface BridgeConnection {
  readonly editorId: string
  readonly state: ConnectionState
  readonly browsers: readonly BrowserInfo[]
  submit(job: JobRequest): boolean
  cancel(cancel: { jobId: string; sessionId: string; browserId?: string }): void
  onEvent(listener: (event: HubEvent) => void): () => void
  onPeers(listener: (browsers: readonly BrowserInfo[]) => void): () => void
  onState(listener: (state: ConnectionState) => void): () => void
}

export interface HubConnectionOptions {
  hubScriptPath: string
  version: string
  logFile?: string
  idleExitMs?: number
  ports?: readonly number[]
  editorId?: string
  log?: (line: string) => void
  /** Test seams. */
  ensure?: (options: EnsureHubOptions) => Promise<FoundHub>
  createSocket?: (url: string) => WebSocket
}

const BACKOFF_MS = [300, 700, 1_500, 3_000, 5_000]

type Listener<T> = (value: T) => void

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>()
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value)
      } catch {
        // a faulty listener must not break the connection
      }
    }
  }
}

/**
 * The editor's link to the local hub: makes sure a hub is running (starting one if needed),
 * connects as an editor, reconnects with backoff, and exposes who is connected and the events
 * the browser produces.
 */
export class HubConnection implements BridgeConnection {
  editorId: string
  state: ConnectionState = 'offline'
  browsers: readonly BrowserInfo[] = []
  port: number | null = null
  lastError: string | null = null

  private socket: WebSocket | null = null
  private wanted = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  private lastMessageAt = 0
  private looping = false
  private readonly events = new Emitter<HubEvent>()
  private readonly peers = new Emitter<readonly BrowserInfo[]>()
  private readonly states = new Emitter<ConnectionState>()

  constructor(private readonly options: HubConnectionOptions) {
    this.editorId = options.editorId ?? newId()
  }

  onEvent = (listener: (event: HubEvent) => void) => this.events.on(listener)
  onPeers = (listener: (browsers: readonly BrowserInfo[]) => void) => this.peers.on(listener)
  onState = (listener: (state: ConnectionState) => void) => this.states.on(listener)

  start(): void {
    this.wanted = true
    void this.connect()
  }

  stop(): void {
    this.wanted = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.dropSocket(1000, 'closing')
    this.setBrowsers([])
    this.setState('offline')
  }

  /** Drops the connection and asks the hub to exit, so the next start launches a fresh one. */
  async restartHub(): Promise<void> {
    const socket = this.socket
    if (socket?.readyState === WebSocket.OPEN) socket.send(serialize({ type: 'shutdown' }))
    this.dropSocket(1000, 'restarting hub')
    this.attempt = 0
    await new Promise((resolve) => setTimeout(resolve, 600))
    if (this.wanted) void this.connect()
  }

  submit(job: JobRequest): boolean {
    if (this.state !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(serialize({ type: 'job', job }))
      return true
    } catch {
      return false
    }
  }

  cancel(cancel: { jobId: string; sessionId: string; browserId?: string }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(serialize({ type: 'cancel', ...cancel }))
    } catch {
      // the job will time out on its own
    }
  }

  // ── connection loop ──────────────────────────────────────────────────────────────────────────
  private async connect(): Promise<void> {
    if (!this.wanted || this.looping || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return
    this.looping = true
    try {
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.setState('connecting')
      const hub = await (this.options.ensure ?? ensureHub)({
        hubScriptPath: this.options.hubScriptPath,
        ports: this.options.ports,
        version: this.options.version,
        logFile: this.options.logFile,
        idleExitMs: this.options.idleExitMs
      })
      if (!this.wanted) return
      this.port = hub.port
      this.open(hub.port)
    } catch (error) {
      this.lastError = (error as Error).message
      this.options.log?.(`could not reach the hub: ${this.lastError}`)
      this.setState('offline')
      this.scheduleRetry()
    } finally {
      this.looping = false
    }
  }

  private open(port: number): void {
    const query = new URLSearchParams({ role: 'editor', id: this.editorId, protocol: String(PROTOCOL_VERSION) })
    const url = `ws://${HUB_HOST}:${port}/ws?${query}`
    const socket = (this.options.createSocket ?? ((u) => new WebSocket(u)))(url)
    this.socket = socket

    socket.on('open', () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.lastError = null
      this.lastMessageAt = Date.now()
      this.setState('connected')
      this.startWatchdog()
      this.options.log?.(`connected to the hub on port ${port}`)
    })
    socket.on('message', (data) => {
      if (this.socket !== socket) return
      this.lastMessageAt = Date.now()
      this.handle(data.toString())
    })
    socket.on('error', (error) => {
      this.lastError = error.message
    })
    socket.on('close', (code) => {
      if (this.socket !== socket) return
      this.socket = null
      this.stopWatchdog()
      this.setBrowsers([])
      this.setState('offline')
      if (code === CLOSE_REPLACED) {
        // Another window is using our id; take a new one instead of fighting over it.
        this.editorId = newId()
        this.options.log?.('another window used this editor id; switched to a new one')
      }
      this.scheduleRetry()
    })
  }

  private handle(raw: string): void {
    const parsed = parseJson(hubToEditorSchema, raw)
    if (!parsed.ok) {
      this.options.log?.(`ignored an invalid hub message: ${parsed.error}`)
      return
    }
    const message = parsed.value
    switch (message.type) {
      case 'ping':
        this.socket?.send(serialize({ type: 'pong' }))
        return
      case 'peers':
        this.setBrowsers(message.browsers)
        return
      case 'event':
        this.events.emit({ jobId: message.jobId, seq: message.seq, event: message.event })
        return
      case 'welcome':
        return
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  private dropSocket(code: number, reason: string): void {
    const old = this.socket
    this.socket = null
    this.stopWatchdog()
    try {
      old?.close(code, reason)
    } catch {
      // already closed
    }
  }

  private scheduleRetry(): void {
    if (!this.wanted) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt += 1
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      if (this.state === 'connected' && Date.now() - this.lastMessageAt > HEARTBEAT_DEAD_AFTER_MS) {
        this.options.log?.('the hub stopped answering; reconnecting')
        this.dropSocket(4000, 'silent hub')
        this.setBrowsers([])
        this.setState('offline')
        this.scheduleRetry()
      }
    }, 5_000)
    this.watchdog.unref?.()
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  private setBrowsers(browsers: readonly BrowserInfo[]): void {
    this.browsers = browsers
    this.peers.emit(browsers)
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.states.emit(state)
  }
}
