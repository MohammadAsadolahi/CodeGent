import type { FileEdit, Hunk, ParsedReply, ParseProblem, ReplyStatus } from './types'

/**
 * Parses ChatGPT's reply (markdown) into file edits.
 *
 * The contract, in short: a heading names the operation and the file, a fenced code block holds
 * the content (SEARCH/REPLACE hunks for updates), and `CODEGENT_STATUS: …` closes the reply. The
 * parser accepts the harmless variations chat models produce, but it only ever creates an edit
 * from a block that is *attached to a file heading* — loose code samples are never mistaken for
 * file content, and only the first block after a heading can define it.
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
  problems: ParseProblem[]
): boolean => {
  if (parsed.unterminated) {
    problems.push({
      path,
      message:
        'a SEARCH/REPLACE section was never closed; nothing from this block was used'
    })
    return false
  }
  if (parsed.malformed) {
    problems.push({
      path,
      message: `malformed SEARCH/REPLACE block: ${parsed.malformed}`
    })
    return false
  }
  if (parsed.stray.length > 0) {
    problems.push({
      path,
      message: `text outside the SEARCH/REPLACE markers (“${parsed.stray[0]!.trim().slice(0, 60)}”); put every change inside a marker pair`
    })
    return false
  }
  if (parsed.hunks.length === 0) {
    problems.push({ path, message: 'the block contains no complete SEARCH/REPLACE pair' })
    return false
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

  const closePending = () => {
    const open = pending as Pending | null
    if (
      open &&
      !open.consumed &&
      open.header.operation !== 'delete' &&
      open.header.operation !== 'rename'
    ) {
      problems.push({
        path: open.header.paths[0],
        message: `“${open.header.operation} file” heading without a code block holding the content`,
        kind: 'heading-without-block'
      })
    }
    pending = null
  }

  const handleBlock = (body: string[], cutOff: boolean) => {
    const meaningful = body.filter((line) => line.trim() !== '')
    if (meaningful.length === 1 && STATUS_RE.test(meaningful[0]!)) {
      status = STATUS_RE.exec(meaningful[0]!)!.groups!.value!.toLowerCase() as ReplyStatus
      return
    }

    const current = pending as Pending | null
    if (!current) {
      if (body.some((line) => CONFLICT_START.test(line))) {
        problems.push({
          message: 'a SEARCH/REPLACE block was not preceded by a file heading'
        })
      }
      return // an ordinary code sample
    }
    const { operation, paths } = current.header
    const path = operation === 'rename' ? paths[1]! : paths[0]!

    if (cutOff) {
      problems.push({
        path,
        message: 'the reply was cut off inside this code block; nothing from it was used'
      })
      current.consumed = true
      return
    }
    const parsed = parseHunks(body)

    // Later blocks under the same heading can only *add hunks*; a marker-less block is commentary.
    if (current.consumed) {
      const target = current.edit as Extendable | undefined
      if (parsed.hasMarkers && (target?.kind === 'update' || target?.kind === 'rename')) {
        if (acceptHunks(parsed, path, problems)) target.hunks.push(...parsed.hunks)
      }
      return
    }
    current.consumed = true

    switch (operation) {
      case 'update': {
        if (!parsed.hasMarkers) {
          warnings.push(
            `“${path}”: no SEARCH/REPLACE markers, so the block was treated as the complete new file`
          )
          const edit: FileEdit = { kind: 'replace', path, content: body.join('\n') }
          edits.push(edit)
          current.edit = edit
          return
        }
        if (!acceptHunks(parsed, path, problems)) return
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
            message: 'SEARCH/REPLACE markers are not valid in a complete-file block'
          })
          return
        }
        const edit: FileEdit = { kind: operation, path, content: body.join('\n') }
        edits.push(edit)
        current.edit = edit
        return
      }
      case 'rename': {
        const rename = current.edit as Extendable | undefined
        if (parsed.hasMarkers) {
          if (acceptHunks(parsed, path, problems) && rename?.kind === 'rename')
            rename.hunks.push(...parsed.hunks)
        } else if (meaningful.length > 0) {
          edits.push({ kind: 'replace', path, content: body.join('\n') })
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

    const statusMatch = STATUS_RE.exec(line)
    if (statusMatch?.groups) {
      status = statusMatch.groups.value!.toLowerCase() as ReplyStatus
      continue
    }

    const header = parseHeader(line)
    if (header) {
      closePending()
      if (header.operation === 'delete') {
        edits.push({ kind: 'delete', path: header.paths[0]! })
        pending = { header, consumed: true }
      } else if (header.operation === 'rename') {
        const edit: FileEdit = {
          kind: 'rename',
          from: header.paths[0]!,
          to: header.paths[1]!,
          hunks: []
        }
        edits.push(edit)
        pending = { header, consumed: false, edit }
      } else {
        pending = { header, consumed: false }
      }
      continue
    }

    prose.push(line)
  }
  closePending()

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
