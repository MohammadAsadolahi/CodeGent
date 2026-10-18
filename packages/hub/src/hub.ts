import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  browserToHubSchema,
  CLOSE_PROTOCOL_VIOLATION,
  CLOSE_REPLACED,
  CLOSE_SHUTDOWN,
  CLOSE_STALE,
  editorToHubSchema,
  HEARTBEAT_DEAD_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  HUB_HOST,
  HUB_IDLE_EXIT_MS,
  HUB_SERVICE_NAME,
  isAllowedHostHeader,
  isOriginAllowedForRole,
  isTerminalEvent,
  MAILBOX_MAX_EVENTS,
  MAILBOX_TTL_MS,
  MAX_MESSAGE_BYTES,
  parseJson,
  PROTOCOL_VERSION,
  serialize,
  type BrowserInfo,
  type EditorToHub,
  type HubHealth,
  type HubToBrowser,
  type HubToEditor,
  type JobEvent,
  type JobFailureCode,
  type Role
} from '@codegent/protocol'
import { Mailbox } from './mailbox'

export interface HubOptions {
  /** 0 picks any free port; read the real one from {@link Hub.port} after `start()`. */
  port: number
  host?: string
  version?: string
  idleExitMs?: number
  heartbeatIntervalMs?: number
  deadAfterMs?: number
  maxMessageBytes?: number
  mailboxTtlMs?: number
  mailboxMaxEvents?: number
  /** Called once when no editor has been connected for `idleExitMs`. */
  onIdle?: () => void
  /** Called when an editor asks the hub to stop. */
  onShutdownRequested?: () => void
  log?: (message: string) => void
}

interface Peer {
  role: Role
  id: string
  ws: WebSocket
  lastSeen: number
  strikes: number
  /** Set once a heartbeat-timeout close has been issued, so it is not repeated every tick. */
  closing?: boolean
}

interface BrowserPeer extends Peer {
  role: 'browser'
  info: BrowserInfo
}

type Verdict =
  | { ok: true; role: Role; id: string; query: URLSearchParams }
  | { ok: false; status: number; reason: string }

const MAX_STRIKES = 5
const ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required'
}

const clip = (value: string | null, max: number, fallback: string): string =>
  (value ?? fallback).slice(0, max) || fallback

export class Hub {
  private readonly host: string
  private readonly version: string
  private readonly server: http.Server
  private readonly wss: WebSocketServer
  private readonly editors = new Map<string, Peer>()
  private readonly browsers = new Map<string, BrowserPeer>()
  private readonly mailbox: Mailbox
  private readonly startedAt = Date.now()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private boundPort = 0
  private stopped = false

  constructor(private readonly options: HubOptions) {
    this.host = options.host ?? HUB_HOST
    this.version = options.version ?? '0.0.0'
    this.mailbox = new Mailbox(
      options.mailboxTtlMs ?? MAILBOX_TTL_MS,
      options.mailboxMaxEvents ?? MAILBOX_MAX_EVENTS
    )
    this.server = http.createServer((req, res) => this.handleRequest(req, res))
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxMessageBytes ?? MAX_MESSAGE_BYTES,
      perMessageDeflate: false
    })
    this.server.on('upgrade', (req, socket, head) =>
      this.handleUpgrade(req, socket, head)
    )
    this.server.on('error', (error) => this.log(`server error: ${error.message}`))
  }

  get port(): number {
    return this.boundPort
  }

  /** True between a successful `start()` and `stop()`. */
  get running(): boolean {
    return this.boundPort !== 0 && !this.stopped
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(this.options.port, this.host, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    this.boundPort = (this.server.address() as AddressInfo).port
    this.heartbeatTimer = setInterval(
      () => this.tick(),
      this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    )
    this.updateIdleTimer()
    this.log(`listening on ${this.host}:${this.boundPort}`)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const peer of this.allPeers()) peer.ws.close(CLOSE_SHUTDOWN, 'hub stopping')
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        for (const peer of this.allPeers()) peer.ws.terminate()
        this.server.closeAllConnections()
      }, 250)
      this.server.close(() => {
        clearTimeout(force)
        resolve()
      })
      this.wss.close()
      this.server.closeIdleConnections()
    })
    this.log('stopped')
  }

  health(): HubHealth {
    return {
      ok: true,
      service: HUB_SERVICE_NAME,
      protocol: PROTOCOL_VERSION,
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      editors: this.editors.size,
      browsers: this.browsers.size
    }
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────────
  private handleRequest(req: IncomingMessage, res: http.ServerResponse): void {
    const reply = (status: number, body: string, type = 'text/plain') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(body)
    }
    if (!isAllowedHostHeader(req.headers.host, this.boundPort)) {
      return reply(403, 'forbidden')
    }
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/health') return reply(404, 'not found')
    if (req.method !== 'GET') return reply(405, 'method not allowed')
    reply(200, JSON.stringify(this.health()), 'application/json')
  }

  // ── WebSocket upgrade ───────────────────────────────────────────────────────────────────
  private checkUpgrade(req: IncomingMessage): Verdict {
    if (!isAllowedHostHeader(req.headers.host, this.boundPort)) {
      return { ok: false, status: 403, reason: 'host not allowed' }
    }
    let url: URL
    try {
      url = new URL(req.url ?? '', 'http://hub.invalid')
    } catch {
      return { ok: false, status: 400, reason: 'bad url' }
    }
    if (url.pathname !== '/ws') return { ok: false, status: 404, reason: 'not found' }
    const role = url.searchParams.get('role')
    if (role !== 'editor' && role !== 'browser') {
      return { ok: false, status: 400, reason: 'unknown role' }
    }
    if (!isOriginAllowedForRole(role, req.headers.origin)) {
      return { ok: false, status: 403, reason: 'origin not allowed' }
    }
    if (url.searchParams.get('protocol') !== String(PROTOCOL_VERSION)) {
      return {
        ok: false,
        status: 426,
        reason: `protocol mismatch (hub speaks ${PROTOCOL_VERSION})`
      }
    }
    const id = url.searchParams.get('id') ?? ''
    if (!ID_PATTERN.test(id)) return { ok: false, status: 400, reason: 'bad id' }
    return { ok: true, role, id, query: url.searchParams }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const verdict = this.checkUpgrade(req)
    if (!verdict.ok) {
      const text = STATUS_TEXT[verdict.status] ?? 'Error'
      socket.write(
        `HTTP/1.1 ${verdict.status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(verdict.reason)}\r\n\r\n${verdict.reason}`
      )
      socket.destroy()
      this.log(`rejected upgrade: ${verdict.status} ${verdict.reason}`)
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, verdict))
  }

  // ── connections ──────────────────────────────────────────────────────────────────────────
  private onConnection(ws: WebSocket, verdict: Extract<Verdict, { ok: true }>): void {
    const { role, id, query } = verdict
    const previous = role === 'editor' ? this.editors.get(id) : this.browsers.get(id)
    if (previous) previous.ws.close(CLOSE_REPLACED, 'replaced by a newer connection')

    const base: Peer = { role, id, ws, lastSeen: Date.now(), strikes: 0 }
    ws.on('error', (error) => this.log(`${role} ${id} socket error: ${error.message}`))

    if (role === 'editor') {
      this.editors.set(id, base)
      this.updateIdleTimer()
      this.send(base, {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        hubVersion: this.version,
        clientId: id,
        role
      })
      this.send(base, { type: 'peers', browsers: this.browserInfos() })
      for (const data of this.mailbox.drain(id)) this.sendRaw(base, data)
    } else {
      const peer: BrowserPeer = {
        ...base,
        role: 'browser',
        info: {
          id,
          name: clip(query.get('name'), 200, 'Browser'),
          profile: query.get('profile')?.slice(0, 200) || undefined,
          userAgent: clip(query.get('ua'), 500, 'unknown'),
          extensionVersion: clip(query.get('ext'), 50, 'unknown'),
          connectedAt: Date.now(),
          chatgptTabs: 0
        }
      }
      this.browsers.set(id, peer)
      this.send(peer, {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        hubVersion: this.version,
        clientId: id,
        role
      })
      this.broadcastPeers()
    }

    const current = (): Peer | undefined =>
      role === 'editor' ? this.editors.get(id) : this.browsers.get(id)
    ws.on('message', (data, isBinary) => {
      const peer = current()
      if (!peer || peer.ws !== ws) return
      this.onMessage(peer, data, isBinary)
    })
    ws.on('close', () => {
      const peer = current()
      if (!peer || peer.ws !== ws) return // already replaced by a newer connection
      if (role === 'editor') {
        this.editors.delete(id)
        this.updateIdleTimer()
      } else {
        this.browsers.delete(id)
        this.broadcastPeers()
      }
      this.log(`${role} ${id} disconnected`)
    })
    this.log(`${role} ${id} connected`)
  }

  private onMessage(peer: Peer, data: RawData, isBinary: boolean): void {
    peer.lastSeen = Date.now()
    const strike = (why: string) => {
      peer.strikes += 1
      this.log(`${peer.role} ${peer.id}: ${why} (strike ${peer.strikes})`)
      if (peer.strikes >= MAX_STRIKES)
        peer.ws.close(CLOSE_PROTOCOL_VIOLATION, 'protocol violation')
    }
    if (isBinary) return strike('binary frame')
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8')

    if (peer.role === 'editor') {
      const parsed = parseJson(editorToHubSchema, text)
      if (!parsed.ok) return strike(parsed.error)
      peer.strikes = 0
      this.onEditorMessage(peer, parsed.value)
    } else {
      const parsed = parseJson(browserToHubSchema, text)
      if (!parsed.ok) return strike(parsed.error)
      peer.strikes = 0
      const browser = this.browsers.get(peer.id)
      if (!browser) return
      const message = parsed.value
      if (message.type === 'presence') {
        browser.info = {
          ...browser.info,
          chatgptTabs: message.chatgptTabs,
          profile: message.profile ?? browser.info.profile
        }
        this.broadcastPeers()
      } else if (message.type === 'event') {
        this.routeEvent(message)
      }
    }
  }

  private onEditorMessage(editor: Peer, message: EditorToHub): void {
    switch (message.type) {
      case 'job': {
        const { job } = message
        if (job.editorId !== editor.id) {
          return this.failJob(
            editor,
            job.jobId,
            'internal',
            'job.editorId does not match this connection'
          )
        }
        const target = this.pickBrowser(job.browserId)
        if ('failure' in target) {
          return this.failJob(
            editor,
            job.jobId,
            target.failure.code,
            target.failure.message
          )
        }
        this.send(target.browser, { type: 'job', job })
        return
      }
      case 'cancel': {
        const target = this.pickBrowser(message.browserId)
        if ('browser' in target) this.send(target.browser, message)
        return
      }
      case 'shutdown':
        this.log(`shutdown requested by editor ${editor.id}`)
        this.options.onShutdownRequested?.()
        return
      case 'pong':
        return
    }
  }

  // ── routing ──────────────────────────────────────────────────────────────────────────────
  private pickBrowser(
    browserId: string | undefined
  ): { browser: BrowserPeer } | { failure: { code: JobFailureCode; message: string } } {
    if (browserId) {
      const chosen = this.browsers.get(browserId)
      if (chosen && chosen.ws.readyState === WebSocket.OPEN) return { browser: chosen }
      return {
        failure: { code: 'no-browser', message: 'The selected browser is not connected.' }
      }
    }
    if (this.browsers.size === 0) {
      return {
        failure: { code: 'no-browser', message: 'No browser extension is connected.' }
      }
    }
    if (this.browsers.size > 1) {
      return {
        failure: {
          code: 'ambiguous-browser',
          message: 'Several browsers are connected; choose which one to use.'
        }
      }
    }
    return { browser: this.browsers.values().next().value as BrowserPeer }
  }

  private routeEvent(
    message: Extract<ReturnType<typeof browserToHubSchema>, { type: 'event' }>
  ): void {
    const editor = this.editors.get(message.editorId)
    const payload: HubToEditor = message
    if (editor && editor.ws.readyState === WebSocket.OPEN) {
      this.send(editor, payload)
    } else {
      this.mailbox.add(
        message.editorId,
        serialize(payload),
        isTerminalEvent(message.event)
      )
    }
  }

  private failJob(
    editor: Peer,
    jobId: string,
    code: JobFailureCode,
    message: string
  ): void {
    const event: JobEvent = { kind: 'failed', code, message }
    this.send(editor, { type: 'event', editorId: editor.id, jobId, seq: 0, event })
  }

  private broadcastPeers(): void {
    const message: HubToEditor = { type: 'peers', browsers: this.browserInfos() }
    for (const editor of this.editors.values()) this.send(editor, message)
  }

  private browserInfos(): BrowserInfo[] {
    return [...this.browsers.values()].map((browser) => browser.info)
  }

  // ── plumbing ─────────────────────────────────────────────────────────────────────────────
  private allPeers(): Peer[] {
    return [...this.editors.values(), ...this.browsers.values()]
  }

  private send(peer: Peer, message: HubToEditor | HubToBrowser): void {
    this.sendRaw(peer, serialize(message))
  }

  private sendRaw(peer: Peer, data: string): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return
    try {
      peer.ws.send(data)
    } catch (error) {
      this.log(`send to ${peer.role} ${peer.id} failed: ${(error as Error).message}`)
    }
  }

  private tick(): void {
    const now = Date.now()
    const deadAfter = this.options.deadAfterMs ?? HEARTBEAT_DEAD_AFTER_MS
    for (const peer of this.allPeers()) {
      if (peer.closing) continue
      if (now - peer.lastSeen > deadAfter) {
        this.log(`${peer.role} ${peer.id} went silent; closing`)
        peer.closing = true
        // Polite close first; a truly dead peer never answers, so force it shortly after.
        peer.ws.close(CLOSE_STALE, 'heartbeat timeout')
        setTimeout(() => peer.ws.terminate(), 500).unref()
        continue
      }
      this.send(peer, { type: 'ping' })
    }
    this.mailbox.sweep()
  }

  private updateIdleTimer(): void {
    const idleMs = this.options.idleExitMs ?? HUB_IDLE_EXIT_MS
    if (this.stopped) return
    if (this.editors.size > 0 || idleMs <= 0) {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = undefined
      return
    }
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.editors.size === 0) {
        this.log(`no editor for ${idleMs} ms; idle exit`)
        this.options.onIdle?.()
      }
    }, idleMs)
  }

  private log(message: string): void {
    this.options.log?.(message)
  }
}
