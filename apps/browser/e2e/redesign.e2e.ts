// The same real Chromium + real extension + real hub as the other end-to-end tests, against the
// mock when it looks like the ChatGPT page since October 2026: one send/stop button, no test ids,
// no author attribute on messages, turns marked only by `data-talvt-turn-state`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { JobEvent } from '@codegent/protocol'
import { sleep, startWorld, waitUntil, type World } from './harness'

let world: World

const completed = (event: JobEvent): Extract<JobEvent, { kind: 'completed' }> => {
  if (event.kind !== 'completed') {
    throw new Error(`expected the job to complete, got ${JSON.stringify(event)}`)
  }
  return event
}

beforeAll(async () => {
  world = await startWorld()
  world.mock.layout = 'redesign'
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

const REPLY = [
  'I will add a greeting helper.',
  '',
  '### Updated file: `src/greeting.ts`',
  '',
  '```',
  '<<<<<<< SEARCH',
  'export const greet = () => "hi"',
  '=======',
  'export const greet = (name: string) => `hello ${name}`',
  '>>>>>>> REPLACE',
  '```',
  '',
  'CODEGENT_STATUS: continue'
].join('\n')

describe('the redesigned ChatGPT page', () => {
  it('sends the prompt intact and returns the reply — status line included — as markdown', async () => {
    world.mock.queueReply(REPLY, { chunks: 5, chunkMs: 40 })
    const prompt = [
      'Task: add a greeting.',
      '',
      '```',
      'const x = 1',
      '```',
      '',
      'Done?'
    ].join('\n')
    const job = world.editor.job({ text: prompt })

    const result = completed(await world.editor.run(job))

    expect(result.markdown).toBe(REPLY)
    expect(world.mock.sent).toEqual([prompt])
    expect(world.editor.kinds(job.jobId)).toEqual([
      'accepted',
      'progress:tab-ready',
      'progress:filled',
      'progress:submitted',
      'progress:generating',
      'completed'
    ])
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
    expect(world.context.pages()).toHaveLength(pagesAfterFirst)
    expect(second.conversationUrl).toBe(first.conversationUrl)
  })

  it('reopens the conversation when its tab was closed, and returns only the new reply', async () => {
    const sessionId = crypto.randomUUID()
    world.mock.queueReply('Original answer.')
    world.mock.queueReply('Answer after reopening.')
    completed(await world.editor.run(world.editor.job({ text: 'before', sessionId })))

    for (const page of world.context.pages()) await page.close()
    await sleep(300)

    const second = completed(
      await world.editor.run(
        world.editor.job({ text: 'after', sessionId, newChat: false })
      )
    )
    expect(second.markdown).toBe('Answer after reopening.')
  })

  it('reports a cancelled run and presses the stop button', async () => {
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

    expect(
      await world.editor.waitForEvent(
        job.jobId,
        (e) => e.kind === 'failed',
        'cancellation'
      )
    ).toMatchObject({ kind: 'failed', code: 'cancelled' })
    await waitUntil(
      () => world.mock.stopClicks === stopsBefore + 1,
      'the stop button to be pressed'
    )
  })

  it('refuses to run while signed out', async () => {
    world.mock.loggedOut = true
    const result = await world.editor.run(world.editor.job({ text: 'hello' }))
    expect(result).toMatchObject({ kind: 'failed', code: 'login-required' })
  })

  it('self-test passes and the report can be copied', async () => {
    const chat = await world.context.newPage()
    await chat.goto('https://chatgpt.com/')
    const popup = await world.context.newPage()
    await popup.goto(`chrome-extension://${world.extensionId}/popup.html`)
    await waitUntil(
      async () => (await popup.textContent('#tabs')) === '1',
      'the ChatGPT tab to be counted'
    )
    const sentBefore = world.mock.sent.length

    await popup.click('#selftest')
    await popup.waitForSelector('#report li', { timeout: 15_000 })
    const rows = await popup.$$eval('#report li', (items) =>
      items.map((li) => ({
        ok: li.querySelector('span')!.className === 'pass',
        name: li.querySelector('.name')!.textContent
      }))
    )
    expect(rows.filter((r) => !r.ok)).toEqual([])
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Message box', 'Entering text works', 'Send button'])
    )
    expect(await popup.isVisible('#copyreport')).toBe(true)
    expect(world.mock.sent.length).toBe(sentBefore)
    await chat.close()
    await popup.close()
  })
})
