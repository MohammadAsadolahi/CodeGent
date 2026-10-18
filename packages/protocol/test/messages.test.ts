import { describe, expect, it } from 'vitest'
import {
  browserToHubSchema,
  editorToHubSchema,
  hubToBrowserSchema,
  hubToEditorSchema,
  isTerminalEvent,
  jobEventSchema,
  jobRequestSchema,
  MAX_JOB_TEXT_CHARS,
  newId,
  parseJson,
  serialize,
  type JobRequest
} from '../src'

const baseJob = (): JobRequest => ({
  jobId: newId(),
  sessionId: newId(),
  editorId: newId(),
  text: 'hello',
  newChat: true,
  chatUrl: 'https://chatgpt.com/',
  autoSubmit: true,
  timeoutMs: 60_000
})

describe('job request', () => {
  it('accepts a valid job (browserId optional)', () => {
    const job = baseJob()
    expect(jobRequestSchema(job, '$')).toEqual(job)
    expect(jobRequestSchema({ ...job, browserId: newId() }, '$').browserId).toBeDefined()
  })

  it('rejects empty and oversized text', () => {
    expect(() => jobRequestSchema({ ...baseJob(), text: '' }, '$')).toThrow(/\$\.text/)
    expect(() =>
      jobRequestSchema({ ...baseJob(), text: 'x'.repeat(MAX_JOB_TEXT_CHARS + 1) }, '$')
    ).toThrow(/\$\.text/)
  })

  it('rejects non-http(s) and malformed URLs', () => {
    for (const chatUrl of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://x',
      'nope',
      ''
    ]) {
      expect(() => jobRequestSchema({ ...baseJob(), chatUrl }, '$')).toThrow(/chatUrl/)
    }
  })

  it('rejects absurd timeouts', () => {
    expect(() => jobRequestSchema({ ...baseJob(), timeoutMs: 5 }, '$')).toThrow(
      /timeoutMs/
    )
    expect(() =>
      jobRequestSchema({ ...baseJob(), timeoutMs: 10 * 24 * 3_600_000 }, '$')
    ).toThrow(/timeoutMs/)
  })
})

describe('job events', () => {
  it('accepts every event kind', () => {
    const events = [
      { kind: 'accepted', tabId: 12 },
      { kind: 'progress', stage: 'submitted' },
      {
        kind: 'completed',
        markdown: '### Updated file: `a.ts`',
        conversationUrl: 'https://chatgpt.com/c/abc',
        durationMs: 1234
      },
      { kind: 'failed', code: 'rate-limited', message: 'slow down' }
    ]
    for (const event of events) expect(jobEventSchema(event, '$')).toEqual(event)
  })

  it('rejects unknown kinds, stages and failure codes', () => {
    expect(() => jobEventSchema({ kind: 'exploded' }, '$')).toThrow()
    expect(() => jobEventSchema({ kind: 'progress', stage: 'nope' }, '$')).toThrow(
      /stage/
    )
    expect(() =>
      jobEventSchema({ kind: 'failed', code: 'nope', message: 'x' }, '$')
    ).toThrow(/code/)
  })

  it('knows which events are terminal', () => {
    expect(isTerminalEvent({ kind: 'accepted', tabId: 1 })).toBe(false)
    expect(isTerminalEvent({ kind: 'progress', stage: 'filled' })).toBe(false)
    expect(isTerminalEvent({ kind: 'failed', code: 'timeout', message: 'x' })).toBe(true)
  })
})

describe('direction enforcement', () => {
  const job = { type: 'job', job: baseJob() }
  const cancel = { type: 'cancel', jobId: newId(), sessionId: newId() }
  const event = {
    type: 'event',
    editorId: newId(),
    jobId: newId(),
    seq: 1,
    event: { kind: 'progress', stage: 'filled' }
  }
  const shutdown = { type: 'shutdown' }
  const presence = { type: 'presence', chatgptTabs: 2 }

  it('editors may send job, cancel, pong and shutdown only', () => {
    for (const ok of [job, cancel, { type: 'pong' }, shutdown]) {
      expect(parseJson(editorToHubSchema, JSON.stringify(ok)).ok).toBe(true)
    }
    for (const bad of [event, presence, { type: 'welcome' }]) {
      expect(parseJson(editorToHubSchema, JSON.stringify(bad)).ok).toBe(false)
    }
  })

  it('browsers may send presence, event and pong only — never job or shutdown', () => {
    for (const ok of [presence, event, { type: 'pong' }]) {
      expect(parseJson(browserToHubSchema, JSON.stringify(ok)).ok).toBe(true)
    }
    for (const bad of [job, cancel, shutdown]) {
      expect(parseJson(browserToHubSchema, JSON.stringify(bad)).ok).toBe(false)
    }
  })

  it('hub → editor carries welcome, peers, event and ping', () => {
    const welcome = {
      type: 'welcome',
      protocol: 1,
      hubVersion: '0.1.0',
      clientId: newId(),
      role: 'editor'
    }
    for (const ok of [
      welcome,
      { type: 'peers', browsers: [] },
      event,
      { type: 'ping' }
    ]) {
      expect(parseJson(hubToEditorSchema, JSON.stringify(ok)).ok).toBe(true)
    }
    expect(parseJson(hubToEditorSchema, JSON.stringify(job)).ok).toBe(false)
  })

  it('hub → browser carries welcome, job, cancel and ping', () => {
    for (const ok of [job, cancel, { type: 'ping' }]) {
      expect(parseJson(hubToBrowserSchema, JSON.stringify(ok)).ok).toBe(true)
    }
    expect(parseJson(hubToBrowserSchema, JSON.stringify(event)).ok).toBe(false)
  })

  it('serialize → parse is lossless', () => {
    const message = { type: 'job', job: baseJob() } as const
    const parsed = parseJson(editorToHubSchema, serialize(message))
    expect(parsed).toEqual({ ok: true, value: message })
  })
})
