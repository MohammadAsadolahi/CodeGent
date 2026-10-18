import { assistantMessage, escapeHtml, userMessage } from './chatgpt-dom'

export interface FakeChatOptions {
  /** HTML placed inside the assistant's `.markdown` body. */
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
}

/**
 * A stand-in for the ChatGPT page: a contenteditable composer whose send button enables on input,
 * a conversation list, and a reply that streams in behind a stop button.
 */
export class FakeChat {
  readonly sent: string[] = []
  readonly composer: HTMLElement
  readonly sendButton: HTMLButtonElement
  private readonly list: HTMLElement
  private stopButton: HTMLButtonElement | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  stopClicks = 0

  constructor(
    private readonly doc: Document,
    private readonly options: FakeChatOptions = {}
  ) {
    doc.body.innerHTML =
      (options.loggedOut ? '<header><button data-testid="login-button">Log in</button></header>' : '<header></header>') +
      '<main><div id="thread"></div><form id="composer-form">' +
      '<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>' +
      '<button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form></main>'
    this.list = doc.getElementById('thread')!
    this.composer = doc.getElementById('prompt-textarea')!
    this.sendButton = doc.querySelector('[data-testid="send-button"]')!

    for (const item of options.existing ?? []) {
      this.list.insertAdjacentHTML(
        'beforeend',
        item.role === 'user' ? userMessage(item.html, item.id) : assistantMessage(item.html, { id: item.id, turnState: 'complete' })
      )
    }

    this.composer.addEventListener('input', () => this.syncButton())
    this.sendButton.addEventListener('click', (event) => {
      event.preventDefault()
      if (!this.options.flakyButton) this.submit()
    })
    this.composer.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter' && this.options.enterSubmits !== false) {
        event.preventDefault()
        this.submit()
      }
    })
  }

  private syncButton(): void {
    this.sendButton.disabled = (this.composer.textContent ?? '').trim() === ''
  }

  /** What a user pressing "send" does. */
  submit(): void {
    const text = (this.composer.textContent ?? '').trim()
    if (!text) return
    this.sent.push(text)
    this.composer.textContent = ''
    this.syncButton()
    this.list.insertAdjacentHTML('beforeend', userMessage(text))
    if (this.options.silent) {
      this.showStop()
      return
    }
    this.later(this.options.startDelayMs ?? 20, () => this.streamReply())
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  private showStop(): void {
    if (this.options.streamingIndicators === false) return
    this.stopButton = this.doc.createElement('button')
    this.stopButton.type = 'button'
    this.stopButton.setAttribute('data-testid', 'stop-button')
    this.stopButton.setAttribute('aria-label', 'Stop streaming')
    this.stopButton.textContent = 'Stop'
    this.stopButton.addEventListener('click', () => {
      this.stopClicks += 1
      this.clearTimers()
      this.hideStop()
    })
    this.doc.getElementById('composer-form')!.append(this.stopButton)
  }

  private hideStop(): void {
    this.stopButton?.remove()
    this.stopButton = null
  }

  /** Simulates a banner (rate limit etc.) appearing as a dialog. */
  showDialog(text: string): void {
    this.doc.body.insertAdjacentHTML('beforeend', `<div role="dialog">${escapeHtml(text)}</div>`)
  }

  private streamReply(): void {
    const reply = this.options.reply ?? '<p>OK</p>'
    const chunks = Math.max(1, this.options.streamChunks ?? 3)
    const chunkMs = this.options.chunkMs ?? 15
    const id = 'msg-' + (this.list.querySelectorAll('[data-message-author-role="assistant"]').length + 1) + '-' + Math.random().toString(36).slice(2, 7)

    this.list.insertAdjacentHTML(
      'beforeend',
      assistantMessage('', { id, turnState: this.options.streamingIndicators === false ? undefined : 'streaming' })
    )
    const turn = this.list.lastElementChild as HTMLElement
    const body = turn.querySelector('.markdown') as HTMLElement
    this.showStop()

    const reveal = (upTo: number) => (body.innerHTML = reply.slice(0, upTo))
    const finish = () => {
      body.innerHTML = reply
      this.hideStop()
      if (this.options.streamingIndicators !== false) turn.setAttribute('data-talvt-turn-state', 'complete')
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
