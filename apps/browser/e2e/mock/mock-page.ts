/**
 * A stand-in for chatgpt.com used by the browser end-to-end tests. It is deliberately close to
 * the real page where the extension is sensitive: the composer is a real ProseMirror editor
 * (`#prompt-textarea`), the send button only exists while there is text, the stop button replaces
 * it while a reply streams, turns carry `data-talvt-turn-state`, the URL changes via the History
 * API after the first message, and a reopened conversation renders its history *late*.
 *
 * The test drives it through `/__mock/*` requests it intercepts (see harness.ts), so replies can
 * be queued before any tab exists.
 */
import { baseKeymap } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { schema } from 'prosemirror-schema-basic'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import {
  clearComposer,
  composerHolds,
  fillComposer,
  type FillStrategyName
} from '../../src/content/fill'
import { escapeHtml } from '../../test/fixtures/chatgpt-dom'
import { renderMarkdown } from './render'

interface Turn {
  role: 'user' | 'assistant'
  /** Markdown source (assistant) or plain text (user). */
  text: string
  id: string
}

interface ReplyPlan {
  markdown: string
  chunks: number
  chunkMs: number
  /** Keep streaming until the test releases it — for cancel / tab-close tests. */
  hold: boolean
}

const uid = () => Math.random().toString(36).slice(2, 10)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const call = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(
    `/__mock/${path}`,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }
  )
  return (await response.json()) as T
}

const state = {
  loggedOut: false,
  thread: [] as Turn[],
  conversationId: null as string | null,
  generating: false
}

document.body.innerHTML = `
  <header><span>ChatGPT</span><span id="auth"></span></header>
  <main>
    <div id="thread"></div>
    <form id="composer-form" onsubmit="return false">
      <div id="composer-mount"></div>
      <span id="actions"></span>
    </form>
  </main>`
const threadEl = document.getElementById('thread')!
const actionsEl = document.getElementById('actions')!
const authEl = document.getElementById('auth')!

// ── composer: a real ProseMirror editor ───────────────────────────────────────────────────────
const composerText = (view: EditorView): string =>
  view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')

const view: EditorView = new EditorView(document.getElementById('composer-mount')!, {
  state: EditorState.create({
    schema,
    plugins: [
      keymap({
        Enter: () => {
          submit()
          return true
        }
      }),
      keymap(baseKeymap)
    ]
  }),
  dispatchTransaction(transaction) {
    view.updateState(view.state.apply(transaction))
    renderActions()
  }
})
view.dom.id = 'prompt-textarea'

function renderActions(): void {
  const hasText = composerText(view).trim() !== ''
  if (state.generating) {
    actionsEl.innerHTML =
      '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>'
    actionsEl.querySelector('button')!.addEventListener('click', () => {
      void call('stop', {})
      state.generating = false
      renderActions()
    })
  } else if (hasText) {
    actionsEl.innerHTML =
      '<button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>'
    actionsEl.querySelector('button')!.addEventListener('click', () => submit())
  } else {
    actionsEl.innerHTML =
      '<button type="button" data-testid="composer-speech-button" aria-label="Start voice mode">Voice</button>'
  }
}

// ── conversation ──────────────────────────────────────────────────────────────────────────────
const turnHtml = (
  turn: Turn,
  streamingState?: 'streaming' | 'complete',
  partial?: string
): string => {
  if (turn.role === 'user') {
    return (
      `<section data-testid="conversation-turn" data-turn="user"><div data-message-author-role="user" data-message-id="${turn.id}">` +
      `<div class="whitespace-pre-wrap">${escapeHtml(turn.text)}</div></div></section>`
    )
  }
  return (
    `<section data-testid="conversation-turn" data-turn="assistant" data-talvt-turn-state="${streamingState ?? 'complete'}">` +
    `<div data-message-author-role="assistant" data-message-id="${turn.id}"><div class="flex w-full flex-col gap-1">` +
    `<div class="markdown prose">${renderMarkdown(partial ?? turn.text)}</div></div></div></section>`
  )
}

const saveThread = (): void => {
  if (state.conversationId)
    localStorage.setItem(`mock:${state.conversationId}`, JSON.stringify(state.thread))
}

function submit(): void {
  const text = composerText(view).trim()
  if (!text || state.generating) return
  void call('sent', { text })
  view.dispatch(view.state.tr.delete(0, view.state.doc.content.size))

  if (!state.conversationId) {
    state.conversationId = `conv-${uid()}`
    history.pushState(null, '', `/c/${state.conversationId}`)
  }
  const user: Turn = { role: 'user', text, id: `user-${uid()}` }
  state.thread.push(user)
  threadEl.insertAdjacentHTML('beforeend', turnHtml(user))
  void streamAnswer()
}

async function streamAnswer(): Promise<void> {
  state.generating = true
  renderActions()
  const plan = await call<ReplyPlan>('next-reply')
  const turn: Turn = { role: 'assistant', text: plan.markdown, id: `asst-${uid()}` }

  await sleep(60)
  if (!state.generating) return // stopped before the first token
  threadEl.insertAdjacentHTML('beforeend', turnHtml(turn, 'streaming', ''))
  const section = threadEl.lastElementChild as HTMLElement
  const body = section.querySelector('.markdown') as HTMLElement

  const lines = plan.markdown.split('\n')
  for (let step = 1; step <= plan.chunks; step++) {
    if (!state.generating) return
    body.innerHTML = renderMarkdown(
      lines.slice(0, Math.ceil((lines.length * step) / plan.chunks)).join('\n')
    )
    await sleep(plan.chunkMs)
  }
  while (plan.hold && state.generating) {
    if ((await call<{ released: boolean }>('released')).released) break
    await sleep(100)
  }
  if (!state.generating) return
  body.innerHTML = renderMarkdown(plan.markdown)
  section.setAttribute('data-talvt-turn-state', 'complete')
  state.thread.push(turn)
  saveThread()
  state.generating = false
  renderActions()
}

function renderAuth(): void {
  authEl.innerHTML = state.loggedOut
    ? '<button data-testid="login-button">Log in</button><button data-testid="signup-button">Sign up</button>'
    : ''
}

// Reopening /c/<id> restores history asynchronously, like the real app.
const reopened = /^\/c\/(conv-[\w-]+)/.exec(location.pathname)
if (reopened) {
  state.conversationId = reopened[1]!
  const saved = localStorage.getItem(`mock:${state.conversationId}`)
  if (saved) {
    state.thread = JSON.parse(saved) as Turn[]
    setTimeout(() => {
      threadEl.innerHTML = state.thread.map((t) => turnHtml(t)).join('')
    }, 350)
  }
}

void call<{ loggedOut: boolean }>('config').then((config) => {
  state.loggedOut = config.loggedOut
  renderAuth()
})
renderActions()

// ── direct hooks used by the fill-strategy tests (run in a plain page) ───────────────────────
;(window as unknown as { __mock: unknown }).__mock = {
  composerText: () => composerText(view),
  /** Runs the extension's own fill logic against this real ProseMirror editor. */
  async fill(text: string, strategies: FillStrategyName[]) {
    const composer = document.getElementById('prompt-textarea')!
    const result = await fillComposer(composer, text, {
      strategies,
      requireSendEnabled: true
    })
    return { result, holds: composerHolds(composer, text), text: composerText(view) }
  },
  clear: () => clearComposer(document.getElementById('prompt-textarea')!)
}
