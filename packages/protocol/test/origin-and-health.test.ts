import { describe, expect, it } from 'vitest'
import {
  classifyOrigin,
  findHub,
  HUB_SERVICE_NAME,
  isAllowedHostHeader,
  isOriginAllowedForRole,
  newId,
  PROTOCOL_VERSION,
  probeHub,
  shortId
} from '../src'

const goodChromeOrigin = `chrome-extension://${'a'.repeat(32)}`
const goodFirefoxOrigin = 'moz-extension://3f2b8c1e-0a5d-4a8e-9b1f-0123456789ab'

describe('classifyOrigin', () => {
  it('treats a missing Origin as none', () => {
    expect(classifyOrigin(undefined)).toBe('none')
    expect(classifyOrigin('')).toBe('none')
  })

  it('recognises genuine extension origins', () => {
    expect(classifyOrigin(goodChromeOrigin)).toBe('extension')
    expect(classifyOrigin(goodFirefoxOrigin)).toBe('extension')
  })

  it('treats web origins and look-alikes as other', () => {
    for (const origin of [
      'https://chatgpt.com',
      'https://evil.example',
      'http://127.0.0.1:47615',
      'null',
      'chrome-extension://short',
      `chrome-extension://${'a'.repeat(32)}.evil.com`,
      `chrome-extension://${'z'.repeat(32)}`,
      'moz-extension://not-a-uuid',
      'file://'
    ]) {
      expect(classifyOrigin(origin)).toBe('other')
    }
  })
})

describe('isOriginAllowedForRole', () => {
  it('lets editors in only without an Origin', () => {
    expect(isOriginAllowedForRole('editor', undefined)).toBe(true)
    expect(isOriginAllowedForRole('editor', goodChromeOrigin)).toBe(false)
    expect(isOriginAllowedForRole('editor', 'https://evil.example')).toBe(false)
  })

  it('lets browsers in only with an extension Origin', () => {
    expect(isOriginAllowedForRole('browser', goodChromeOrigin)).toBe(true)
    expect(isOriginAllowedForRole('browser', goodFirefoxOrigin)).toBe(true)
    expect(isOriginAllowedForRole('browser', undefined)).toBe(false)
    expect(isOriginAllowedForRole('browser', 'https://chatgpt.com')).toBe(false)
  })
})

describe('isAllowedHostHeader', () => {
  it('accepts loopback names on the hub port', () => {
    for (const host of [
      '127.0.0.1:47615',
      'localhost:47615',
      'LOCALHOST:47615',
      '[::1]:47615'
    ]) {
      expect(isAllowedHostHeader(host, 47615)).toBe(true)
    }
  })

  it('rejects everything else (DNS rebinding, wrong port, missing)', () => {
    for (const host of [
      undefined,
      '',
      'evil.example:47615',
      '127.0.0.1',
      '127.0.0.1:1',
      '127.0.0.1:47615.evil.example',
      'localhost.evil.example:47615'
    ]) {
      expect(isAllowedHostHeader(host, 47615)).toBe(false)
    }
  })
})

describe('ids', () => {
  it('generates unique UUIDs and a short form', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId()))
    expect(ids.size).toBe(2000)
    for (const id of Array.from(ids).slice(0, 10)) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      expect(shortId(id)).toBe(id.slice(0, 8))
    }
  })
})

const health = (over: Record<string, unknown> = {}) => ({
  ok: true,
  service: HUB_SERVICE_NAME,
  protocol: PROTOCOL_VERSION,
  version: '0.1.0',
  pid: 1234,
  startedAt: 1,
  editors: 0,
  browsers: 0,
  ...over
})

const respond = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) })

describe('probeHub', () => {
  it('returns the health document of a hub', async () => {
    const result = await probeHub(47615, { fetch: () => respond(health()) })
    expect(result?.service).toBe(HUB_SERVICE_NAME)
  })

  it('returns null for non-OK responses, network errors and foreign services', async () => {
    expect(await probeHub(1, { fetch: () => respond(health(), false) })).toBeNull()
    expect(
      await probeHub(1, { fetch: () => Promise.reject(new Error('refused')) })
    ).toBeNull()
    expect(await probeHub(1, { fetch: () => respond({ hello: 'world' }) })).toBeNull()
    expect(
      await probeHub(1, { fetch: () => respond(health({ service: 'other' })) })
    ).toBeNull()
  })

  it('gives up after the timeout', async () => {
    const hang = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const started = Date.now()
    expect(await probeHub(1, { fetch: hang, timeoutMs: 50 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('findHub', () => {
  it('prefers the first compatible hub in port order, whichever answers first', async () => {
    const fetchByPort = (url: string) => {
      const port = Number(new URL(url).port)
      if (port === 1) return respond(health({ protocol: PROTOCOL_VERSION + 1 }))
      if (port === 2)
        return new Promise((r) => setTimeout(() => r(respond(health())), 40)).then(
          (x) => x as never
        )
      return respond(health({ pid: 99 }))
    }
    const found = await findHub({ ports: [1, 2, 3], fetch: fetchByPort as never })
    expect(found?.port).toBe(2)
  })

  it('returns null when nothing compatible is running', async () => {
    const found = await findHub({
      ports: [1, 2],
      fetch: () => Promise.reject(new Error('refused'))
    })
    expect(found).toBeNull()
    const incompatible = await findHub({
      ports: [1],
      fetch: () => respond(health({ protocol: PROTOCOL_VERSION + 5 }))
    })
    expect(incompatible).toBeNull()
  })
})
