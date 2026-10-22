import { newId } from '@codegent/protocol'
import {
  parseReply,
  planChanges,
  type EditOutcome,
  type FileChange,
  type ParsedReply,
  type ParseProblem
} from '../edits'
import { GitError } from '../git'
import {
  buildFollowUpPrompt,
  buildInitialPrompt,
  buildNoChangesPrompt,
  buildTruncatedPrompt,
  type DiagnosticsSummary,
  type PublishResult,
  type RepoContext,
  type StepReport,
  type VerifyResult
} from '../prompt'
import { buildCommitMessage } from './commit-message'
import {
  ChatError,
  type AgentDeps,
  type ChatReply,
  type ChatStage,
  type FinishKind,
  type MessageKind,
  type PauseKind,
  type Phase,
  type RunListener,
  type RunSettings,
  type RunSnapshot,
  type StepRecord
} from './types'

/** Control-flow signals; they never escape the run. */
class StopSignal extends Error {}
class PauseSignal extends Error {
  constructor(
    readonly reason: PauseKind,
    message: string
  ) {
    super(message)
  }
}
class FinishSignal extends Error {
  constructor(
    readonly outcome: FinishKind,
    message: string
  ) {
    super(message)
  }
}

interface PendingMessage {
  text: string
  kind: MessageKind
}

/** Work on a step whose reply has been read but whose result has not yet been reported back. */
interface StepWork {
  record: StepRecord
  parsed: ParsedReply
  changes: FileChange[]
  outcomes: EditOutcome[]
  diagnostics?: DiagnosticsSummary
  verify?: VerifyResult
  commit?: { sha: string; shortSha: string; message: string }
}

/**
 * ChatGPT sometimes closes with `done` and a recap that names the files it changed as headings,
 * without any content under them. With nothing to apply that is a summary, not an edit that went
 * missing, so it must not be reported back as a failure (which would cost another round trip).
 */
const withoutRecapProblems = (parsed: ParsedReply): ParsedReply => {
  const recap = parsed.problems.length
  if (
    parsed.status !== 'done' ||
    parsed.edits.length > 0 ||
    recap === 0 ||
    !parsed.problems.every((problem) => problem.kind === 'heading-without-block')
  )
    return parsed
  return {
    ...parsed,
    problems: [],
    warnings: [
      ...parsed.warnings,
      `ChatGPT listed ${recap} file${recap === 1 ? '' : 's'} without any content, as a recap; ignored because it reported the task as done`
    ]
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** SEARCH text that does not match its file: the failure a complete file avoids altogether. */
const WHOLE_FILE_CODES: ReadonlySet<string> = new Set([
  'not-found',
  'ambiguous',
  'empty-search'
])
/** Tangled SEARCH/REPLACE markers, which a complete file avoids as well. */
const WHOLE_FILE_KINDS: ReadonlySet<string | undefined> = new Set([
  'unclosed-markers',
  'malformed-markers',
  'stray-text',
  'empty-block'
])
/** Problems where the content of a file never reached CodeGent. */
const SHAPE_KINDS: ReadonlySet<string | undefined> = new Set([
  'heading-without-block',
  'unfenced-markers',
  'orphan-block',
  'cut-off'
])
/** A complete file is only asked for when it is small enough to be written out reliably. */
const WHOLE_FILE_MAX_CHARS = 24_000
/** Replies in a row that may fail for one file (or in one way) before the run gives up on it. */
const MAX_ATTEMPTS = 3

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const explainChatError = (error: ChatError): string => {
  switch (error.code) {
    case 'no-browser':
      return 'No browser is connected. Open Chrome or Edge with the CodeGent Bridge extension enabled (it connects by itself), then press Resume.'
    case 'ambiguous-browser':
      return 'More than one browser is connected. Close the extra one or choose which browser to use, then press Resume.'
    case 'login-required':
      return `${error.message} Sign in in the ChatGPT tab, then press Resume.`
    case 'rate-limited':
      return `ChatGPT is limiting your messages (${error.message}). Wait until the limit resets, then press Resume.`
    case 'timeout':
      return `${error.message} Check the ChatGPT tab (an approval prompt may be waiting for you), then press Resume.`
    case 'bridge':
      return `${error.message} Press Resume to try again.`
    default:
      return `${error.message} Check the ChatGPT tab, then press Resume.`
  }
}

const changedPaths = (changes: readonly FileChange[]): string[] => {
  const paths = new Set<string>()
  for (const change of changes) {
    if (change.kind === 'rename') {
      paths.add(change.from)
      paths.add(change.to)
    } else paths.add(change.path)
  }
  return [...paths]
}

/** Files that exist before the change and are about to be modified, deleted or moved. */
const existingPaths = (changes: readonly FileChange[]): string[] =>
  changes.flatMap((change) =>
    change.kind === 'create'
      ? []
      : change.kind === 'rename'
        ? [change.from]
        : [change.path]
  )

/** Paths that still exist after the change (the ones worth asking the language server about). */
const livePaths = (changes: readonly FileChange[]): string[] =>
  changes.flatMap((change) =>
    change.kind === 'delete' ? [] : change.kind === 'rename' ? [change.to] : [change.path]
  )

/**
 * One task, from the first prompt to "done". The run owns the conversation with ChatGPT; every
 * interaction with the outside world (the chat, the files, git, checks, the user) goes through
 * the injected ports so each transition can be tested in isolation.
 */
export class AgentRun {
  readonly id: string
  readonly sessionId: string

  private snap: RunSnapshot
  private readonly listeners = new Set<RunListener>()
  private controller = new AbortController()
  private pending: PendingMessage | null = null
  private work: StepWork | null = null
  private conversationStarted = false
  private failedStepsInARow = 0
  /** Consecutive replies in which a file could not be applied; '' stands for no particular file. */
  private readonly failureStreaks = new Map<string, number>()
  /** Consecutive replies whose file contents did not reach CodeGent at all. */
  private shapeFailureStreak = 0
  private formatRetriesLeft: number
  private running = false
  private repo: RepoContext | undefined

  constructor(
    private readonly deps: AgentDeps,
    private readonly settings: RunSettings,
    readonly task: string
  ) {
    this.id = (deps.newId ?? newId)()
    this.sessionId = (deps.newId ?? newId)()
    this.formatRetriesLeft = settings.formatRetries
    this.snap = { id: this.id, task, state: { kind: 'idle' }, steps: [] }
  }

  // ── public surface ───────────────────────────────────────────────────────────────────────────
  snapshot(): RunSnapshot {
    return { ...this.snap, steps: [...this.snap.steps] }
  }

  onChange(listener: RunListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Runs until the task finishes or the run needs the user; resolves with the final snapshot. */
  async start(): Promise<RunSnapshot> {
    if (this.snap.state.kind !== 'idle')
      throw new Error('This run has already been started.')
    this.snap.startedAt = this.now()
    return this.drive(async () => {
      this.setPhase('preparing', 0, 'Reading the repository')
      this.repo = await this.deps.git.context()
      this.snap.repo = this.repo
      this.pending = {
        text: buildInitialPrompt({
          repo: this.repo,
          task: this.task,
          conventions: this.settings.conventions
        }),
        kind: 'initial'
      }
    })
  }

  /** Continues after a pause (user action needed, or "continue" mode between steps). */
  async resume(): Promise<RunSnapshot> {
    if (this.snap.state.kind !== 'paused' || this.running) {
      throw new Error('Only a paused run can be resumed.')
    }
    this.controller = new AbortController()
    return this.drive()
  }

  /** Aborts whatever is in flight and ends the run. */
  stop(): void {
    this.controller.abort()
    if (!this.running && this.snap.state.kind === 'paused') {
      this.finish('stopped', 'Stopped by the user.')
    }
  }

  // ── driver ───────────────────────────────────────────────────────────────────────────────────
  private async drive(prepare?: () => Promise<void>): Promise<RunSnapshot> {
    this.running = true
    try {
      if (prepare) await prepare()
      for (;;) {
        this.throwIfStopped()
        if (this.work) await this.finishStep(this.work)
        else await this.exchangeAndHandle()
      }
    } catch (error) {
      if (error instanceof PauseSignal) {
        this.setState({
          kind: 'paused',
          reason: error.reason,
          message: error.message,
          step: this.snap.steps.length
        })
      } else if (error instanceof FinishSignal) {
        this.finish(error.outcome, error.message)
      } else if (error instanceof StopSignal) {
        this.finish('stopped', 'Stopped by the user.')
      } else {
        this.finish('error', errorText(error))
      }
    } finally {
      this.running = false
    }
    return this.snapshot()
  }

  /** Sends the pending message, reads the reply, applies it, and prepares the next message. */
  private async exchangeAndHandle(): Promise<void> {
    const message = this.pending
    if (!message)
      throw new FinishSignal('error', 'Internal error: there is nothing to send.')

    const record: StepRecord = {
      step: this.snap.steps.length + 1,
      messageKind: message.kind,
      promptChars: message.text.length,
      startedAt: this.now(),
      outcomes: []
    }
    this.snap.steps.push(record)

    const reply = await this.send(message, record)
    this.pending = null
    this.snap.conversationUrl = reply.conversationUrl

    this.setPhase('reading', record.step)
    const parsed = withoutRecapProblems(parseReply(reply.markdown))
    record.reply = {
      chars: reply.markdown.length,
      status: parsed.status,
      summary: parsed.summary.slice(0, 4_000),
      durationMs: reply.durationMs,
      editCount: parsed.edits.length,
      problems: parsed.problems.map((problem) =>
        problem.path ? `“${problem.path}”: ${problem.message}` : problem.message
      ),
      warnings: parsed.warnings,
      truncated: parsed.truncated
    }
    this.emit()

    if (parsed.edits.length === 0 && parsed.problems.length === 0) {
      record.finishedAt = this.now()
      this.afterReplyWithoutChanges(parsed, record)
      return
    }
    this.work = await this.applyAndCheck(parsed, record)
  }

  private async send(message: PendingMessage, record: StepRecord): Promise<ChatReply> {
    this.setPhase('sending', record.step)
    let reply: ChatReply
    try {
      reply = await this.deps.chat.send({
        sessionId: this.sessionId,
        text: message.text,
        newChat: !this.conversationStarted,
        signal: this.controller.signal,
        onProgress: (stage) => this.onChatStage(stage, record.step)
      })
    } catch (error) {
      this.snap.steps.pop() // this step never produced a reply; the message stays pending
      if (
        this.controller.signal.aborted ||
        (error instanceof ChatError && error.code === 'cancelled')
      ) {
        throw new StopSignal()
      }
      if (error instanceof ChatError) {
        if (error.code === 'tab-unavailable' && this.conversationStarted) {
          throw new FinishSignal(
            'error',
            `${error.message} The ChatGPT conversation is gone, so this run cannot continue. Start a new run.`
          )
        }
        throw new PauseSignal('needs-attention', explainChatError(error))
      }
      throw new FinishSignal('error', errorText(error))
    }
    // A port is not obliged to honour the abort signal: a reply that arrives after Stop is dropped.
    if (this.controller.signal.aborted) {
      this.snap.steps.pop()
      throw new StopSignal()
    }
    this.conversationStarted = true
    return reply
  }

  private onChatStage(stage: ChatStage, step: number): void {
    const phase: Phase =
      stage === 'waiting-for-browser'
        ? 'waiting-for-browser'
        : stage === 'generating'
          ? 'waiting-for-reply'
          : 'sending'
    const detail =
      stage === 'tab-ready'
        ? 'ChatGPT is ready'
        : stage === 'filled'
          ? 'Prompt typed in'
          : stage === 'submitted'
            ? 'Prompt sent'
            : stage === 'generating'
              ? 'ChatGPT is answering'
              : 'Waiting for the browser'
    this.setPhase(phase, step, detail)
  }

  /** A reply with nothing to apply: finish, nudge once, or give up. */
  private afterReplyWithoutChanges(parsed: ParsedReply, record: StepRecord): void {
    if (parsed.status === 'done')
      throw new FinishSignal(
        'done',
        parsed.summary || 'ChatGPT reports the task is complete.'
      )
    if (parsed.status === 'blocked')
      throw new FinishSignal('blocked', parsed.summary || 'ChatGPT cannot continue.')
    this.throwIfOutOfSteps()
    if (this.formatRetriesLeft > 0) {
      this.formatRetriesLeft -= 1
      this.pending = { text: buildNoChangesPrompt(), kind: 'format-reminder' }
      record.finishedAt = this.now()
      this.emit()
      return
    }
    throw new FinishSignal(
      'no-changes',
      'ChatGPT replied without any file changes in the required format.'
    )
  }

  // ── applying ─────────────────────────────────────────────────────────────────────────────────
  private async applyAndCheck(
    parsed: ParsedReply,
    record: StepRecord
  ): Promise<StepWork> {
    this.setPhase('reading', record.step, 'Checking the changes against your files')
    const changeSet = await planChanges(parsed.edits, this.deps.workspace.view, {
      workspaceRoot: this.settings.workspaceRoot,
      allowDirty: this.settings.allowDirty
    })
    let { outcomes, changes } = changeSet

    if (!this.settings.autoApply && changes.length > 0) {
      const approval = this.deps.approval
      if (!approval)
        throw new FinishSignal(
          'error',
          'Review is turned on but nothing is available to ask you.'
        )
      this.setPhase('awaiting-approval', record.step)
      const decision = await approval.review({
        step: record.step,
        changeSet,
        summary: parsed.summary
      })
      record.decision = decision
      this.throwIfStopped()
      if (decision === 'stop') throw new StopSignal()
      if (decision === 'skip') {
        outcomes = outcomes.map((outcome) =>
          outcome.status === 'applied'
            ? {
                ...outcome,
                status: 'failed' as const,
                detail: 'not applied (declined by the user)',
                errors: [
                  {
                    code: 'conflict' as const,
                    message: 'The user chose not to apply this change.'
                  }
                ]
              }
            : outcome
        )
        changes = []
      }
    }

    if (changes.length > 0) {
      this.throwIfStopped()
      await this.deps.checks.prepare?.(existingPaths(changes), this.controller.signal)
      this.throwIfStopped()
      this.setPhase('applying', record.step)
      try {
        record.receipt = await this.deps.workspace.apply(changes, {
          runId: this.id,
          step: record.step
        })
      } catch (error) {
        throw new FinishSignal(
          'error',
          `The changes could not be written: ${errorText(error)}`
        )
      }
    }
    record.outcomes = outcomes
    this.emit()

    const work: StepWork = { record, parsed, changes, outcomes }
    if (changes.length > 0) {
      this.throwIfStopped()
      this.setPhase('checking', record.step)
      work.diagnostics = await this.deps.checks.diagnostics(
        livePaths(changes),
        this.controller.signal
      )
      this.throwIfStopped()
      work.verify = await this.deps.checks.verify(this.controller.signal)
      record.diagnostics = work.diagnostics
      record.verify = work.verify
      this.emit()
    }
    return work
  }

  // ── reporting back ───────────────────────────────────────────────────────────────────────────
  /** Publishes the step (commit/push) and decides what happens next. Resumable at the publish. */
  private async finishStep(work: StepWork): Promise<void> {
    const { record, parsed, outcomes } = work
    const publish = await this.publish(work)
    record.publish = publish
    this.work = null
    record.finishedAt = this.now()
    this.emit()

    const failures =
      outcomes.filter((outcome) => outcome.status === 'failed').length +
      parsed.problems.length
    const checksFailed =
      (work.diagnostics?.errors ?? 0) > 0 ||
      (work.verify !== undefined && work.verify.exitCode !== 0)
    this.failedStepsInARow = failures > 0 ? this.failedStepsInARow + 1 : 0
    const attempt = await this.trackFailures(outcomes, parsed.problems)

    if (parsed.status === 'blocked')
      throw new FinishSignal('blocked', parsed.summary || 'ChatGPT cannot continue.')
    if (parsed.status === 'done' && failures === 0 && !checksFailed) {
      throw new FinishSignal('done', parsed.summary || 'The task is complete.')
    }
    if (attempt.exhausted) throw new FinishSignal('stuck', attempt.exhausted)
    if (this.failedStepsInARow >= this.settings.maxFailedSteps) {
      throw new FinishSignal(
        'stuck',
        `${this.failedStepsInARow} steps in a row had changes that could not be applied.${attempt.reason ? ` Last problem: ${attempt.reason}` : ''}`
      )
    }
    this.throwIfOutOfSteps()

    const report: StepReport = {
      step: record.step,
      repo: this.repo!,
      outcomes,
      problems: record.reply?.problems,
      problemDetails: parsed.problems,
      wholeFile: attempt.wholeFile,
      oneFileOnly: attempt.oneFileOnly,
      diagnostics: work.diagnostics,
      verify: work.verify,
      publish
    }
    const text = parsed.truncated
      ? `${buildFollowUpPrompt(report)}\n\n${buildTruncatedPrompt(outcomes.filter((o) => o.status === 'applied').map((o) => o.path))}`
      : buildFollowUpPrompt(report)
    this.pending = { text, kind: parsed.truncated ? 'cut-off-reminder' : 'follow-up' }

    if (!this.settings.autoContinue) {
      throw new PauseSignal(
        'awaiting-continue',
        `Step ${record.step} is done. Press Continue to send the result to ChatGPT.`
      )
    }
  }

  private async publish(work: StepWork): Promise<PublishResult> {
    if (work.changes.length === 0)
      return { state: 'skipped', reason: 'no file was changed' }
    if (!this.settings.commit)
      return { state: 'skipped', reason: 'committing is turned off in the settings' }

    this.setPhase('publishing', work.record.step)
    if (!work.commit) {
      const message = buildCommitMessage({
        prefix: this.settings.commitPrefix,
        task: this.task,
        summary: work.parsed.summary,
        step: work.record.step
      })
      try {
        const committed = await this.deps.git.commit(changedPaths(work.changes), message)
        if (!committed.committed || !committed.sha) {
          return { state: 'skipped', reason: 'git found nothing to commit' }
        }
        work.commit = {
          sha: committed.sha,
          shortSha: committed.shortSha ?? committed.sha.slice(0, 7),
          message: message.split('\n')[0]!
        }
        this.repo = {
          ...this.repo!,
          sha: committed.sha,
          shortSha: work.commit.shortSha,
          subject: work.commit.message
        }
      } catch (error) {
        this.work = work
        throw new PauseSignal(
          'needs-attention',
          `Git could not commit the changes: ${errorText(error)} Fix it, then press Resume.`
        )
      }
    }

    const { sha, shortSha, message } = work.commit
    if (!this.settings.push) {
      return {
        state: 'committed',
        sha,
        shortSha,
        message,
        reason: 'pushing is turned off in the settings'
      }
    }
    try {
      const pushed = await this.deps.git.push()
      return {
        state: 'pushed',
        sha,
        shortSha,
        message,
        branch: pushed.branch,
        remote: pushed.remote
      }
    } catch (error) {
      this.work = work
      const hint =
        error instanceof GitError && error.kind === 'non-fast-forward'
          ? 'GitHub has commits you do not have locally. Pull them (CodeGent never merges for you), then press Resume.'
          : error instanceof GitError && error.kind === 'auth'
            ? 'Git is not signed in to GitHub. Push once from a terminal or sign in, then press Resume.'
            : error instanceof GitError && error.kind === 'protected-branch'
              ? 'The branch is protected on GitHub. Switch to another branch, then press Resume.'
              : 'Fix the problem, then press Resume.'
      throw new PauseSignal(
        'needs-attention',
        `The push to GitHub failed — ${errorText(error).split('\n')[0]}. ${hint}`
      )
    }
  }

  /**
   * Remembers which files keep failing, and how, so that every repeat is asked for differently — a
   * complete file instead of SEARCH/REPLACE, one file at a time instead of all of them — and the
   * run stops instead of asking a third time in the same way. A reply that fails is never answered
   * with the same request twice.
   */
  private async trackFailures(
    outcomes: readonly EditOutcome[],
    problems: readonly ParseProblem[]
  ): Promise<{
    wholeFile: string[]
    oneFileOnly: boolean
    exhausted?: string
    reason?: string
  }> {
    const failedNow = new Map<string, { shape: boolean; replaceable: boolean }>()
    const note = (path: string, shape: boolean, replaceable: boolean) => {
      const known = failedNow.get(path)
      failedNow.set(path, {
        shape: (known?.shape ?? false) || shape,
        replaceable: (known?.replaceable ?? false) || replaceable
      })
    }
    for (const outcome of outcomes) {
      if (outcome.status === 'failed') {
        note(
          outcome.path,
          false,
          outcome.errors.some((error) => WHOLE_FILE_CODES.has(error.code))
        )
      } else this.failureStreaks.delete(outcome.path)
    }
    for (const problem of problems) {
      note(
        problem.path ?? '',
        SHAPE_KINDS.has(problem.kind),
        WHOLE_FILE_KINDS.has(problem.kind)
      )
    }

    if (failedNow.size === 0) {
      this.failureStreaks.clear()
      this.shapeFailureStreak = 0
      return { wholeFile: [], oneFileOnly: false }
    }
    for (const path of failedNow.keys())
      this.failureStreaks.set(path, (this.failureStreaks.get(path) ?? 0) + 1)
    const shapeFailed = [...failedNow.values()].some((how) => how.shape)
    this.shapeFailureStreak = shapeFailed ? this.shapeFailureStreak + 1 : 0

    const firstFailure = outcomes.find((outcome) => outcome.status === 'failed')
    const reason = clip(
      (firstFailure?.detail ?? problems[0]?.message ?? '').replace(/\s+/g, ' ').trim(),
      200
    )
    const stuckOn = [...failedNow.keys()].find(
      (path) => (this.failureStreaks.get(path) ?? 0) >= MAX_ATTEMPTS
    )
    const stop = (what: string) =>
      `${what} in ${MAX_ATTEMPTS} replies in a row, so the run stopped instead of asking again. Last problem: ${reason}`
    const exhausted =
      this.shapeFailureStreak >= MAX_ATTEMPTS
        ? stop(
            "ChatGPT's file contents could not be read (they did not arrive inside code blocks)"
          )
        : stuckOn === undefined
          ? undefined
          : stuckOn === ''
            ? stop("ChatGPT's replies could not be used")
            : stop(`ChatGPT could not get \`${stuckOn}\` applied`)

    const wholeFile: string[] = []
    for (const [path, how] of failedNow) {
      if (path === '' || how.shape || !how.replaceable) continue
      if ((this.failureStreaks.get(path) ?? 0) < 2) continue
      const text = await this.deps.workspace.view.read(path).catch(() => null)
      if (text !== null && text.length <= WHOLE_FILE_MAX_CHARS) wholeFile.push(path)
    }
    return {
      wholeFile,
      oneFileOnly: this.shapeFailureStreak >= 2,
      exhausted,
      reason
    }
  }

  // ── plumbing ─────────────────────────────────────────────────────────────────────────────────
  private throwIfStopped(): void {
    if (this.controller.signal.aborted) throw new StopSignal()
  }

  private throwIfOutOfSteps(): void {
    if (this.snap.steps.length >= this.settings.maxSteps) {
      throw new FinishSignal(
        'step-limit',
        `Stopped after ${this.settings.maxSteps} steps (the limit in the settings).`
      )
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private setPhase(phase: Phase, step: number, detail?: string): void {
    this.setState({ kind: 'running', phase, step, detail })
  }

  private setState(state: RunSnapshot['state']): void {
    this.snap = { ...this.snap, state }
    this.emit()
  }

  private finish(outcome: FinishKind, message: string): void {
    const last = this.snap.steps.at(-1)
    if (last && last.finishedAt === undefined) last.finishedAt = this.now()
    this.setState({ kind: 'finished', outcome, message })
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
