import {
  newId,
  type BrowserInfo,
  type JobEvent,
  type JobRequest
} from '@codegent/protocol'
import {
  ChatError,
  type ChatPort,
  type ChatReply,
  type ChatRequest
} from '@codegent/engine'
import type { BridgeConnection } from './hub-connection'

export interface BridgeChatOptions {
  chatUrl: () => string
  autoSubmit: () => boolean
  replyTimeoutMs: () => number
  browserWaitMs: () => number
  /** Asked when several browsers are connected and none was chosen before. */
  chooseBrowser: (browsers: readonly BrowserInfo[]) => Promise<string | undefined>
  preferredBrowserId?: () => string | undefined
  rememberBrowser?: (id: string) => void
  now?: () => number
  /** Extra time allowed on top of the browser-side timeout; tests shorten it. */
  graceMs?: number
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })

/** Grace added to the browser-side timeout so the browser's own verdict arrives first. */
const REPLY_GRACE_MS = 30_000

/** Sends one message to ChatGPT through the hub and waits for the reply. */
export class BridgeChat implements ChatPort {
  constructor(
    private readonly connection: BridgeConnection,
    private readonly options: BridgeChatOptions
  ) {}

  async send(request: ChatRequest): Promise<ChatReply> {
    const browserId = await this.waitForBrowser(request)
    if (request.signal.aborted) throw new ChatError('cancelled', 'cancelled')

    const job: JobRequest = {
      jobId: newId(),
      sessionId: request.sessionId,
      editorId: this.connection.editorId,
      text: request.text,
      newChat: request.newChat,
      chatUrl: this.options.chatUrl(),
      autoSubmit: this.options.autoSubmit(),
      timeoutMs: this.options.replyTimeoutMs(),
      browserId
    }
    return new Promise<ChatReply>((resolve, reject) => {
      let settled = false
      const settle = (action: () => void) => {
        if (settled) return
        settled = true
        offEvents()
        clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
        action()
      }
      const handle = (event: JobEvent) => {
        switch (event.kind) {
          case 'accepted':
            return
          case 'progress':
            request.onProgress?.(event.stage)
            return
          case 'completed':
            return settle(() =>
              resolve({
                markdown: event.markdown,
                conversationUrl: event.conversationUrl,
                durationMs: event.durationMs
              })
            )
          case 'failed':
            return settle(() => reject(new ChatError(event.code, event.message)))
        }
      }
      const offEvents = this.connection.onEvent((incoming) => {
        if (incoming.jobId === job.jobId) handle(incoming.event)
      })
      const onAbort = () => {
        this.connection.cancel({ jobId: job.jobId, sessionId: job.sessionId, browserId })
        settle(() => reject(new ChatError('cancelled', 'cancelled')))
      }
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(new ChatError('timeout', 'ChatGPT did not answer in time.'))
          ),
        job.timeoutMs + (this.options.graceMs ?? REPLY_GRACE_MS)
      )
      request.signal.addEventListener('abort', onAbort, { once: true })

      if (!this.connection.submit(job)) {
        settle(() =>
          reject(new ChatError('bridge', 'The connection to the CodeGent hub was lost.'))
        )
      }
    })
  }

  /** Waits (up to the configured time) for the hub and a browser, then picks which browser to use. */
  private async waitForBrowser(request: ChatRequest): Promise<string> {
    const now = this.options.now ?? Date.now
    const deadline = now() + this.options.browserWaitMs()
    let announced = false
    for (;;) {
      if (request.signal.aborted) throw new ChatError('cancelled', 'cancelled')
      if (this.connection.state === 'connected') {
        const browsers = this.connection.browsers
        const preferred = this.options.preferredBrowserId?.()
        if (preferred && browsers.some((browser) => browser.id === preferred))
          return preferred
        if (browsers.length === 1) return browsers[0]!.id
        if (browsers.length > 1) {
          const chosen = await this.options.chooseBrowser(browsers)
          if (!chosen) throw new ChatError('ambiguous-browser', 'No browser was chosen.')
          this.options.rememberBrowser?.(chosen)
          return chosen
        }
      }
      if (now() >= deadline) {
        throw this.connection.state === 'connected'
          ? new ChatError('no-browser', 'No browser extension is connected.')
          : new ChatError('bridge', 'CodeGent could not reach its local hub.')
      }
      if (!announced) {
        announced = true
        request.onProgress?.('waiting-for-browser')
      }
      await sleep(250, request.signal)
    }
  }
}
