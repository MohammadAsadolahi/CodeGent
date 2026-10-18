// The conversation as chatgpt.com rendered it on 2026-10-18: one container per exchange that holds
// the user's message, the agent's activity row, the assistant's message and a row of buttons. The
// first real run failed here — the reply shared a container with the prompt and was thrown away
// together with it.
import { beforeEach, describe, expect, it } from 'vitest'
import { messagesToMarkdown } from '../../src/content/markdown'
import { freshReplyElements, takeSnapshot } from '../../src/content/observe'
import { listAssistantMessages, messageId } from '../../src/content/selectors'
import { codeBlock, exchangeHtml } from '../fixtures/chatgpt-dom'

const PROMPT =
  'You are working on the GitHub repository octo/project. Make exactly two small changes and nothing else.'
const REPLY =
  '<p>Done.</p><h3>Updated file: <code>src/a.ts</code></h3>' +
  codeBlock('ts', 'export const a = 1')
const REPLY_MARKDOWN =
  'Done.\n\n### Updated file: `src/a.ts`\n\n```ts\nexport const a = 1\n```'

const page = (...exchanges: string[]): void => {
  document.body.innerHTML = `<main><div id="thread">${exchanges.join('')}</div></main>`
}

/** What is left of the page when it carries none of the markers it carries today. */
const withoutMarkers = (html: string): string =>
  html.replace(
    / data-(content-search-unit-key|chatgpt-search-unit-key|chatgpt-search-message-ids|chatgpt-selection-message-id|chatgpt-selection-conversation-id|dil-source-message-id|chatgpt-copy-reference|markdown-copy|markdown-text-style|conversation-role|user-message-bubble|chatgpt-agent-turn-start)="[^"]*"/g,
    ''
  )

const finished = (n = 1, id = 'msg-1') =>
  exchangeHtml({
    n,
    state: 'complete',
    user: PROMPT,
    assistant: { id, html: REPLY }
  })

describe('the exchange container of the redesigned page', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reads the reply from the message the page marks as the assistant’s', () => {
    page()
    const snapshot = takeSnapshot(document)
    page(finished())

    const fresh = freshReplyElements(document, snapshot, PROMPT)

    expect(fresh).toHaveLength(1)
    expect(messageId(fresh[0]!)).toBe('msg-1')
    expect(messagesToMarkdown(fresh)).toBe(REPLY_MARKDOWN)
  })

  it('counts one message once, although a page may mark it in two ways', () => {
    page(
      finished().replace(
        '<div data-markdown-text-style="assistant-message">',
        '<div data-message-author-role="assistant" data-markdown-text-style="assistant-message">'
      )
    )
    expect(listAssistantMessages(document)).toHaveLength(1)
  })

  it('finds the same reply when the page carries none of its markers (the generic fallback)', () => {
    page()
    const snapshot = takeSnapshot(document)
    page(withoutMarkers(finished()))

    const fresh = freshReplyElements(document, snapshot, PROMPT)

    expect(fresh.length).toBeGreaterThan(0)
    // Neither the user’s bubble nor the activity row nor the buttons are part of it.
    expect(messagesToMarkdown(fresh)).toBe(REPLY_MARKDOWN)
  })

  it('has no reply yet while the container holds only the user’s message', () => {
    page()
    const snapshot = takeSnapshot(document)
    page(exchangeHtml({ n: 1, state: 'streaming', user: PROMPT }))

    expect(freshReplyElements(document, snapshot, PROMPT)).toEqual([])
    page(withoutMarkers(exchangeHtml({ n: 1, state: 'streaming', user: PROMPT })))
    expect(freshReplyElements(document, snapshot, PROMPT)).toEqual([])
  })

  it('returns only the newest exchange of a conversation that already has history', () => {
    page(finished(1, 'msg-old'))
    const snapshot = takeSnapshot(document)
    const reply = '<p>Second answer.</p>'
    page(
      finished(1, 'msg-old'),
      exchangeHtml({
        n: 2,
        state: 'complete',
        user: 'next task',
        assistant: { id: 'msg-new', html: reply }
      })
    )

    expect(messagesToMarkdown(freshReplyElements(document, snapshot, 'next task'))).toBe(
      'Second answer.'
    )
  })

  it('does the same for a follow-up when no marker is available', () => {
    page(withoutMarkers(finished(1, 'msg-old')))
    const snapshot = takeSnapshot(document)
    page(
      withoutMarkers(finished(1, 'msg-old')),
      withoutMarkers(
        exchangeHtml({
          n: 2,
          state: 'complete',
          user: 'next task',
          assistant: { id: 'msg-new', html: '<p>Second answer.</p>' }
        })
      )
    )

    expect(messagesToMarkdown(freshReplyElements(document, snapshot, 'next task'))).toBe(
      'Second answer.'
    )
  })

  it('takes a reply that starts like the prompt as a reply, not as the prompt', () => {
    page()
    const snapshot = takeSnapshot(document)
    page(
      withoutMarkers(
        exchangeHtml({
          n: 1,
          state: 'complete',
          user: 'Hello',
          assistant: { id: 'm', html: '<p>Hello! How can I help?</p>' }
        })
      )
    )

    expect(messagesToMarkdown(freshReplyElements(document, snapshot, 'Hello'))).toBe(
      'Hello! How can I help?'
    )
  })
})
