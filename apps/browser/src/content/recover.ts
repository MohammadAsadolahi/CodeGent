/**
 * A safety net for edits that the page showed but the markdown conversion did not recognise as
 * code. The chat page cannot show SEARCH/REPLACE markers intact unless they are inside a code
 * block (anywhere else it turns `=======` into headings and `>>>>>>>` into block quotes), so
 * markers that reach the markdown *outside* a fence mean the converter missed a code block — for
 * example one drawn as a stack of line elements, which it would read as paragraphs, dropping the
 * indentation and putting blank lines between the lines.
 *
 * The text the page lays out for the reader still has the lines exactly as shown, so the marker
 * regions are taken from it and put back into fences. Nothing is changed unless that happens, and
 * a reply the converter read correctly is never touched.
 */

const CONFLICT_START = /^<{5,9}(?:[ \t].*)?$/
const CONFLICT_END = /^>{5,9}(?:[ \t].*)?$/
const FENCE = /^\s*(`{3,}|~{3,})/

/** Whether `markdown` has SEARCH/REPLACE markers at the start of a line outside every code fence. */
export const hasUnfencedMarkers = (markdown: string): boolean => {
  let open: string | null = null
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (open === null) open = marker
      else if (
        marker[0] === open[0] &&
        marker.length >= open.length &&
        /^\s*[`~]+\s*$/.test(line)
      )
        open = null
      continue
    }
    if (open === null && CONFLICT_START.test(line)) return true
  }
  return false
}

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
  'tr',
  'ul'
])
const SKIPPED_TAGS = new Set(['button', 'script', 'style', 'svg', 'noscript', 'template'])

/** Whether the page lays the element out as a block (its own line) rather than inline. */
const isBlock = (element: Element): boolean =>
  BLOCK_TAGS.has(element.localName) ||
  /^(?:block|flex|grid|list-item|table|flow-root)/.test(
    element.ownerDocument.defaultView?.getComputedStyle(element).display ?? ''
  )

/**
 * The text of `root` as a reader sees it, with a line break at every block boundary and every
 * <br>, and nothing collapsed — a code viewer's indentation and blank lines stay as they are.
 * Walking the elements gives the same text in a browser and in the tests; the browser's own
 * `innerText` would add layout rules this does not need.
 */
const walkText = (root: Node): string => {
  let out = ''
  const breakLine = () => {
    if (out !== '' && !out.endsWith('\n')) out += '\n'
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    if (
      SKIPPED_TAGS.has(element.localName) ||
      element.matches('.sr-only, [hidden], [aria-hidden="true"]') ||
      element.ownerDocument.defaultView?.getComputedStyle(element).display === 'none'
    )
      return
    if (element.localName === 'br') {
      out += '\n'
      return
    }
    const block = isBlock(element)
    if (block) breakLine()
    for (const child of Array.from(element.childNodes)) visit(child)
    if (block) breakLine()
  }
  visit(root)
  return out
}

/** The text of `element` as a reader sees it, one line per line shown. */
export const layoutText = (element: Element): string =>
  walkText(element).replace(/\r\n?/g, '\n').replace(/ /g, ' ')

const fenceAround = (lines: readonly string[]): string[] => {
  const longest = Math.max(
    0,
    ...lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length))
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [fence, ...lines, fence]
}

/** Puts every run of SEARCH/REPLACE pairs in `text` into a code fence; counts the runs. */
export const fenceMarkerRegions = (text: string): { text: string; regions: number } => {
  const lines = text.split('\n')
  const out: string[] = []
  let regions = 0
  for (let i = 0; i < lines.length;) {
    if (!CONFLICT_START.test(lines[i]!)) {
      out.push(lines[i]!)
      i++
      continue
    }
    const region: string[] = []
    for (;;) {
      let end = i
      while (end < lines.length && !CONFLICT_END.test(lines[end]!)) end++
      const stop = Math.min(end, lines.length - 1)
      region.push(...lines.slice(i, stop + 1))
      i = stop + 1
      // Another pair after nothing but blank lines belongs to the same file.
      let next = i
      while (next < lines.length && lines[next]!.trim() === '') next++
      if (
        end < lines.length &&
        next < lines.length &&
        CONFLICT_START.test(lines[next]!)
      ) {
        region.push(...lines.slice(i, next))
        i = next
        continue
      }
      break
    }
    out.push(...fenceAround(region))
    regions++
  }
  return { text: out.join('\n'), regions }
}

/**
 * `markdown`, unless it carries SEARCH/REPLACE markers outside a fence and the page text carries
 * them intact: then the page text, with those marker regions fenced.
 */
export const recoverEditBlocks = (
  markdown: string,
  bodies: readonly Element[]
): string => {
  if (!hasUnfencedMarkers(markdown)) return markdown
  const recovered = fenceMarkerRegions(bodies.map(layoutText).join('\n\n'))
  return recovered.regions > 0 ? recovered.text.trim() : markdown
}
