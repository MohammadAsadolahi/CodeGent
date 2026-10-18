/**
 * The contract between the extension and its sidebar webview. Plain data only (no runtime imports),
 * so it is shared verbatim by both sides.
 */

export type NoticeKind = 'info' | 'warning' | 'error'

export interface UiNotice {
  kind: NoticeKind
  text: string
}

export interface UiBrowser {
  id: string
  label: string
  chatgptTabs: number
}

export interface UiConnection {
  hub: 'connected' | 'connecting' | 'offline'
  browsers: UiBrowser[]
  chatgptTabs: number
  selectedBrowserId?: string
  /** What is wrong and how to fix it, when something is. */
  hint?: string
}

export type UiRepo =
  | {
      ok: true
      fullName: string
      webUrl: string
      branch: string
      shortSha: string
      subject: string
      ahead: number
      behind: number
      hasUpstream: boolean
      dirtyCount: number
      dirtyFiles: string[]
      warnings: string[]
    }
  | { ok: false; problem: string; reason: string }

export interface UiToggles {
  autoApply: boolean
  autoContinue: boolean
  commit: boolean
  push: boolean
  autoSubmit: boolean
}

export type ToggleKey = keyof UiToggles

export type UiEditKind = 'created' | 'updated' | 'replaced' | 'deleted' | 'renamed'

export interface UiEdit {
  path: string
  fromPath?: string
  kind: UiEditKind
  status: 'applied' | 'skipped' | 'failed'
  detail: string
  notes: string[]
  errors: string[]
}

export interface UiDiagnostic {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning'
  message: string
}

export interface UiStep {
  n: number
  kind: 'initial' | 'follow-up' | 'format-reminder' | 'cut-off-reminder'
  /** ChatGPT's own words about what it did in this step. */
  summary: string
  replyStatus: 'continue' | 'done' | 'blocked' | null
  durationSeconds?: number
  working: boolean
  edits: UiEdit[]
  problems: string[]
  warnings: string[]
  diagnostics?: { errors: number; warnings: number; items: UiDiagnostic[] }
  verify?: { command: string; outcome: 'passed' | 'failed' | 'timed-out' | 'could-not-run'; exitCode: number | null }
  publish?: { state: 'pushed' | 'committed' | 'skipped'; label: string; shortSha?: string }
  decision?: 'apply' | 'skip' | 'stop'
  canUndo: boolean
  undone: boolean
}

export type UiFinishKind = 'done' | 'blocked' | 'stopped' | 'step-limit' | 'stuck' | 'no-changes' | 'error'

export interface UiRun {
  id: string
  task: string
  startedAt: number
  state: 'running' | 'paused' | 'finished'
  /** Short label of what is happening now ("Waiting for ChatGPT"). */
  phase?: string
  detail?: string
  pauseReason?: 'needs-attention' | 'awaiting-continue'
  outcome?: UiFinishKind
  message?: string
  steps: UiStep[]
  conversationUrl?: string
  canStop: boolean
  canResume: boolean
  resumeLabel: 'Resume' | 'Continue'
}

export interface UiReviewFile {
  path: string
  fromPath?: string
  kind: 'create' | 'modify' | 'delete' | 'rename'
  added: number
  removed: number
}

export interface UiReview {
  step: number
  summary: string
  files: UiReviewFile[]
}

export interface UiHistoryItem {
  id: string
  task: string
  startedAt: number
  outcome: UiFinishKind | 'interrupted'
  message: string
  steps: number
  repo: string
}

export interface UiState {
  version: string
  connection: UiConnection
  repo: UiRepo
  toggles: UiToggles
  run: UiRun | null
  review: UiReview | null
  history: UiHistoryItem[]
  /** A run is being started (checks are running). */
  busy: boolean
  notice: UiNotice | null
  setup: { browserExtensionPath?: string }
}

export type ToWebview = { type: 'state'; state: UiState }

export type ToExtension =
  | { type: 'ready' }
  | { type: 'start'; task: string }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'decide'; decision: 'apply' | 'skip' | 'stop' }
  | { type: 'undo'; step: number }
  | { type: 'dismissRun' }
  | { type: 'setToggle'; key: ToggleKey; value: boolean }
  | { type: 'refreshRepo' }
  | { type: 'pushNow' }
  | { type: 'openDiff'; path: string; step?: number }
  | { type: 'openFile'; path: string }
  | { type: 'openUrl'; url: string }
  | { type: 'openBrowserExtensionFolder' }
  | { type: 'copyBrowserExtensionPath' }
  | { type: 'restartHub' }
  | { type: 'chooseBrowser' }
  | { type: 'showLog' }
  | { type: 'clearHistory' }
  | { type: 'dismissNotice' }
