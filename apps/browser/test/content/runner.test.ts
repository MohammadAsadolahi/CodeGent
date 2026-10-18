import { afterEach, describe, expect, it } from 'vitest'
import { newId, type JobEvent, type JobRequest } from '@codegent/protocol'
import { runJob, type RunnerTiming } from '../../src/content/runner'
import { codeBlock } from '../fixtures/chatgpt-dom'
import { FakeChat, type FakeChatOptions } from '../fixtures/fake-chat'

const FAST: RunnerTiming = {
  composerTimeoutMs: 300,
  headerRenderMs: 10,
  idleWaitMs: 150,
  newChatPauseMs: 10,
  conversationSettleMs: 1_500,
  historyStableMs: 80,
  submitConfirmMs: 250
}
const WAIT = { settleMs: 80, degradedSettleMs: 200, pollMs: 15 }

const makeJob = (overrides: Partial<JobRequest> = {}): JobRequest => ({
  jobId: newId(),
  sessionId: newId(),
  editorId: newId(),
  text: 'Please add a greeting.',
  newChat: true,
  chatUrl: 'https://chatgpt.com/',
  autoSubmit: true,
  timeoutMs: 5_000,
  ...overrides
})

let chat: FakeChat | undefined
afterEach(() => {
  chat?.dispose()
  chat = undefined
  history.pushState({}, '', '/')
})

const run = async (
  job: JobRequest,
  options: FakeChatOptions = {},
  control: { abortAfterMs?: number; setup?: (chat: FakeChat) => void } = {}
) => {
  chat = new FakeChat(document, options)
  control.setup?.(chat)
  const events: JobEvent[] = []
  const controller = new AbortController()
  if (control.abortAfterMs !== undefined)
    setTimeout(() => controller.abort(), control.abortAfterMs)
  await runJob(job, {
    doc: document,
    emit: (event) => events.push(event),
    signal: controller.signal,
    wait: WAIT,
    timing: FAST
  })
  return { events, chat }
}

const terminal = (events: JobEvent[]) => events.at(-1)!
const kinds = (events: JobEvent[]) =>
  events.map((e) => (e.kind === 'progress' ? `progress:${e.stage}` : e.kind))

describe('a successful run', () => {
  const reply =
    '<p>Done.</p><h3>Updated file: <code>src/a.ts</code></h3>' +
    codeBlock('ts', 'export const a = 1')

  it('types the prompt, sends it and returns the reply as markdown', async () => {
    const job = makeJob({ text: 'Line one\nLine two with `code` and ```fence```' })
    const { events, chat } = await run(job, { reply })

    expect(kinds(events)).toEqual([
      'progress:tab-ready',
      'progress:filled',
      'progress:submitted',
      'progress:generating',
      'completed'
    ])
    expect(chat.sent).toEqual([job.text])
    const done = terminal(events)
    expect(done.kind).toBe('completed')
    if (done.kind === 'completed') {
      expect(done.markdown).toBe(
        'Done.\n\n### Updated file: `src/a.ts`\n\n```ts\nexport const a = 1\n```'
      )
      expect(done.conversationUrl).toBe(document.location.href)
      expect(done.messageId).toMatch(/^msg-/)
      expect(done.durationMs).toBeGreaterThan(0)
    }
  })

  it('returns only the new reply when the conversation already has history', async () => {
    const job = makeJob({ newChat: false })
    const { events } = await run(job, {
      reply: '<p>New answer.</p>',
      existing: [
        { role: 'user', html: 'earlier question', id: 'u1' },
        { role: 'assistant', html: '<p>Old answer.</p>', id: 'a1' }
      ]
    })
    const done = terminal(events)
    expect(done.kind === 'completed' && done.markdown).toBe('New answer.')
  })

  it('waits for a restored conversation to render before taking its snapshot', async () => {
    history.pushState({}, '', '/c/restored-1')
    const job = makeJob({ newChat: false })
    const { events } = await run(
      job,
      { reply: '<p>Fresh.</p>' },
      {
        setup: (c) => {
          // History arrives late, as it does when a conversation tab is reopened.
          setTimeout(() => {
            const thread = document.getElementById('thread')!
            thread.insertAdjacentHTML(
              'afterbegin',
              '<section><div data-message-author-role="assistant" data-message-id="old-1"><div class="markdown"><p>Stale reply.</p></div></div></section>'
            )
          }, 120)
        }
      }
    )
    const done = terminal(events)
    expect(done.kind === 'completed' && done.markdown).toBe('Fresh.')
  })

  it('keeps going through a "Continue generating" prompt', async () => {
    const { events } = await run(makeJob(), {
      reply: '<p>Part one. Part two.</p>',
      continueButton: true
    })
    const done = terminal(events)
    expect(done.kind === 'completed' && done.markdown).toBe('Part one. Part two.')
  })

  it('still completes when the page shows no streaming indicators (degraded detection)', async () => {
    const { events } = await run(makeJob(), {
      reply: '<p>No stop button here.</p>',
      streamingIndicators: false
    })
    const done = terminal(events)
    expect(done.kind === 'completed' && done.markdown).toBe('No stop button here.')
    expect(kinds(events)).not.toContain('progress:generating')
  })

  it('sends with the Enter key when the send button does nothing', async () => {
    const { events, chat } = await run(makeJob(), {
      flakyButton: true,
      reply: '<p>ok</p>'
    })
    expect(terminal(events).kind).toBe('completed')
    expect(chat.sent).toHaveLength(1)
  })

  it('waits for the user to send when autoSubmit is off', async () => {
    const job = makeJob({ autoSubmit: false })
    const { events, chat } = await run(
      job,
      { reply: '<p>manual</p>' },
      {
        setup: (c) => {
          // The user reviews the filled prompt for a moment and then presses send.
          setTimeout(() => c.submit(), 200)
        }
      }
    )
    expect(kinds(events).slice(0, 3)).toEqual([
      'progress:tab-ready',
      'progress:filled',
      'progress:submitted'
    ])
    expect(terminal(events).kind).toBe('completed')
    expect(chat.sent).toEqual([job.text])
  })
})

describe('failures', () => {
  const failure = (events: JobEvent[]) => {
    const last = terminal(events)
    if (last.kind !== 'failed')
      throw new Error(`expected failure, got ${JSON.stringify(last)}`)
    return last
  }

  it('reports login-required when the page shows login buttons', async () => {
    const { events } = await run(makeJob(), { loggedOut: true })
    expect(failure(events).code).toBe('login-required')
  })

  it('reports a verification challenge as page-error', async () => {
    document.title = 'Just a moment...'
    const { events } = await run(makeJob(), { loggedOut: false })
    expect(failure(events).code).toBe('page-error')
    expect(failure(events).message).toMatch(/verification challenge/)
  })

  it('reports composer-not-found when the page has no message box', async () => {
    document.body.innerHTML = '<main><p>nothing here</p></main>'
    const events: JobEvent[] = []
    await runJob(makeJob(), {
      doc: document,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      timing: FAST
    })
    expect(failure(events).code).toBe('composer-not-found')
  })

  it('reports rate limits shown as a dialog when no reply arrives', async () => {
    const { events } = await run(
      makeJob(),
      { silent: true, streamingIndicators: false },
      {
        setup: (c) =>
          setTimeout(
            () =>
              c.showDialog(
                "You've reached the current usage cap for GPT-5. Try again later."
              ),
            150
          )
      }
    )
    expect(failure(events).code).toBe('rate-limited')
    expect(failure(events).message).toMatch(/usage cap/)
  })

  it('times out when ChatGPT never finishes, naming any dialog it is showing', async () => {
    const job = makeJob({ timeoutMs: 700 })
    const { events } = await run(
      job,
      { silent: true },
      {
        setup: (c) => setTimeout(() => c.showDialog('Allow ChatGPT to use GitHub?'), 100)
      }
    )
    const f = failure(events)
    expect(f.code).toBe('timeout')
    expect(f.message).toMatch(/Allow ChatGPT to use GitHub/)
  })

  it('cancels mid-run: reports cancelled and presses ChatGPT’s stop button', async () => {
    const { events, chat } = await run(makeJob(), { silent: true }, { abortAfterMs: 300 })
    expect(failure(events).code).toBe('cancelled')
    expect(chat.stopClicks).toBe(1)
  })

  it('fails with submit-failed when neither the button nor Enter sends', async () => {
    const { events } = await run(makeJob(), { flakyButton: true, enterSubmits: false })
    expect(failure(events).code).toBe('submit-failed')
  })

  it('reports busy when a previous reply cannot be stopped', async () => {
    chat = new FakeChat(document, {})
    const stuck = document.createElement('button')
    stuck.type = 'button'
    stuck.setAttribute('data-testid', 'stop-button')
    stuck.textContent = 'Stop'
    document.getElementById('composer-form')!.append(stuck) // ignores clicks
    const events: JobEvent[] = []
    await runJob(makeJob(), {
      doc: document,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      timing: FAST,
      wait: WAIT
    })
    expect(failure(events).code).toBe('busy')
  })

  it('never throws out of runJob, even when the page is hostile', async () => {
    chat = new FakeChat(document, {})
    Object.defineProperty(chat.composer, 'innerText', {
      set: () => {
        throw new Error('boom')
      },
      get: () => ''
    })
    const events: JobEvent[] = []
    await expect(
      runJob(makeJob(), {
        doc: document,
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        timing: FAST
      })
    ).resolves.toBeUndefined()
    expect(terminal(events).kind).toBe('failed')
  })
})
