/**
 * Converts the rendered DOM of a ChatGPT reply back into markdown.
 *
 * The goal is not a perfect round trip of every construct but a *lossless* one for the parts the
 * edit parser relies on: headings (with inline-code paths), fenced code blocks (verbatim, with a
 * fence long enough that the code can never close it) and plain lines. Reading the DOM instead
 * of the clipboard needs no user gesture and no clipboard permission.
 */
import { normalizeSpace } from './dom-utils'
import { ASSISTANT_MESSAGE } from './selectors'

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
    if (SKIPPED_TAGS.has(el.localName)) continue
    if (isKatex(el) && isDisplayMath(el)) {
      flush()
      blocks.push(`$$\n${texOf(el)}\n$$`)
    } else if (BLOCK_TAGS.has(el.localName)) {
      flush()
      blocks.push(...renderBlockElement(el))
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
 * said:"), hidden elements and decorative icons. Used when a whole conversation turn has to be
 * converted because the page marks neither its message nor its body.
 */
const withoutChrome = (element: Element): Element => {
  const clone = element.cloneNode(true) as Element
  for (const hidden of Array.from(
    clone.querySelectorAll('.sr-only, [hidden], [aria-hidden="true"]')
  ))
    hidden.remove()
  return clone
}

/** The parts of `element` that hold the reply text: marked message bodies, or the element itself. */
const replyBodies = (element: Element): Element[] => {
  const messages = element.matches(ASSISTANT_MESSAGE)
    ? [element]
    : Array.from(element.querySelectorAll(ASSISTANT_MESSAGE))
  return (messages.length > 0 ? messages : [element]).flatMap((message) => {
    const bodies = Array.from(message.querySelectorAll('.markdown'))
    return bodies.length > 0 ? bodies : [withoutChrome(message)]
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
