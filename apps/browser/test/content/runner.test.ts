import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, type JobEvent, type JobRequest } from '@codegent/protocol'
import { runJob, type RunnerTiming } from '../../src/content/runner'
import {
  bareAssistantTurn,
  codeBlock,
  exchangeHtml,
  redesignCodeBlock
} from '../fixtures/chatgpt-dom'
import { FakeChat, type ChatLayout, type FakeChatOptions } from '../fixtures/fake-chat'

const FAST: RunnerTiming = {
  composerTimeoutMs: 300,
  headerRenderMs: 10,
  idleWaitMs: 150,
  newChatPauseMs: 10,
  conversationSettleMs: 1_500,
  historyStableMs: 80,
  submitConfirmMs: 250
}
const WAIT = {
  settleMs: 80,
  degradedSettleMs: 200,
  softSettleMs: 200,
  noReplyGraceMs: 200,
  pollMs: 15
}

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
let layout: ChatLayout = 'legacy'
afterEach(() => {
  chat?.dispose()
  chat = undefined
  layout = 'legacy'
  history.pushState({}, '', '/')
})

const run = async (
  job: JobRequest,
  options: FakeChatOptions = {},
  control: { abortAfterMs?: number; setup?: (chat: FakeChat) => void } = {}
) => {
  chat = new FakeChat(document, { layout, ...options })
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

const failure = (events: JobEvent[]) => {
  const last = terminal(events)
  if (last.kind !== 'failed')
    throw new Error(`expected failure, got ${JSON.stringify(last)}`)
  return last
}

/** History that shows up late, the way a reopened conversation renders. */
const staleReply = (kind: ChatLayout): string =>
  ({
    legacy:
      '<section><div data-message-author-role="assistant" data-message-id="old-1"><div class="markdown"><p>Stale reply.</p></div></div></section>',
    bare: bareAssistantTurn('<p>Stale reply.</p>', 'complete'),
    redesign: exchangeHtml({
      n: 0,
      state: 'complete',
      user: 'an earlier question',
      assistant: { id: 'old-1', html: '<p>Stale reply.</p>' }
    })
  })[kind]

describe.each(['legacy', 'redesign', 'bare'] as const)(
  'a successful run (%s page)',
  (kind) => {
    beforeEach(() => {
      layout = kind
    })
    const reply =
      '<p>Done.</p><h3>Updated file: <code>src/a.ts</code></h3>' +
      (kind === 'redesign'
        ? redesignCodeBlock('TypeScript', 'export const a = 1')
        : codeBlock('ts', 'export const a = 1'))

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
        // The redesigned page does not tell the language of a code block.
        expect(done.markdown).toBe(
          `Done.\n\n### Updated file: \`src/a.ts\`\n\n\`\`\`${kind === 'redesign' ? '' : 'ts'}\nexport const a = 1\n\`\`\``
        )
        expect(done.conversationUrl).toBe(document.location.href)
        if (kind !== 'bare') expect(done.messageId).toMatch(/^msg-/)
        expect(done.durationMs).toBeGreaterThan(0)
      }
    })

    it('does not mistake its own prompt for the reply, even when the reply starts alike', async () => {
      const job = makeJob({ text: 'Hello' })
      const { events } = await run(job, { reply: '<p>Hello! How can I help?</p>' })
      const done = terminal(events)
      expect(done.kind === 'completed' && done.markdown).toBe('Hello! How can I help?')
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
          setup: () => {
            setTimeout(() => {
              document
                .getElementById('thread')!
                .insertAdjacentHTML('afterbegin', staleReply(kind))
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

    it('completes even when a "streaming" hint never clears after the reply is done', async () => {
      const { events } = await run(makeJob(), {
        reply: '<p>Finished.</p>',
        stuckTurnState: 'streaming'
      })
      const done = terminal(events)
      expect(done.kind === 'completed' && done.markdown).toBe('Finished.')
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
  }
)

describe.each(['legacy', 'redesign', 'bare'] as const)('failures (%s page)', (kind) => {
  beforeEach(() => {
    layout = kind
  })

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

  it('times out when ChatGPT never finishes, naming any dialog and what the page looked like', async () => {
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
    expect(f.message).toMatch(/Page: .*turns=1/)
    expect(f.message).toMatch(/Seen: .*generating/)
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

  it('fails fast, naming the page, when the reply is shown in markup it cannot read', async () => {
    const started = Date.now()
    const { events } = await run(makeJob({ timeoutMs: 20_000 }), {
      reply: '<p>You cannot see me.</p>',
      unmarkedReply: true
    })
    const f = failure(events)
    expect(f.code).toBe('page-error')
    expect(f.message).toMatch(/could not find its reply/)
    expect(f.message).toMatch(/Page: .*composer=/)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('robustness against a page that is not quite what we expect', () => {
  beforeEach(() => {
    layout = 'redesign'
  })

  it('does not wait for a stale “streaming” hint from an old turn before sending', async () => {
    const { events } = await run(
      makeJob({ newChat: false }),
      { reply: '<p>Sent anyway.</p>' },
      {
        setup: () =>
          document
            .getElementById('thread')!
            .insertAdjacentHTML(
              'beforeend',
              '<div data-talvt-turn-state="streaming"><p>left over</p></div>'
            )
      }
    )
    const done = terminal(events)
    expect(done.kind === 'completed' && done.markdown).toBe('Sent anyway.')
  })

  it('reports an answer without readable text instead of completing with an empty reply', async () => {
    layout = 'bare' // a turn the page marks only by its state: the whole turn is converted
    const { events } = await run(makeJob(), {
      reply: '<span class="sr-only">only for screen readers</span>'
    })
    const f = failure(events)
    expect(f.code).toBe('page-error')
    expect(f.message).toMatch(/no text could be read/)
    expect(f.message).toMatch(/Page: .*turns=2/)
  })
})

describe('failures that do not depend on the page layout', () => {
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
