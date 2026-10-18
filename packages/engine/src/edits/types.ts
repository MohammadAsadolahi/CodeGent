/** What ChatGPT says about whether more work remains after this step. */
export type ReplyStatus = 'continue' | 'done' | 'blocked'

/** One SEARCH/REPLACE pair. Lines carry no terminators. */
export interface Hunk {
  search: string[]
  replace: string[]
}

export type FileEdit =
  | { kind: 'update'; path: string; hunks: Hunk[] }
  /** Whole new content for a file that already exists. */
  | { kind: 'replace'; path: string; content: string }
  | { kind: 'create'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; from: string; to: string; hunks: Hunk[] }

export interface ParseProblem {
  /** The file the problem belongs to, when known. */
  path?: string
  message: string
}

export interface ParsedReply {
  edits: FileEdit[]
  status: ReplyStatus | undefined
  /** The prose of the reply, without edit blocks or the status line. */
  summary: string
  /** Things that were understood but unusual (e.g. whole-file content under "Updated file"). */
  warnings: string[]
  /** Things that could not be understood; the affected edits are NOT in `edits`. */
  problems: ParseProblem[]
  /** An unclosed code block or conflict marker: the reply was probably cut off. */
  truncated: boolean
}

/** Why a path or edit was rejected or could not be applied. */
export type EditErrorCode =
  | 'path'
  | 'missing-file'
  | 'not-found'
  | 'ambiguous'
  | 'empty-search'
  | 'exists'
  | 'dirty-file'
  | 'ignored-file'
  | 'binary-file'
  | 'conflict'

export interface ClosestMatch {
  startLine: number
  endLine: number
  /** 0–1 similarity of the best window to the SEARCH text. */
  score: number
  snippet: string[]
}

export interface EditError {
  code: EditErrorCode
  message: string
  /** 1-based index of the failing hunk within the edit, when applicable. */
  hunk?: number
  /** 1-based lines where an ambiguous SEARCH text matched. */
  candidates?: number[]
  closest?: ClosestMatch
}

export type MatchTier =
  'exact' | 'trailing-space' | 'trim' | 'collapse-space' | 'ignore-blank-lines'

export type FileChange =
  | { kind: 'create'; path: string; after: string }
  | { kind: 'modify'; path: string; before: string; after: string }
  | { kind: 'delete'; path: string; before: string }
  | { kind: 'rename'; from: string; to: string; before: string; after: string }

/** What happened to one parsed edit. */
export interface EditOutcome {
  edit: FileEdit
  /** The path shown to people (the destination for renames). */
  path: string
  status: 'applied' | 'skipped' | 'failed'
  /** Short human summary, e.g. "2 hunks" or "already absent". */
  detail: string
  errors: EditError[]
  /** Notes worth passing on, e.g. "matched ignoring indentation". */
  notes: string[]
}

export interface ChangeSet {
  outcomes: EditOutcome[]
  /** Net effect per path after all applied edits, in a stable order. */
  changes: FileChange[]
}
