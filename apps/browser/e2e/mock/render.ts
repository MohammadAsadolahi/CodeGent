import { codeBlock, escapeHtml, redesignCodeBlock } from '../../test/fixtures/chatgpt-dom'

const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

/** A small markdown renderer that emits ChatGPT-like markup (code blocks with header + Copy). */
/** `bare` draws code the way the redesigned page does (no `<pre>`), `pre` the way it used to. */
export const renderMarkdown = (
  markdown: string,
  codeStyle: 'pre' | 'bare' = 'pre'
): string => {
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length) {
        const closing = /^(`{3,}|~{3,})\s*$/.exec(lines[i]!)
        if (
          closing &&
          closing[1]![0] === marker[0] &&
          closing[1]!.length >= marker.length
        )
          break
        body.push(lines[i]!)
        i++
      }
      i++ // closing fence
      const language = fence[2] || 'plaintext'
      out.push(
        codeStyle === 'bare'
          ? redesignCodeBlock(language, body.join('\n'))
          : codeBlock(language, body.join('\n'))
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`)
      i++
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!))
        (items.push(`<li>${inline(lines[i]!.replace(/^[-*]\s+/, ''))}</li>`), i++)
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(`{3,}|~{3,}|#{1,6}\s|[-*]\s)/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!)
      i++
    }
    out.push(`<p>${inline(paragraph.join('\n'))}</p>`)
  }
  return out.join('')
}
