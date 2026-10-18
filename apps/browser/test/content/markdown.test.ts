import { describe, expect, it } from 'vitest'
import { elementToMarkdown, messagesToMarkdown } from '../../src/content/markdown'
import {
  assistantMessage,
  codeBlock,
  redesignCodeBlock,
  setBody
} from '../fixtures/chatgpt-dom'

const md = (html: string): string => {
  const root = document.createElement('div')
  root.innerHTML = html
  return elementToMarkdown(root)
}

describe('inline content', () => {
  it('renders paragraphs, emphasis, inline code and links', () => {
    expect(
      md(
        '<p>Use <strong>care</strong> with <em>this</em> <code>foo()</code> call, see <a href="https://x.dev/a">docs</a>.</p>'
      )
    ).toBe('Use **care** with *this* `foo()` call, see [docs](https://x.dev/a).')
  })

  it('collapses source whitespace like a browser would', () => {
    expect(md('<p>one\n      two   three</p>')).toBe('one two three')
  })

  it('turns <br> into line breaks', () => {
    expect(md('<p>first<br>second</p>')).toBe('first\nsecond')
  })

  it('keeps links whose text equals their url bare and drops javascript: urls', () => {
    expect(md('<p><a href="https://x.dev">https://x.dev</a></p>')).toBe('https://x.dev')
    expect(md('<p><a href="javascript:alert(1)">click</a></p>')).toBe('click')
  })

  it('protects inline code that itself contains backticks', () => {
    expect(md('<p><code>a ` b</code></p>')).toBe('``a ` b``')
    expect(md('<p><code>`x`</code></p>')).toBe('`` `x` ``')
  })

  it('ignores buttons, scripts and svgs', () => {
    expect(
      md(
        '<p>hello<button>Copy</button><svg><text>no</text></svg><script>x()</script></p>'
      )
    ).toBe('hello')
  })
})

describe('headings and structure', () => {
  it('preserves inline-code paths inside headings (the edit parser depends on this)', () => {
    expect(md('<h3>Updated file: <code>src/utils/math.ts</code></h3>')).toBe(
      '### Updated file: `src/utils/math.ts`'
    )
    expect(
      md('<h3>Renamed file: <code>a.ts</code> (old) <code>b.ts</code> (new)</h3>')
    ).toBe('### Renamed file: `a.ts` (old) `b.ts` (new)')
  })

  it('separates blocks with one blank line', () => {
    expect(md('<p>A</p><h2>B</h2><p>C</p>')).toBe('A\n\n## B\n\nC')
  })

  it('renders blockquotes, rules and tables', () => {
    expect(md('<blockquote><p>quoted</p><p>more</p></blockquote>')).toBe(
      '> quoted\n>\n> more'
    )
    expect(md('<p>x</p><hr><p>y</p>')).toBe('x\n\n---\n\ny')
    expect(
      md(
        '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>x|y</td></tr></tbody></table>'
      )
    ).toBe('| a | b |\n| --- | --- |\n| 1 | x\\|y |')
  })

  it('renders nested and ordered lists', () => {
    expect(
      md(
        '<ul><li>one<ul><li>inner</li></ul></li><li><p>two</p></li></ul><ol start="3"><li>x</li><li>y</li></ol>'
      )
    ).toBe('- one\n  - inner\n- two\n\n3. x\n4. y')
  })

  it('keeps a fenced block inside a list item attached to it', () => {
    const out = md(`<ol><li>Run:${codeBlock('bash', 'npm test')}</li></ol>`)
    expect(out).toBe('1. Run:\n   ```bash\n   npm test\n   ```')
  })

  it('renders math from KaTeX annotations', () => {
    expect(
      md(
        '<p>Area <span class="katex"><span class="katex-mathml"><annotation encoding="application/x-tex">\\pi r^2</annotation></span><span aria-hidden="true">garbage</span></span></p>'
      )
    ).toBe('Area $\\pi r^2$')
  })
})

describe('code blocks', () => {
  it('reproduces code verbatim, decoding entities and ignoring highlight markup and header chrome', () => {
    const code = 'export const a = 1 < 2 && "x" > \'y\'\n\n  return `${a}`'
    const out = md(codeBlock('ts', code))
    expect(out).toBe(
      '```ts\nexport const a = 1 < 2 && "x" > \'y\'\n\n  return `${a}`\n```'
    )
    expect(out).not.toMatch(/Copy/)
  })

  it('takes the language from the header label when the code element has no language class', () => {
    expect(
      md(codeBlock('python', 'print(1)', { classLanguage: false, label: 'Python' }))
    ).toBe('```python\nprint(1)\n```')
  })

  it('uses a fence longer than any backtick run inside the code', () => {
    const code = 'before\n```\nnested\n```\nafter'
    const out = md(codeBlock('markdown', code))
    expect(out).toBe('````markdown\nbefore\n```\nnested\n```\nafter\n````')
  })

  it('keeps conflict markers and indentation untouched', () => {
    const code = '<<<<<<< SEARCH\n    old()\n=======\n    new()\n>>>>>>> REPLACE'
    expect(md(codeBlock('ts', code))).toBe(`\`\`\`ts\n${code}\n\`\`\``)
  })

  it('handles CodeMirror-style editors without a code element', () => {
    const html =
      '<pre><div class="cm-editor"><div class="cm-content"><div class="cm-line">line 1</div><div class="cm-line">  line 2</div></div></div></pre>'
    expect(md(html)).toBe('```\nline 1\n  line 2\n```')
  })

  it('falls back to the pre text, minus buttons, when there is no recognizable structure', () => {
    expect(md('<pre><button>Copy</button>plain text\nsecond</pre>')).toBe(
      '```\nplain text\nsecond\n```'
    )
  })

  it('normalizes CRLF inside code', () => {
    expect(md('<pre><code>a\r\nb</code></pre>')).toBe('```\na\nb\n```')
  })
})

describe('messagesToMarkdown', () => {
  it('uses the .markdown body and joins several messages', () => {
    setBody(
      assistantMessage('<p>First.</p>', { id: 'a' }) +
        assistantMessage(
          '<h3>Created file: <code>x.ts</code></h3>' +
            codeBlock('ts', 'export const x = 1'),
          { id: 'b' }
        )
    )
    const messages = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]')
    )
    expect(messagesToMarkdown(messages)).toBe(
      'First.\n\n### Created file: `x.ts`\n\n```ts\nexport const x = 1\n```'
    )
  })

  it('skips empty messages', () => {
    setBody(
      assistantMessage('', { id: 'a' }) + assistantMessage('<p>Only.</p>', { id: 'b' })
    )
    const messages = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]')
    )
    expect(messagesToMarkdown(messages)).toBe('Only.')
  })
})

describe('code blocks without a <pre> (the redesigned page)', () => {
  it('turns the labelled container around a bare <code> into a fenced block, indentation intact', () => {
    const code = 'export const a = {\n  b: 1\n}'
    expect(md(`<p>Here:</p>${redesignCodeBlock('TypeScript', code)}<p>Done.</p>`)).toBe(
      `Here:\n\n\`\`\`\n${code}\n\`\`\`\n\nDone.`
    )
  })

  it('keeps a one-line file a block, not inline code', () => {
    expect(
      md(redesignCodeBlock('Plain text', 'CodeGent live end-to-end check passed.'))
    ).toBe('```\nCodeGent live end-to-end check passed.\n```')
  })

  it('does not show the language strip as a line of text', () => {
    expect(md(redesignCodeBlock('Python', 'print(1)'))).not.toMatch(/Python|Copy/)
  })

  it('keeps a short line of prose before a code block when it has no Copy button', () => {
    expect(md('<div>Example</div><div><code>x = 1\ny = 2</code></div>')).toBe(
      'Example\n\n```\nx = 1\ny = 2\n```'
    )
  })

  it('finds a block of code inside inline wrappers', () => {
    expect(md('<span><span><code>a\nb</code></span></span>')).toBe('```\na\nb\n```')
  })

  it('takes the language from the class of the <code> when it has one', () => {
    expect(md('<div><code class="language-ts">let a</code></div>')).toBe(
      '```ts\nlet a\n```'
    )
  })

  it('uses a fence longer than any backtick run inside the code', () => {
    expect(md('<div><code>a\n```\nb</code></div>')).toBe('````\na\n```\nb\n````')
  })

  it('still renders inline code inside sentences, lists and headings as inline code', () => {
    expect(md('<p>Call <code>greet()</code> now</p>')).toBe('Call `greet()` now')
    expect(md('<ul><li><code>one</code></li></ul>')).toBe('- `one`')
    expect(md('<h3>Updated file: <code>src/a.ts</code></h3>')).toBe(
      '### Updated file: `src/a.ts`'
    )
    // …also in a layout whose paragraphs are plain divs, because text stands beside the code.
    expect(md('<div>Use <code>foo</code> here</div>')).toBe('Use `foo` here')
  })

  it('reads the exact reply the real page produced in the probe run', () => {
    const reply =
      '<h3>Created file: <code>docs/probe.md</code></h3>' +
      redesignCodeBlock('Plain text', 'hello from the probe\nsecond line') +
      '<p>CODEGENT_STATUS: done</p>'
    expect(md(reply)).toBe(
      '### Created file: `docs/probe.md`\n\n```\nhello from the probe\nsecond line\n```\n\nCODEGENT_STATUS: done'
    )
  })
})
