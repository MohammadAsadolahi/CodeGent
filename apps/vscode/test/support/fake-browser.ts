import WebSocket from 'ws'
import { newId, type JobRequest } from '@codegent/protocol'

export const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls until `probe` returns something truthy. */
export const until = async (probe: () => unknown, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** A scripted browser extension speaking the real protocol to a real hub. */
export class FakeBrowser {
  readonly jobs: JobRequest[] = []
  readonly cancels: Array<{ jobId: string }> = []
  private socket!: WebSocket
  onJob: (job: JobRequest, send: (event: object) => void) => void = () => {}

  constructor(
    private readonly port: number,
    readonly id = newId()
  ) {}

  async connect(): Promise<this> {
    const query = new URLSearchParams({ role: 'browser', id: this.id, protocol: '1', name: 'Chrome', ua: 'test', ext: '0' })
    this.socket = new WebSocket(`ws://127.0.0.1:${this.port}/ws?${query}`, { origin: EXT_ORIGIN })
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.type === 'ping') this.socket.send(JSON.stringify({ type: 'pong' }))
      if (message.type === 'job') {
        this.jobs.push(message.job)
        this.onJob(message.job, (event) => this.reply(message.job, event))
      }
      if (message.type === 'cancel') this.cancels.push(message)
    })
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
    return this
  }

  reply(job: JobRequest, event: object, seq = 100): void {
    this.socket.send(JSON.stringify({ type: 'event', editorId: job.editorId, jobId: job.jobId, seq, event }))
  }

  /** Answers every job with a finished reply, the way a ChatGPT tab would. */
  answerWith(reply: (job: JobRequest, index: number) => string): void {
    this.onJob = (job, send) => {
      send({ kind: 'accepted', tabId: 1 })
      send({ kind: 'progress', stage: 'generating' })
      send({
        kind: 'completed',
        markdown: reply(job, this.jobs.length - 1),
        conversationUrl: 'https://chatgpt.com/c/test-conversation',
        durationMs: 5
      })
    }
  }

  close(): void {
    this.socket.terminate()
  }
}
