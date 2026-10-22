import { beforeEach, describe, expect, it } from 'vitest'
import { messagesToMarkdown, replyBodies } from '../../src/content/markdown'
import {
  fenceMarkerRegions,
  hasUnfencedMarkers,
  layoutText,
  recoverEditBlocks
} from '../../src/content/recover'
import { assistantMessage, codeBlock, escapeHtml, setBody } from '../fixtures/chatgpt-dom'

/**
 * A code viewer that draws every line as an element of its own, with no newline in the text (an
 * empty line holds a <br>, as it must to take up a line on the page).
 */
const lineViewer = (lines: readonly string[]): string =>
  `<div class="viewer">${lines
    .map(
      (line) =>
        `<div class="line" style="white-space: pre">${line === '' ? '<br>' : escapeHtml(line)}</div>`
    )
    .join('')}</div>`

const reply = (html: string): HTMLElement => {
  setBody(assistantMessage(html, { id: 'msg-1' }))
  return document.querySelector('[data-message-author-role="assistant"]') as HTMLElement
}

const recover = (message: HTMLElement): string =>
  recoverEditBlocks(messagesToMarkdown([message]), replyBodies(message))

describe('hasUnfencedMarkers', () => {
  it('is false for markers inside any kind of fence, and for inline code', () => {
    const marked = '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE'
    expect(hasUnfencedMarkers(`\`\`\`ts\n${marked}\n\`\`\``)).toBe(false)
    expect(hasUnfencedMarkers(`~~~\n${marked}\n~~~`)).toBe(false)
    expect(hasUnfencedMarkers(`\`\`\`\`md\n\`\`\`ts\n${marked}\n\`\`\`\n\`\`\`\``)).toBe(
      false
    )
    expect(hasUnfencedMarkers('write `<<<<<<< SEARCH` first')).toBe(false)
    expect(hasUnfencedMarkers('plain text')).toBe(false)
  })

  it('is true for markers at the start of a line outside a fence, also after a closed fence', () => {
    expect(hasUnfencedMarkers('<<<<<<< SEARCH\nx')).toBe(true)
    expect(hasUnfencedMarkers('```ts\nx\n```\n<<<<<<< SEARCH\nx')).toBe(true)
  })
})

describe('layoutText', () => {
  it('breaks lines at blocks and <br>, skips buttons, and turns non-breaking spaces into spaces', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<h3>Title</h3><p>one<br>two three</p><button>Copy</button><div><div>a</div><div>b</div></div>'
    expect(layoutText(root)).toBe('Title\none\ntwo three\na\nb\n')
  })
})

describe('fenceMarkerRegions', () => {
  it('puts a run of pairs into one fence and leaves everything else alone', () => {
    const text = [
      'Updated file: a.ts',
      '<<<<<<< SEARCH',
      'x',
      '=======',
      'y',
      '>>>>>>> REPLACE',
      '',
      '<<<<<<< SEARCH',
      'p',
      '=======',
      'q',
      '>>>>>>> REPLACE',
      'Created file: b.ts',
      'CODEGENT_STATUS: done'
    ].join('\n')
    const { text: out, regions } = fenceMarkerRegions(text)
    expect(regions).toBe(1)
    expect(out).toBe(
      [
        'Updated file: a.ts',
        '```',
        '<<<<<<< SEARCH',
        'x',
        '=======',
        'y',
        '>>>>>>> REPLACE',
        '',
        '<<<<<<< SEARCH',
        'p',
        '=======',
        'q',
        '>>>>>>> REPLACE',
        '```',
        'Created file: b.ts',
        'CODEGENT_STATUS: done'
      ].join('\n')
    )
  })

  it('fences files separately, and with a fence the content cannot close', () => {
    const { text, regions } = fenceMarkerRegions(
      'Updated file: a.md\n<<<<<<< SEARCH\n```js\n=======\n```ts\n>>>>>>> REPLACE\nText\nUpdated file: b.ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE'
    )
    expect(regions).toBe(2)
    expect(text).toContain(
      '````\n<<<<<<< SEARCH\n```js\n=======\n```ts\n>>>>>>> REPLACE\n````'
    )
    expect(text).toContain('Text\nUpdated file: b.ts\n```\n<<<<<<< SEARCH')
  })

  it('keeps a pair that was cut off, so the reader of the text can say so', () => {
    const { text, regions } = fenceMarkerRegions('<<<<<<< SEARCH\nx\n=======\ny')
    expect(regions).toBe(1)
    expect(text).toBe('```\n<<<<<<< SEARCH\nx\n=======\ny\n```')
  })
})

describe('recoverEditBlocks', () => {
  const lines = [
    '<<<<<<< SEARCH',
    'def test_a() -> None:',
    '    prompt = build()',
    '',
    '',
    '# --- Placeholders ---',
    '=======',
    'def test_a() -> None:',
    '    prompt = build()',
    '    assert prompt',
    '',
    '',
    '# --- Placeholders ---',
    '>>>>>>> REPLACE'
  ]

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('leaves a reply with ordinary code blocks exactly as converted', () => {
    const message = reply(
      '<h3>Updated file: <code>tests/a.py</code></h3>' +
        codeBlock('python', lines.join('\n'))
    )
    const converted = messagesToMarkdown([message])
    expect(hasUnfencedMarkers(converted)).toBe(false)
    expect(recover(message)).toBe(converted)
  })

  it('gets back the exact lines of a code viewer the converter read as paragraphs', () => {
    const message = reply(
      '<h3>Updated file: <code>tests/a.py</code></h3>' +
        lineViewer(lines) +
        '<p>CODEGENT_STATUS: continue</p>'
    )
    // What the converter makes of such a viewer: the markers are there, but not as code — the
    // indentation is gone and there is a blank line between the lines.
    const converted = messagesToMarkdown([message])
    expect(hasUnfencedMarkers(converted)).toBe(true)
    expect(converted).toContain('<<<<<<< SEARCH\n\ndef test_a() -> None:')

    const recovered = recover(message)
    expect(recovered).toBe(
      [
        'Updated file: tests/a.py',
        '```',
        ...lines,
        '```',
        'CODEGENT_STATUS: continue'
      ].join('\n')
    )
  })

  it('does nothing when the text of the page does not have the markers intact', () => {
    // The markers were written outside a code block and the page scrambled them: nothing to get back.
    const message = reply(
      '<p>Updated file: a.ts &lt;&lt;&lt;&lt;&lt;&lt;&lt; SEARCH</p><blockquote><p>REPLACE</p></blockquote>'
    )
    const converted = messagesToMarkdown([message])
    expect(hasUnfencedMarkers(converted)).toBe(false)
    expect(recover(message)).toBe(converted)
  })
})
