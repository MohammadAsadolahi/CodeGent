import {
  STOP_ICON_PATH,
  assistantMessage,
  escapeHtml,
  redesignAssistantTurn,
  redesignUserTurn,
  userMessage
} from './chatgpt-dom'

export type ChatLayout = 'legacy' | 'redesign'

export interface FakeChatOptions {
  /** Which generation of the ChatGPT page to imitate (default: the one with test ids and roles). */
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
  /** Show the reply in markup the extension cannot recognise as a conversation turn. */
  unmarkedReply?: boolean
}

const BODY = '.markdown, [data-body]'

/**
 * A stand-in for the ChatGPT page: a contenteditable composer whose send button enables on input,
 * a conversation list, and a reply that streams in behind a stop button. The `redesign` layout
 * follows the page as it looks since October 2026: a single send/stop button, no test ids, no
 * author attributes on messages.
 */
export class FakeChat {
  readonly sent: string[] = []
  readonly composer: HTMLElement
  readonly sendButton: HTMLButtonElement
  private readonly list: HTMLElement
  private readonly layout: ChatLayout
  private stopButton: HTMLButtonElement | null = null
  private stopMode = false
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
    doc.body.innerHTML =
      this.layout === 'legacy'
        ? header +
          '<main><div id="thread"></div><form id="composer-form">' +
          '<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>' +
          '<button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form></main>'
        : header +
          '<main><div id="thread"></div>' +
          '<form id="composer-form"><div contenteditable="true" role="textbox"></div>' +
          '<div data-composer-trailing><button type="submit" data-composer-submit aria-disabled="true" ' +
          'aria-label="Send message" data-send-label="Send message" data-stop-label="Stop generating">' +
          '<svg viewBox="0 0 20 20"><path d="M10 4l5 6h-4v6H9v-6H5z"/></svg></button></div></form></main>'
    this.list = doc.getElementById('thread')!
    this.composer = doc.querySelector('[contenteditable="true"]')!
    this.sendButton = doc.querySelector(
      this.layout === 'legacy' ? '[data-testid="send-button"]' : 'button[data-composer-submit]'
    )!

    for (const item of options.existing ?? []) {
      this.list.insertAdjacentHTML(
        'beforeend',
        item.role === 'user'
          ? this.userHtml(item.html, item.id)
          : this.assistantHtml(item.html, { id: item.id, turnState: 'complete' })
      )
    }

    this.composer.addEventListener('input', () => this.syncButton())
    this.sendButton.addEventListener('click', (event) => {
      event.preventDefault()
      if (this.stopMode) return this.stop()
      if (!this.options.flakyButton) this.submit()
    })
    this.composer.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter' && this.options.enterSubmits !== false) {
        event.preventDefault()
        this.submit()
      }
    })
  }

  private userHtml(text: string, id?: string): string {
    return this.layout === 'legacy' ? userMessage(text, id) : redesignUserTurn(text)
  }

  private assistantHtml(html: string, options: { id?: string; turnState?: string }): string {
    return this.layout === 'legacy'
      ? assistantMessage(html, options)
      : redesignAssistantTurn(html, options.turnState)
  }

  private syncButton(): void {
    const empty = (this.composer.textContent ?? '').trim() === ''
    if (this.layout === 'legacy') this.sendButton.disabled = empty
    else this.sendButton.setAttribute('aria-disabled', String(empty))
  }

  /** What a user pressing "send" does. */
  submit(): void {
    if (this.stopMode) return
    const text = (this.composer.textContent ?? '').trim()
    if (!text) return
    this.sent.push(text)
    this.composer.textContent = ''
    this.syncButton()
    this.list.insertAdjacentHTML('beforeend', this.userHtml(text))
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
    if (this.layout === 'redesign') {
      // The one button turns into the stop button: new label, square icon.
      this.stopMode = true
      this.sendButton.setAttribute('aria-label', 'Stop generating')
      this.sendButton.removeAttribute('aria-disabled')
      this.sendButton.innerHTML = `<svg viewBox="0 0 20 20"><path d="${STOP_ICON_PATH}"/></svg>`
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
    if (this.layout === 'redesign') {
      if (!this.stopMode) return
      this.stopMode = false
      this.sendButton.setAttribute('aria-label', 'Send message')
      this.sendButton.innerHTML = '<svg viewBox="0 0 20 20"><path d="M10 4l5 6h-4v6H9v-6H5z"/></svg>'
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
    const id =
      'msg-' +
      (this.list.querySelectorAll(BODY).length + 1) +
      '-' +
      Math.random().toString(36).slice(2, 7)

    this.list.insertAdjacentHTML(
      'beforeend',
      this.options.unmarkedReply
        ? '<div class="mystery"><div data-body></div></div>'
        : this.assistantHtml('', {
            id,
            // Without streaming indicators a turn is born in its final state (the redesign
            // always marks turns; the old page recognised them by their role instead).
            turnState:
              this.options.streamingIndicators === false
                ? this.layout === 'redesign'
                  ? 'complete'
                  : undefined
                : 'streaming'
          })
    )
    const turn = this.list.lastElementChild as HTMLElement
    const body = turn.querySelector(BODY) as HTMLElement
    this.showStop()

    const reveal = (upTo: number) => (body.innerHTML = reply.slice(0, upTo))
    const finish = () => {
      body.innerHTML = reply
      this.hideStop()
      if (this.options.streamingIndicators !== false && !this.options.unmarkedReply)
        turn.setAttribute('data-talvt-turn-state', this.options.stuckTurnState ?? 'complete')
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
