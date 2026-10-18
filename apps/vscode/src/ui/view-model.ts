import type {
  EditOutcome,
  FileChange,
  FinishKind,
  RunSnapshot,
  RunState,
  StepRecord
} from '@codegent/engine'
import type { BrowserInfo } from '@codegent/protocol'
import type { ConnectionState } from '../bridge/hub-connection'
import type { RepoStatus } from '../workspace/repo-service'
import type {
  UiConnection,
  UiEdit,
  UiRepo,
  UiReview,
  UiReviewFile,
  UiRun,
  UiStep
} from './protocol'

// ── run phases in plain language ───────────────────────────────────────────────────────────────
export const describeState = (state: RunState): { phase?: string; detail?: string } => {
  if (state.kind !== 'running') return {}
  switch (state.phase) {
    case 'preparing':
      return { phase: 'Preparing', detail: state.detail }
    case 'waiting-for-browser':
      return { phase: 'Waiting for the browser', detail: 'Open Chrome or Edge with the CodeGent Bridge extension' }
    case 'sending':
      return { phase: 'Sending to ChatGPT', detail: state.detail }
    case 'waiting-for-reply':
      return { phase: 'ChatGPT is working', detail: state.detail ?? 'Reading your repository and writing changes' }
    case 'reading':
      return { phase: 'Reading the reply', detail: state.detail }
    case 'awaiting-approval':
      return { phase: 'Waiting for your review' }
    case 'applying':
      return { phase: 'Applying changes' }
    case 'checking':
      return { phase: 'Checking the result', detail: 'Language-server diagnostics and your verify command' }
    case 'publishing':
      return { phase: 'Committing and pushing' }
  }
}

export const outcomeTitle: Record<FinishKind, string> = {
  done: 'Finished',
  blocked: 'ChatGPT is blocked',
  stopped: 'Stopped',
  'step-limit': 'Step limit reached',
  stuck: 'Stuck',
  'no-changes': 'No changes received',
  error: 'Stopped by an error'
}

// ── steps ──────────────────────────────────────────────────────────────────────────────────────
const editKind = (outcome: EditOutcome): UiEdit['kind'] => {
  switch (outcome.edit.kind) {
    case 'create':
      return 'created'
    case 'delete':
      return 'deleted'
    case 'rename':
      return 'renamed'
    case 'replace':
      return 'replaced'
    default:
      return 'updated'
  }
}

const toUiEdit = (outcome: EditOutcome): UiEdit => ({
  path: outcome.path,
  fromPath: outcome.edit.kind === 'rename' ? outcome.edit.from : undefined,
  kind: editKind(outcome),
  status: outcome.status,
  detail: outcome.detail,
  notes: outcome.notes,
  errors: outcome.errors.map((error) => error.message)
})

export interface StepContext {
  /** Whether this is the newest applied step and its checkpoint is still available. */
  canUndo: boolean
  undone: boolean
  /** The step has been sent but its reply is not processed yet. */
  working: boolean
}

export const toUiStep = (record: StepRecord, context: StepContext): UiStep => {
  const { verify, publish, diagnostics } = record
  return {
    n: record.step,
    kind: record.messageKind,
    summary: record.reply?.summary ?? '',
    replyStatus: record.reply?.status ?? null,
    durationSeconds: record.reply ? Math.round(record.reply.durationMs / 1000) : undefined,
    working: context.working,
    edits: record.outcomes.map(toUiEdit),
    problems: record.reply?.problems ?? [],
    warnings: record.reply?.warnings ?? [],
    diagnostics: diagnostics
      ? {
          errors: diagnostics.errors,
          warnings: diagnostics.warnings,
          items: diagnostics.items.slice(0, 8).map(({ path, line, column, severity, message }) => ({ path, line, column, severity, message: message.slice(0, 300) }))
        }
      : undefined,
    verify: verify
      ? {
          command: verify.command,
          exitCode: verify.exitCode,
          outcome: verify.timedOut ? 'timed-out' : verify.exitCode === null ? 'could-not-run' : verify.exitCode === 0 ? 'passed' : 'failed'
        }
      : undefined,
    publish: publish
      ? publish.state === 'pushed'
        ? { state: 'pushed', label: `Pushed ${publish.shortSha} to ${publish.remote}/${publish.branch}`, shortSha: publish.shortSha }
        : publish.state === 'committed'
          ? { state: 'committed', label: `Committed ${publish.shortSha} (${publish.reason})`, shortSha: publish.shortSha }
          : { state: 'skipped', label: `Not committed (${publish.reason})` }
      : undefined,
    decision: record.decision,
    canUndo: context.canUndo,
    undone: context.undone
  }
}

export interface RunContext {
  isUndone: (receiptId: string) => boolean
  hasCheckpoint: (receiptId: string) => boolean
}

export const toUiRun = (snapshot: RunSnapshot, context: RunContext): UiRun => {
  const { state } = snapshot
  const lastApplied = [...snapshot.steps].reverse().find((s) => s.receipt && !context.isUndone(s.receipt.id))
  const steps = snapshot.steps.map((record, index) => {
    const isLast = index === snapshot.steps.length - 1
    return toUiStep(record, {
      canUndo: record === lastApplied && !!record.receipt && context.hasCheckpoint(record.receipt.id) && state.kind !== 'running',
      undone: !!record.receipt && context.isUndone(record.receipt.id),
      working: state.kind === 'running' && isLast && record.finishedAt === undefined
    })
  })
  const { phase, detail } = describeState(state)
  return {
    id: snapshot.id,
    task: snapshot.task,
    startedAt: snapshot.startedAt ?? 0,
    state: state.kind === 'paused' ? 'paused' : state.kind === 'finished' ? 'finished' : 'running',
    phase,
    detail,
    pauseReason: state.kind === 'paused' ? state.reason : undefined,
    outcome: state.kind === 'finished' ? state.outcome : undefined,
    message: state.kind === 'paused' || state.kind === 'finished' ? state.message : undefined,
    steps,
    conversationUrl: snapshot.conversationUrl,
    canStop: state.kind === 'running' || state.kind === 'paused',
    canResume: state.kind === 'paused',
    resumeLabel: state.kind === 'paused' && state.reason === 'awaiting-continue' ? 'Continue' : 'Resume'
  }
}

// ── repository & connection ───────────────────────────────────────────────────────────────────
export const toUiRepo = (status: RepoStatus): UiRepo =>
  status.ok
    ? {
        ok: true,
        fullName: `${status.owner}/${status.name}`,
        webUrl: status.webUrl,
        branch: status.branch,
        shortSha: status.shortSha,
        subject: status.subject,
        ahead: status.upstream?.ahead ?? 0,
        behind: status.upstream?.behind ?? 0,
        hasUpstream: status.upstream !== null,
        dirtyCount: status.dirtyCount,
        dirtyFiles: status.dirtyFiles,
        warnings: status.warnings
      }
    : { ok: false, problem: status.problem, reason: status.reason }

export const toUiConnection = (
  hub: ConnectionState,
  browsers: readonly BrowserInfo[],
  selectedBrowserId: string | undefined,
  lastError: string | null
): UiConnection => {
  const chatgptTabs = browsers.reduce((sum, browser) => sum + browser.chatgptTabs, 0)
  let hint: string | undefined
  if (hub === 'offline') hint = lastError ? `The local hub is not running (${lastError}).` : 'The local hub is not running.'
  else if (hub === 'connecting') hint = 'Connecting to the local hub…'
  else if (browsers.length === 0) hint = 'No browser is connected. Install the CodeGent Bridge extension (see Setup) and keep the browser open.'
  else if (chatgptTabs === 0) hint = 'Open chatgpt.com in the browser and sign in.'
  return {
    hub: hub === 'connected' ? 'connected' : hub === 'connecting' ? 'connecting' : 'offline',
    browsers: browsers.map((browser) => ({
      id: browser.id,
      label: browser.profile ? `${browser.name} — ${browser.profile}` : browser.name,
      chatgptTabs: browser.chatgptTabs
    })),
    chatgptTabs,
    selectedBrowserId,
    hint
  }
}

// ── review ─────────────────────────────────────────────────────────────────────────────────────
/** Added/removed line counts between two texts (multiset comparison; good enough for a summary). */
export const lineStats = (before: string, after: string): { added: number; removed: number } => {
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added += 1
  }
  let removed = 0
  for (const left of counts.values()) removed += left
  return { added, removed }
}

export const toUiReview = (step: number, summary: string, changes: readonly FileChange[]): UiReview => ({
  step,
  summary: summary.slice(0, 2_000),
  files: changes.map((change): UiReviewFile => {
    switch (change.kind) {
      case 'create':
        return { path: change.path, kind: 'create', ...lineStats('', change.after) }
      case 'delete':
        return { path: change.path, kind: 'delete', ...lineStats(change.before, '') }
      case 'rename':
        return { path: change.to, fromPath: change.from, kind: 'rename', ...lineStats(change.before, change.after) }
      default:
        return { path: change.path, kind: 'modify', ...lineStats(change.before, change.after) }
    }
  })
})
