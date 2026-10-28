import {
  isTerminalEvent,
  type JobEvent,
  type JobFailureCode,
  type JobRequest
} from '@codegent/protocol'
import type {
  ContentReadyReply,
  FromContent,
  RunJobReply,
  ToContent
} from '../shared/messages'
import { CONTENT_READY_TIMEOUT_MS, isChatUrl } from './config'
import type { ActiveJob, WorkerState } from './state'

export interface TabInfo {
  id?: number
  url?: string
}

/** The slice of the `chrome.*` API the router needs; faked in unit tests. */
export interface BrowserApi {
  tabs: {
    get(tabId: number): Promise<TabInfo>
    create(properties: { url: string; active: boolean }): Promise<TabInfo>
    update(
      tabId: number,
      properties: { url?: string; active?: boolean }
    ): Promise<unknown>
    reload(tabId: number): Promise<void>
    sendMessage(tabId: number, message: ToContent): Promise<unknown>
  }
  scripting: {
    executeScript(injection: {
      target: { tabId: number }
      files: string[]
    }): Promise<unknown>
  }
}

export interface JobRouterDeps {
  api: BrowserApi
  state: WorkerState
  send: (message: {
    editorId: string
    jobId: string
    seq: number
    event: JobEvent
  }) => Promise<void>
  log?: (...args: unknown[]) => void
  contentReadyTimeoutMs?: number
  now?: () => number
}

type Plan =
  | { action: 'send'; tabId: number }
  | { action: 'navigate'; tabId: number; url: string }
  | { action: 'create'; url: string }
  | { action: 'fail'; code: JobFailureCode; message: string }

const sameConversation = (a: string | undefined, b: string): boolean => {
  if (!a) return false
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return false
  }
}

const failed = (code: JobFailureCode, message: string): JobEvent => ({
  kind: 'failed',
  code,
  message
})

/**
 * Decides which ChatGPT tab runs each job, gets the job into that tab's content script, relays
 * the script's events to the hub and turns every way a run can go wrong (tab closed, page
 * reloaded, script never loaded) into an explicit failure instead of a silent hang.
 */
export class JobRouter {
  private readonly seq = new Map<string, number>()
  private ticker: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: JobRouterDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Call once at worker start: a restarted worker must keep supervising jobs from before. */
  async resume(): Promise<void> {
    if ((await this.activeJobCount()) > 0) this.ensureTicker()
  }

  // ── entry points ─────────────────────────────────────────────────────────────────────────
  async handleJob(job: JobRequest): Promise<void> {
    const { state } = this.deps
    if (!isChatUrl(job.chatUrl)) {
      return this.emit(
        job.editorId,
        job.jobId,
        failed('internal', 'CodeGent only opens chatgpt.com.')
      )
    }
    const busy = await state.read((s) =>
      Object.values(s.activeJobs).some((j) => j.sessionId === job.sessionId)
    )
    if (busy) {
      return this.emit(
        job.editorId,
        job.jobId,
        failed('busy', 'This conversation is still working on the previous message.')
      )
    }

    try {
      const plan = await this.plan(job)
      if (plan.action === 'fail') {
        return this.emit(job.editorId, job.jobId, failed(plan.code, plan.message))
      }
      await this.execute(job, plan)
    } catch (error) {
      this.deps.log?.('handleJob failed', error)
      await this.failJob(
        { jobId: job.jobId, editorId: job.editorId },
        'tab-unavailable',
        `Could not open ChatGPT: ${(error as Error).message}`
      )
    }
  }

  async handleCancel(cancel: { jobId: string }): Promise<void> {
    const active = await this.deps.state.read((s) => s.activeJobs[cancel.jobId])
    if (!active) return
    if (active.awaitingSince !== undefined) {
      return this.failJob(
        active,
        'cancelled',
        'The run was cancelled before ChatGPT loaded.'
      )
    }
    try {
      await this.deps.api.tabs.sendMessage(active.tabId, {
        type: 'cancel-job',
        jobId: cancel.jobId
      })
    } catch {
      await this.failJob(
        active,
        'cancelled',
        'The run was cancelled (the ChatGPT tab was not reachable).'
      )
    }
  }

  /** A content script announced itself; hand it the job that was waiting for this tab, if any. */
  async handleContentReady(tabId: number): Promise<ContentReadyReply> {
    const outcome = await this.deps.state.update((s) => {
      const pending = s.pending[tabId]
      if (pending) {
        delete s.pending[tabId]
        const active = s.activeJobs[pending.jobId]
        if (active) delete active.awaitingSince
        return { job: pending, orphans: [] as ActiveJob[] }
      }
      // The page loaded while a run was in flight there: that run's script is gone.
      const orphans = Object.values(s.activeJobs).filter(
        (j) => j.tabId === tabId && j.awaitingSince === undefined
      )
      return { job: null, orphans }
    })
    for (const orphan of outcome.orphans) {
      await this.failJob(
        orphan,
        'page-error',
        'The ChatGPT page was reloaded while the run was in progress.'
      )
    }
    return { job: outcome.job }
  }

  /** An event produced by a content script; relay it and keep the bookkeeping in step. */
  async handleContentEvent(
    message: Extract<FromContent, { type: 'job-event' }>
  ): Promise<void> {
    const active = await this.deps.state.read((s) => s.activeJobs[message.jobId])
    if (!active) return // stale event for a job that already ended
    if (isTerminalEvent(message.event)) await this.finish(active, message.event)
    await this.deps.send({
      editorId: message.editorId,
      jobId: message.jobId,
      seq: message.seq,
      event: message.event
    })
  }

  async onTabRemoved(tabId: number): Promise<void> {
    const affected = await this.deps.state.update((s) => {
      delete s.pending[tabId]
      return Object.values(s.activeJobs).filter((j) => j.tabId === tabId)
    })
    for (const job of affected) {
      await this.failJob(
        job,
        'tab-unavailable',
        'The ChatGPT tab was closed during the run.'
      )
    }
  }

  /**
   * Once a second while jobs are active: nudges content scripts (page timers can be throttled in
   * background tabs) and fails jobs whose tab never produced a content script.
   */
  async tick(): Promise<void> {
    const jobs = await this.deps.state.read((s) => Object.values(s.activeJobs))
    if (jobs.length === 0) return this.stopTicker()
    const limit = this.deps.contentReadyTimeoutMs ?? CONTENT_READY_TIMEOUT_MS
    for (const job of jobs) {
      if (job.awaitingSince !== undefined) {
        if (this.now() - job.awaitingSince > limit) {
          await this.failJob(
            job,
            'tab-unavailable',
            'The ChatGPT page did not finish loading (is the CodeGent browser extension enabled for chatgpt.com?).'
          )
        }
        continue
      }
      this.deps.api.tabs.sendMessage(job.tabId, { type: 'tick' }).catch(() => undefined)
    }
  }

  async activeJobCount(): Promise<number> {
    return this.deps.state.read((s) => Object.keys(s.activeJobs).length)
  }

  // ── planning & execution ─────────────────────────────────────────────────────────────────
  private async plan(job: JobRequest): Promise<Plan> {
    const { state } = this.deps
    if (!job.newChat) {
      const record = await state.read((s) => s.sessions[job.sessionId])
      if (record) {
        const tab = await this.chatTab(record.tabId)
        if (tab) {
          if (
            record.conversationUrl &&
            !sameConversation(tab.url, record.conversationUrl)
          ) {
            return {
              action: 'navigate',
              tabId: record.tabId,
              url: record.conversationUrl
            }
          }
          return { action: 'send', tabId: record.tabId }
        }
        if (record.conversationUrl)
          return { action: 'create', url: record.conversationUrl }
      }
      return {
        action: 'fail',
        code: 'tab-unavailable',
        message:
          'The ChatGPT conversation for this run is no longer available. Start a new run.'
      }
    }

    // A new run gets its own tab: never navigate away from another run's saved chat.
    // Follow-ups still use their session's tab, or reopen the saved conversation URL.
    return { action: 'create', url: job.chatUrl }
  }

  private async execute(
    job: JobRequest,
    plan: Exclude<Plan, { action: 'fail' }>
  ): Promise<void> {
    const { api, state } = this.deps
    const register = (tabId: number, awaiting: boolean) =>
      state.update((s) => {
        s.activeJobs[job.jobId] = {
          jobId: job.jobId,
          sessionId: job.sessionId,
          editorId: job.editorId,
          tabId,
          startedAt: this.now(),
          ...(awaiting ? { awaitingSince: this.now() } : {})
        }
        s.sessions[job.sessionId] = {
          tabId,
          editorId: job.editorId,
          conversationUrl: job.newChat
            ? undefined
            : s.sessions[job.sessionId]?.conversationUrl,
          updatedAt: this.now()
        }
        if (awaiting) s.pending[tabId] = job
      })

    if (plan.action === 'send') {
      await register(plan.tabId, false)
      this.ensureTicker()
      await this.emit(job.editorId, job.jobId, { kind: 'accepted', tabId: plan.tabId })
      await this.deliver(plan.tabId, job)
      return
    }

    let tabId: number
    if (plan.action === 'navigate') {
      tabId = plan.tabId
      await register(tabId, true)
      await api.tabs.update(tabId, { url: plan.url, active: true })
    } else {
      const tab = await api.tabs.create({ url: plan.url, active: true })
      if (tab.id === undefined) throw new Error('the browser did not return a tab id')
      tabId = tab.id
      await register(tabId, true)
    }
    this.ensureTicker()
    await this.emit(job.editorId, job.jobId, { kind: 'accepted', tabId })
  }

  /** Hands a job to an already-loaded content script, repairing the tab if it is not there. */
  private async deliver(tabId: number, job: JobRequest): Promise<void> {
    const { api, state } = this.deps
    const attempt = async (): Promise<RunJobReply | undefined> => {
      try {
        return (await api.tabs.sendMessage(tabId, { type: 'run-job', job })) as
          RunJobReply | undefined
      } catch {
        return undefined
      }
    }
    let reply = await attempt()
    if (!reply) {
      // No content script in that tab (extension reloaded, or the page is mid-navigation).
      try {
        await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
        await new Promise((resolve) => setTimeout(resolve, 150))
        reply = await attempt()
      } catch (error) {
        this.deps.log?.('script injection failed', error)
      }
    }
    if (reply?.accepted) return
    if (reply && !reply.accepted) {
      await this.failJob(
        { jobId: job.jobId, editorId: job.editorId },
        'busy',
        'The ChatGPT tab is already running another message.'
      )
      return
    }
    // Last resort: reload the page and let the normal ready handshake deliver the job.
    await state.update((s) => {
      s.pending[tabId] = job
      const active = s.activeJobs[job.jobId]
      if (active) active.awaitingSince = this.now()
    })
    await api.tabs.reload(tabId)
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────────────────────
  private async finish(
    active: ActiveJob,
    event: Extract<JobEvent, { kind: 'completed' | 'failed' }>
  ): Promise<void> {
    await this.deps.state.update((s) => {
      delete s.activeJobs[active.jobId]
      delete s.pending[active.tabId]
      if (event.kind === 'completed') {
        s.sessions[active.sessionId] = {
          tabId: active.tabId,
          editorId: active.editorId,
          conversationUrl: event.conversationUrl,
          updatedAt: this.now()
        }
      }
    })
    this.seq.delete(active.jobId)
  }

  private async failJob(
    job: { jobId: string; editorId: string },
    code: JobFailureCode,
    message: string
  ): Promise<void> {
    await this.deps.state.update((s) => {
      const existing = s.activeJobs[job.jobId]
      if (existing) {
        delete s.activeJobs[job.jobId]
        delete s.pending[existing.tabId]
      }
    })
    this.seq.delete(job.jobId)
    await this.deps.send({
      editorId: job.editorId,
      jobId: job.jobId,
      seq: 99,
      event: failed(code, message)
    })
  }

  /** Worker-originated events use sequence numbers 0–98; the content script starts at 100. */
  private emit(editorId: string, jobId: string, event: JobEvent): Promise<void> {
    const next = Math.min(98, this.seq.get(jobId) ?? 0)
    this.seq.set(jobId, next + 1)
    return this.deps.send({ editorId, jobId, seq: next, event })
  }

  private async chatTab(tabId: number): Promise<TabInfo | null> {
    try {
      const tab = await this.deps.api.tabs.get(tabId)
      return isChatUrl(tab.url) ? tab : null
    } catch {
      return null
    }
  }

  private ensureTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => void this.tick(), 1_000)
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
  }
}
