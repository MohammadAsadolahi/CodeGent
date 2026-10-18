/**
 * Describes what the content script can see on the ChatGPT page, so that a site change can be
 * diagnosed from a failure message or the popup's report instead of by guessing. Only structure
 * is described — tag names, attribute names, counts and lengths — never the conversation text
 * (the outline shows the first few words of a text node, and only on request from the popup).
 */
import { normalizeSpace } from './dom-utils'
import {
  ASSISTANT_MESSAGE,
  USER_MESSAGE,
  findComposer,
  findSendButton,
  findStopButton,
  listTurns,
  outermost,
  turnRole,
  turnState,
  visibleOverlayText
} from './selectors'

const dataNames = (element: Element): string[] =>
  element.getAttributeNames().filter((name) => name.startsWith('data-'))

const describeButton = (button: Element): string => {
  const type = button.getAttribute('type')
  const label = button.getAttribute('aria-label')
  const flags = dataNames(button)
    .map((name) => name.slice(5))
    .slice(0, 6)
    .join('+')
  return (
    `button${type ? `[type=${type}]` : ''}` +
    `${label ? `[label="${label.slice(0, 24)}"]` : ''}${flags ? `{${flags}}` : ''}`
  )
}

const count = (doc: Document, selector: string): number =>
  doc.querySelectorAll(selector).length

/** One line (about 500 characters) that says how the page looks to the content script. */
export const describePage = (doc: Document): string => {
  const composer = findComposer(doc)
  const send = findSendButton(doc, composer?.element)
  const stop = findStopButton(doc)
  const turns = listTurns(doc)
  const last = turns.at(-1)
  const lastData = last
    ? [
        ...new Set([
          ...dataNames(last),
          ...Array.from(last.children).flatMap((child) => dataNames(child))
        ])
      ].slice(0, 8)
    : []
  const overlay = visibleOverlayText(doc)
  return [
    `path=${doc.location.pathname.replace(/\/c\/[\w-]+/, '/c/…')}`,
    `composer=${composer ? `${composer.element.localName} via ${composer.selector.slice(0, 60)}` : 'none'}`,
    `send=${send ? describeButton(send.element) : 'none'}`,
    `stop=${stop ? stop.selector.slice(0, 48) : 'none'}`,
    `turns=${turns.length}` +
      (turns.length
        ? ` [${turns
            .slice(-3)
            .map(
              (turn) =>
                `${turnRole(turn) ?? '?'}/${turnState(turn) ?? '-'}/${normalizeSpace(turn.textContent ?? '').length}ch`
            )
            .join(', ')}]`
        : ''),
    `counts={turnState:${count(doc, '[data-talvt-turn-state]')},assistant:${count(doc, ASSISTANT_MESSAGE)},user:${count(doc, USER_MESSAGE)},article:${count(doc, 'article')},dataTurn:${count(doc, '[data-turn]')},markdown:${count(doc, '.markdown')},pre:${count(doc, 'pre')}}`,
    lastData.length ? `last-turn-data=[${lastData.join(' ')}]` : '',
    overlay ? `dialog="${overlay.slice(0, 40)}"` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

const KEPT_ATTRIBUTES = new Set([
  'id',
  'role',
  'type',
  'name',
  'contenteditable',
  'disabled'
])

const outlineOf = (element: Element, depth: number, state: { nodes: number }): string => {
  if (state.nodes++ > 450) return '…'
  const attributes = element
    .getAttributeNames()
    .filter(
      (name) =>
        name.startsWith('data-') || name.startsWith('aria-') || KEPT_ATTRIBUTES.has(name)
    )
    .map(
      (name) =>
        `${name}=${JSON.stringify((element.getAttribute(name) ?? '').slice(0, 40))}`
    )
    .join(' ')
  let line = `<${element.localName}${attributes ? ` ${attributes}` : ''}>`
  if (element.localName === 'svg') {
    const path = element.querySelector('path')?.getAttribute('d')
    return path ? `${line} path:${path.slice(0, 30)}` : line
  }
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => (node.textContent ?? '').trim())
    .join(' ')
    .slice(0, 20)
  if (text) line += ` ${JSON.stringify(text)}`
  const children = Array.from(element.children)
  if (children.length === 0) return line
  if (depth <= 0) return `${line} …${children.length}`
  return [
    line,
    ...children.map((child) =>
      outlineOf(child, depth - 1, state)
        .split('\n')
        .map((row) => `  ${row}`)
        .join('\n')
    )
  ].join('\n')
}

/**
 * How code is marked up in the last reply: a code block is where a reply stops being plain text,
 * and the one thing the edit parser cannot do without.
 */
const codeSamples = (doc: Document): string[] => {
  const found = outermost(
    Array.from(
      doc.querySelectorAll(
        'pre, [data-code-block], .cm-editor, [class*="code-block" i], [class*="codeblock" i]'
      )
    )
  )
  if (found.length === 0) {
    const inline = Array.from(doc.querySelectorAll('code')).filter((code) =>
      (code.textContent ?? '').includes('\n')
    )
    found.push(...outermost(inline))
  }
  return found.slice(-2).map((element) => outlineOf(element, 6, { nodes: 0 }))
}

/**
 * A readable outline of the message box with its buttons and of the last two turns: tag names,
 * `data-`/`aria-` attributes and the first words of each text node. Meant to be copied from the
 * popup into a bug report when the page layout has changed.
 */
export const pageOutline = (doc: Document): string => {
  const composer = findComposer(doc)?.element
  const form =
    composer?.closest('form') ?? composer?.parentElement?.parentElement?.parentElement
  const turns = listTurns(doc)
  const code = codeSamples(doc)
  return [
    describePage(doc),
    '--- message box area ---',
    form ? outlineOf(form, 7, { nodes: 0 }) : '(message box not found)',
    `--- last two turns (${turns.length} in total) ---`,
    ...turns.slice(-2).map((turn) => outlineOf(turn, 14, { nodes: 0 })),
    `--- code blocks (${code.length} shown, last first) ---`,
    ...code.reverse()
  ].join('\n')
}
