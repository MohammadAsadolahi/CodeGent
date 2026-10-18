import http from 'node:http'
import WebSocket from 'ws'
import { newId, PROTOCOL_VERSION, type JobRequest } from '@codegent/protocol'
import { Hub, type HubOptions } from '../src'

export const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`

export interface Client {
  ws: WebSocket
  id: string
  received: any[]
  /** Resolves with (and consumes) the next received message matching `predicate`. */
  next(predicate?: (message: any) => boolean, timeoutMs?: number): Promise<any>
  /** Asserts that nothing matching arrives within `ms`. */
  expectNone(predicate: (message: any) => boolean, ms?: number): Promise<void>
  send(message: unknown): void
  sendRaw(data: string | Buffer, binary?: boolean): void
  closed: Promise<{ code: number; reason: string }>
  close(): void
}

export interface ConnectOptions {
  role: 'editor' | 'browser'
  id?: string
  /** undefined = sensible default for the role; null = send no Origin header. */
  origin?: string | null
  host?: string
  protocol?: number | string
  path?: string
  autoPong?: boolean
  name?: string
  profile?: string
}

export class Rejected extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`upgrade rejected with HTTP ${status}: ${body}`)
  }
}

export const connect = (hub: Hub, options: ConnectOptions): Promise<Client> =>
  new Promise((resolve, reject) => {
    const id = options.id ?? newId()
    const query = new URLSearchParams({
      role: options.role,
      id,
      protocol: String(options.protocol ?? PROTOCOL_VERSION)
    })
    if (options.name) query.set('name', options.name)
    if (options.profile) query.set('profile', options.profile)
    if (options.role === 'browser') {
      query.set('ua', 'TestBrowser/1.0')
      query.set('ext', '0.0.1')
    }
    const headers: Record<string, string> = {}
    if (options.host) headers.Host = options.host
    const origin =
      options.origin === undefined
        ? options.role === 'browser'
          ? EXT_ORIGIN
          : undefined
        : (options.origin ?? undefined)
    const ws = new WebSocket(
      `ws://127.0.0.1:${hub.port}${options.path ?? '/ws'}?${query}`,
      {
        headers,
        ...(origin ? { origin } : {})
      }
    )

    const received: any[] = []
    const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> =
      []
    const autoPong = options.autoPong ?? true

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'ping' && autoPong) ws.send(JSON.stringify({ type: 'pong' }))
      const waiterIndex = waiters.findIndex((w) => w.predicate(message))
      if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0]!.resolve(message)
      else received.push(message)
    })

    const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
      ws.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }))
    })

    ws.once('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => reject(new Rejected(res.statusCode ?? 0, body)))
    })
    ws.once('error', () => {
      /* surfaced through unexpected-response or close */
    })

    ws.once('open', () => {
      resolve({
        ws,
        id,
        received,
        next(predicate = () => true, timeoutMs = 2_000) {
          const index = received.findIndex(predicate)
          if (index >= 0) return Promise.resolve(received.splice(index, 1)[0])
          return new Promise((resolveNext, rejectNext) => {
            const waiter = { predicate, resolve: resolveNext }
            waiters.push(waiter)
            setTimeout(() => {
              const at = waiters.indexOf(waiter)
              if (at >= 0) {
                waiters.splice(at, 1)
                rejectNext(
                  new Error(
                    `timed out waiting for message (have ${JSON.stringify(received)})`
                  )
                )
              }
            }, timeoutMs)
          })
        },
        async expectNone(predicate, ms = 150) {
          await new Promise((r) => setTimeout(r, ms))
          const hit = received.find(predicate)
          if (hit) throw new Error(`unexpected message: ${JSON.stringify(hit)}`)
        },
        send: (message) => ws.send(JSON.stringify(message)),
        sendRaw: (data, binary = false) => ws.send(data, { binary }),
        closed,
        close: () => ws.close()
      })
    })
  })

export const startHub = async (options: Partial<HubOptions> = {}): Promise<Hub> => {
  const hub = new Hub({ port: 0, version: 'test', idleExitMs: 0, ...options })
  await hub.start()
  return hub
}

export const makeJob = (
  overrides: Partial<JobRequest> & { editorId: string }
): JobRequest => ({
  jobId: newId(),
  sessionId: newId(),
  text: 'do the thing',
  newChat: true,
  chatUrl: 'https://chatgpt.com/',
  autoSubmit: true,
  timeoutMs: 60_000,
  ...overrides
})

export const progressEvent = (editorId: string, jobId: string, seq = 1) => ({
  type: 'event',
  editorId,
  jobId,
  seq,
  event: { kind: 'progress', stage: 'filled' }
})

export const completedEvent = (editorId: string, jobId: string, seq = 9) => ({
  type: 'event',
  editorId,
  jobId,
  seq,
  event: {
    kind: 'completed',
    markdown: 'done',
    conversationUrl: 'https://chatgpt.com/c/1',
    durationMs: 10
  }
})

export const httpRequest = (
  hub: Hub,
  options: { path?: string; method?: string; host?: string } = {}
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hub.port,
        path: options.path ?? '/health',
        method: options.method ?? 'GET',
        headers: options.host ? { Host: options.host } : {}
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
