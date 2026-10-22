import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Hub } from '@codegent/hub'
import { ChatError } from '@codegent/engine'
import { newId, type BrowserInfo, type JobRequest } from '@codegent/protocol'
import { BridgeChat, type BridgeChatOptions } from '../../src/bridge/bridge-chat'
import {
  HubConnection,
  type BridgeConnection,
  type HubEvent
} from '../../src/bridge/hub-connection'
import { FakeBrowser, sleep, until } from '../support/fake-browser'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const startHub = async () => {
  const hub = new Hub({ port: 0, idleExitMs: 0, version: 'test' })
  await hub.start()
  cleanups.push(() => hub.stop())
  return hub
}

const connectEditor = async (
  hub: Hub,
  overrides: Partial<ConstructorParameters<typeof HubConnection>[0]> = {}
) => {
  const connection = new HubConnection({
    hubScriptPath: 'unused',
    version: 'test',
    ensure: async () => ({ port: hub.port, health: hub.health() }),
    ...overrides
  })
  connection.start()
  cleanups.push(() => connection.stop())
  await until(() => connection.state === 'connected', 'the editor to connect')
  return connection
}

const chatOptions = (over: Partial<BridgeChatOptions> = {}): BridgeChatOptions => ({
  chatUrl: () => 'https://chatgpt.com/',
  autoSubmit: () => true,
  replyTimeoutMs: () => 5_000,
  browserWaitMs: () => 2_000,
  chooseBrowser: async (browsers) => browsers[0]?.id,
  ...over
})

const request = (
  text = 'hello',
  over: Partial<Parameters<BridgeChat['send']>[0]> = {}
) => ({
  sessionId: newId(),
  text,
  newChat: true,
  signal: new AbortController().signal,
  ...over
})

describe('HubConnection', () => {
  it('connects as an editor and reports the connected browsers as they come and go', async () => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    expect(connection.browsers).toEqual([])
    const seen: number[] = []
    connection.onPeers((list) => seen.push(list.length))

    const browser = await new FakeBrowser(hub.port).connect()
    await until(() => connection.browsers.length === 1, 'the browser to appear')
    expect(connection.browsers[0]).toMatchObject({ id: browser.id, name: 'Chrome' })
    browser.close()
    await until(() => connection.browsers.length === 0, 'the browser to disappear')
    expect(seen).toEqual([1, 0])
  })

  it('delivers job events to listeners and sends jobs and cancels to the browser', async () => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    const browser = await new FakeBrowser(hub.port).connect()
    await until(() => connection.browsers.length === 1, 'the browser to appear')

    const events: HubEvent[] = []
    connection.onEvent((event) => events.push(event))
    const job: JobRequest = {
      jobId: newId(),
      sessionId: newId(),
      editorId: connection.editorId,
      text: 'hi',
      newChat: true,
      chatUrl: 'https://chatgpt.com/',
      autoSubmit: true,
      timeoutMs: 5_000
    }
    expect(connection.submit(job)).toBe(true)
    await until(() => browser.jobs.length === 1, 'the job to reach the browser')
    browser.reply(job, { kind: 'progress', stage: 'filled' })
    await until(() => events.length === 1, 'the event to arrive')
    expect(events[0]).toMatchObject({
      jobId: job.jobId,
      event: { kind: 'progress', stage: 'filled' }
    })

    connection.cancel({ jobId: job.jobId, sessionId: job.sessionId })
    await until(() => browser.cancels.length === 1, 'the cancel to reach the browser')
  })

  it('refuses to submit while offline', async () => {
    const connection = new HubConnection({
      hubScriptPath: 'x',
      version: 't',
      ensure: async () => {
        throw new Error('no hub')
      }
    })
    expect(connection.submit({} as JobRequest)).toBe(false)
  })

  it('reconnects with the same identity after the hub restarts', async () => {
    const hub = new Hub({ port: 0, idleExitMs: 0 })
    await hub.start()
    const port = hub.port
    const connection = new HubConnection({
      hubScriptPath: 'x',
      version: 't',
      ensure: async () => ({ port, health: hub.health() })
    })
    connection.start()
    cleanups.push(() => connection.stop())
    await until(() => connection.state === 'connected', 'initial connect')
    const id = connection.editorId

    await hub.stop()
    await until(
      () => connection.state === 'offline',
      'the connection to notice the hub is gone'
    )
    const second = new Hub({ port, idleExitMs: 0 })
    await second.start()
    cleanups.push(() => second.stop())
    await until(() => connection.state === 'connected', 'the editor to reconnect', 15_000)
    expect(connection.editorId).toBe(id)
  })

  it('takes a new id when another window replaces its connection', async () => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    const original = connection.editorId
    const intruder = new WebSocket(
      `ws://127.0.0.1:${hub.port}/ws?role=editor&id=${original}&protocol=1`
    )
    await new Promise((resolve) => intruder.once('open', resolve))
    cleanups.push(() => intruder.terminate())
    await until(() => connection.editorId !== original, 'a new editor id')
    await until(() => connection.state === 'connected', 'reconnected under the new id')
  })

  it('can ask the hub to shut down and then finds (or starts) a fresh one', async () => {
    const hubs: Hub[] = []
    const launch = async () => {
      // Like the real process: `shutdown` from an editor makes the hub stop itself.
      const hub: Hub = new Hub({
        port: 0,
        idleExitMs: 0,
        onShutdownRequested: () => void hub.stop()
      })
      await hub.start()
      hubs.push(hub)
      cleanups.push(() => hub.stop())
      return hub
    }
    let active = await launch()
    const connection = new HubConnection({
      hubScriptPath: 'x',
      version: 't',
      ensure: async () => {
        if (!active.running) active = await launch()
        return { port: active.port, health: active.health() }
      }
    })
    connection.start()
    cleanups.push(() => connection.stop())
    await until(() => connection.state === 'connected', 'initial connect')

    await connection.restartHub()

    await until(
      () => connection.state === 'connected' && hubs.length === 2,
      'a fresh hub to be started and joined',
      15_000
    )
    expect(hubs[0]!.running).toBe(false)
    expect(hubs[1]!.running).toBe(true)
  })
})

describe('BridgeChat', () => {
  const setup = async (browserCount = 1, options: Partial<BridgeChatOptions> = {}) => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    const browsers: FakeBrowser[] = []
    for (let i = 0; i < browserCount; i++)
      browsers.push(await new FakeBrowser(hub.port).connect())
    await until(() => connection.browsers.length === browserCount, 'browsers to connect')
    return {
      hub,
      connection,
      browsers,
      chat: new BridgeChat(connection, chatOptions(options))
    }
  }

  it('sends the message as a job and resolves with the completed reply, reporting progress', async () => {
    const { browsers, chat } = await setup()
    browsers[0]!.onJob = (_job, send) => {
      send({ kind: 'accepted', tabId: 1 })
      send({ kind: 'progress', stage: 'submitted' })
      send({ kind: 'progress', stage: 'generating' })
      send({
        kind: 'completed',
        markdown: 'the reply',
        conversationUrl: 'https://chatgpt.com/c/1',
        durationMs: 42
      })
    }
    const stages: string[] = []
    const reply = await chat.send(
      request('Do the thing', { onProgress: (stage) => stages.push(stage) })
    )

    expect(reply).toEqual({
      markdown: 'the reply',
      conversationUrl: 'https://chatgpt.com/c/1',
      durationMs: 42
    })
    expect(stages).toEqual(['submitted', 'generating'])
    const job = browsers[0]!.jobs[0]!
    expect(job).toMatchObject({
      text: 'Do the thing',
      newChat: true,
      autoSubmit: true,
      chatUrl: 'https://chatgpt.com/',
      timeoutMs: 5_000
    })
    expect(job.browserId).toBe(browsers[0]!.id)
  })

  it('logs the size and shape of each reply, never its contents', async () => {
    const lines: string[] = []
    const { browsers, chat } = await setup(1, { log: (line) => lines.push(line) })
    browsers[0]!.onJob = (_job, send) =>
      send({
        kind: 'completed',
        markdown:
          'secret words\n\n### Updated file: `src/a.ts`\n\n```ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```',
        conversationUrl: 'https://chatgpt.com/c/1',
        durationMs: 1
      })
    await chat.send(request())

    expect(lines).toEqual([
      'Reply received: 96 characters, 11 lines; 1 file headings, 2 code-fence lines, 1 SEARCH/REPLACE pairs.'
    ])
    expect(lines.join('')).not.toContain('secret')
  })

  it('turns a failed job into a ChatError carrying the code', async () => {
    const { browsers, chat } = await setup()
    browsers[0]!.onJob = (_job, send) =>
      send({ kind: 'failed', code: 'rate-limited', message: 'slow down' })
    await expect(chat.send(request())).rejects.toMatchObject({
      name: 'ChatError',
      code: 'rate-limited',
      message: 'slow down'
    })
  })

  it('only listens to events of its own job', async () => {
    const { browsers, chat } = await setup()
    browsers[0]!.onJob = (job, send) => {
      browsers[0]!.reply(
        { ...job, jobId: newId() },
        {
          kind: 'completed',
          markdown: 'someone else',
          conversationUrl: 'https://chatgpt.com/c/x',
          durationMs: 1
        }
      )
      send({
        kind: 'completed',
        markdown: 'mine',
        conversationUrl: 'https://chatgpt.com/c/y',
        durationMs: 1
      })
    }
    expect((await chat.send(request())).markdown).toBe('mine')
  })

  it('cancels: tells the browser and rejects with "cancelled"', async () => {
    const { browsers, chat } = await setup()
    const controller = new AbortController()
    const pending = chat.send(request('x', { signal: controller.signal }))
    await until(() => browsers[0]!.jobs.length === 1, 'the job to reach the browser')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await until(
      () => browsers[0]!.cancels.length === 1,
      'the cancel to reach the browser'
    )
    expect(browsers[0]!.cancels[0]).toMatchObject({ jobId: browsers[0]!.jobs[0]!.jobId })
  })

  it('gives up with "timeout" if the browser never reports back', async () => {
    const { browsers, chat } = await setup(1, {
      replyTimeoutMs: () => 1_000,
      graceMs: 100
    })
    const started = Date.now()
    await expect(chat.send(request())).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(browsers[0]!.jobs).toHaveLength(1)
  })

  it('waits for a browser to connect (announcing it), then carries on', async () => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    const chat = new BridgeChat(connection, chatOptions({ browserWaitMs: () => 5_000 }))
    const stages: string[] = []
    const pending = chat.send(request('x', { onProgress: (stage) => stages.push(stage) }))
    await sleep(400)
    const browser = await new FakeBrowser(hub.port).connect()
    browser.onJob = (_job, send) =>
      send({
        kind: 'completed',
        markdown: 'late browser',
        conversationUrl: 'https://chatgpt.com/c/1',
        durationMs: 1
      })
    expect((await pending).markdown).toBe('late browser')
    expect(stages).toContain('waiting-for-browser')
  })

  it('fails with "no-browser" when none shows up in time, "bridge" when the hub itself is unreachable', async () => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    const chat = new BridgeChat(connection, chatOptions({ browserWaitMs: () => 300 }))
    await expect(chat.send(request())).rejects.toMatchObject({ code: 'no-browser' })

    const offline: BridgeConnection = {
      editorId: 'e',
      state: 'offline',
      browsers: [],
      submit: () => false,
      cancel: () => {},
      onEvent: () => () => {},
      onPeers: () => () => {},
      onState: () => () => {}
    }
    await expect(
      new BridgeChat(offline, chatOptions({ browserWaitMs: () => 200 })).send(request())
    ).rejects.toMatchObject({ code: 'bridge' })
  })

  it('can be cancelled while waiting for a browser', async () => {
    const hub = await startHub()
    const connection = await connectEditor(hub)
    const chat = new BridgeChat(connection, chatOptions({ browserWaitMs: () => 10_000 }))
    const controller = new AbortController()
    const pending = chat.send(request('x', { signal: controller.signal }))
    await sleep(100)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('asks which browser to use when several are connected, and remembers the answer', async () => {
    const asked: string[][] = []
    const remembered: string[] = []
    let preferred: string | undefined
    const { browsers, chat } = await setup(2, {
      chooseBrowser: async (list) => {
        asked.push(list.map((b: BrowserInfo) => b.id))
        return list[1]!.id
      },
      rememberBrowser: (id) => {
        remembered.push(id)
        preferred = id
      },
      preferredBrowserId: () => preferred
    })
    for (const browser of browsers) {
      browser.onJob = (_job, send) =>
        send({
          kind: 'completed',
          markdown: browser.id,
          conversationUrl: 'https://chatgpt.com/c/1',
          durationMs: 1
        })
    }
    const first = await chat.send(request())
    const second = await chat.send(request())
    expect(asked).toHaveLength(1)
    expect(remembered).toHaveLength(1)
    expect(first.markdown).toBe(second.markdown)
    expect(first.markdown).toBe(remembered[0])
  })

  it('fails with "ambiguous-browser" when the user picks nothing', async () => {
    const { chat } = await setup(2, { chooseBrowser: async () => undefined })
    await expect(chat.send(request())).rejects.toMatchObject({
      code: 'ambiguous-browser'
    })
  })

  it('reports a lost connection at submit time', async () => {
    const connection: BridgeConnection = {
      editorId: 'e',
      state: 'connected',
      browsers: [
        {
          id: 'b',
          name: 'Chrome',
          userAgent: 'x',
          extensionVersion: '1',
          connectedAt: 0,
          chatgptTabs: 1
        }
      ],
      submit: () => false,
      cancel: () => {},
      onEvent: () => () => {},
      onPeers: () => () => {},
      onState: () => () => {}
    }
    await expect(
      new BridgeChat(connection, chatOptions()).send(request())
    ).rejects.toBeInstanceOf(ChatError)
  })
})
