import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JobEvent } from '@codegent/protocol'
import { sleep, startWorld, waitUntil, type World } from './harness'

let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world?.close()
})

const terminal = (e: JobEvent) => e.kind === 'completed' || e.kind === 'failed'

describe('MV3 service worker lifecycle', () => {
  it('a killed worker is revived by an open ChatGPT tab and reconnects to the hub on its own', async () => {
    const page = await world.context.newPage()
    await page.goto('https://chatgpt.com/') // an open ChatGPT tab keeps pinging the worker
    await waitUntil(
      () => world.editor.peers.length === 1,
      'the extension to be connected'
    )

    await world.killServiceWorker()
    await waitUntil(
      () => world.editor.peers.length === 0,
      'the hub to notice the worker is gone'
    )
    await waitUntil(
      () => world.editor.peers.length === 1,
      'the worker to be revived and reconnect',
      30_000
    )
    await page.close()
  })

  it('a run survives the worker being killed in the middle of it', async () => {
    world.mock.queueReply('survived the restart', { hold: true })
    const job = world.editor.job({ text: 'long task' })
    world.editor.start(job)
    await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'progress' && e.stage === 'generating',
      'generation to start'
    )

    await world.killServiceWorker()
    await sleep(500)
    world.mock.release()

    const done = await world.editor.waitForEvent(
      job.jobId,
      terminal,
      'the run to finish',
      45_000
    )
    expect(done).toMatchObject({ kind: 'completed', markdown: 'survived the restart' })
  })

  it('a worker restart does not lose the conversation: the next message continues it', async () => {
    const sessionId = crypto.randomUUID()
    world.mock.queueReply('first')
    world.mock.queueReply('second')
    const first = await world.editor.run(world.editor.job({ text: 'one', sessionId }))
    expect(first.kind).toBe('completed')

    await world.killServiceWorker()
    // The editor waits for the browser to come back before submitting (see the bridge client).
    await waitUntil(
      () => world.editor.peers.length === 0,
      'the hub to notice the worker is gone'
    )
    await waitUntil(
      () => world.editor.peers.length === 1,
      'the worker to be revived',
      30_000
    )

    const second = await world.editor.run(
      world.editor.job({ text: 'two', sessionId, newChat: false }),
      60_000
    )
    expect(second).toMatchObject({ kind: 'completed', markdown: 'second' })
    if (first.kind === 'completed' && second.kind === 'completed') {
      expect(second.conversationUrl).toBe(first.conversationUrl)
    }
  })

  it('a run whose tab is closed while the worker is dead still fails cleanly after revival', async () => {
    world.mock.queueReply('never', { hold: true })
    const job = world.editor.job({ text: 'long task' })
    world.editor.start(job)
    await world.editor.waitForEvent(
      job.jobId,
      (e) => e.kind === 'progress' && e.stage === 'generating',
      'generation to start'
    )

    await world.killServiceWorker()
    await waitUntil(
      () => world.editor.peers.length === 0,
      'the hub to notice the worker is gone'
    )
    for (const page of world.context.pages()) await page.close()

    // The closed tab fires tabs.onRemoved, which wakes the worker; it must fail the persisted job.
    const done = await world.editor.waitForEvent(
      job.jobId,
      terminal,
      'the run to fail',
      45_000
    )
    expect(done).toMatchObject({ kind: 'failed', code: 'tab-unavailable' })
  })
})
