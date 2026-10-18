import https from 'node:https'

// The pretend chatgpt.com has a throw-away certificate.
const agent = new https.Agent({ rejectUnauthorized: false })

const call = <T>(port: number, path: string, body?: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = https.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: payload === undefined ? 'GET' : 'POST',
        agent,
        headers:
          payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
              }
      },
      (response) => {
        let text = ''
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(text || '{}') as T)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.on('error', reject)
    request.end(payload)
  })

export interface MockLog {
  /** The messages submitted in the pretend ChatGPT, in order. */
  sent: string[]
  stopClicks: number
  loggedOut: boolean
  layout: 'legacy' | 'redesign'
  queued: number
}

/** Remote control of the pretend chatgpt.com that the real browser extension talks to. */
export class MockChatGpt {
  constructor(private readonly port: number) {}

  /** The next message gets this reply. `hold` keeps the page "generating" until `release()`. */
  async queueReply(markdown: string, options: { hold?: boolean } = {}): Promise<void> {
    await call(this.port, '/__mock/control/queue', { markdown, ...options })
  }
  async release(): Promise<void> {
    await call(this.port, '/__mock/control/release', {})
  }
  async setLoggedOut(loggedOut: boolean): Promise<void> {
    await call(this.port, '/__mock/control/set', { loggedOut })
  }
  /** Which generation of the ChatGPT page the pretend site imitates. */
  async setLayout(layout: 'legacy' | 'redesign'): Promise<void> {
    await call(this.port, '/__mock/control/set', { layout })
  }
  log(): Promise<MockLog> {
    return call<MockLog>(this.port, '/__mock/control/log')
  }
  async reset(): Promise<void> {
    await call(this.port, '/__mock/control/reset', {})
  }
}
