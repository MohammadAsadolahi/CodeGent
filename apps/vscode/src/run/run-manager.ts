import {
  AgentRun,
  type AgentDeps,
  type ApprovalDecision,
  type FileChange,
  type RunSettings,
  type RunSnapshot
} from '@codegent/engine'
import type { Settings } from '../settings-model'
import type { UiHistoryItem, UiNotice, UiReview, UiRun } from '../ui/protocol'
import { outcomeTitle, toUiReview, toUiRun } from '../ui/view-model'
import type { UndoResult } from '../workspace/fs-workspace'
import type { RepoOk, RepoStatus } from '../workspace/repo-service'

export interface RunHost {
  readSettings(): Settings
  /** The ports of a run; the approval port is supplied by the manager. */
  createDeps(settings: Settings): Omit<AgentDeps, 'approval'>
  workspace: {
    undo(receiptId: string): Promise<UndoResult>
    isUndone(receiptId: string): boolean
    receiptChanges(receiptId: string): FileChange[] | undefined
  }
  repoStatus(options?: { fetch?: boolean }): Promise<RepoStatus>
  /** First-time question before CodeGent commits and pushes in this repository. */
  confirmPublishing(repo: RepoOk): Promise<'allow' | 'commit-only' | 'cancel'>
  loadHistory(): UiHistoryItem[]
  saveHistory(items: UiHistoryItem[]): void
  notify(notice: UiNotice): void
}

interface PendingReview {
  step: number
  summary: string
  changes: FileChange[]
  resolve: (decision: ApprovalDecision) => void
}

const HISTORY_LIMIT = 30

/**
 * Owns the current agent run: starts it with fresh settings, exposes its state in the shape the
 * panel wants, mediates review decisions, and keeps history. Free of VS Code APIs.
 */
export class RunManager {
  private run: AgentRun | null = null
  private snapshot: RunSnapshot | null = null
  private activeSettings: RunSettings | null = null
  private review: PendingReview | null = null
  private starting = false
  private history: UiHistoryItem[]
  private readonly listeners = new Set<() => void>()
  private repoName = ''

  constructor(private readonly host: RunHost) {
    this.history = host.loadHistory()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get busy(): boolean {
    return this.starting
  }

  get active(): boolean {
    return this.starting || (this.snapshot !== null && this.snapshot.state.kind !== 'finished')
  }

  /** Everything the panel shows about runs. */
  view(): { run: UiRun | null; review: UiReview | null; history: UiHistoryItem[] } {
    return {
      run: this.snapshot
        ? toUiRun(this.snapshot, {
            isUndone: (id) => this.host.workspace.isUndone(id),
            hasCheckpoint: (id) => this.host.workspace.receiptChanges(id) !== undefined
          })
        : null,
      review: this.review ? toUiReview(this.review.step, this.review.summary, this.review.changes) : null,
      history: this.history
    }
  }

  /** The changes of the review in progress, for opening diffs. */
  pendingChanges(): FileChange[] | undefined {
    return this.review?.changes
  }

  /** The changes a step applied, for opening diffs afterwards. */
  stepChanges(step: number): FileChange[] | undefined {
    const receipt = this.snapshot?.steps.find((s) => s.step === step)?.receipt
    return receipt ? this.host.workspace.receiptChanges(receipt.id) : undefined
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────
  async start(task: string): Promise<void> {
    const text = task.trim()
    if (!text) return this.host.notify({ kind: 'warning', text: 'Describe the task first.' })
    if (this.active) return this.host.notify({ kind: 'warning', text: 'A run is already in progress.' })

    this.starting = true
    this.emit()
    let agent: AgentRun
    try {
      const status = await this.host.repoStatus({ fetch: true })
      if (!status.ok) return this.host.notify({ kind: 'error', text: status.reason })
      if (status.upstream && status.upstream.behind > 0) {
        return this.host.notify({
          kind: 'error',
          text: `GitHub has ${status.upstream.behind} commit${status.upstream.behind === 1 ? '' : 's'} that you do not have locally. Pull first — ChatGPT reads GitHub, so its changes would not match your files.`
        })
      }
      const settings = this.host.readSettings()
      let run: RunSettings = { ...settings.run, workspaceRoot: status.root }
      if (run.commit) {
        const decision = await this.host.confirmPublishing(status)
        if (decision === 'cancel') return
        if (decision === 'commit-only') run = { ...run, push: false }
      }
      this.activeSettings = run
      this.repoName = `${status.owner}/${status.name}`
      agent = new AgentRun({ ...this.host.createDeps(settings), approval: { review: (input) => this.askForReview(input) } }, run, text)
      this.run = agent
      this.snapshot = agent.snapshot()
      agent.onChange((snapshot) => {
        this.snapshot = snapshot
        this.emit()
      })
    } catch (error) {
      return this.host.notify({ kind: 'error', text: `Could not start: ${(error as Error).message}` })
    } finally {
      this.starting = false
      this.emit()
    }
    await this.settle(agent.start())
  }

  async resume(): Promise<void> {
    if (!this.run || this.snapshot?.state.kind !== 'paused') return
    await this.settle(this.run.resume())
  }

  stop(): void {
    this.review?.resolve('stop')
    this.review = null
    this.run?.stop()
    this.emit()
  }

  decide(decision: ApprovalDecision): void {
    const review = this.review
    if (!review) return
    this.review = null
    review.resolve(decision)
    this.emit()
  }

  /** Changes the toggles of a run that is already under way (they are read at each step). */
  updateActiveSettings(patch: Partial<Pick<RunSettings, 'autoApply' | 'autoContinue' | 'commit' | 'push'>>): void {
    if (this.activeSettings) Object.assign(this.activeSettings, patch)
  }

  async undoStep(step: number): Promise<void> {
    const receipt = this.snapshot?.steps.find((s) => s.step === step)?.receipt
    if (!receipt) return this.host.notify({ kind: 'warning', text: 'That step has nothing to undo.' })
    const result = await this.host.workspace.undo(receipt.id)
    const skipped = result.skipped.map((s) => (s.path ? `${s.path} (${s.reason})` : s.reason))
    if (result.undone.length > 0 && skipped.length === 0) {
      this.host.notify({
        kind: 'info',
        text: `Step ${step} was undone in your working tree (${result.undone.length} file${result.undone.length === 1 ? '' : 's'}). If it had been committed, the commit is still in git history.`
      })
    } else if (result.undone.length > 0) {
      this.host.notify({ kind: 'warning', text: `Step ${step} was partly undone. Left alone: ${skipped.join('; ')}.` })
    } else {
      this.host.notify({ kind: 'warning', text: `Nothing was undone: ${skipped.join('; ') || 'no files'}.` })
    }
    this.emit()
  }

  dismiss(): void {
    if (this.snapshot?.state.kind !== 'finished') return
    this.run = null
    this.snapshot = null
    this.activeSettings = null
    this.emit()
  }

  clearHistory(): void {
    this.history = []
    this.host.saveHistory(this.history)
    this.emit()
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────
  private askForReview(input: { step: number; changeSet: { changes: FileChange[] }; summary: string }): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.review = { step: input.step, summary: input.summary, changes: input.changeSet.changes, resolve }
      this.emit()
    })
  }

  /** Runs until the next stop (finished or paused) and reacts to how it ended. */
  private async settle(running: Promise<RunSnapshot>): Promise<void> {
    const snapshot = await running
    this.snapshot = snapshot
    this.review = null
    if (snapshot.state.kind === 'finished') {
      this.remember(snapshot)
      const { outcome, message } = snapshot.state
      this.host.notify({
        kind: outcome === 'done' ? 'info' : outcome === 'stopped' ? 'info' : 'warning',
        text: `${outcomeTitle[outcome]}: ${message}`
      })
    } else if (snapshot.state.kind === 'paused') {
      this.host.notify({ kind: 'info', text: snapshot.state.message })
    }
    this.emit()
  }

  private remember(snapshot: RunSnapshot): void {
    if (snapshot.state.kind !== 'finished') return
    const item: UiHistoryItem = {
      id: snapshot.id,
      task: snapshot.task.slice(0, 300),
      startedAt: snapshot.startedAt ?? 0,
      outcome: snapshot.state.outcome,
      message: snapshot.state.message.slice(0, 300),
      steps: snapshot.steps.length,
      repo: this.repoName
    }
    this.history = [item, ...this.history.filter((h) => h.id !== item.id)].slice(0, HISTORY_LIMIT)
    this.host.saveHistory(this.history)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
