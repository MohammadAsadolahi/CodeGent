import type {
  FileEdit,
  Hunk,
  ParsedReply,
  ParseProblem,
  ProblemKind,
  ReplyStatus
} from './types'

/**
 * Parses ChatGPT's reply (markdown) into file edits.
 *
 * The contract, in short: a heading names the operation and the file, a fenced code block holds
 * the content (SEARCH/REPLACE hunks for updates), and `CODEGENT_STATUS: …` closes the reply. The
 * parser accepts the harmless variations chat models produce, but it only ever creates an edit
 * from a block that is *attached to a file heading* — loose code samples are never mistaken for
 * file content, and only the first block after a heading can define it.
 *
 * Variations it understands besides the canonical form: SEARCH/REPLACE pairs written straight
 * under the heading without a fence; headings written *inside* the code block; and a bare file
 * name above a fenced SEARCH/REPLACE block (the way many coding tools format edits).
 */

type Operation = 'update' | 'create' | 'delete' | 'rename' | 'replace'

interface Header {
  operation: Operation
  /** Paths exactly as written (not yet normalised or validated). */
  paths: string[]
}

const VERBS: ReadonlyArray<[RegExp, Operation]> = [
  [/^(?:updat|modif|edit|chang|patch|fix)/i, 'update'],
  [/^(?:creat|new|add)/i, 'create'],
  [/^(?:delet|remov)/i, 'delete'],
  [/^(?:renam|mov)/i, 'rename'],
  [/^(?:replac|rewrit|rewrote|overwr)/i, 'replace']
]

const HEADER_RE =
  /^\s{0,3}(?<marker>#{1,6}\s*|\*\*\s*|__\s*|[-*+]\s+\*\*\s*)?(?<verb>updated?|modif(?:y|ied)|edit(?:ed)?|changed?|patch(?:ed)?|fix(?:ed)?|created?|new|added?|deleted?|removed?|remove|renamed?|moved?|replaced?|rewrit(?:e|ten)|rewrote|overwr(?:ite|itten))\b(?<file>\s+(?:the\s+)?files?\b)?(?<rest>.*)$/i

const STATUS_RE =
  /^\s*(?:[>*_`#\-\s]*)CODEGENT_STATUS\s*:\s*[*_`]*\s*(?<value>continue|done|blocked)\b/i

const FENCE_RE = /^(?<indent>\s*)(?<marker>`{3,}|~{3,})(?<info>[^`]*)$/
const CONFLICT_START = /^<{5,9}(?:[ \t].*)?$/
const CONFLICT_MID = /^={5,9}[ \t]*$/
const CONFLICT_END = /^>{5,9}(?:[ \t].*)?$/

/**
 * What is left of SEARCH/REPLACE markers after a chat page has rendered them as ordinary
 * markdown: the start marker as text, the end marker as seven nested block quotes.
 */
const MARKER_REMNANTS = /<{5,9}[ \t]*SEARCH|(?:>[ \t]*){5,9}REPLACE\b/i

const MAX_PATH_TEXT = 1_000

const looksLikePath = (text: string): boolean =>
  text.length > 0 &&
  text.length <= MAX_PATH_TEXT &&
  !/[\r\n]/.test(text) &&
  !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)

const stripEmphasis = (text: string): string => text.replace(/(\*\*|__)/g, '').trim()

const classifyVerb = (verb: string): Operation => {
  for (const [pattern, operation] of VERBS) if (pattern.test(verb)) return operation
  return 'update'
}

/** Pulls the file path(s) out of whatever follows the verb in a heading. */
const extractPaths = (rest: string, operation: Operation): string[] => {
  const ticks = [...rest.matchAll(/`([^`\n]+)`(?<after>[^`]{0,16})/g)]
  if (ticks.length > 0) {
    const spans = ticks.map((tick) => ({
      text: tick[1]!.trim(),
      role: /\(\s*old\s*\)/i.test(tick.groups!.after!)
        ? 'old'
        : /\(\s*new\s*\)/i.test(tick.groups!.after!)
          ? 'new'
          : undefined
    }))
    if (operation === 'rename' && spans.length >= 2) {
      const oldSpan = spans.find((span) => span.role === 'old')
      const newSpan = spans.find((span) => span.role === 'new')
      if (oldSpan && newSpan && oldSpan !== newSpan) return [oldSpan.text, newSpan.text]
      return [spans[0]!.text, spans[1]!.text]
    }
    return spans.map((span) => span.text).filter(looksLikePath)
  }
  // Unquoted: accept only something that is clearly a path (has a slash or an extension).
  const cleaned = stripEmphasis(rest)
    .replace(/^\s*[:\-–—]\s*/, '')
    .trim()
  if (operation === 'rename') {
    const parts = cleaned.split(/\s*(?:->|→|=>|\bto\b)\s*/i).map((part) => part.trim())
    if (
      parts.length === 2 &&
      parts.every((part) => /[/.]/.test(part) && !/\s/.test(part))
    )
      return parts
    return []
  }
  const token = cleaned.split(/\s+/)[0]?.replace(/[:,;.)]+$/, '') ?? ''
  return /[/.]/.test(token) && looksLikePath(token) ? [token] : []
}

const parseHeader = (line: string): Header | null => {
  const match = HEADER_RE.exec(line)
  if (!match?.groups) return null
  const { marker, verb, file, rest } = match.groups
  if (!marker && !file) return null // plain prose such as "Updated the config to …"
  const operation = classifyVerb(verb!)
  const paths = extractPaths(rest ?? '', operation)
  if (paths.length === 0) return null
  if (operation === 'rename' && paths.length < 2) return null
  return { operation, paths }
}

/**
 * A line that holds nothing but a file name — `src/a.ts`, **src/a.ts**, `File: src/a.ts`,
 * `### src/a.ts:` — the way many coding tools announce an edit. Only a path-like token counts
 * (a slash or a file extension, no spaces).
 */
const parseBareFileName = (line: string): string | null => {
  let text = line.trim()
  if (text === '' || text.length > 300) return null
  text = text.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d{1,2}[.)]\s+)/, '')
  text = text.replace(
    /^(?:\*\*|__)?\s*(?:file(?:name)?|path)\s*[:\-–—]\s*(?:\*\*|__)?\s*/i,
    ''
  )
  text = text.replace(/[\s:]*(?:\*\*|__)?[\s:]*$/, '')
  const wrapped =
    /^(?:\*\*|__)?`([^`\n]+)`(?:\*\*|__)?$/.exec(text) ??
    /^(?:\*\*|__)([^*_\n]+?)(?:\*\*|__)$/.exec(text)
  const candidate = (wrapped ? wrapped[1]! : text).trim()
  if (candidate === '' || /\s/.test(candidate)) return null
  if (!/^[\w.@+~$%\-/\\]+$/.test(candidate)) return null
  if (!/[/\\]/.test(candidate) && !/\.[A-Za-z0-9]{1,10}$/.test(candidate)) return null
  return looksLikePath(candidate) ? candidate : null
}

interface HunkParse {
  hunks: Hunk[]
  hasMarkers: boolean
  stray: string[]
  malformed: string | undefined
  unterminated: boolean
}

const parseHunks = (body: readonly string[]): HunkParse => {
  const result: HunkParse = {
    hunks: [],
    hasMarkers: false,
    stray: [],
    malformed: undefined,
    unterminated: false
  }
  let state: 'outside' | 'search' | 'replace' = 'outside'
  let search: string[] = []
  let replace: string[] = []
  for (const line of body) {
    if (state === 'outside') {
      if (CONFLICT_START.test(line)) {
        result.hasMarkers = true
        state = 'search'
        search = []
        replace = []
      } else if (line.trim() !== '') {
        result.stray.push(line)
      }
    } else if (state === 'search') {
      if (CONFLICT_MID.test(line)) state = 'replace'
      else if (CONFLICT_START.test(line) || CONFLICT_END.test(line)) {
        result.malformed ??= 'a conflict marker appeared inside a SEARCH section'
      } else search.push(line)
    } else if (CONFLICT_END.test(line)) {
      result.hunks.push({ search, replace })
      state = 'outside'
    } else if (CONFLICT_START.test(line) || CONFLICT_MID.test(line)) {
      result.malformed ??= 'a conflict marker appeared inside a REPLACE section'
    } else replace.push(line)
  }
  result.unterminated = state !== 'outside'
  return result
}

/** Records why a block of hunks cannot be trusted; returns whether it can be used. */
const acceptHunks = (
  parsed: HunkParse,
  path: string,
  problems: ParseProblem[],
  operation?: ParseProblem['operation']
): boolean => {
  const reject = (kind: ProblemKind, message: string): false => {
    problems.push({ path, operation, message, kind })
    return false
  }
  if (parsed.unterminated) {
    return reject(
      'unclosed-markers',
      'a SEARCH/REPLACE section was never closed; nothing from this block was used'
    )
  }
  if (parsed.malformed) {
    return reject(
      'malformed-markers',
      `malformed SEARCH/REPLACE block: ${parsed.malformed}`
    )
  }
  if (parsed.stray.length > 0) {
    return reject(
      'stray-text',
      `text outside the SEARCH/REPLACE markers (“${parsed.stray[0]!.trim().slice(0, 60)}”); put every change inside a marker pair`
    )
  }
  if (parsed.hunks.length === 0) {
    return reject('empty-block', 'the block contains no complete SEARCH/REPLACE pair')
  }
  return true
}

const stripIndent = (line: string, width: number): string => {
  let removed = 0
  while (
    removed < width &&
    removed < line.length &&
    (line[removed] === ' ' || line[removed] === '\t')
  )
    removed++
  return line.slice(removed)
}

type Extendable = Extract<FileEdit, { kind: 'update' | 'rename' }>

interface Pending {
  header: Header
  /** Whether the first code block after the heading has been used. */
  consumed: boolean
  /** The edit this heading produced, so that later marker blocks can add hunks to it. */
  edit?: FileEdit
  /** Index of the heading line, to look for unreadable SEARCH/REPLACE text when no block follows. */
  line: number
  /**
   * The heading was inferred from a bare file name. That is only a guess, so only a block with
   * SEARCH/REPLACE markers may use it (those still have to match the file exactly); any other
   * block is an ordinary code sample.
   */
  inferred?: boolean
}

const nextNonBlank = (lines: readonly string[], from: number): number => {
  let index = from
  while (index < lines.length && lines[index]!.trim() === '') index++
  return index
}

/**
 * Whether a heading-like line really announces a file: what follows it (a fence, SEARCH/REPLACE
 * markers, another heading or the end) is what a heading is followed by, so that a similar-looking
 * line inside a hunk's text is left alone.
 */
const announcesContent = (lines: readonly string[], index: number): boolean => {
  const header = parseHeader(lines[index]!)
  if (!header) return false
  if (header.operation === 'delete' || header.operation === 'rename') return true
  const next = nextNonBlank(lines, index + 1)
  if (next >= lines.length) return true
  const line = lines[next]!
  return (
    FENCE_RE.test(line) ||
    CONFLICT_START.test(line) ||
    parseHeader(line) !== null ||
    STATUS_RE.test(line)
  )
}

const samePath = (a: Header, b: Header): boolean =>
  a.paths[a.operation === 'rename' ? 1 : 0] === b.paths[b.operation === 'rename' ? 1 : 0]

/** Longest run of backticks (or tildes) in `lines`, to wrap them in a fence they cannot close. */
const wrapInFence = (lines: readonly string[]): string[] => {
  const longest = Math.max(
    0,
    ...lines.flatMap((line) => [...line.matchAll(/`{3,}/g)].map((run) => run[0].length))
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [fence, ...lines, fence]
}

/**
 * A code block that carries its own file headings (the model put the headings *inside* the fence,
 * or wrapped the whole answer in one). Returns each file's section as ordinary reply text, so that
 * the normal rules apply to it; or null when the block is an ordinary code sample.
 */
const splitBundle = (
  body: readonly string[],
  outer: Pending | null
): { sections: Array<{ header: Header; text: string }>; status?: ReplyStatus } | null => {
  const starts: Array<{ index: number; header: Header; announced: boolean }> = []
  for (let index = 0; index < body.length; index++) {
    const header = parseHeader(body[index]!)
    if (!header) continue
    const next = nextNonBlank(body, index + 1)
    const content = next < body.length
    const announced =
      content && (CONFLICT_START.test(body[next]!) || FENCE_RE.test(body[next]!))
    const ok =
      header.operation === 'update'
        ? announced
        : header.operation === 'delete' || header.operation === 'rename'
          ? true
          : content
    if (ok) starts.push({ index, header, announced })
  }
  const first = starts[0]
  if (!first) return null
  // Text before the first heading makes this a code sample that merely mentions one — unless the
  // block is plainly a whole reply: an update heading directly followed by its SEARCH/REPLACE text.
  const leading = body.slice(0, first.index).some((line) => line.trim() !== '')
  if (leading && !starts.some((start) => start.announced)) return null
  // A block under another file's heading is that file's content, even if it looks like a heading.
  if (outer && !outer.consumed && !samePath(outer.header, first.header)) return null

  let status: ReplyStatus | undefined
  const sections = starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? body.length
    const rest = body.slice(start.index + 1, end)
    while (rest.length > 0 && rest[rest.length - 1]!.trim() === '') rest.pop()
    const tail = rest[rest.length - 1]
    const closing = tail === undefined ? null : STATUS_RE.exec(tail)
    if (closing?.groups && position === starts.length - 1) {
      status = closing.groups.value!.toLowerCase() as ReplyStatus
      rest.pop()
      while (rest.length > 0 && rest[rest.length - 1]!.trim() === '') rest.pop()
    }
    const firstContent = nextNonBlank(rest, 0)
    const needsFence =
      (start.header.operation === 'create' || start.header.operation === 'replace') &&
      firstContent < rest.length &&
      !FENCE_RE.test(rest[firstContent]!)
    const section = needsFence ? wrapInFence(rest.slice(firstContent)) : rest
    return { header: start.header, text: [body[start.index]!, ...section].join('\n') }
  })
  return { sections, status }
}

export const parseReply = (markdown: string): ParsedReply => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const edits: FileEdit[] = []
  const warnings: string[] = []
  const problems: ParseProblem[] = []
  const prose: string[] = []
  let status: ReplyStatus | undefined
  let truncated = false
  let pending: Pending | null = null

  const closePending = (endLine: number) => {
    const open = pending as Pending | null
    pending = null
    if (
      !open ||
      open.consumed ||
      open.inferred ||
      open.header.operation === 'delete' ||
      open.header.operation === 'rename'
    )
      return
    const unreadable = lines
      .slice(open.line + 1, endLine)
      .some((line) => MARKER_REMNANTS.test(line))
    problems.push({
      path: open.header.paths[0],
      operation: open.header.operation,
      message: unreadable
        ? `“${open.header.operation} file” heading followed by SEARCH/REPLACE text that is not inside a fenced code block`
        : `“${open.header.operation} file” heading without a code block holding the content`,
      kind: unreadable ? 'unfenced-markers' : 'heading-without-block'
    })
  }

  /** Merges the result of parsing a section of a reply that sits inside a code block. */
  const absorb = (inner: ParsedReply) => {
    edits.push(...inner.edits)
    warnings.push(...inner.warnings)
    problems.push(...inner.problems)
    if (inner.truncated) truncated = true
    if (inner.status) status = inner.status
  }

  const handleBlock = (body: string[], cutOff: boolean) => {
    const meaningful = body.filter((line) => line.trim() !== '')
    if (meaningful.length === 1 && STATUS_RE.test(meaningful[0]!)) {
      status = STATUS_RE.exec(meaningful[0]!)!.groups!.value!.toLowerCase() as ReplyStatus
      return
    }

    const current = pending as Pending | null

    const bundle = splitBundle(body, current)
    if (bundle) {
      bundle.sections.forEach((section, index) => {
        const inner = parseReply(section.text)
        if (cutOff && index === bundle.sections.length - 1) inner.truncated = true
        absorb(inner)
      })
      if (bundle.status) status = bundle.status
      if (
        current &&
        !current.consumed &&
        samePath(current.header, bundle.sections[0]!.header)
      )
        current.consumed = true
      return
    }
    const content = body

    if (!current) {
      if (content.some((line) => CONFLICT_START.test(line))) {
        problems.push({
          message: 'a SEARCH/REPLACE block was not preceded by a file heading',
          kind: 'orphan-block'
        })
      }
      return // an ordinary code sample
    }
    const { operation, paths } = current.header
    const path = operation === 'rename' ? paths[1]! : paths[0]!

    if (cutOff) {
      if (!current.inferred) {
        problems.push({
          path,
          operation,
          message:
            'the reply was cut off inside this code block; nothing from it was used',
          kind: 'cut-off'
        })
      }
      current.consumed = true
      return
    }
    const parsed = parseHunks(content)

    // Later blocks under the same heading can only *add hunks*; a marker-less block is commentary.
    if (current.consumed) {
      const target = current.edit as Extendable | undefined
      if (parsed.hasMarkers && (target?.kind === 'update' || target?.kind === 'rename')) {
        if (acceptHunks(parsed, path, problems, operation))
          target.hunks.push(...parsed.hunks)
      }
      return
    }
    current.consumed = true

    if (current.inferred && !parsed.hasMarkers) return // a code sample that follows a file name

    switch (operation) {
      case 'update': {
        if (!parsed.hasMarkers) {
          warnings.push(
            `“${path}”: no SEARCH/REPLACE markers, so the block was treated as the complete new file`
          )
          const edit: FileEdit = { kind: 'replace', path, content: content.join('\n') }
          edits.push(edit)
          current.edit = edit
          return
        }
        if (!acceptHunks(parsed, path, problems, operation)) return
        const edit: FileEdit = { kind: 'update', path, hunks: parsed.hunks }
        edits.push(edit)
        current.edit = edit
        return
      }
      case 'create':
      case 'replace': {
        if (parsed.hasMarkers) {
          problems.push({
            path,
            operation,
            message: 'SEARCH/REPLACE markers are not valid in a complete-file block',
            kind: 'markers-in-complete-file'
          })
          return
        }
        const edit: FileEdit = { kind: operation, path, content: content.join('\n') }
        edits.push(edit)
        current.edit = edit
        return
      }
      case 'rename': {
        const rename = current.edit as Extendable | undefined
        if (parsed.hasMarkers) {
          if (acceptHunks(parsed, path, problems, operation) && rename?.kind === 'rename')
            rename.hunks.push(...parsed.hunks)
        } else if (meaningful.length > 0) {
          edits.push({ kind: 'replace', path, content: content.join('\n') })
        }
        return
      }
      case 'delete':
        return // unreachable: a delete heading is complete on its own, later blocks are commentary
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    const fence = FENCE_RE.exec(line)
    if (fence?.groups) {
      const { indent, marker } = fence.groups
      const closing = new RegExp(
        `^\\s*${marker![0] === '`' ? '`' : '~'}{${marker!.length},}\\s*$`
      )
      const body: string[] = []
      let closed = false
      let j = i + 1
      for (; j < lines.length; j++) {
        if (closing.test(lines[j]!)) {
          closed = true
          break
        }
        body.push(stripIndent(lines[j]!, indent!.length))
      }
      if (!closed) truncated = true
      handleBlock(body, !closed)
      i = closed ? j : lines.length
      continue
    }

    if (CONFLICT_START.test(line)) {
      const body = [line]
      let j = i
      let closed = false
      for (; j + 1 < lines.length; j++) {
        const next = lines[j + 1]!
        if (CONFLICT_END.test(next)) {
          body.push(next)
          j++
          closed = true
          break
        }
        if (STATUS_RE.test(next) || announcesContent(lines, j + 1)) break
        body.push(next)
      }
      handleBlock(body, false)
      i = j
      if (!closed && j === lines.length - 1) truncated = true
      continue
    }

    const statusMatch = STATUS_RE.exec(line)
    if (statusMatch?.groups) {
      status = statusMatch.groups.value!.toLowerCase() as ReplyStatus
      continue
    }

    const header = parseHeader(line)
    if (header) {
      closePending(i)
      if (header.operation === 'delete') {
        edits.push({ kind: 'delete', path: header.paths[0]! })
        pending = { header, consumed: true, line: i }
      } else if (header.operation === 'rename') {
        const edit: FileEdit = {
          kind: 'rename',
          from: header.paths[0]!,
          to: header.paths[1]!,
          hunks: []
        }
        edits.push(edit)
        pending = { header, consumed: false, edit, line: i }
      } else {
        pending = { header, consumed: false, line: i }
      }
      continue
    }

    const bare = parseBareFileName(line)
    if (bare) {
      const next = nextNonBlank(lines, i + 1)
      if (
        next < lines.length &&
        (FENCE_RE.test(lines[next]!) || CONFLICT_START.test(lines[next]!))
      ) {
        closePending(i)
        pending = {
          header: { operation: 'update', paths: [bare] },
          consumed: false,
          inferred: true,
          line: i
        }
        continue
      }
    }

    prose.push(line)
  }
  closePending(lines.length)

  return {
    edits,
    status,
    summary: prose
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    warnings,
    problems,
    truncated
  }
}

/** Counts of what a reply is made of, for diagnosing a reply that could not be used (no content). */
export interface ReplyShape {
  chars: number
  lines: number
  /** Fence lines (an opening and a closing fence count as two). */
  fenceLines: number
  /** Lines that start a SEARCH/REPLACE pair, inside a fence or not. */
  markerLines: number
  /** Lines that read as a file heading. */
  headingLines: number
}

export const describeReplyShape = (markdown: string): ReplyShape => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  return {
    chars: markdown.length,
    lines: lines.length,
    fenceLines: lines.filter((line) => FENCE_RE.test(line)).length,
    markerLines: lines.filter((line) => CONFLICT_START.test(line)).length,
    headingLines: lines.filter((line) => parseHeader(line) !== null).length
  }
}
