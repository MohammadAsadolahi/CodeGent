import type { JobRequest } from '@codegent/protocol'
import { newId } from '@codegent/protocol'

/** Minimal storage surface so the logic can be tested without a browser. */
export interface KeyValueArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface SessionRecord {
  tabId: number
  editorId: string
  conversationUrl?: string
  updatedAt: number
}

export interface ActiveJob {
  jobId: string
  sessionId: string
  editorId: string
  tabId: number
  startedAt: number
  /** When the job started waiting for a (re)loading tab to announce its content script. */
  awaitingSince?: number
}

interface Snapshot {
  sessions: Record<string, SessionRecord>
  lastTabByEditor: Record<string, number>
  activeJobs: Record<string, ActiveJob>
  pending: Record<string, JobRequest>
}

const EMPTY = (): Snapshot => ({
  sessions: {},
  lastTabByEditor: {},
  activeJobs: {},
  pending: {}
})
const KEY = 'codegent-state'

/**
 * Everything that must survive the service worker being killed. All mutations go through one
 * queue so concurrent handlers cannot clobber each other's read-modify-write.
 */
export class WorkerState {
  private cache: Snapshot | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly area: KeyValueArea) {}

  private async load(): Promise<Snapshot> {
    if (this.cache) return this.cache
    const stored = (await this.area.get(KEY))[KEY] as Partial<Snapshot> | undefined
    this.cache = { ...EMPTY(), ...stored }
    return this.cache
  }

  /** Runs `fn` against the state exclusively, then persists it. */
  update<T>(fn: (state: Snapshot) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.load()
      const result = fn(state)
      await this.area.set({ [KEY]: state })
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  read<T>(fn: (state: Snapshot) => T): Promise<T> {
    const run = this.queue.then(async () => fn(await this.load()))
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** Long-lived settings (survive browser restarts). */
export interface SettingsArea extends KeyValueArea {}

export const loadBrowserId = async (area: SettingsArea): Promise<string> => {
  const stored = (await area.get('browserId')).browserId
  if (typeof stored === 'string' && stored) return stored
  const id = newId()
  await area.set({ browserId: id })
  return id
}

export const loadProfile = async (area: SettingsArea): Promise<string> => {
  const stored = (await area.get('profile')).profile
  return typeof stored === 'string' ? stored : ''
}

export const saveProfile = (area: SettingsArea, profile: string): Promise<void> =>
  area.set({ profile: profile.trim().slice(0, 100) })

/** The outbox holds serialized hub messages that could not be sent while disconnected. */
export interface OutboxStore {
  load(): Promise<string[]>
  save(items: string[]): Promise<void>
}

export const makeOutboxStore = (area: KeyValueArea): OutboxStore => ({
  async load() {
    const stored = (await area.get('codegent-outbox'))['codegent-outbox']
    return Array.isArray(stored)
      ? stored.filter((x): x is string => typeof x === 'string')
      : []
  },
  save: (items) => area.set({ 'codegent-outbox': items })
})
