import { useEffect, useRef, useState } from 'preact/hooks'
import type { UiConnection, UiNotice, UiRepo, UiState, ToggleKey, UiToggles } from '../src/ui/protocol'
import { Check, Copy, Cross, Dot, Folder, Info, Play, Refresh, Warn } from './icons'
import { loadPersisted, post, savePersisted } from './store'

// ── small pieces ───────────────────────────────────────────────────────────────────────────────
export const Notice = ({ notice }: { notice: UiNotice }) => (
  <div class={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
    {notice.kind === 'error' ? <Cross /> : notice.kind === 'warning' ? <Warn /> : <Info />}
    <span class="wrap" style="flex:1">
      {notice.text}
    </span>
    <button class="link" onClick={() => post({ type: 'dismissNotice' })} aria-label="Dismiss message">
      Dismiss
    </button>
  </div>
)

type ChipTone = 'ok' | 'bad' | 'warn' | 'idle'

const Chip = ({ tone, label, title, onClick }: { tone: ChipTone; label: string; title: string; onClick?: () => void }) => {
  const content = (
    <>
      <Dot />
      {label}
    </>
  )
  return onClick ? (
    <button class={`chip ${tone}`} title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span class={`chip ${tone}`} title={title}>
      {content}
    </span>
  )
}

export const Header = ({ connection, version }: { connection: UiConnection; version: string }) => {
  const browserCount = connection.browsers.length
  const needsChoice = browserCount > 1 && !connection.selectedBrowserId
  return (
    <header class="top">
      <div class="row">
        <strong>CodeGent</strong>
        <span class="muted">v{version}</span>
      </div>
      <div class="chips" aria-label="Connection status">
        <Chip
          tone={connection.hub === 'connected' ? 'ok' : connection.hub === 'connecting' ? 'warn' : 'bad'}
          label="Hub"
          title={connection.hub === 'connected' ? 'The local hub is running' : connection.hub === 'connecting' ? 'Connecting to the local hub…' : 'The local hub is not running — click to restart it'}
          onClick={connection.hub === 'offline' ? () => post({ type: 'restartHub' }) : undefined}
        />
        <Chip
          tone={browserCount > 0 ? (needsChoice ? 'warn' : 'ok') : 'bad'}
          label={browserCount > 1 ? `Browser (${browserCount})` : 'Browser'}
          title={
            browserCount === 0
              ? 'No browser extension is connected'
              : connection.browsers.map((b) => `${b.label} — ${b.chatgptTabs} ChatGPT tab${b.chatgptTabs === 1 ? '' : 's'}`).join('\n')
          }
          onClick={browserCount > 1 ? () => post({ type: 'chooseBrowser' }) : undefined}
        />
        <Chip
          tone={connection.chatgptTabs > 0 ? 'ok' : browserCount > 0 ? 'warn' : 'idle'}
          label="ChatGPT"
          title={connection.chatgptTabs > 0 ? `${connection.chatgptTabs} ChatGPT tab${connection.chatgptTabs === 1 ? '' : 's'} open` : 'No ChatGPT tab is open (one is opened automatically when a run starts, but it must be signed in)'}
        />
      </div>
    </header>
  )
}

// ── setup guide ────────────────────────────────────────────────────────────────────────────────
const Step = ({ ok, title, children }: { ok: boolean; title: string; children?: preact.ComponentChildren }) => (
  <li>
    <span class={ok ? 'ok' : 'todo'}>{ok ? <Check size={16} /> : <Cross size={16} />}</span>
    <div style="flex:1;min-width:0">
      <div>
        <strong>{title}</strong>
      </div>
      {children}
    </div>
  </li>
)

export const isReady = (state: UiState): boolean =>
  state.connection.hub === 'connected' && state.connection.browsers.length > 0 && state.connection.chatgptTabs > 0 && state.repo.ok

export const SetupGuide = ({ state }: { state: UiState }) => {
  const { connection, repo, setup } = state
  const ready = isReady(state)
  return (
    <details class="card" open={!ready}>
      <summary>
        <strong>{ready ? 'Setup (all good)' : 'Setup — finish these steps'}</strong>
      </summary>
      <ol class="steps" style="margin-top:8px">
        <Step ok={connection.hub === 'connected'} title="Local hub">
          {connection.hub !== 'connected' && (
            <p class="muted">
              {connection.hint ?? 'Starting…'}{' '}
              <button class="link" onClick={() => post({ type: 'restartHub' })}>
                Restart
              </button>
            </p>
          )}
        </Step>
        <Step ok={connection.browsers.length > 0} title="Browser extension connected">
          {connection.browsers.length === 0 && (
            <>
              <p class="muted">
                In Chrome or Edge open <span class="mono">chrome://extensions</span>, turn on <em>Developer mode</em>, choose <em>Load unpacked</em> and select this folder:
              </p>
              {setup.browserExtensionPath && <p class="mono wrap">{setup.browserExtensionPath}</p>}
              <div class="actions">
                <button class="small" onClick={() => post({ type: 'openBrowserExtensionFolder' })}>
                  <Folder /> Show folder
                </button>
                <button class="small" onClick={() => post({ type: 'copyBrowserExtensionPath' })}>
                  <Copy /> Copy path
                </button>
              </div>
            </>
          )}
        </Step>
        <Step ok={connection.chatgptTabs > 0} title="ChatGPT open and signed in">
          {connection.chatgptTabs === 0 && (
            <p class="muted">
              Open <span class="mono">chatgpt.com</span> in that browser and sign in. In ChatGPT's settings connect the <em>GitHub</em> app and allow it to read this repository — that is how ChatGPT fetches your latest code.
            </p>
          )}
        </Step>
        <Step ok={repo.ok} title={repo.ok ? `GitHub repository: ${repo.fullName}` : 'GitHub repository'}>
          {!repo.ok && <p class="muted wrap">{repo.reason}</p>}
        </Step>
      </ol>
    </details>
  )
}

// ── repository ─────────────────────────────────────────────────────────────────────────────────
export const RepoCard = ({ repo }: { repo: UiRepo }) => {
  if (!repo.ok) return null
  const needsPush = repo.ahead > 0 || !repo.hasUpstream
  return (
    <section class="card" aria-label="Repository">
      <h2>Repository</h2>
      <div class="row wrapping">
        <button class="link" onClick={() => post({ type: 'openUrl', url: repo.webUrl })} title="Open on GitHub">
          <strong>{repo.fullName}</strong>
        </button>
        <span class="muted">on</span>
        <span class="mono">{repo.branch}</span>
        <span class="spacer" />
        <button class="small" onClick={() => post({ type: 'refreshRepo' })} title="Re-read the repository and check GitHub for newer commits">
          <Refresh /> Refresh
        </button>
      </div>
      <p class="muted wrap">
        <span class="mono">{repo.shortSha}</span> {repo.subject}
      </p>
      {repo.warnings.length > 0 && (
        <ul class="warnings">
          {repo.warnings.map((warning) => (
            <li key={warning}>
              <Warn /> <span class="wrap">{warning}</span>
            </li>
          ))}
        </ul>
      )}
      {repo.dirtyCount > 0 && (
        <details>
          <summary>{repo.dirtyCount} uncommitted file{repo.dirtyCount === 1 ? '' : 's'}</summary>
          <div class="mono wrap">{repo.dirtyFiles.join('\n')}</div>
        </details>
      )}
      {needsPush && repo.behind === 0 && (
        <div class="actions">
          <button class="small" onClick={() => post({ type: 'pushNow' })} title="Push this branch to GitHub so ChatGPT can read it">
            Push now
          </button>
        </div>
      )}
    </section>
  )
}

// ── task ───────────────────────────────────────────────────────────────────────────────────────
const TOGGLES: Array<{ key: ToggleKey; label: string; title: string }> = [
  { key: 'autoApply', label: 'Apply automatically', title: 'Apply ChatGPT’s changes without asking (every step can be undone). Off: review each step first.' },
  { key: 'autoContinue', label: 'Continue automatically', title: 'Send each result back to ChatGPT on its own. Off: pause after every step.' },
  { key: 'commit', label: 'Commit each step', title: 'Commit the files each step changed.' },
  { key: 'push', label: 'Push each step', title: 'Push after committing so ChatGPT can read the new code from GitHub.' },
  { key: 'autoSubmit', label: 'Send in ChatGPT', title: 'Press send in ChatGPT for you. Off: the prompt is typed in and you press Enter.' }
]

export const TaskCard = ({ toggles, locked, busy }: { toggles: UiToggles; locked: boolean; busy: boolean }) => {
  const [draft, setDraft] = useState(loadPersisted().draft)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => savePersisted({ draft }), [draft])

  const start = () => {
    if (draft.trim() && !locked && !busy) post({ type: 'start', task: draft })
  }
  return (
    <section class="card" aria-label="New task">
      <h2>Task</h2>
      <textarea
        ref={box}
        value={draft}
        placeholder="What should ChatGPT build or fix? Be specific — it reads the latest code from GitHub by itself."
        aria-label="Task description"
        disabled={locked}
        onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            start()
          }
        }}
      />
      <div class="toggles">
        {TOGGLES.map(({ key, label, title }) => (
          <label class="toggle" key={key} title={title}>
            <input type="checkbox" checked={toggles[key]} onChange={(event) => post({ type: 'setToggle', key, value: (event.target as HTMLInputElement).checked })} />
            {label}
          </label>
        ))}
      </div>
      <div class="row">
        <span class="muted">Ctrl+Enter to start</span>
        <span class="spacer" />
        <button class="primary" disabled={!draft.trim() || locked || busy} onClick={start}>
          <Play /> {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </section>
  )
}
