import type { JobEvent, JobRequest } from '@codegent/protocol'

/** Service worker → content script (via `tabs.sendMessage`). */
export type ToContent =
  | { type: 'run-job'; job: JobRequest }
  | { type: 'cancel-job'; jobId: string }
  | { type: 'tick' }
  | { type: 'self-test'; probeFill: boolean }

export type RunJobReply = { accepted: true } | { accepted: false; reason: string }

/** Content script → service worker (via `runtime.sendMessage`). */
export type FromContent =
  | { type: 'content-ready'; url: string }
  /** Wakes a terminated service worker so it can re-establish the hub connection. */
  | { type: 'content-ping' }
  | { type: 'job-event'; editorId: string; jobId: string; seq: number; event: JobEvent }

export type ContentReadyReply = { job: JobRequest | null }

/** Popup → service worker. */
export type FromPopup =
  | { type: 'popup:status' }
  | { type: 'popup:reconnect' }
  | { type: 'popup:set-profile'; profile: string }
  | { type: 'popup:self-test'; probeFill: boolean }

export interface SelfTestCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestReport {
  url: string
  at: string
  ok: boolean
  checks: SelfTestCheck[]
}

export interface PopupStatus {
  connected: boolean
  hubPort: number | null
  browserId: string
  profile: string
  extensionVersion: string
  chatgptTabs: number
  activeJobs: number
  lastError: string | null
  lastEventAt: number | null
}
