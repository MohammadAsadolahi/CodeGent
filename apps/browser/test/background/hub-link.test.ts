import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  newId,
  PROTOCOL_VERSION,
  type JobEvent,
  type JobRequest
} from '@codegent/protocol'
import { HubLink, type HubLinkOptions } from '../../src/background/hub-link'
import { makeOutboxStore, type KeyValueArea } from '../../src/background/state'

class MemoryArea implements KeyValueArea {
  data: Record<string, unknown> = {}
  async get(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys]
    return Object.fromEntries(
      list.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])])
    )
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v)
  }
}

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason }
    this.readyState = 3
    this.onclose?.({ code: code ?? 1005 })
  }
  // test helpers
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(message: unknown) {
    this.onmessage?.({
      data: typeof message === 'string' ? message : JSON.stringify(message)
    })
  }
  drop() {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
  get messages() {
    return this.sent.map((s) => JSON.parse(s))
  }
}

const progress = (): JobEvent => ({ kind: 'progress', stage: 'filled' })
const done = (): JobEvent => ({
  kind: 'completed',
  markdown: 'm',
  conversationUrl: 'https://chatgpt.com/c/1',
  durationMs: 1
})
const evt = (event: JobEvent, seq = 1) => ({ editorId: 'e1', jobId: 'j1', seq, event })

const validJob = (): JobRequest => ({
  jobId: newId(),
  sessionId: newId(),
  editorId: 'e1',
  text: 'hi',
  newChat: true,
  chatUrl: 'https://chatgpt.com/',
  autoSubmit: true,
  timeoutMs: 60_000
})

let area: MemoryArea
let onJob: ReturnType<typeof vi.fn>
let onCancel: ReturnType<typeof vi.fn>
let onConnected: ReturnType<typeof vi.fn>
let hubAvailable: boolean

const makeLink = (over: Partial<HubLinkOptions> = {}) => {
  const link = new HubLink({
    identity: async () => ({
      browserId: 'b1',
      name: 'Chrome',
      profile: 'Work',
      userAgent: 'UA/1',
      extensionVersion: '0.1.0'
    }),
    onJob: onJob as never,
    onCancel: onCancel as never,
    onConnected: onConnected as never,
    outbox: makeOutboxStore(area),
    find: async () => (hubAvailable ? { port: 47615, health: {} as never } : null),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...over
  })
  return link
}

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  area = new MemoryArea()
  onJob = vi.fn()
  onCancel = vi.fn()
  onConnected = vi.fn()
  hubAvailable = true
})
afterEach(() => {
  vi.useRealTimers()
})

describe('connecting', () => {
  it('connects to the discovered hub with its identity in the URL', async () => {
    const link = makeLink()
    link.start()
    await settle()
    const socket = FakeSocket.all[0]!
    const url = new URL(socket.url)
    expect(url.protocol).toBe('ws:')
    expect(url.host).toBe('127.0.0.1:47615')
    expect(url.pathname).toBe('/ws')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      role: 'browser',
      id: 'b1',
      protocol: String(PROTOCOL_VERSION),
      name: 'Chrome',
      profile: 'Work',
      ua: 'UA/1',
      ext: '0.1.0'
    })
    socket.open()
    expect(link.state).toBe('connected')
    expect(link.port).toBe(47615)
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying with backoff while no hub is running, then connects when one appears', async () => {
    hubAvailable = false
    const link = makeLink()
    link.start()
    await settle(100)
    expect(link.state).toBe('idle')
    expect(link.lastError).toMatch(/not running/i)
    expect(FakeSocket.all).toHaveLength(0)

    hubAvailable = true
    await settle(6_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('reconnects after the socket drops', async () => {
    const link = makeLink()
    link.start()
    await settle()
    FakeSocket.all[0]!.open()
    FakeSocket.all[0]!.drop()
    expect(link.state).toBe('idle')
    await settle(1_000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('does not open a second socket while one is connecting or open', async () => {
    const link = makeLink()
    link.start()
    await settle()
    await link.ensureConnected()
    await link.ensureConnected()
    expect(FakeSocket.all).toHaveLength(1)
    FakeSocket.all[0]!.open()
    await link.ensureConnected()
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('stop() closes the socket and stays stopped', async () => {
    const link = makeLink()
    link.start()
    await settle()
    FakeSocket.all[0]!.open()
    link.stop()
    await settle(10_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(link.state).toBe('idle')
  })

  it('reconnectNow() replaces the connection immediately', async () => {
    const link = makeLink()
    link.start()
    await settle()
    FakeSocket.all[0]!.open()
    link.reconnectNow()
    await settle()
    expect(FakeSocket.all).toHaveLength(2)
    expect(FakeSocket.all[0]!.closedWith?.code).toBe(1000)
  })
})

describe('messages from the hub', () => {
  it('answers pings, dispatches jobs and cancels, ignores garbage', async () => {
    const link = makeLink()
    link.start()
    await settle()
    const socket = FakeSocket.all[0]!
    socket.open()

    socket.receive({ type: 'ping' })
    expect(socket.messages).toContainEqual({ type: 'pong' })

    const job = validJob()
    socket.receive({ type: 'job', job })
    expect(onJob).toHaveBeenCalledWith(job)

    socket.receive({ type: 'cancel', jobId: 'j', sessionId: 's' })
    expect(onCancel).toHaveBeenCalledWith({ jobId: 'j', sessionId: 's' })

    socket.receive('not json')
    socket.receive({ type: 'job', job: { nope: true } })
    socket.receive({ type: 'peers', browsers: [] }) // not valid for browsers
    expect(onJob).toHaveBeenCalledTimes(1)
    expect(link.state).toBe('connected')
  })

  it('reconnects when the hub goes silent', async () => {
    const link = makeLink()
    link.start()
    await settle()
    const socket = FakeSocket.all[0]!
    socket.open()
    await settle(30_000)
    expect(link.state).toBe('connected') // 30 s < threshold
    await settle(10_000)
    expect(link.state).toBe('idle')
    expect(socket.closedWith?.code).toBe(4000)
    await settle(1_500)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('does not treat pings as silence', async () => {
    const link = makeLink()
    link.start()
    await settle()
    const socket = FakeSocket.all[0]!
    socket.open()
    for (let i = 0; i < 8; i++) {
      await settle(10_000)
      socket.receive({ type: 'ping' })
    }
    expect(link.state).toBe('connected')
  })
})

describe('outgoing events', () => {
  it('sends immediately when connected, in order', async () => {
    const link = makeLink()
    link.start()
    await settle()
    const socket = FakeSocket.all[0]!
    socket.open()
    await link.sendEvent(evt(progress(), 1))
    await link.sendEvent(evt(done(), 2))
    expect(socket.messages.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual([
      1, 2
    ])
  })

  it('holds events while disconnected and flushes them in order on reconnect', async () => {
    hubAvailable = false
    const link = makeLink()
    link.start()
    await settle(100)
    await link.sendEvent(evt(progress(), 1))
    await link.sendEvent(evt(done(), 2))
    expect(await makeOutboxStore(area).load()).toHaveLength(2)

    hubAvailable = true
    await settle(6_000)
    const socket = FakeSocket.all[0]!
    socket.open()
    await settle()
    expect(socket.messages.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual([
      1, 2
    ])
    expect(await makeOutboxStore(area).load()).toEqual([])
  })

  it('survives a worker restart: a new link instance flushes what the old one queued', async () => {
    hubAvailable = false
    const first = makeLink()
    first.start()
    await settle(100)
    await first.sendEvent(evt(done(), 7))

    hubAvailable = true
    const second = makeLink()
    second.start()
    await settle()
    const socket = FakeSocket.all[0]!
    socket.open()
    await settle()
    expect(socket.messages.find((m) => m.type === 'event')?.seq).toBe(7)
  })

  it('never sends a newer event ahead of an older queued one', async () => {
    hubAvailable = false
    const link = makeLink()
    link.start()
    await settle(100)
    await link.sendEvent(evt(progress(), 1))
    hubAvailable = true
    await settle(6_000)
    const socket = FakeSocket.all[0]!
    socket.open()
    const racing = link.sendEvent(evt(done(), 2)) // arrives while the flush is still running
    await settle()
    await racing
    expect(socket.messages.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual([
      1, 2
    ])
  })

  it('bounds the outbox but never drops completed/failed events first', async () => {
    hubAvailable = false
    const link = makeLink()
    link.start()
    await settle(100)
    await link.sendEvent(evt(done(), 1))
    for (let i = 2; i < 130; i++) await link.sendEvent(evt(progress(), i))
    const queued = (await makeOutboxStore(area).load()).map((s) => JSON.parse(s))
    expect(queued).toHaveLength(100)
    expect(queued[0].event.kind).toBe('completed')
  })

  it('announces presence on connect and when it changes', async () => {
    const link = makeLink()
    link.start()
    await settle()
    link.sendPresence({ chatgptTabs: 2 })
    const socket = FakeSocket.all[0]!
    expect(socket.messages).toEqual([]) // not connected yet; remembered for later
    socket.open()
    expect(socket.messages).toContainEqual({ type: 'presence', chatgptTabs: 2 })
    link.sendPresence({ chatgptTabs: 3 })
    expect(socket.messages.at(-1)).toEqual({ type: 'presence', chatgptTabs: 3 })
  })
})
