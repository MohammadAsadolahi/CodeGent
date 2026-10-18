import type { UiEdit, UiHistoryItem, UiReview, UiRun, UiStep } from '../src/ui/protocol'
import { Check, Cross, Diff, Dot, Folder, Info, Spinner, Stop, Undo, Warn } from './icons'
import { formatAgo, formatDuration, post, useNow } from './store'

const KIND_LABEL: Record<UiStep['kind'], string> = {
  initial: 'First message',
  'follow-up': 'Result sent back',
  'format-reminder': 'Format reminder',
  'cut-off-reminder': 'Reply was cut off'
}

const EDIT_VERB: Record<UiEdit['kind'], string> = {
  created: 'Created',
  updated: 'Updated',
  replaced: 'Replaced',
  deleted: 'Deleted',
  renamed: 'Renamed'
}

const EditRow = ({ edit, step }: { edit: UiEdit; step: number }) => {
  const tone =
    edit.status === 'applied' ? 'ok' : edit.status === 'failed' ? 'bad' : 'skip'
  const opens = edit.status === 'applied' && edit.kind !== 'deleted'
  return (
    <li>
      <span class={tone}>
        {edit.status === 'applied' ? (
          <Check />
        ) : edit.status === 'failed' ? (
          <Cross />
        ) : (
          <Dot size={6} />
        )}
      </span>
      <div class="edit-main">
        <span>
          {edit.status === 'failed'
            ? 'Could not change'
            : edit.status === 'skipped'
              ? 'No change'
              : EDIT_VERB[edit.kind]}{' '}
        </span>
        {opens ? (
          <button
            class="link mono wrap"
            onClick={() => post({ type: 'openFile', path: edit.path })}
            title="Open file"
          >
            {edit.path}
          </button>
        ) : (
          <span class="mono wrap">{edit.path}</span>
        )}
        {edit.fromPath && <span class="muted"> (from {edit.fromPath})</span>}
        {edit.status === 'applied' && edit.detail && (
          <span class="muted"> — {edit.detail}</span>
        )}
        {edit.status === 'skipped' && <span class="muted"> — {edit.detail}</span>}
        {edit.errors.map((error) => (
          <div class="edit-errors" key={error}>
            {error}
          </div>
        ))}
        {edit.notes.map((note) => (
          <div class="edit-notes" key={note}>
            {note}
          </div>
        ))}
      </div>
      {edit.status === 'applied' && (
        <button
          class="small"
          title="Show what changed"
          aria-label={`Show diff of ${edit.path}`}
          onClick={() => post({ type: 'openDiff', path: edit.path, step })}
        >
          <Diff />
        </button>
      )}
    </li>
  )
}

const Fact = ({
  tone,
  children
}: {
  tone: 'ok' | 'bad' | 'warn' | 'muted'
  children: preact.ComponentChildren
}) => (
  <div class={`fact ${tone}`}>
    <span>
      {tone === 'ok' ? (
        <Check />
      ) : tone === 'bad' ? (
        <Cross />
      ) : tone === 'warn' ? (
        <Warn />
      ) : (
        <Info />
      )}
    </span>
    <span>{children}</span>
  </div>
)

const StepCard = ({ step }: { step: UiStep }) => (
  <article class={`step ${step.undone ? 'undone' : ''}`} aria-label={`Step ${step.n}`}>
    <div class="step-head">
      <span class="n">Step {step.n}</span>
      <span class="muted">{KIND_LABEL[step.kind]}</span>
      <span class="spacer" />
      {step.working && <Spinner />}
      {step.durationSeconds !== undefined && (
        <span class="muted">ChatGPT {formatDuration(step.durationSeconds)}</span>
      )}
      {step.undone && <span class="muted">· undone</span>}
    </div>
    {step.summary && <div class="step-summary">{step.summary}</div>}
    {step.edits.length > 0 && (
      <ul class="edits">
        {step.edits.map((edit, index) => (
          <EditRow key={`${edit.path}-${index}`} edit={edit} step={step.n} />
        ))}
      </ul>
    )}
    <div class="facts">
      {step.problems.map((problem) => (
        <Fact key={problem} tone="bad">
          {problem}
        </Fact>
      ))}
      {step.warnings.map((warning) => (
        <Fact key={warning} tone="warn">
          {warning}
        </Fact>
      ))}
      {step.decision === 'skip' && (
        <Fact tone="warn">You chose not to apply this step.</Fact>
      )}
      {step.diagnostics &&
        (step.diagnostics.errors === 0 && step.diagnostics.warnings === 0 ? (
          <Fact tone="ok">No new errors or warnings in the changed files.</Fact>
        ) : (
          <>
            <Fact tone={step.diagnostics.errors > 0 ? 'bad' : 'warn'}>
              {step.diagnostics.errors} new error
              {step.diagnostics.errors === 1 ? '' : 's'}, {step.diagnostics.warnings}{' '}
              warning{step.diagnostics.warnings === 1 ? '' : 's'} in the changed files
            </Fact>
            <details>
              <summary>Show problems</summary>
              {step.diagnostics.items.map((item, index) => (
                <div class="diagnostic" key={index}>
                  <span class="mono">
                    {item.path}:{item.line}
                  </span>{' '}
                  {item.message}
                </div>
              ))}
            </details>
          </>
        ))}
      {step.verify && (
        <Fact tone={step.verify.outcome === 'passed' ? 'ok' : 'bad'}>
          <span class="mono">{step.verify.command}</span>{' '}
          {step.verify.outcome === 'passed'
            ? 'passed'
            : step.verify.outcome === 'timed-out'
              ? 'timed out'
              : step.verify.outcome === 'could-not-run'
                ? 'could not run'
                : `failed (exit code ${step.verify.exitCode})`}
        </Fact>
      )}
      {step.publish && (
        <Fact
          tone={
            step.publish.state === 'pushed'
              ? 'ok'
              : step.publish.state === 'committed'
                ? 'warn'
                : 'muted'
          }
        >
          {step.publish.label}
        </Fact>
      )}
    </div>
    {step.canUndo && (
      <div class="actions">
        <button
          class="small"
          onClick={() => post({ type: 'undo', step: step.n })}
          title="Put the files of this step back in your working tree"
        >
          <Undo /> Undo this step
        </button>
      </div>
    )}
  </article>
)

const outcomeTone = (outcome: UiRun['outcome']): 'ok' | 'bad' | 'warn' =>
  outcome === 'done' ? 'ok' : outcome === 'error' ? 'bad' : 'warn'

export const RunCard = ({ run }: { run: UiRun }) => {
  const now = useNow(run.state === 'running')
  const elapsed = Math.max(0, Math.round((now - run.startedAt) / 1000))
  return (
    <section class="card" aria-label="Current run">
      <h2>Run</h2>
      <div class="task-title">{run.task}</div>

      {run.state === 'running' && (
        <div class="status-line" role="status" aria-live="polite">
          <Spinner size={16} />
          <div style="flex:1">
            <strong>{run.phase ?? 'Working'}</strong>
            {run.detail && <div class="muted">{run.detail}</div>}
            <div class="muted">{formatDuration(elapsed)} so far</div>
          </div>
          <button class="danger" onClick={() => post({ type: 'stop' })}>
            <Stop /> Stop
          </button>
        </div>
      )}

      {run.state === 'paused' && (
        <div
          class={`status-line ${run.pauseReason === 'needs-attention' ? 'warn' : ''}`}
          role="alert"
        >
          {run.pauseReason === 'needs-attention' ? (
            <Warn size={16} />
          ) : (
            <Info size={16} />
          )}
          <div style="flex:1">
            <strong>
              {run.pauseReason === 'needs-attention' ? 'Needs your attention' : 'Paused'}
            </strong>
            <div class="wrap">{run.message}</div>
            <div class="actions">
              <button class="primary" onClick={() => post({ type: 'resume' })}>
                {run.resumeLabel}
              </button>
              <button class="danger" onClick={() => post({ type: 'stop' })}>
                <Stop /> Stop
              </button>
            </div>
          </div>
        </div>
      )}

      {run.state === 'finished' && (
        <div class={`status-line ${outcomeTone(run.outcome)}`} role="status">
          {run.outcome === 'done' ? (
            <Check size={16} />
          ) : run.outcome === 'error' ? (
            <Cross size={16} />
          ) : (
            <Info size={16} />
          )}
          <div style="flex:1">
            <strong>{TITLES[run.outcome ?? 'done']}</strong>
            <div class="wrap">{run.message}</div>
            <div class="actions">
              {run.conversationUrl && (
                <button
                  class="small"
                  onClick={() => post({ type: 'openUrl', url: run.conversationUrl! })}
                >
                  <Folder /> Open conversation
                </button>
              )}
              <button class="small" onClick={() => post({ type: 'dismissRun' })}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {run.steps.map((step) => (
        <StepCard key={step.n} step={step} />
      ))}
    </section>
  )
}

const TITLES: Record<NonNullable<UiRun['outcome']>, string> = {
  done: 'Finished',
  blocked: 'ChatGPT is blocked',
  stopped: 'Stopped',
  'step-limit': 'Step limit reached',
  stuck: 'Stuck',
  'no-changes': 'No changes received',
  error: 'Stopped by an error'
}

export const ReviewCard = ({ review }: { review: UiReview }) => (
  <section class="card" aria-label="Review changes" style="border-color:var(--cg-info)">
    <h2>Review step {review.step}</h2>
    {review.summary && <div class="step-summary">{review.summary}</div>}
    <ul class="edits">
      {review.files.map((file) => (
        <li key={file.path}>
          <span class={file.kind === 'delete' ? 'bad' : 'ok'}>
            {file.kind === 'delete' ? <Cross /> : <Check />}
          </span>
          <div class="edit-main">
            <span>
              {file.kind === 'create'
                ? 'Create'
                : file.kind === 'delete'
                  ? 'Delete'
                  : file.kind === 'rename'
                    ? 'Rename'
                    : 'Change'}{' '}
            </span>
            <span class="mono wrap">{file.path}</span>
            {file.fromPath && <span class="muted"> (from {file.fromPath})</span>}
            <span class="muted">
              {' '}
              +{file.added} −{file.removed}
            </span>
          </div>
          <button
            class="small"
            aria-label={`Show diff of ${file.path}`}
            onClick={() => post({ type: 'openDiff', path: file.path })}
          >
            <Diff />
          </button>
        </li>
      ))}
    </ul>
    <div class="actions">
      <button class="primary" onClick={() => post({ type: 'decide', decision: 'apply' })}>
        <Check /> Apply
      </button>
      <button onClick={() => post({ type: 'decide', decision: 'skip' })}>
        Skip this step
      </button>
      <button class="danger" onClick={() => post({ type: 'decide', decision: 'stop' })}>
        <Stop /> Stop run
      </button>
    </div>
  </section>
)

export const History = ({ items }: { items: UiHistoryItem[] }) => {
  const now = useNow(false)
  if (items.length === 0) return null
  return (
    <details class="card">
      <summary>
        <strong>History ({items.length})</strong>
      </summary>
      {items.map((item) => (
        <div class="history-item" key={item.id}>
          <span
            class={
              item.outcome === 'done' ? 'ok' : item.outcome === 'error' ? 'bad' : 'warn'
            }
          >
            {item.outcome === 'done' ? (
              <Check />
            ) : item.outcome === 'error' ? (
              <Cross />
            ) : (
              <Info />
            )}
          </span>
          <div style="flex:1;min-width:0">
            <div class="wrap">{item.task}</div>
            <div class="muted wrap">
              {item.repo} · {item.steps} step{item.steps === 1 ? '' : 's'} ·{' '}
              {formatAgo(item.startedAt, now)} — {item.message}
            </div>
          </div>
        </div>
      ))}
      <div class="actions">
        <button class="small" onClick={() => post({ type: 'clearHistory' })}>
          Clear history
        </button>
      </div>
    </details>
  )
}
