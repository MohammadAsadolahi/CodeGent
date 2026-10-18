import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { extensionIdFromKey } from '@codegent/hub'
import type { JobEvent } from '@codegent/protocol'
import { E2E_PORTS, sleep, startWorld, waitUntil, type World } from './harness'

let world: World

/** Narrows a terminal event to `completed`, failing with the full payload otherwise. */
const completed = (event: JobEvent): Extract<JobEvent, { kind: 'completed' }> => {
  if (event.kind !== 'completed') {
    throw new Error(
      `expected the job to complete, got ${JSON.stringify(event)}\nhub log:\n${world.hubLog.slice(-12).join('\n')}`
    )
  }
  return event
}

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world?.close()
})
afterEach(async () => {
  world.mock.loggedOut = false
  for (const page of world.context.pages()) await page.close().catch(() => undefined)
  await waitUntil(
    () => world.editor.peers[0]?.chatgptTabs === 0,
    'the tab count to drop to 0'
  ).catch(() => undefined)
})

describe('identity', () => {
  it('has the id that follows from the key pinned in its manifest — the id the hub is told to allow', () => {
    const { key } = JSON.parse(
      fs.readFileSync(
        fileURLToPath(new URL('../static/manifest.json', import.meta.url)),
        'utf8'
      )
    )
    expect(world.extensionId).toBe(extensionIdFromKey(key))
  })
})

const REPLY = [
  'I will add a greeting helper.',
  '',
  '### Updated file: `src/greeting.ts`',
  '',
  '```ts',
  '<<<<<<< SEARCH',
  'export const greet = () => "hi"',
  '=======',
  'export const greet = (name: string) => `hello ${name}`',
  '>>>>>>> REPLACE',
  '```',
  '',
  'CODEGENT_STATUS: done'
].join('\n')

describe('connection', () => {
  it('the extension connects to the hub and identifies itself', () => {
    const [peer] = world.editor.peers
    expect(peer).toMatchObject({ name: 'Chrome', chatgptTabs: 0 })
  })

  it('web pages cannot connect to the hub, in either role', async () => {
    const page = await world.context.newPage()
    await page.goto('https://chatgpt.com/')
    const opened = await page.evaluate(
      (port) =>
        new Promise<Record<string, boolean>>((resolve) => {
          const results: Record<string, boolean> = {}
          let pending = 2
          for (const role of ['editor', 'browser']) {
            const socket = new WebSocket(
              `ws://127.0.0.1:${port}/ws?role=${role}&id=evil-${role}&protocol=1`
            )
            let didOpen = false
            socket.onopen = () => {
              didOpen = true
              socket.close()
            }
            socket.onerror = () => undefined
            socket.onclose = () => {
              results[role] = didOpen
              if (--pending === 0) resolve(results)
            }
          }
        }),
      E2E_PORTS[0]!
    )
    expect(opened).toEqual({ editor: false, browser: false })
    expect(
      world.hubLog.filter((line) => line.includes('origin not allowed')).length
    ).toBeGreaterThanOrEqual(2)
    expect(world.hub.health()).toMatchObject({ editors: 1, browsers: 1 })
  })
})

describe('a job', () => {
  it('opens ChatGPT, sends the prompt intact and returns the reply as markdown', async () => {
    world.mock.queueReply(REPLY)
    const prompt = [
      'Task: add a greeting.',
      '',
      'Rules:',
      '- use `greet()`',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'Done?'
    ].join('\n')
    const job = world.editor.job({ text: prompt })

    const result = completed(await world.editor.run(job))

    expect(result.markdown).toBe(REPLY)
    expect(result.conversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/conv-/)
    expect(world.mock.sent).toEqual([prompt])
    expect(world.editor.kinds(job.jobId)).toEqual([
      'accepted',
      'progress:tab-ready',
      'progress:filled',
      'progress:submitted',
      'progress:generating',
      'completed'
    ])
    await waitUntil(
      () => world.editor.peers[0]?.chatgptTabs === 1,
      'presence to report the ChatGPT tab'
    )
  })

  it('continues in the same conversation and tab for follow-ups', async () => {
    const sessionId = crypto.randomUUID()
    world.mock.queueReply('First answer.')
    world.mock.queueReply('Second answer.')
    const first = completed(
      await world.editor.run(world.editor.job({ text: 'step one', sessionId }))
    )
    const pagesAfterFirst = world.context.pages().length

    const second = completed(
      await world.editor.run(
        world.editor.job({ text: 'step two', sessionId, newChat: false })
      )
    )

    expect(second.markdown).toBe('Second answer.')
    expect(world.context.pages()).toHaveLength(pagesAfterFirst) // same tab
    expect(world.mock.sent.slice(-2)).toEqual(['step one', 'step two'])
    expect(second.conversationUrl).toBe(first.conversationUrl)
  })

  it('reopens the conversation when its tab was closed, and waits for history to load', async () => {
    const sessionId = crypto.randomUUID()
    world.mock.queueReply('Original answer.')
    world.mock.queueReply('Answer after reopening.')
    const first = completed(
      await world.editor.run(world.editor.job({ text: 'before', sessionId }))
    )

    for (const page of world.context.pages()) await page.close()
    await sleep(300)

    const second = completed(
      await world.editor.run(
        world.editor.job({ text: 'after', sessionId, newChat: false })
      )
    )
    expect(second.markdown).toBe('Answer after reopening.')
    expect(world.context.pages().map((p) => p.url())).toContain(first.conversationUrl)
  })

  it('starts a new chat in the idle tab instead of piling up tabs', async () => {
    world.mock.queueReply('one')
    world.mock.queueReply('two')
    completed(await world.editor.run(world.editor.job({ text: 'a' })))
    const tabs = world.context.pages().length
    completed(await world.editor.run(world.editor.job({ text: 'b' })))
    expect(world.context.pages()).toHaveLength(tabs)
  })
})

describe('when things go wrong', () => {
  it('reports a cancelled run and presses ChatGPT’s stop button', async () => {
    world.mock.queueReply('never finishes', { hold: true })
    const job = world.editor.job({ text: 'long task' })
    world.editor.start(job)
    await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'progress' && e.stage === 'generating',
      'generation to start'
    )
    const stopsBefore = world.mock.stopClicks

    world.editor.send({ type: 'cancel', jobId: job.jobId, sessionId: job.sessionId })

    const result = await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'failed',
      'cancellation'
    )
    expect(result).toMatchObject({ kind: 'failed', code: 'cancelled' })
    await waitUntil(
      () => world.mock.stopClicks === stopsBefore + 1,
      'the stop button to be pressed'
    )
  })

  it('reports a closed tab instead of hanging', async () => {
    world.mock.queueReply('never finishes', { hold: true })
    const job = world.editor.job({ text: 'long task' })
    world.editor.start(job)
    await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'progress' && e.stage === 'generating',
      'generation to start'
    )

    for (const page of world.context.pages()) await page.close()

    const result = await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'failed',
      'a failure'
    )
    expect(result).toMatchObject({ kind: 'failed', code: 'tab-unavailable' })
  })

  it('refuses to run while signed out', async () => {
    world.mock.loggedOut = true
    const result = await world.editor.run(world.editor.job({ text: 'hello' }))
    expect(result).toMatchObject({ kind: 'failed', code: 'login-required' })
  })

  it('rejects a follow-up for a conversation it has never seen', async () => {
    const result = await world.editor.run(world.editor.job({ text: 'x', newChat: false }))
    expect(result).toMatchObject({ kind: 'failed', code: 'tab-unavailable' })
  })
})

describe('resilience', () => {
  it('reconnects by itself after the hub restarts, and keeps working', async () => {
    await world.restartHub()
    await world.editor.reconnect()
    await waitUntil(
      () => world.editor.peers.length === 1,
      'the extension to find the restarted hub',
      30_000
    )

    world.mock.queueReply('still here')
    const result = completed(
      await world.editor.run(world.editor.job({ text: 'ping after restart' }))
    )
    expect(result.markdown).toBe('still here')
  })

  it('delivers a reply produced while the editor was disconnected (window reload)', async () => {
    world.mock.queueReply('late reply', { chunks: 3, chunkMs: 400 })
    const job = world.editor.job({ text: 'slow task' })
    world.editor.start(job)
    await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'progress' && e.stage === 'submitted',
      'the prompt to be sent'
    )

    await world.editor.reconnect() // same editor id, as a reloaded window would use
    const result = await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'completed',
      'the reply after reconnecting'
    )
    expect(completed(result).markdown).toBe('late reply')
  })
})
