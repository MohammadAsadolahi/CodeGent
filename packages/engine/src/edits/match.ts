import type { ClosestMatch, MatchTier } from './types'

/** A uniform change of leading whitespace between the SEARCH text and the file. */
export type IndentShift = { add: string } | { remove: string }

export interface Match {
  /** First matched line (0-based) and one past the last. */
  start: number
  end: number
  tier: MatchTier
  /** Blank lines dropped from the start/end of the SEARCH text for it to match. */
  trimmedLead: number
  trimmedTrail: number
  /** Set when the file is indented differently from the SEARCH text, consistently. */
  indent?: IndentShift
  /** Indentation differed but not uniformly, so the replacement is inserted as written. */
  indentUnresolved?: boolean
}

export type FindResult =
  | { ok: true; match: Match }
  | { ok: false; reason: 'not-found'; closest?: ClosestMatch }
  | { ok: false; reason: 'ambiguous'; candidates: number[] }
  | { ok: false; reason: 'empty' }

export const isBlank = (line: string): boolean => line.trim() === ''

const trimEnd = (line: string): string => line.replace(/[ \t\r]+$/, '')
const collapse = (line: string): string => line.trim().replace(/[ \t]+/g, ' ')

const WINDOW_TIERS: ReadonlyArray<{ tier: MatchTier; key: (line: string) => string }> = [
  { tier: 'exact', key: (line) => line },
  { tier: 'trailing-space', key: trimEnd },
  { tier: 'trim', key: (line) => line.trim() },
  { tier: 'collapse-space', key: collapse }
]

const leadingWhitespace = (line: string): string => /^[ \t]*/.exec(line)![0]

export const stripBlankEdges = (lines: readonly string[]) => {
  let from = 0
  let to = lines.length
  while (from < to && isBlank(lines[from]!)) from++
  while (to > from && isBlank(lines[to - 1]!)) to--
  return { lines: lines.slice(from, to), lead: from, trail: lines.length - to }
}

/** Start indexes where `needle` appears as a contiguous window under the given line key. */
const scanWindows = (
  content: readonly string[],
  needle: readonly string[],
  key: (s: string) => string
): number[] => {
  const size = needle.length
  if (size === 0 || size > content.length) return []
  const wanted = needle.map(key)
  const keyed = content.map(key)
  const hits: number[] = []
  outer: for (let start = 0; start <= keyed.length - size; start++) {
    for (let j = 0; j < size; j++) {
      if (keyed[start + j] !== wanted[j]) continue outer
    }
    hits.push(start)
  }
  return hits
}

/** Windows that match when blank lines are ignored on both sides; returns [start, end) pairs. */
const scanIgnoringBlanks = (
  content: readonly string[],
  needle: readonly string[]
): Array<[number, number]> => {
  const wanted = needle.filter((line) => !isBlank(line)).map(collapse)
  if (wanted.length === 0) return []
  const indexes: number[] = []
  const keyed: string[] = []
  content.forEach((line, index) => {
    if (!isBlank(line)) {
      indexes.push(index)
      keyed.push(collapse(line))
    }
  })
  const hits: Array<[number, number]> = []
  outer: for (let s = 0; s <= keyed.length - wanted.length; s++) {
    for (let j = 0; j < wanted.length; j++) {
      if (keyed[s + j] !== wanted[j]) continue outer
    }
    hits.push([indexes[s]!, indexes[s + wanted.length - 1]! + 1])
  }
  return hits
}

/**
 * Compares the indentation of aligned (file line, SEARCH line) pairs. Returns the single shift
 * that maps the SEARCH text onto the file, 'none' when they already agree, or 'mixed'.
 */
const indentShift = (
  pairs: ReadonlyArray<readonly [string, string]>
): IndentShift | 'none' | 'mixed' => {
  let shift: IndentShift | 'none' | undefined
  for (const [fileLine, searchLine] of pairs) {
    if (isBlank(fileLine) || isBlank(searchLine)) continue
    const fileIndent = leadingWhitespace(fileLine)
    const searchIndent = leadingWhitespace(searchLine)
    let current: IndentShift | 'none'
    if (fileIndent === searchIndent) current = 'none'
    else if (fileIndent.startsWith(searchIndent))
      current = { add: fileIndent.slice(searchIndent.length) }
    else if (searchIndent.startsWith(fileIndent))
      current = { remove: searchIndent.slice(fileIndent.length) }
    else return 'mixed'
    if (shift === undefined) shift = current
    else if (JSON.stringify(shift) !== JSON.stringify(current)) return 'mixed'
  }
  return shift ?? 'none'
}

const withShift = (match: Match, result: IndentShift | 'none' | 'mixed'): Match => {
  if (result === 'mixed') return { ...match, indentUnresolved: true }
  if (result === 'none') return match
  return { ...match, indent: result }
}

/**
 * Finds `search` in `content` (both as arrays of lines). The strictest comparison that matches
 * anywhere decides: exactly one hit is the answer, several hits are *ambiguous* (never guessed),
 * none falls through to a looser comparison.
 */
export const findBlock = (
  content: readonly string[],
  search: readonly string[]
): FindResult => {
  const stripped = stripBlankEdges(search)
  if (stripped.lines.length === 0) return { ok: false, reason: 'empty' }

  const variants = [{ lines: search, lead: 0, trail: 0 }]
  if (stripped.lead > 0 || stripped.trail > 0) variants.push(stripped)

  for (const { tier, key } of WINDOW_TIERS) {
    for (const variant of variants) {
      const hits = scanWindows(content, variant.lines, key)
      if (hits.length > 1)
        return { ok: false, reason: 'ambiguous', candidates: hits.map((hit) => hit + 1) }
      if (hits.length === 1) {
        const start = hits[0]!
        const base: Match = {
          start,
          end: start + variant.lines.length,
          tier,
          trimmedLead: variant.lead,
          trimmedTrail: variant.trail
        }
        if (tier === 'exact' || tier === 'trailing-space')
          return { ok: true, match: base }
        const pairs = variant.lines.map((line, j) => [content[start + j]!, line] as const)
        return { ok: true, match: withShift(base, indentShift(pairs)) }
      }
    }
  }

  const loose = scanIgnoringBlanks(content, stripped.lines)
  if (loose.length > 1)
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: loose.map(([start]) => start + 1)
    }
  if (loose.length === 1) {
    const [start, end] = loose[0]!
    const fileLines = content.slice(start, end).filter((line) => !isBlank(line))
    const searchLines = stripped.lines.filter((line) => !isBlank(line))
    const pairs = searchLines.map((line, j) => [fileLines[j]!, line] as const)
    return {
      ok: true,
      match: withShift(
        {
          start,
          end,
          tier: 'ignore-blank-lines',
          trimmedLead: stripped.lead,
          trimmedTrail: stripped.trail
        },
        indentShift(pairs)
      )
    }
  }

  const closest = closestMatch(content, stripped.lines)
  return closest
    ? { ok: false, reason: 'not-found', closest }
    : { ok: false, reason: 'not-found' }
}

/** Replacement lines adjusted to the way the SEARCH text was matched. */
export const adjustReplacement = (replace: readonly string[], match: Match): string[] => {
  let lines = [...replace]
  for (let i = 0; i < match.trimmedLead && lines.length > 0 && isBlank(lines[0]!); i++)
    lines.shift()
  for (
    let i = 0;
    i < match.trimmedTrail && lines.length > 0 && isBlank(lines.at(-1)!);
    i++
  )
    lines.pop()
  const { indent } = match
  if (indent && 'add' in indent) {
    lines = lines.map((line) => (isBlank(line) ? line : indent.add + line))
  } else if (indent && 'remove' in indent) {
    lines = lines.map((line) =>
      line.startsWith(indent.remove) ? line.slice(indent.remove.length) : line
    )
  }
  return lines
}

// ── "closest match" hint ────────────────────────────────────────────────────────────────────

const MAX_COMPARE_CHARS = 200
const MAX_WINDOWS = 400
const MAX_NEEDLE_LINES = 60
const SNIPPET_LINES = 8

const similarity = (a: string, b: string): number => {
  if (a === b) return 1
  if (a === '' || b === '') return 0
  const x = a.slice(0, MAX_COMPARE_CHARS)
  const y = b.slice(0, MAX_COMPARE_CHARS)
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1)
      )
    }
    previous = row
  }
  return 1 - previous[y.length]! / Math.max(x.length, y.length)
}

/** The stretch of `content` that looks most like `search`, to help the author fix the SEARCH text. */
export const closestMatch = (
  content: readonly string[],
  search: readonly string[]
): ClosestMatch | undefined => {
  const needle = search.slice(0, MAX_NEEDLE_LINES)
  if (needle.length === 0 || content.length === 0) return undefined
  const wanted = needle.map(collapse)
  const keyed = content.map(collapse)
  const lastStart = Math.max(0, keyed.length - wanted.length)

  const starts = new Set<number>()
  wanted.forEach((key, j) => {
    if (key === '') return
    keyed.forEach((candidate, i) => {
      if (candidate === key && i - j >= 0 && i - j <= lastStart) starts.add(i - j)
    })
  })
  if (starts.size === 0 && keyed.length <= 3_000) {
    for (let i = 0; i <= lastStart; i++) starts.add(i)
  }

  let best: { start: number; score: number } | undefined
  for (const start of [...starts].slice(0, MAX_WINDOWS)) {
    let total = 0
    for (let j = 0; j < wanted.length; j++) {
      total += similarity(keyed[start + j] ?? '', wanted[j]!)
    }
    const score = total / wanted.length
    if (!best || score > best.score) best = { start, score }
  }
  if (!best || best.score < 0.5) return undefined
  const end = Math.min(content.length, best.start + search.length)
  return {
    startLine: best.start + 1,
    endLine: Math.max(best.start + 1, end),
    score: Math.round(best.score * 100) / 100,
    snippet: content
      .slice(best.start, best.start + Math.min(search.length, SNIPPET_LINES))
      .map((line) => line)
  }
}
