/**
 * Detects the lines a model writes when it is too lazy to write the code out — `// ... existing
 * code ...`, `# rest of the file unchanged`. Inside a replacement they would be written to the file
 * literally, in place of the real code they stand for, so such a replacement is refused.
 */

const COMMENT_LEADER = /^(?:\/\/+|#+|--|;+|\/\*+|<!--|\*)\s*/
const ELLIPSIS = /^(?:\.{3}|…)|(?:\.{3}|…)$/
const ELISION_WORDS =
  /\b(?:existing|rest of|remaining|unchanged|omitted|same as (?:before|above)|previous (?:code|content|version)|other (?:code|methods|functions|content|sections|parts)|snipped?|truncated|keep(?:ing)? (?:the )?(?:rest|existing))\b/i

export const isPlaceholderLine = (line: string): boolean => {
  const text = line.trim()
  if (text === '' || text.length > 140) return false
  // It must read as a comment or as a bare ellipsis; `def existing(): ...` is real code.
  if (!COMMENT_LEADER.test(text) && !/^(?:\.{3}|…)/.test(text)) return false
  const body = text
    .replace(COMMENT_LEADER, '')
    .replace(/\s*(?:\*\/|-->)$/, '')
    .trim()
  if (!ELLIPSIS.test(body)) return false
  // A lone `...` is Python's Ellipsis; only a comment that says nothing else is a placeholder.
  if (/^(?:\.{3}|…)$/.test(body)) return body !== text
  return ELISION_WORDS.test(body)
}

/** The first placeholder line in `candidate` that the file did not already have, if any. */
export const findPlaceholder = (
  candidate: readonly string[],
  existing: readonly string[]
): string | undefined => {
  const known = new Set(existing.map((line) => line.trim()))
  return candidate.find((line) => isPlaceholderLine(line) && !known.has(line.trim()))
}
