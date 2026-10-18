import type { JobFailureCode } from '@codegent/protocol'
import type { ChangeSet, EditOutcome, FileChange, ParsedReply, ReplyStatus, WorkspaceView } from '../edits'
import type {
  DiagnosticsSummary,
  PublishResult,
  RepoContext,
  VerifyResult
} from '../prompt'

// ── ports: everything the loop needs from the outside world ────────────────────────────────────

export type ChatStage = 'waiting-for-browser' | 'tab-ready' | 'filled' | 'submitted' | 'generating'

export interface ChatRequest {
  sessionId: string
  text: string
  /** True for the first message of a conversation. */
  newChat: boolean
  signal: AbortSignal
  onProgress?: (stage: ChatStage) => void
}

export interface ChatReply {
  markdown: string
  conversationUrl: string
  durationMs: number
}

/** A failure to get a reply out of ChatGPT; `code` says what the user (or a retry) can do about it. */
export class ChatError extends Error {
  constructor(
    readonly code: JobFailureCode | 'bridge',
    message: string
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

export interface ChatPort {
  send(request: ChatRequest): Promise<ChatReply>
}

export interface ApplyReceipt {
  /** Opaque id the workspace can use to undo this application. */
  id: string
  paths: string[]
}

export interface WorkspacePort {
  view: WorkspaceView
  /** Writes all changes (or none). */
  apply(changes: readonly FileChange[], meta: { runId: string; step: number }): Promise<ApplyReceipt>
}

export interface GitPort {
  /** Identity and head of the repository ChatGPT will read. Rejects if there is no GitHub remote. */
  context(): Promise<RepoContext>
  commit(paths: readonly string[], message: string): Promise<{ committed: boolean; sha?: string; shortSha?: string }>
  push(): Promise<{ branch: string; remote: string }>
}

export interface ChecksPort {
  /**
   * Called just before changes are written, with the existing files about to be modified, so that
   * problems that were already there can be told apart from the ones the change introduces.
   */
  prepare?(existingPaths: readonly string[], signal: AbortSignal): Promise<void>
  diagnostics(paths: readonly string[], signal: AbortSignal): Promise<DiagnosticsSummary>
  /** Runs the user's verify command; undefined when none is configured. */
  verify(signal: AbortSignal): Promise<VerifyResult | undefined>
}

export type ApprovalDecision = 'apply' | 'skip' | 'stop'

export interface ApprovalPort {
  review(input: { step: number; changeSet: ChangeSet; summary: string }): Promise<ApprovalDecision>
}

export interface AgentDeps {
  chat: ChatPort
  workspace: WorkspacePort
  git: GitPort
  checks: ChecksPort
  approval?: ApprovalPort
  /** Injectable for tests. */
  now?: () => number
  newId?: () => string
}

export interface RunSettings {
  maxSteps: number
  /** Stop after this many steps in a row in which something could not be applied. */
  maxFailedSteps: number
  /** Send the follow-up automatically; otherwise pause after each step. */
  autoContinue: boolean
  /** Apply without asking; otherwise every step goes through the approval port. */
  autoApply: boolean
  commit: boolean
  push: boolean
  commitPrefix: string
  conventions?: string
  allowDirty: boolean
  workspaceRoot?: string
  /** How many times to re-ask when a reply has no usable changes. */
  formatRetries: number
}

export const DEFAULT_SETTINGS: RunSettings = {
  maxSteps: 12,
  maxFailedSteps: 3,
  autoContinue: true,
  autoApply: true,
  commit: true,
  push: true,
  commitPrefix: 'codegent: ',
  allowDirty: false,
  formatRetries: 1
}

// ── what the loop reports ───────────────────────────────────────────────────────────────────────

export type Phase =
  | 'preparing'
  | 'waiting-for-browser'
  | 'sending'
  | 'waiting-for-reply'
  | 'reading'
  | 'awaiting-approval'
  | 'applying'
  | 'checking'
  | 'publishing'

export type MessageKind = 'initial' | 'follow-up' | 'format-reminder' | 'cut-off-reminder'

export interface StepRecord {
  /** 1-based; one step per ChatGPT reply that was processed. */
  step: number
  messageKind: MessageKind
  promptChars: number
  startedAt: number
  finishedAt?: number
  reply?: {
    chars: number
    status: ReplyStatus | undefined
    summary: string
    durationMs: number
    editCount: number
    problems: string[]
    warnings: string[]
    truncated: boolean
  }
  outcomes: EditOutcome[]
  diagnostics?: DiagnosticsSummary
  verify?: VerifyResult
  publish?: PublishResult
  receipt?: ApplyReceipt
  /** What the user chose when asked, if they were. */
  decision?: ApprovalDecision
}

export type FinishKind =
  | 'done'
  | 'blocked'
  | 'stopped'
  | 'step-limit'
  | 'stuck'
  | 'no-changes'
  | 'error'

export type PauseKind = 'needs-attention' | 'awaiting-continue'

export type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; phase: Phase; step: number; detail?: string }
  | { kind: 'paused'; reason: PauseKind; message: string; step: number }
  | { kind: 'finished'; outcome: FinishKind; message: string }

export interface RunSnapshot {
  id: string
  task: string
  repo?: RepoContext
  conversationUrl?: string
  state: RunState
  steps: StepRecord[]
  startedAt?: number
}

export type RunListener = (snapshot: RunSnapshot) => void

/** What `parseReply` produced plus what the loop derived from it (kept for the UI). */
export type ParsedStep = ParsedReply
