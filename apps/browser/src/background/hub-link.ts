import {
  findHub,
  HEARTBEAT_DEAD_AFTER_MS,
  HUB_HOST,
  hubToBrowserSchema,
  parseJson,
  PROTOCOL_VERSION,
  serialize,
  type FoundHub,
  type JobEvent,
  type JobRequest
} from '@codegent/protocol'
import { hubPorts } from './config'
import type { OutboxStore } from './state'

export type LinkState = 'idle' | 'probing' | 'connecting' | 'connected'

export interface BrowserIdentity {
  browserId: string
  name: string
  profile: string
  userAgent: string
  extensionVersion: string
}

export interface HubLinkOptions {
  identity: () => Promise<BrowserIdentity>
  onJob: (job: JobRequest) => void
  onCancel: (cancel: { jobId: string; sessionId: string }) => void
  /** Fired when the link comes up so callers can re-announce presence. */
  onConnected?: () => void
  onStateChange?: (state: LinkState) => void
  outbox: OutboxStore
  /** Test seams; production uses the real implementations. */
  find?: () => Promise<FoundHub | null>
  createSocket?: (url: string) => WebSocket
  log?: (...args: unknown[]) => void
}

const OUTBOX_LIMIT = 100
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000]

const isTerminalRaw = (raw: string): boolean =>
  raw.includes('"kind":"completed"') || raw.includes('"kind":"failed"')

/**
 * The browser side of the hub connection. It finds the hub on the candidate ports, keeps the
 * socket alive (answering pings, watching for silence), reconnects with backoff, and passes
 * every outgoing event through a persisted, ordered outbox so nothing is lost while the hub is
 * unreachable or the service worker restarts.
 */
export class HubLink {
  state: LinkState = 'idle'
  port: number | null = null
  lastError: string | null = null

  private socket: WebSocket | null = null
  private lastMessageAt = 0
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  private wanted = false
  private connecting = false
  private pendingPresence: { chatgptTabs: number; profile?: string } | null = null
  private pumpChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: HubLinkOptions) {}

  /** Begin (and keep) connecting. Idempotent. */
  start(): void {
    this.wanted = true
    void this.ensureConnected()
  }

  stop(): void {
    this.wanted = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.stopWatchdog()
    this.socket?.close(1000, 'stopping')
    this.socket = null
    this.setState('idle')
  }

  /** Called by the keep-alive alarm and by the popup. Safe to call at any time. */
  async ensureConnected(): Promise<void> {
    if (!this.wanted || this.connecting) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return
    this.connecting = true
    try {
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.setState('probing')
      const find = this.options.find ?? (() => findHub({ ports: hubPorts }))
      const hub = await find()
      if (!hub) {
        this.lastError = 'CodeGent is not running in VS Code (no hub found).'
        this.setState('idle')
        this.scheduleRetry()
        return
      }
      await this.open(hub)
    } catch (error) {
      this.lastError = (error as Error).message
      this.setState('idle')
      this.scheduleRetry()
    } finally {
      this.connecting = false
    }
  }

  reconnectNow(): void {
    this.attempt = 0
    this.dropSocket(1000, 'reconnect requested')
    void this.ensureConnected()
  }

  /**
   * Abandons the current socket right away. The old socket may take a long time to finish its
   * close handshake (or never), so it is detached first and its late events are ignored.
   */
  private dropSocket(code: number, reason: string): void {
    const old = this.socket
    this.socket = null
    this.stopWatchdog()
    try {
      old?.close(code, reason)
    } catch {
      // already closed
    }
    this.setState('idle')
  }

  /** Delivers an event to the hub, in order, surviving disconnects and worker restarts. */
  sendEvent(message: {
    editorId: string
    jobId: string
    seq: number
    event: JobEvent
  }): Promise<void> {
    return this.pump(JSON.stringify({ type: 'event', ...message }))
  }

  sendPresence(presence: { chatgptTabs: number; profile?: string }): void {
    this.pendingPresence = presence
    this.sendPendingPresence()
  }

  // ── connection ───────────────────────────────────────────────────────────────────────────
  private async open(hub: FoundHub): Promise<void> {
    const identity = await this.options.identity()
    const query = new URLSearchParams({
      role: 'browser',
      id: identity.browserId,
      protocol: String(PROTOCOL_VERSION),
      name: identity.name,
      ua: identity.userAgent,
      ext: identity.extensionVersion
    })
    if (identity.profile) query.set('profile', identity.profile)
    const url = `ws://${HUB_HOST}:${hub.port}/ws?${query}`

    this.setState('connecting')
    const socket = (this.options.createSocket ?? ((u) => new WebSocket(u)))(url)
    this.socket = socket
    this.port = hub.port

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.lastError = null
      this.lastMessageAt = Date.now()
      this.setState('connected')
      this.startWatchdog()
      this.sendPendingPresence()
      this.options.onConnected?.()
      void this.pump()
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.lastMessageAt = Date.now()
      this.handleRaw(typeof event.data === 'string' ? event.data : '')
    }
    socket.onerror = () => {
      this.lastError = 'The connection to the CodeGent hub failed.'
    }
    socket.onclose = () => {
      if (this.socket !== socket) return // detached earlier; its late events do not matter
      this.socket = null
      this.stopWatchdog()
      this.setState('idle')
      this.scheduleRetry()
    }
  }

  private handleRaw(raw: string): void {
    const parsed = parseJson(hubToBrowserSchema, raw)
    if (!parsed.ok) {
      this.options.log?.('ignored invalid hub message:', parsed.error)
      return
    }
    const message = parsed.value
    switch (message.type) {
      case 'ping':
        this.trySend(serialize({ type: 'pong' }))
        return
      case 'job':
        this.options.onJob(message.job)
        return
      case 'cancel':
        this.options.onCancel({ jobId: message.jobId, sessionId: message.sessionId })
        return
      case 'welcome':
        return
    }
  }

  // ── outgoing ─────────────────────────────────────────────────────────────────────────────
  private canSend(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  private trySend(raw: string): boolean {
    if (!this.canSend()) return false
    try {
      this.socket!.send(raw)
      return true
    } catch {
      return false
    }
  }

  private sendPendingPresence(): void {
    if (this.pendingPresence) {
      this.trySend(JSON.stringify({ type: 'presence', ...this.pendingPresence }))
    }
  }

  /** Appends `raw` (if any) to the persisted outbox and sends as much as the link allows, in order. */
  private pump(raw?: string): Promise<void> {
    this.pumpChain = this.pumpChain.then(async () => {
      const items = await this.options.outbox.load()
      if (raw !== undefined) items.push(raw)
      while (items.length > OUTBOX_LIMIT) {
        // Progress events are expendable; a lost completed/failed is not.
        const droppable = items.findIndex((item) => !isTerminalRaw(item))
        items.splice(droppable === -1 ? 0 : droppable, 1)
      }
      let sent = 0
      while (sent < items.length && this.trySend(items[sent]!)) sent++
      await this.options.outbox.save(items.slice(sent))
    })
    return this.pumpChain
  }

  // ── timers ───────────────────────────────────────────────────────────────────────────────
  private scheduleRetry(): void {
    if (!this.wanted) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt += 1
    this.retryTimer = setTimeout(
      () => void this.ensureConnected(),
      base + Math.random() * 250
    )
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      if (
        this.state === 'connected' &&
        Date.now() - this.lastMessageAt > HEARTBEAT_DEAD_AFTER_MS
      ) {
        this.options.log?.('hub went silent; reconnecting')
        this.lastError = 'The CodeGent hub stopped responding.'
        this.dropSocket(4000, 'silent hub')
        this.scheduleRetry()
      }
    }, 5_000)
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  private setState(state: LinkState): void {
    if (this.state === state) return
    this.state = state
    this.options.onStateChange?.(state)
  }
}
