import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describePage, pageOutline } from '../../src/content/describe'
import { runSelfTest } from '../../src/content/diagnostics'
import { messagesToMarkdown } from '../../src/content/markdown'
import { codeBlock, redesignAssistantTurn } from '../fixtures/chatgpt-dom'
import { FakeChat, type ChatLayout } from '../fixtures/fake-chat'

let chat: FakeChat | undefined
afterEach(() => {
  chat?.dispose()
  chat = undefined
})

describe.each(['legacy', 'redesign'] as const)(
  'self-test (%s page)',
  (layout: ChatLayout) => {
    beforeEach(() => {
      chat = new FakeChat(document, {
        layout,
        existing: [
          { role: 'user', html: 'a secret question about payroll', id: 'u1' },
          { role: 'assistant', html: '<p>an answer mentioning payroll</p>', id: 'a1' }
        ]
      })
    })

    it('passes on a healthy page and attaches an outline for bug reports', async () => {
      const report = await runSelfTest(document, { probeFill: true })
      // (the host check is about the address bar, which a unit test page does not have)
      expect(report.checks.filter((c) => !c.ok && c.name !== 'ChatGPT page')).toEqual([])
      const names = report.checks.map((c) => c.name)
      expect(names).toEqual(
        expect.arrayContaining([
          'Message box',
          'Send button',
          'Conversation turns',
          'Reply readable'
        ])
      )
      expect(report.outline).toMatch(/--- message box area ---/)
      expect(report.outline).toMatch(/--- last two turns \(2 in total\) ---/)
      expect(chat!.composer.textContent).toBe('') // the probe marker was cleaned up
    })

    it('describes the page in one line without quoting the conversation', () => {
      const line = describePage(document)
      expect(line).not.toMatch(/\n/)
      expect(line).toMatch(/composer=div via /)
      expect(line).toMatch(/turns=2 \[/)
      expect(line).toMatch(/stop=none/)
      expect(line).not.toMatch(/payroll/)
    })

    it('shows only the first words of each text node in the outline', () => {
      const outline = pageOutline(document)
      expect(outline).toMatch(/"a secret question ab"/)
      expect(outline).not.toMatch(/payroll/)
    })
  }
)

describe('describePage', () => {
  it('names the stop button, the dialog and the turn states while a reply streams', () => {
    document.body.innerHTML =
      '<main><div data-talvt-turn-state="streaming" data-turn-id="t1"><p>x</p></div>' +
      '<form><div contenteditable="true"></div><button type="submit" data-composer-submit ' +
      'aria-label="Stop generating" data-stop-label="Stop generating"></button></form></main>' +
      '<div role="dialog">Allow ChatGPT to use GitHub?</div>'
    const line = describePage(document)
    expect(line).toMatch(/stop=button\[aria-label="Stop generating"\]/)
    expect(line).toMatch(/turns=1 \[\?\/streaming\/1ch\]/)
    expect(line).toMatch(/dialog="Allow ChatGPT to use GitHub\?"/)
    expect(line).toMatch(/last-turn-data=\[data-talvt-turn-state data-turn-id\]/)
  })
})

describe('messagesToMarkdown on whole turns', () => {
  it('drops screen-reader labels, hidden parts and action buttons', () => {
    document.body.innerHTML = redesignAssistantTurn(
      '<p>Done.</p><h3>Updated file: <code>src/a.ts</code></h3>' +
        codeBlock('ts', 'export const a = 1') +
        '<span aria-hidden="true">decoration</span>',
      'complete'
    )
    const turn = document.body.firstElementChild!
    expect(messagesToMarkdown([turn])).toBe(
      'Done.\n\n### Updated file: `src/a.ts`\n\n```ts\nexport const a = 1\n```'
    )
  })

  it('prefers the marked message inside a turn over the turn itself', () => {
    document.body.innerHTML =
      '<article><h6 class="sr-only">ChatGPT said:</h6>' +
      '<div data-message-author-role="assistant"><div class="markdown"><p>Only this.</p></div></div>' +
      '<div><span>Thought for 4 seconds</span></div></article>'
    expect(messagesToMarkdown([document.querySelector('article')!])).toBe('Only this.')
  })
})
