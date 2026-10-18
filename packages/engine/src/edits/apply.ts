import { adjustReplacement, findBlock } from './match'
import type { ClosestMatch, EditError, Hunk, MatchTier } from './types'

export interface HunkOutcome {
  /** 1-based, in the order the hunks appeared. */
  index: number
  ok: boolean
  tier?: MatchTier
  /** 1-based inclusive line range that was replaced, in the file as it was when the hunk ran. */
  startLine?: number
  endLine?: number
  note?: string
  error?: EditError
}

export interface ApplyResult {
  /** True only when every hunk applied; `content` is then the new text. */
  ok: boolean
  content: string
  hunks: HunkOutcome[]
}

interface Line {
  text: string
  /** The terminator that followed this line in the original ('\n', '\r\n'); '' when none. */
  eol: string
}

const splitLines = (content: string): Line[] => {
  const lines: Line[] = []
  const pattern = /\r\n|\n/g
  let last = 0
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    lines.push({ text: content.slice(last, match.index), eol: match[0] })
    last = match.index + match[0].length
  }
  if (last < content.length) lines.push({ text: content.slice(last), eol: '' })
  return lines
}

export const dominantEol = (content: string): string => {
  const crlf = (content.match(/\r\n/g) ?? []).length
  const lf = (content.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

const describeFailure = (
  reason: 'not-found' | 'ambiguous' | 'empty',
  hunk: number,
  detail: { candidates?: number[]; closest?: ClosestMatch }
): EditError => {
  if (reason === 'ambiguous') {
    const where = detail.candidates!.slice(0, 6).join(', ')
    return {
      code: 'ambiguous',
      hunk,
      candidates: detail.candidates,
      message: `SEARCH text of hunk ${hunk} matches ${detail.candidates!.length} places (lines ${where}); include more surrounding lines so it matches exactly one place.`
    }
  }
  if (reason === 'empty') {
    return {
      code: 'empty-search',
      hunk,
      message: `SEARCH text of hunk ${hunk} is empty; include at least one existing line to anchor the change.`
    }
  }
  return {
    code: 'not-found',
    hunk,
    closest: detail.closest,
    message: detail.closest
      ? `SEARCH text of hunk ${hunk} was not found. The closest text is at lines ${detail.closest.startLine}–${detail.closest.endLine}.`
      : `SEARCH text of hunk ${hunk} was not found anywhere in the file.`
  }
}

/**
 * Applies SEARCH/REPLACE hunks to `content` one after another (each sees the result of the ones
 * before it). Original line endings, the final-newline convention and every untouched line are
 * preserved byte for byte. If any hunk fails the content is returned unchanged with `ok: false`.
 */
export const applyHunks = (content: string, hunks: readonly Hunk[]): ApplyResult => {
  const eol = dominantEol(content)
  const lines = splitLines(content)
  const hadFinalNewline = content === '' || lines.at(-1)?.eol !== ''
  const outcomes: HunkOutcome[] = []

  hunks.forEach((hunk, offset) => {
    const index = offset + 1
    const view = lines.map((line) => line.text)

    // An empty SEARCH is only meaningful for an empty file: it provides the whole content.
    if (hunk.search.every((line) => line.trim() === '')) {
      if (lines.length === 0) {
        lines.push(...hunk.replace.map((text) => ({ text, eol })))
        outcomes.push({ index, ok: true, note: 'filled an empty file' })
      } else {
        outcomes.push({ index, ok: false, error: describeFailure('empty', index, {}) })
      }
      return
    }

    const found = findBlock(view, hunk.search)
    if (!found.ok) {
      outcomes.push({
        index,
        ok: false,
        error: describeFailure(found.reason, index, {
          candidates: found.reason === 'ambiguous' ? found.candidates : undefined,
          closest: found.reason === 'not-found' ? found.closest : undefined
        })
      })
      return
    }

    const { match } = found
    const replacement = adjustReplacement(hunk.replace, match).map((text) => ({
      text,
      eol
    }))
    lines.splice(match.start, match.end - match.start, ...replacement)
    const notes: string[] = []
    if (match.tier !== 'exact') notes.push(`matched ignoring ${describeTier(match.tier)}`)
    if (match.indent)
      notes.push('indentation of the replacement was adjusted to the file')
    if (match.indentUnresolved)
      notes.push(
        'indentation differed inconsistently; the replacement was inserted as written'
      )
    outcomes.push({
      index,
      ok: true,
      tier: match.tier,
      startLine: match.start + 1,
      endLine: Math.max(match.start + 1, match.end),
      note: notes.join('; ') || undefined
    })
  })

  const ok = outcomes.every((outcome) => outcome.ok)
  if (!ok) return { ok: false, content, hunks: outcomes }

  return {
    ok: true,
    content: join(lines, hadFinalNewline, eol, content === ''),
    hunks: outcomes
  }
}

const describeTier = (tier: MatchTier): string => {
  switch (tier) {
    case 'trailing-space':
      return 'trailing whitespace'
    case 'trim':
      return 'indentation'
    case 'collapse-space':
      return 'indentation and repeated spaces'
    case 'ignore-blank-lines':
      return 'indentation and blank lines'
    default:
      return 'nothing'
  }
}

const join = (
  lines: readonly Line[],
  hadFinalNewline: boolean,
  eol: string,
  wasEmpty: boolean
): string => {
  if (lines.length === 0) return ''
  const finalNewline = wasEmpty ? true : hadFinalNewline
  let out = ''
  lines.forEach((line, i) => {
    const last = i === lines.length - 1
    out += line.text
    if (!last) out += line.eol || eol
    else if (finalNewline) out += line.eol || eol
  })
  return out
}

/** Whole-file content normalised to the conventions of the file it replaces (or the repo default). */
export const conformContent = (content: string, original: string | null): string => {
  const normalized = content.replace(/\r\n?/g, '\n')
  const eol = original === null ? '\n' : dominantEol(original)
  let result = eol === '\n' ? normalized : normalized.replace(/\n/g, eol)
  if (result === '') return result
  const originalEndsWithNewline =
    original === null || original === '' || /\n$/.test(original)
  if (originalEndsWithNewline && !result.endsWith('\n')) result += eol
  return result
}
