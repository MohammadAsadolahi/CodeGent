/**
 * Converts the rendered DOM of a ChatGPT reply back into markdown.
 *
 * The goal is not a perfect round trip of every construct but a *lossless* one for the parts the
 * edit parser relies on: headings (with inline-code paths), fenced code blocks (verbatim, with a
 * fence long enough that the code can never close it) and plain lines. Reading the DOM instead
 * of the clipboard needs no user gesture and no clipboard permission.
 */
import { hasReadableText, normalizeSpace } from './dom-utils'
import { ASSISTANT_MESSAGE, outermost } from './selectors'

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul'
])
const SKIPPED_TAGS = new Set(['button', 'script', 'style', 'svg', 'noscript', 'template'])

const collapse = (text: string): string => text.replace(/[ \t\r\n\f]+/g, ' ')

const append = (out: string, piece: string): string => {
  if (piece.startsWith(' ') && (out === '' || out.endsWith(' ') || out.endsWith('\n'))) {
    return out + piece.slice(1)
  }
  return out + piece
}

const tidy = (text: string): string =>
  text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/^[\s]+|[\s]+$/g, '')

const longestBacktickRun = (text: string): number =>
  Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))

const inlineCode = (text: string): string => {
  const fence = '`'.repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

const wrap = (marker: string, inner: string): string => {
  const core = inner.trim()
  if (!core) return inner
  const lead = inner.slice(0, inner.length - inner.trimStart().length)
  const trail = inner.slice(inner.trimEnd().length)
  return `${lead}${marker}${core}${marker}${trail}`
}

const isKatex = (el: Element): boolean => el.classList.contains('katex')
const isDisplayMath = (el: Element): boolean => el.classList.contains('katex-display')

const texOf = (el: Element): string =>
  el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ??
  normalizeSpace(el.textContent ?? '')

function renderInlineChildren(parent: Node): string {
  let out = ''
  for (const child of Array.from(parent.childNodes))
    out = append(out, renderInline(child))
  return out
}

function renderInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return collapse((node as Text).data)
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const tag = el.localName
  if (SKIPPED_TAGS.has(tag)) return ''
  if (isKatex(el)) return isDisplayMath(el) ? `$$${texOf(el)}$$` : `$${texOf(el)}$`
  switch (tag) {
    case 'br':
      return '\n'
    case 'code':
      return inlineCode(el.textContent ?? '')
    case 'strong':
    case 'b':
      return wrap('**', renderInlineChildren(el))
    case 'em':
    case 'i':
      return wrap('*', renderInlineChildren(el))
    case 's':
    case 'del':
    case 'strike':
      return wrap('~~', renderInlineChildren(el))
    case 'a': {
      const text = renderInlineChildren(el)
      const href = el.getAttribute('href') ?? ''
      if (!href || /^\s*javascript:/i.test(href) || text.trim() === href) return text
      return `[${text.trim()}](${href})`
    }
    case 'img':
      return el.getAttribute('alt') ?? ''
    default:
      return renderInlineChildren(el)
  }
}

function languageLabel(pre: Element): string {
  for (const candidate of pre.querySelectorAll('div, span')) {
    if (candidate.closest('code')) continue
    if (candidate.querySelector('code, pre, button')) continue
    const text = normalizeSpace(candidate.textContent ?? '')
    if (!text || text.length > 32 || !/^[\w+#.\- ]+$/.test(text)) continue
    if (/^(copy( code)?|edit|run|copied!?)$/i.test(text)) continue
    return text.split(' ')[0]!.toLowerCase()
  }
  return ''
}

function extractCode(pre: Element): { language: string; code: string } {
  const codeEl = pre.querySelector('code')
  let code: string
  if (codeEl) {
    code = codeEl.textContent ?? ''
  } else {
    const editor = pre.querySelector('.cm-content')
    if (editor) {
      code = Array.from(editor.querySelectorAll('.cm-line'))
        .map((line) => line.textContent ?? '')
        .join('\n')
    } else {
      const clone = pre.cloneNode(true) as Element
      clone.querySelectorAll('button, svg').forEach((n) => n.remove())
      code = clone.textContent ?? ''
    }
  }
  const classMatch = codeEl?.className.toString().match(/(?:^|\s)language-([^\s]+)/)
  // A header label is only trustworthy next to a real <code> element; in other layouts the
  // first text-bearing div may well be a line of the code itself.
  const language = classMatch?.[1] ?? (codeEl ? languageLabel(pre) : '')
  code = code.replace(/\r\n/g, '\n')
  if (code.endsWith('\n')) code = code.slice(0, -1)
  return { language, code }
}

/** Elements inside which a `<code>` is a word of a sentence, not a block of code. */
const SENTENCE_CONTEXT = new Set([
  'p',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'del',
  's',
  'strike',
  'summary',
  'label',
  'button',
  'figcaption'
])

/**
 * A `<code>` that is a block of code rather than a word in a sentence. The page used to put every
 * block in a `<pre>`; now a block is a labelled container around a bare `<code>`. Such a code
 * element spans several lines, or stands alone outside any sentence (a one-line file is still a
 * block). Inline code has sentence context or text beside it.
 */
const isBlockCode = (code: Element): boolean => {
  if ((code.textContent ?? '').includes('\n')) return true
  for (let parent = code.parentElement; parent; parent = parent.parentElement) {
    if (SENTENCE_CONTEXT.has(parent.localName)) return false
  }
  const beside = Array.from(code.parentElement?.childNodes ?? []).some((node) =>
    node === code
      ? false
      : node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? '').trim() !== ''
        : node.nodeType === Node.ELEMENT_NODE && hasReadableText(node as Element)
  )
  return !beside
}

/**
 * A code viewer built on CodeMirror: no <code>, no <pre>, one element per line. Read as ordinary
 * markup it would turn every line into a paragraph, losing the indentation.
 */
const EDITOR = '.cm-editor, .cm-content'

const holdsBlockCode = (el: Element): boolean =>
  el.matches(EDITOR) ||
  el.querySelector(EDITOR) !== null ||
  Array.from(el.querySelectorAll('code')).some(isBlockCode)

const CODE_LABEL = /^[\w+#.\- ]{1,32}$/

/** The text of `el` without its buttons and icons. */
const labelOf = (el: Element): string => {
  const clone = el.cloneNode(true) as Element
  for (const chrome of Array.from(clone.querySelectorAll('button, svg'))) chrome.remove()
  return normalizeSpace(clone.textContent ?? '')
}

/**
 * The strip above a block of code that names its language beside a Copy button. It is page
 * chrome, not part of the reply, so it must not show up as a line of prose.
 */
const isCodeHeader = (el: Element): boolean => {
  const next = el.nextElementSibling
  return (
    next !== null &&
    !SENTENCE_CONTEXT.has(el.localName) &&
    el.querySelector('button') !== null &&
    el.querySelector('code') === null &&
    CODE_LABEL.test(labelOf(el)) &&
    (next.localName === 'code' ? isBlockCode(next) : holdsBlockCode(next))
  )
}

function renderCodeElement(code: Element): string {
  const language = code.className.toString().match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? ''
  let text = (code.textContent ?? '').replace(/\r\n/g, '\n')
  if (text.endsWith('\n')) text = text.slice(0, -1)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function renderEditor(editor: Element): string {
  const content = editor.matches('.cm-content')
    ? editor
    : (editor.querySelector('.cm-content') ?? editor)
  const code = Array.from(content.querySelectorAll('.cm-line'), (line) =>
    (line.textContent ?? '').replace(/​/g, '')
  ).join('\n')
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1))
  return `${fence}\n${code}\n${fence}`
}

function renderPre(pre: Element): string {
  const { language, code } = extractCode(pre)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1))
  return `${fence}${language}\n${code}\n${fence}`
}

function indentBlock(text: string, prefix: string, firstPrefix = prefix): string {
  return text
    .split('\n')
    .map((line, index) => {
      const p = index === 0 ? firstPrefix : prefix
      return line === '' ? p.trimEnd() : p + line
    })
    .join('\n')
}

function renderList(list: Element): string {
  const ordered = list.localName === 'ol'
  let counter = Number.parseInt(list.getAttribute('start') ?? '1', 10) || 1
  const items: string[] = []
  for (const li of Array.from(list.children)) {
    if (li.localName !== 'li') continue
    const marker = ordered ? `${counter++}. ` : '- '
    const body = renderBlocks(li).join('\n')
    items.push(indentBlock(body || '', ' '.repeat(marker.length), marker))
  }
  return items.join('\n')
}

function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children)
      .filter((cell) => cell.localName === 'th' || cell.localName === 'td')
      .map((cell) =>
        tidy(renderInlineChildren(cell)).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      )
  )
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const format = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
  return [
    format(rows[0]!),
    format(Array(width).fill('---')),
    ...rows.slice(1).map(format)
  ].join('\n')
}

function renderBlockElement(el: Element): string[] {
  const tag = el.localName
  const heading = /^h([1-6])$/.exec(tag)
  if (heading) {
    const text = tidy(renderInlineChildren(el))
    return text ? [`${'#'.repeat(Number(heading[1]))} ${text.replace(/\n/g, ' ')}`] : []
  }
  switch (tag) {
    case 'pre':
      return [renderPre(el)]
    case 'ul':
    case 'ol':
      return [renderList(el)]
    case 'hr':
      return ['---']
    case 'table': {
      const table = renderTable(el)
      return table ? [table] : []
    }
    case 'blockquote': {
      const inner = renderBlocks(el).join('\n\n')
      return inner ? [indentBlock(inner, '> ')] : []
    }
    default:
      return renderBlocks(el)
  }
}

function renderBlocks(parent: Node): string[] {
  const blocks: string[] = []
  let inline = ''
  const flush = () => {
    const text = tidy(inline)
    if (text) blocks.push(text)
    inline = ''
  }
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      inline = append(inline, collapse((child as Text).data))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    if (SKIPPED_TAGS.has(el.localName) || isCodeHeader(el)) continue
    if (isKatex(el) && isDisplayMath(el)) {
      flush()
      blocks.push(`$$\n${texOf(el)}\n$$`)
    } else if (el.localName === 'code' && isBlockCode(el)) {
      flush()
      blocks.push(renderCodeElement(el))
    } else if (el.matches(EDITOR)) {
      flush()
      blocks.push(renderEditor(el))
    } else if (BLOCK_TAGS.has(el.localName)) {
      flush()
      blocks.push(...renderBlockElement(el))
    } else if (holdsBlockCode(el)) {
      // An inline wrapper (a span, a link …) around a block of code: look inside it.
      flush()
      blocks.push(...renderBlocks(el))
    } else {
      inline = append(inline, renderInline(el))
    }
  }
  flush()
  return blocks
}

export const elementToMarkdown = (root: Element): string =>
  renderBlocks(root).join('\n\n').trim()

/**
 * A copy of `element` without what a reader never sees: screen-reader-only labels ("ChatGPT
 * said:"), hidden elements, decorative icons and the parts the page itself leaves out when it
 * copies a message. Used when a message has to be converted whose body the page does not mark.
 */
const withoutChrome = (element: Element): Element => {
  const clone = element.cloneNode(true) as Element
  for (const hidden of Array.from(
    clone.querySelectorAll(
      '.sr-only, [hidden], [aria-hidden="true"], [data-conversation-role], [data-markdown-copy="exclude"]'
    )
  ))
    hidden.remove()
  return clone
}

/**
 * The parts of `element` that hold the reply text, from most to least specific: the body the page
 * marks as markdown (`.markdown`, or the element the page copies from — `data-markdown-copy`),
 * else the message with its chrome removed.
 */
export const replyBodies = (element: Element): Element[] => {
  const messages = element.matches(ASSISTANT_MESSAGE)
    ? [element]
    : Array.from(element.querySelectorAll(ASSISTANT_MESSAGE))
  return (messages.length > 0 ? messages : [element]).flatMap((message) => {
    for (const marker of ['.markdown', '[data-markdown-copy="contents"]']) {
      const bodies = outermost(Array.from(message.querySelectorAll(marker)))
      if (bodies.length > 0) return bodies
    }
    return [withoutChrome(message)]
  })
}

/** Markdown for one or more assistant message elements (or whole turns), in document order. */
export const messagesToMarkdown = (messages: readonly Element[]): string =>
  messages
    .map((message) =>
      replyBodies(message)
        .map((body) => elementToMarkdown(body))
        .filter((text) => text !== '')
        .join('\n\n')
    )
    .filter((text) => text !== '')
    .join('\n\n')
