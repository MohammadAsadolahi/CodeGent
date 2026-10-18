import { beforeEach, describe, expect, it } from 'vitest'
import { newId, type JobEvent, type JobRequest } from '@codegent/protocol'
import { JobRouter, type BrowserApi, type TabInfo } from '../../src/background/jobs'
import { WorkerState, type KeyValueArea } from '../../src/background/state'
import type { ToContent } from '../../src/shared/messages'

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

class FakeBrowser implements BrowserApi {
  tabs_: Map<number, TabInfo> = new Map()
  nextId = 100
  created: string[] = []
  updated: Array<{ tabId: number; url?: string }> = []
  reloaded: number[] = []
  injected: number[] = []
  messages: Array<{ tabId: number; message: ToContent }> = []
  /** Controls how the content script answers `run-job`. */
  runJobReply: 'accept' | 'busy' | 'no-receiver' | 'no-receiver-until-injected' = 'accept'
  private injectedOk = new Set<number>()

  tabs = {
    get: async (tabId: number) => {
      const tab = this.tabs_.get(tabId)
      if (!tab) throw new Error('No tab with id')
      return tab
    },
    create: async (properties: { url: string; active: boolean }) => {
      const id = this.nextId++
      this.created.push(properties.url)
      this.tabs_.set(id, { id, url: properties.url })
      return { id, url: properties.url }
    },
    update: async (tabId: number, properties: { url?: string }) => {
      this.updated.push({ tabId, url: properties.url })
      if (properties.url) this.tabs_.set(tabId, { id: tabId, url: properties.url })
    },
    reload: async (tabId: number) => {
      this.reloaded.push(tabId)
    },
    sendMessage: async (tabId: number, message: ToContent) => {
      this.messages.push({ tabId, message })
      if (message.type !== 'run-job') return { ok: true }
      if (this.runJobReply === 'no-receiver')
        throw new Error('Could not establish connection')
      if (
        this.runJobReply === 'no-receiver-until-injected' &&
        !this.injectedOk.has(tabId)
      ) {
        throw new Error('Could not establish connection')
      }
      return this.runJobReply === 'busy'
        ? { accepted: false, reason: 'busy' }
        : { accepted: true }
    }
  }
  scripting = {
    executeScript: async (injection: { target: { tabId: number } }) => {
      this.injected.push(injection.target.tabId)
      this.injectedOk.add(injection.target.tabId)
    }
  }

  openTab(url: string): number {
    const id = this.nextId++
    this.tabs_.set(id, { id, url })
    return id
  }
  closeTab(id: number) {
    this.tabs_.delete(id)
  }
}

interface Harness {
  browser: FakeBrowser
  area: MemoryArea
  router: JobRouter
  sent: Array<{ editorId: string; jobId: string; seq: number; event: JobEvent }>
  clock: { now: number }
  newRouter: () => JobRouter
}

const harness = (): Harness => {
  const browser = new FakeBrowser()
  const area = new MemoryArea()
  const sent: Harness['sent'] = []
  const clock = { now: 1_000_000 }
  const newRouter = () =>
    new JobRouter({
      api: browser,
      state: new WorkerState(area),
      send: async (m) => void sent.push(m),
      now: () => clock.now,
      contentReadyTimeoutMs: 10_000
    })
  return { browser, area, router: newRouter(), sent, clock, newRouter }
}

const job = (over: Partial<JobRequest> = {}): JobRequest => ({
  jobId: newId(),
  sessionId: newId(),
  editorId: 'editor-1',
  text: 'hello',
  newChat: true,
  chatUrl: 'https://chatgpt.com/',
  autoSubmit: true,
  timeoutMs: 60_000,
  ...over
})

const eventsOf = (h: Harness, jobId: string) =>
  h.sent.filter((m) => m.jobId === jobId).map((m) => m.event)
const completed = (url = 'https://chatgpt.com/c/abc'): JobEvent => ({
  kind: 'completed',
  markdown: 'reply',
  conversationUrl: url,
  durationMs: 5
})

let h: Harness
beforeEach(() => {
  h = harness()
})

describe('new chats', () => {
  it('opens a tab, hands the job over on content-ready exactly once, and relays events', async () => {
    const j = job()
    await h.router.handleJob(j)
    expect(h.browser.created).toEqual(['https://chatgpt.com/'])
    expect(eventsOf(h, j.jobId)[0]).toMatchObject({ kind: 'accepted' })

    const tabId = [...h.browser.tabs_.keys()][0]!
    expect((await h.router.handleContentReady(tabId)).job).toEqual(j)

    await h.router.handleContentEvent({
      type: 'job-event',
      editorId: j.editorId,
      jobId: j.jobId,
      seq: 100,
      event: { kind: 'progress', stage: 'filled' }
    })
    await h.router.handleContentEvent({
      type: 'job-event',
      editorId: j.editorId,
      jobId: j.jobId,
      seq: 101,
      event: completed()
    })
    expect(eventsOf(h, j.jobId).map((e) => e.kind)).toEqual([
      'accepted',
      'progress',
      'completed'
    ])
    expect(await h.router.activeJobCount()).toBe(0)
  })

  it('rejects chat URLs outside chatgpt.com', async () => {
    const j = job({ chatUrl: 'https://evil.example/' })
    await h.router.handleJob(j)
    expect(h.browser.created).toEqual([])
    expect(eventsOf(h, j.jobId)[0]).toMatchObject({ kind: 'failed', code: 'internal' })
  })

  it('refuses a second job for a session that is still busy', async () => {
    const first = job()
    await h.router.handleJob(first)
    const second = job({ sessionId: first.sessionId, newChat: false })
    await h.router.handleJob(second)
    expect(eventsOf(h, second.jobId)[0]).toMatchObject({ kind: 'failed', code: 'busy' })
  })

  it('reuses the editor’s previous idle tab for the next new chat, but not a busy one', async () => {
    const first = job()
    await h.router.handleJob(first)
    const tabId = [...h.browser.tabs_.keys()][0]!
    await h.router.handleContentReady(tabId)
    await h.router.handleContentEvent({
      type: 'job-event',
      editorId: 'editor-1',
      jobId: first.jobId,
      seq: 100,
      event: completed()
    })

    const second = job()
    await h.router.handleJob(second)
    expect(h.browser.created).toHaveLength(1) // no new tab
    expect(h.browser.updated.at(-1)).toMatchObject({ tabId, url: 'https://chatgpt.com/' })

    const third = job() // second is still running in that tab ⇒ needs its own tab
    await h.router.handleJob(third)
    expect(h.browser.created).toHaveLength(2)
  })
})

describe('follow-up messages', () => {
  const startConversation = async () => {
    const first = job()
    await h.router.handleJob(first)
    const tabId = [...h.browser.tabs_.keys()][0]!
    await h.router.handleContentReady(tabId)
    await h.router.handleContentEvent({
      type: 'job-event',
      editorId: 'editor-1',
      jobId: first.jobId,
      seq: 100,
      event: completed('https://chatgpt.com/c/abc')
    })
    h.browser.tabs_.set(tabId, { id: tabId, url: 'https://chatgpt.com/c/abc' })
    return { first, tabId }
  }

  it('sends straight to the loaded content script when the tab is still on the conversation', async () => {
    const { first, tabId } = await startConversation()
    const follow = job({ sessionId: first.sessionId, newChat: false, text: 'next step' })
    await h.router.handleJob(follow)
    expect(h.browser.messages.at(-1)).toMatchObject({
      tabId,
      message: { type: 'run-job' }
    })
    expect(h.browser.created).toHaveLength(1)
    expect(eventsOf(h, follow.jobId)[0]).toMatchObject({ kind: 'accepted', tabId })
  })

  it('navigates back when the user moved the tab to another page', async () => {
    const { first, tabId } = await startConversation()
    h.browser.tabs_.set(tabId, { id: tabId, url: 'https://chatgpt.com/c/other' })
    const follow = job({ sessionId: first.sessionId, newChat: false })
    await h.router.handleJob(follow)
    expect(h.browser.updated.at(-1)).toEqual({ tabId, url: 'https://chatgpt.com/c/abc' })
    expect((await h.router.handleContentReady(tabId)).job?.jobId).toBe(follow.jobId)
  })

  it('reopens the conversation when its tab was closed', async () => {
    const { first, tabId } = await startConversation()
    h.browser.closeTab(tabId)
    const follow = job({ sessionId: first.sessionId, newChat: false })
    await h.router.handleJob(follow)
    expect(h.browser.created.at(-1)).toBe('https://chatgpt.com/c/abc')
  })

  it('fails clearly when the conversation is unknown', async () => {
    const orphan = job({ newChat: false })
    await h.router.handleJob(orphan)
    expect(eventsOf(h, orphan.jobId)[0]).toMatchObject({
      kind: 'failed',
      code: 'tab-unavailable'
    })
  })

  it('injects the content script when the tab has none, then delivers', async () => {
    const { first, tabId } = await startConversation()
    h.browser.runJobReply = 'no-receiver-until-injected'
    await h.router.handleJob(job({ sessionId: first.sessionId, newChat: false }))
    expect(h.browser.injected).toEqual([tabId])
    expect(h.browser.reloaded).toEqual([])
  })

  it('reloads the page as a last resort and delivers through the ready handshake', async () => {
    const { first, tabId } = await startConversation()
    h.browser.runJobReply = 'no-receiver'
    const follow = job({ sessionId: first.sessionId, newChat: false })
    await h.router.handleJob(follow)
    expect(h.browser.reloaded).toEqual([tabId])
    expect((await h.router.handleContentReady(tabId)).job?.jobId).toBe(follow.jobId)
  })

  it('reports busy when the content script is already running something', async () => {
    const { first } = await startConversation()
    h.browser.runJobReply = 'busy'
    const follow = job({ sessionId: first.sessionId, newChat: false })
    await h.router.handleJob(follow)
    expect(eventsOf(h, follow.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'busy'
    })
    expect(await h.router.activeJobCount()).toBe(0)
  })
})

describe('things going wrong mid-run', () => {
  const running = async () => {
    const j = job()
    await h.router.handleJob(j)
    const tabId = [...h.browser.tabs_.keys()][0]!
    await h.router.handleContentReady(tabId)
    return { j, tabId }
  }

  it('fails the run when its tab is closed', async () => {
    const { j, tabId } = await running()
    await h.router.onTabRemoved(tabId)
    expect(eventsOf(h, j.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'tab-unavailable'
    })
    expect(await h.router.activeJobCount()).toBe(0)
  })

  it('fails the run when the page reloads under it (content script announces itself again)', async () => {
    const { j, tabId } = await running()
    const reply = await h.router.handleContentReady(tabId)
    expect(reply.job).toBeNull()
    expect(eventsOf(h, j.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'page-error'
    })
  })

  it('fails a job whose fresh tab never produces a content script', async () => {
    const j = job()
    await h.router.handleJob(j)
    h.clock.now += 9_000
    await h.router.tick()
    expect(await h.router.activeJobCount()).toBe(1)
    h.clock.now += 2_000
    await h.router.tick()
    expect(eventsOf(h, j.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'tab-unavailable'
    })
  })

  it('nudges running content scripts on every tick', async () => {
    const { tabId } = await running()
    await h.router.tick()
    expect(h.browser.messages.at(-1)).toEqual({ tabId, message: { type: 'tick' } })
  })

  it('cancels a run through the content script', async () => {
    const { j, tabId } = await running()
    await h.router.handleCancel({ jobId: j.jobId })
    expect(h.browser.messages.at(-1)).toEqual({
      tabId,
      message: { type: 'cancel-job', jobId: j.jobId }
    })
  })

  it('cancels a run that is still waiting for its page, and one whose tab is unreachable', async () => {
    const waiting = job()
    await h.router.handleJob(waiting)
    await h.router.handleCancel({ jobId: waiting.jobId })
    expect(eventsOf(h, waiting.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'cancelled'
    })

    const { j } = await running()
    h.browser.tabs.sendMessage = async () => {
      throw new Error('gone')
    }
    await h.router.handleCancel({ jobId: j.jobId })
    expect(eventsOf(h, j.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'cancelled'
    })
  })

  it('ignores stale events from jobs that already ended', async () => {
    const { j } = await running()
    await h.router.handleContentEvent({
      type: 'job-event',
      editorId: 'editor-1',
      jobId: j.jobId,
      seq: 100,
      event: completed()
    })
    const before = h.sent.length
    await h.router.handleContentEvent({
      type: 'job-event',
      editorId: 'editor-1',
      jobId: j.jobId,
      seq: 105,
      event: { kind: 'progress', stage: 'filled' }
    })
    expect(h.sent).toHaveLength(before)
  })

  it('keeps supervising jobs after the service worker restarts', async () => {
    const { j, tabId } = await running()
    const restarted = h.newRouter() // new in-memory state over the same persisted storage
    await restarted.resume()
    await restarted.onTabRemoved(tabId)
    expect(eventsOf(h, j.jobId).at(-1)).toMatchObject({
      kind: 'failed',
      code: 'tab-unavailable'
    })
  })
})
