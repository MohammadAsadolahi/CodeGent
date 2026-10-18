import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import {
  CLOSE_PROTOCOL_VIOLATION,
  CLOSE_REPLACED,
  CLOSE_STALE,
  HUB_SERVICE_NAME,
  newId,
  PROTOCOL_VERSION
} from '@codegent/protocol'
import { Hub } from '../src'
import {
  completedEvent,
  connect,
  EXT_ORIGIN,
  httpRequest,
  makeJob,
  progressEvent,
  Rejected,
  sleep,
  startHub,
  type Client
} from './helpers'

const hubs: Hub[] = []
const clients: Client[] = []

const hubWith = async (options: Parameters<typeof startHub>[0] = {}) => {
  const hub = await startHub(options)
  hubs.push(hub)
  return hub
}
const join = async (hub: Hub, options: Parameters<typeof connect>[1]) => {
  const client = await connect(hub, options)
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate()
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()))
})

describe('HTTP', () => {
  it('serves /health with service identity and live counts', async () => {
    const hub = await hubWith({ version: '9.9.9' })
    await join(hub, { role: 'editor' })
    await join(hub, { role: 'browser' })
    const { status, body } = await httpRequest(hub)
    expect(status).toBe(200)
    const health = JSON.parse(body)
    expect(health).toMatchObject({
      ok: true,
      service: HUB_SERVICE_NAME,
      protocol: PROTOCOL_VERSION,
      version: '9.9.9',
      editors: 1,
      browsers: 1
    })
    expect(health.pid).toBe(process.pid)
  })

  it('does not send CORS headers (pages cannot read it)', async () => {
    const hub = await hubWith()
    const response = await fetch(`http://127.0.0.1:${hub.port}/health`)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses foreign Host headers (DNS rebinding) and unknown paths/methods', async () => {
    const hub = await hubWith()
    expect((await httpRequest(hub, { host: 'evil.example:1234' })).status).toBe(403)
    expect((await httpRequest(hub, { path: '/nope' })).status).toBe(404)
    expect((await httpRequest(hub, { method: 'POST' })).status).toBe(405)
  })
})

describe('upgrade validation', () => {
  const expectRejected = async (promise: Promise<unknown>, status: number) => {
    const error = await promise.then(
      () => undefined,
      (e) => e
    )
    expect(error).toBeInstanceOf(Rejected)
    expect((error as Rejected).status).toBe(status)
    return error as Rejected
  }

  it('rejects foreign hosts', async () => {
    const hub = await hubWith()
    await expectRejected(connect(hub, { role: 'editor', host: 'evil.example:80' }), 403)
  })

  it('rejects web-page origins for both roles', async () => {
    const hub = await hubWith()
    await expectRejected(
      connect(hub, { role: 'editor', origin: 'https://evil.example' }),
      403
    )
    await expectRejected(
      connect(hub, { role: 'browser', origin: 'https://chatgpt.com' }),
      403
    )
  })

  it('rejects an editor that carries an extension origin and a browser that has none', async () => {
    const hub = await hubWith()
    await expectRejected(connect(hub, { role: 'editor', origin: EXT_ORIGIN }), 403)
    await expectRejected(connect(hub, { role: 'browser', origin: null }), 403)
  })

  it('rejects protocol mismatches with 426', async () => {
    const hub = await hubWith()
    await expectRejected(
      connect(hub, { role: 'editor', protocol: PROTOCOL_VERSION + 1 }),
      426
    )
    await expectRejected(connect(hub, { role: 'editor', protocol: 'x' }), 426)
  })

  it('rejects bad roles, ids and paths', async () => {
    const hub = await hubWith()
    await expectRejected(connect(hub, { role: 'admin' as never }), 400)
    await expectRejected(connect(hub, { role: 'editor', id: 'has spaces' }), 400)
    await expectRejected(connect(hub, { role: 'editor', id: 'x'.repeat(101) }), 400)
    await expectRejected(connect(hub, { role: 'editor', path: '/other' }), 404)
  })

  describe('with an allow-list of browser extensions', () => {
    const OURS = `chrome-extension://${'b'.repeat(32)}`
    const ALSO = `chrome-extension://${'c'.repeat(32)}`

    it('accepts only the listed extensions as the browser — another extension is turned away', async () => {
      const hub = await hubWith({ allowedBrowserOrigins: [OURS, ALSO] })
      await join(hub, { role: 'browser', origin: OURS })
      await join(hub, { role: 'browser', origin: ALSO })
      const error = await expectRejected(
        connect(hub, { role: 'browser', origin: EXT_ORIGIN }),
        403
      )
      expect(error.body).toMatch(/not on the allow-list/)
      expect(error.body).toContain(EXT_ORIGIN) // the log says which one it was
    })

    it('does not change who may be an editor, and still turns web pages away', async () => {
      const hub = await hubWith({ allowedBrowserOrigins: [OURS] })
      await join(hub, { role: 'editor' })
      await expectRejected(connect(hub, { role: 'editor', origin: OURS }), 403)
      await expectRejected(
        connect(hub, { role: 'browser', origin: 'https://chatgpt.com' }),
        403
      )
      await expectRejected(connect(hub, { role: 'browser', origin: null }), 403)
    })

    it('treats an empty list as "no restriction"', async () => {
      const hub = await hubWith({ allowedBrowserOrigins: [] })
      await join(hub, { role: 'browser', origin: EXT_ORIGIN })
    })

    it('tells nobody about the browser that was turned away', async () => {
      const hub = await hubWith({ allowedBrowserOrigins: [OURS] })
      const editor = await join(hub, { role: 'editor' })
      await expectRejected(connect(hub, { role: 'browser', origin: EXT_ORIGIN }), 403)
      await join(hub, { role: 'browser', origin: OURS })
      const peers = await editor.next(
        (m) => m.type === 'peers' && m.browsers.length === 1
      )
      expect(peers.browsers).toHaveLength(1)
    })
  })

  it('accepts a correct editor and browser', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const browser = await join(hub, { role: 'browser' })
    expect((await editor.next((m) => m.type === 'welcome')).role).toBe('editor')
    expect((await browser.next((m) => m.type === 'welcome')).role).toBe('browser')
  })
})

describe('peers', () => {
  it('tells editors who is connected and keeps that list current', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    expect((await editor.next((m) => m.type === 'peers')).browsers).toEqual([])

    const browserId = newId()
    const browser = await join(hub, {
      role: 'browser',
      id: browserId,
      name: 'Chrome',
      profile: 'Work'
    })
    const withBrowser = await editor.next(
      (m) => m.type === 'peers' && m.browsers.length === 1
    )
    expect(withBrowser.browsers[0]).toMatchObject({
      id: browserId,
      name: 'Chrome',
      profile: 'Work',
      chatgptTabs: 0,
      extensionVersion: '0.0.1'
    })

    browser.send({ type: 'presence', chatgptTabs: 2 })
    const updated = await editor.next(
      (m) => m.type === 'peers' && m.browsers[0]?.chatgptTabs === 2
    )
    expect(updated.browsers[0].id).toBe(browserId)

    browser.close()
    await editor.next((m) => m.type === 'peers' && m.browsers.length === 0)
  })

  it('replaces an older connection that reuses the same id', async () => {
    const hub = await hubWith()
    const id = newId()
    const first = await join(hub, { role: 'editor', id })
    const second = await join(hub, { role: 'editor', id })
    expect((await first.closed).code).toBe(CLOSE_REPLACED)
    expect(hub.health().editors).toBe(1)
    // the replacement keeps working
    second.send({ type: 'pong' })
    await sleep(30)
    expect(hub.health().editors).toBe(1)
  })
})

describe('job routing', () => {
  it('forwards a job to the only browser and returns its events to the originating editor', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const other = await join(hub, { role: 'editor' })
    const browser = await join(hub, { role: 'browser' })

    const job = makeJob({ editorId: editor.id })
    editor.send({ type: 'job', job })
    const forwarded = await browser.next((m) => m.type === 'job')
    expect(forwarded.job).toEqual(job)

    browser.send(progressEvent(editor.id, job.jobId))
    browser.send(completedEvent(editor.id, job.jobId))
    expect(
      (await editor.next((m) => m.type === 'event' && m.event.kind === 'progress')).jobId
    ).toBe(job.jobId)
    expect(
      (await editor.next((m) => m.type === 'event' && m.event.kind === 'completed')).jobId
    ).toBe(job.jobId)
    await other.expectNone((m) => m.type === 'event')
  })

  it('answers immediately with no-browser when nothing is connected', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const job = makeJob({ editorId: editor.id })
    editor.send({ type: 'job', job })
    const event = await editor.next((m) => m.type === 'event')
    expect(event.jobId).toBe(job.jobId)
    expect(event.event).toMatchObject({ kind: 'failed', code: 'no-browser' })
  })

  it('reports ambiguity when several browsers are connected and none is chosen', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const a = await join(hub, { role: 'browser' })
    const b = await join(hub, { role: 'browser' })
    editor.send({ type: 'job', job: makeJob({ editorId: editor.id }) })
    const event = await editor.next((m) => m.type === 'event')
    expect(event.event).toMatchObject({ kind: 'failed', code: 'ambiguous-browser' })
    await a.expectNone((m) => m.type === 'job')
    await b.expectNone((m) => m.type === 'job')
  })

  it('routes to the chosen browser when several are connected', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const a = await join(hub, { role: 'browser' })
    const b = await join(hub, { role: 'browser' })
    const job = makeJob({ editorId: editor.id, browserId: b.id })
    editor.send({ type: 'job', job })
    expect((await b.next((m) => m.type === 'job')).job.jobId).toBe(job.jobId)
    await a.expectNone((m) => m.type === 'job')
  })

  it('fails when the chosen browser is not connected', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    await join(hub, { role: 'browser' })
    editor.send({
      type: 'job',
      job: makeJob({ editorId: editor.id, browserId: 'ghost' })
    })
    const event = await editor.next((m) => m.type === 'event')
    expect(event.event).toMatchObject({ kind: 'failed', code: 'no-browser' })
  })

  it('refuses a job whose editorId is not the sender (no spoofing)', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const browser = await join(hub, { role: 'browser' })
    editor.send({ type: 'job', job: makeJob({ editorId: newId() }) })
    const event = await editor.next((m) => m.type === 'event')
    expect(event.event).toMatchObject({ kind: 'failed', code: 'internal' })
    await browser.expectNone((m) => m.type === 'job')
  })

  it('forwards cancel requests to the browser', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    const browser = await join(hub, { role: 'browser' })
    const jobId = newId()
    const sessionId = newId()
    editor.send({ type: 'cancel', jobId, sessionId })
    const cancel = await browser.next((m) => m.type === 'cancel')
    expect(cancel).toMatchObject({ jobId, sessionId })
  })

  it('does not let a browser inject jobs, cancels or shutdowns', async () => {
    const onShutdownRequested = vi.fn()
    const hub = await hubWith({ onShutdownRequested })
    const editor = await join(hub, { role: 'editor' })
    const browser = await join(hub, { role: 'browser' })
    const otherBrowser = await join(hub, { role: 'browser' })
    browser.send({ type: 'job', job: makeJob({ editorId: editor.id }) })
    browser.send({ type: 'shutdown' })
    browser.send({ type: 'cancel', jobId: newId(), sessionId: newId() })
    await editor.expectNone((m) => m.type === 'job' || m.type === 'cancel')
    await otherBrowser.expectNone((m) => m.type === 'job' || m.type === 'cancel')
    expect(onShutdownRequested).not.toHaveBeenCalled()
    expect(hub.health().browsers).toBe(2)
  })
})

describe('mailbox', () => {
  it('replays events produced while the editor was away, to the same editor id', async () => {
    const hub = await hubWith()
    const browser = await join(hub, { role: 'browser' })
    const editorId = newId()
    const first = await join(hub, { role: 'editor', id: editorId })
    first.close()
    await first.closed

    const jobId = newId()
    browser.send(progressEvent(editorId, jobId, 1))
    browser.send(completedEvent(editorId, jobId, 2))
    await sleep(60)

    const back = await join(hub, { role: 'editor', id: editorId })
    const progress = await back.next(
      (m) => m.type === 'event' && m.event.kind === 'progress'
    )
    const done = await back.next(
      (m) => m.type === 'event' && m.event.kind === 'completed'
    )
    expect([progress.seq, done.seq]).toEqual([1, 2])

    // drained: a later reconnect gets nothing again
    back.close()
    await back.closed
    const again = await join(hub, { role: 'editor', id: editorId })
    await again.expectNone((m) => m.type === 'event')
  })

  it('does not deliver another editor’s events', async () => {
    const hub = await hubWith()
    const browser = await join(hub, { role: 'browser' })
    const away = newId()
    browser.send(completedEvent(away, newId()))
    await sleep(40)
    const stranger = await join(hub, { role: 'editor' })
    await stranger.expectNone((m) => m.type === 'event')
  })

  it('expires stale events', async () => {
    const hub = await hubWith({ mailboxTtlMs: 100 })
    const browser = await join(hub, { role: 'browser' })
    const editorId = newId()
    browser.send(completedEvent(editorId, newId()))
    await sleep(250)
    const editor = await join(hub, { role: 'editor', id: editorId })
    await editor.expectNone((m) => m.type === 'event')
  })

  it('keeps terminal events when the box overflows', async () => {
    const hub = await hubWith({ mailboxMaxEvents: 3 })
    const browser = await join(hub, { role: 'browser' })
    const editorId = newId()
    const jobId = newId()
    browser.send(completedEvent(editorId, jobId, 1))
    for (let seq = 2; seq <= 6; seq++) browser.send(progressEvent(editorId, jobId, seq))
    await sleep(80)
    const editor = await join(hub, { role: 'editor', id: editorId })
    await editor.next((m) => m.type === 'event' && m.event.kind === 'completed')
    const progressSeqs: number[] = []
    for (;;) {
      const m = await editor
        .next((x) => x.type === 'event' && x.event.kind === 'progress', 100)
        .catch(() => undefined)
      if (!m) break
      progressSeqs.push(m.seq)
    }
    expect(progressSeqs).toEqual([5, 6]) // oldest progress events were dropped first
  })
})

describe('liveness and abuse resistance', () => {
  it('pings clients and terminates the ones that go silent', async () => {
    const hub = await hubWith({ heartbeatIntervalMs: 25, deadAfterMs: 120 })
    const silent = await join(hub, { role: 'editor', autoPong: false })
    const lively = await join(hub, { role: 'editor', autoPong: true })
    await silent.next((m) => m.type === 'ping')
    expect((await silent.closed).code).toBe(CLOSE_STALE)
    await sleep(200)
    expect(lively.ws.readyState).toBe(lively.ws.OPEN)
    expect(hub.health().editors).toBe(1)
  })

  it('closes connections that keep sending garbage', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    for (let i = 0; i < 5; i++) editor.sendRaw('not json')
    expect((await editor.closed).code).toBe(CLOSE_PROTOCOL_VIOLATION)
  })

  it('tolerates an occasional bad message and resets the strike count', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) editor.sendRaw('{"type":"bogus"}')
      editor.send({ type: 'pong' })
    }
    await sleep(60)
    expect(editor.ws.readyState).toBe(editor.ws.OPEN)
  })

  it('closes on binary frames after repeated use', async () => {
    const hub = await hubWith()
    const editor = await join(hub, { role: 'editor' })
    for (let i = 0; i < 5; i++) editor.sendRaw(Buffer.from([1, 2, 3]), true)
    expect((await editor.closed).code).toBe(CLOSE_PROTOCOL_VIOLATION)
  })

  it('drops connections that exceed the payload limit', async () => {
    const hub = await hubWith({ maxMessageBytes: 1024 })
    const editor = await join(hub, { role: 'editor' })
    editor.sendRaw('x'.repeat(4096))
    expect((await editor.closed).code).toBe(1009)
  })
})

describe('lifecycle', () => {
  it('reports idle only when no editor is connected for the configured time', async () => {
    const onIdle = vi.fn()
    const hub = await hubWith({ idleExitMs: 120, onIdle })
    const editor = await join(hub, { role: 'editor' })
    await sleep(250)
    expect(onIdle).not.toHaveBeenCalled() // an editor is connected

    editor.close()
    await editor.closed
    await sleep(60)
    expect(onIdle).not.toHaveBeenCalled() // grace period still running
    await sleep(200)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('treats a hub nobody ever connected to as idle too', async () => {
    const onIdle = vi.fn()
    await hubWith({ idleExitMs: 80, onIdle })
    await sleep(220)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('a browser alone does not keep the hub alive', async () => {
    const onIdle = vi.fn()
    const hub = await hubWith({ idleExitMs: 80, onIdle })
    await join(hub, { role: 'browser' })
    await sleep(220)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('honours a shutdown request from an editor', async () => {
    const onShutdownRequested = vi.fn()
    const hub = await hubWith({ onShutdownRequested })
    const editor = await join(hub, { role: 'editor' })
    editor.send({ type: 'shutdown' })
    await sleep(60)
    expect(onShutdownRequested).toHaveBeenCalledTimes(1)
  })

  it('refuses to start on a port that is already taken', async () => {
    const first = await hubWith()
    const second = new Hub({ port: first.port, idleExitMs: 0 })
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('stop() disconnects everyone and frees the port', async () => {
    const hub = await startHub()
    const editor = await connect(hub, { role: 'editor' })
    const port = hub.port
    await hub.stop()
    expect((await editor.closed).code).toBe(4003)
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  })

  it('binds to the loopback interface only', async () => {
    const hub = await hubWith()
    const address = (
      hub as unknown as { server: net.Server }
    ).server.address() as net.AddressInfo
    expect(address.address).toBe('127.0.0.1')
  })
})
