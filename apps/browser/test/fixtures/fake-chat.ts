import {
  EXCHANGE_BODY,
  SEND_ICON,
  STOP_ICON,
  assistantMessage,
  bareAssistantTurn,
  bareUserTurn,
  escapeHtml,
  exchangeAssistantParts,
  exchangeFooter,
  exchangeHtml,
  userMessage
} from './chatgpt-dom'

/**
 * Which generation of the ChatGPT page to imitate:
 * - `legacy`: test ids and an author attribute on every message
 * - `redesign`: the page captured on 2026-10-18 — one container per exchange, one send/stop button
 * - `bare`: an invented minimal page (turns marked only by a state attribute) that tests the
 *   generic fallback
 */
export type ChatLayout = 'legacy' | 'redesign' | 'bare'

export interface FakeChatOptions {
  layout?: ChatLayout
  /** HTML placed inside the assistant's reply body. */
  reply?: string
  streamChunks?: number
  chunkMs?: number
  startDelayMs?: number
  loggedOut?: boolean
  existing?: Array<{ role: 'user' | 'assistant'; html: string; id?: string }>
  /** When true the send button ignores clicks; only the Enter key submits. */
  flakyButton?: boolean
  /** When false the Enter key does nothing. */
  enterSubmits?: boolean
  /** When false no stop button / streaming markers are rendered (degraded detection). */
  streamingIndicators?: boolean
  /** Show a "Continue generating" button after the first half of the reply. */
  continueButton?: boolean
  /** Never produce a reply (for timeout / cancel tests). */
  silent?: boolean
  /** Keep the turn-state attribute at this value after the reply (a marker that never clears). */
  stuckTurnState?: string
  /** Show the reply in markup the extension cannot recognise as part of the conversation. */
  unmarkedReply?: boolean
}

const BODY = '.markdown, [data-body], [data-markdown-copy="contents"]'

/**
 * A stand-in for the ChatGPT page: a contenteditable composer whose send button enables on input,
 * a conversation list, and a reply that streams in behind a stop button.
 */
export class FakeChat {
  readonly sent: string[] = []
  readonly composer: HTMLElement
  readonly sendButton: HTMLButtonElement
  private readonly list: HTMLElement
  private readonly layout: ChatLayout
  private stopButton: HTMLButtonElement | null = null
  private stopMode = false
  private exchanges = 0
  private timers: ReturnType<typeof setTimeout>[] = []
  stopClicks = 0

  constructor(
    private readonly doc: Document,
    private readonly options: FakeChatOptions = {}
  ) {
    this.layout = options.layout ?? 'legacy'
    const header = options.loggedOut
      ? this.layout === 'legacy'
        ? '<header><button data-testid="login-button">Log in</button></header>'
        : '<header><button>Log in</button><button>Sign up for free</button></header>'
      : '<header></header>'
    const composer = {
      legacy:
        '<form id="composer-form">' +
        '<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>' +
        '<button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form>',
      // The send button of the captured page: a submit button labelled "Send", no data attributes.
      redesign:
        '<form id="composer-form" data-composer-placement="thread" data-chatgpt-composer="">' +
        '<div class="ProseMirror" contenteditable="true"></div>' +
        `<button type="submit" aria-label="Send" disabled>${SEND_ICON}</button></form>`,
      bare:
        '<form id="composer-form"><div contenteditable="true" role="textbox"></div>' +
        '<div data-composer-trailing><button type="submit" data-composer-submit aria-disabled="true" ' +
        'aria-label="Send message" data-send-label="Send message" data-stop-label="Stop generating">' +
        `${SEND_ICON}</button></div></form>`
    }[this.layout]
    doc.body.innerHTML = `${header}<main><div id="thread"></div>${composer}</main>`
    this.list = doc.getElementById('thread')!
    this.composer = doc.querySelector('[contenteditable="true"]')!
    this.sendButton = doc.querySelector(
      this.layout === 'legacy'
        ? '[data-testid="send-button"]'
        : 'form button[type="submit"]'
    )!

    for (const item of options.existing ?? []) {
      if (item.role === 'user') this.addUser(item.html, 'complete', item.id)
      else this.addAssistant(item.html, { id: item.id, state: 'complete' })
    }

    this.composer.addEventListener('input', () => this.syncButton())
    this.sendButton.addEventListener('click', (event) => {
      event.preventDefault()
      if (this.stopMode) return this.stop()
      if (!this.options.flakyButton) this.submit()
    })
    this.composer.addEventListener('keydown', (event) => {
      if (
        (event as KeyboardEvent).key === 'Enter' &&
        this.options.enterSubmits !== false
      ) {
        event.preventDefault()
        this.submit()
      }
    })
  }

  // ── building the conversation ────────────────────────────────────────────────────────────────
  private addUser(text: string, state: string, id?: string): void {
    if (this.layout === 'legacy') {
      this.list.insertAdjacentHTML('beforeend', userMessage(text, id))
    } else if (this.layout === 'bare') {
      this.list.insertAdjacentHTML('beforeend', bareUserTurn(text))
    } else {
      this.exchanges += 1
      this.list.insertAdjacentHTML(
        'beforeend',
        exchangeHtml({ n: this.exchanges, state, user: text })
      )
    }
  }

  /** Adds the assistant's message; returns the element that holds the turn and the reply body. */
  private addAssistant(
    html: string,
    options: { id?: string; state?: string }
  ): { turn: HTMLElement; body: HTMLElement } {
    const id = options.id ?? 'msg-' + Math.random().toString(36).slice(2, 10)
    if (this.options.unmarkedReply) {
      this.list.insertAdjacentHTML(
        'beforeend',
        '<div class="mystery"><div data-body></div></div>'
      )
    } else if (this.layout === 'legacy') {
      this.list.insertAdjacentHTML(
        'beforeend',
        assistantMessage(html, { id, turnState: options.state })
      )
    } else if (this.layout === 'bare') {
      this.list.insertAdjacentHTML('beforeend', bareAssistantTurn(html, options.state))
    } else {
      let turn = this.list.lastElementChild as HTMLElement | null
      if (
        !turn?.hasAttribute('data-talvt-turn-state') ||
        turn.querySelector(EXCHANGE_BODY)
      ) {
        this.exchanges += 1
        this.list.insertAdjacentHTML(
          'beforeend',
          exchangeHtml({ n: this.exchanges, state: options.state ?? 'complete' })
        )
        turn = this.list.lastElementChild as HTMLElement
      }
      turn.insertAdjacentHTML(
        'beforeend',
        exchangeAssistantParts(this.exchanges, id, html)
      )
      if (options.state) turn.setAttribute('data-talvt-turn-state', options.state)
      if (options.state === 'complete')
        turn.insertAdjacentHTML('beforeend', exchangeFooter())
    }
    const turn = this.list.lastElementChild as HTMLElement
    return { turn, body: turn.querySelector(BODY) as HTMLElement }
  }

  private completeTurn(turn: HTMLElement): void {
    turn.setAttribute('data-talvt-turn-state', this.options.stuckTurnState ?? 'complete')
    if (this.layout === 'redesign') turn.insertAdjacentHTML('beforeend', exchangeFooter())
  }

  private syncButton(): void {
    const empty = (this.composer.textContent ?? '').trim() === ''
    if (this.layout === 'bare')
      this.sendButton.setAttribute('aria-disabled', String(empty))
    else this.sendButton.disabled = empty
  }

  // ── what the user and the page do ────────────────────────────────────────────────────────────
  /** What a user pressing "send" does. */
  submit(): void {
    if (this.stopMode) return
    const text = (this.composer.textContent ?? '').trim()
    if (!text) return
    this.sent.push(text)
    this.composer.textContent = ''
    this.syncButton()
    this.addUser(
      text,
      this.options.streamingIndicators === false ? 'complete' : 'streaming'
    )
    if (this.options.silent) {
      this.showStop()
      return
    }
    this.later(this.options.startDelayMs ?? 20, () => this.streamReply())
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  private stop(): void {
    this.stopClicks += 1
    this.clearTimers()
    this.hideStop()
  }

  private showStop(): void {
    if (this.options.streamingIndicators === false) return
    if (this.layout !== 'legacy') {
      // The one button turns into the stop button. The captured page shows only a square icon;
      // the invented page also changes the label.
      this.stopMode = true
      this.sendButton.disabled = false
      this.sendButton.removeAttribute('aria-disabled')
      if (this.layout === 'bare')
        this.sendButton.setAttribute('aria-label', 'Stop generating')
      else this.sendButton.removeAttribute('aria-label')
      this.sendButton.innerHTML = STOP_ICON
      return
    }
    this.stopButton = this.doc.createElement('button')
    this.stopButton.type = 'button'
    this.stopButton.setAttribute('data-testid', 'stop-button')
    this.stopButton.setAttribute('aria-label', 'Stop streaming')
    this.stopButton.textContent = 'Stop'
    this.stopButton.addEventListener('click', () => this.stop())
    this.doc.getElementById('composer-form')!.append(this.stopButton)
  }

  private hideStop(): void {
    if (this.layout !== 'legacy') {
      if (!this.stopMode) return
      this.stopMode = false
      this.sendButton.setAttribute(
        'aria-label',
        this.layout === 'bare' ? 'Send message' : 'Send'
      )
      this.sendButton.innerHTML = SEND_ICON
      this.syncButton()
      return
    }
    this.stopButton?.remove()
    this.stopButton = null
  }

  /** Simulates a banner (rate limit etc.) appearing as a dialog. */
  showDialog(text: string): void {
    this.doc.body.insertAdjacentHTML(
      'beforeend',
      `<div role="dialog">${escapeHtml(text)}</div>`
    )
  }

  private streamReply(): void {
    const reply = this.options.reply ?? '<p>OK</p>'
    const chunks = Math.max(1, this.options.streamChunks ?? 3)
    const chunkMs = this.options.chunkMs ?? 15
    const indicators = this.options.streamingIndicators !== false
    const { turn, body } = this.addAssistant('', {
      // Without streaming indicators a turn is born in its final state (the new pages always mark
      // their turns; the old page recognised them by their author instead).
      state: indicators ? 'streaming' : this.layout === 'legacy' ? undefined : 'complete'
    })
    this.showStop()

    const reveal = (upTo: number) => (body.innerHTML = reply.slice(0, upTo))
    const finish = () => {
      body.innerHTML = reply
      this.hideStop()
      if (indicators && !this.options.unmarkedReply) this.completeTurn(turn)
    }

    for (let i = 1; i <= chunks; i++) {
      const upTo = Math.ceil((reply.length * i) / chunks)
      const isLast = i === chunks
      this.later(i * chunkMs, () => {
        reveal(upTo)
        if (isLast) {
          if (this.options.continueButton) {
            this.hideStop()
            this.offerContinue(body, reply, finish)
          } else {
            finish()
          }
        }
      })
    }
  }

  private offerContinue(body: HTMLElement, reply: string, finish: () => void): void {
    body.innerHTML = reply.slice(0, Math.ceil(reply.length / 2))
    const button = this.doc.createElement('button')
    button.type = 'button'
    button.textContent = 'Continue generating'
    button.addEventListener('click', () => {
      button.remove()
      this.showStop()
      this.later(this.options.chunkMs ?? 15, finish)
    })
    this.doc.getElementById('composer-form')!.append(button)
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout)
    this.timers = []
  }

  dispose(): void {
    this.clearTimers()
  }
}
