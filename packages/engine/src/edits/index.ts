export * from './types'
export { normalizeRepoPath, type PathOptions, type PathResult } from './paths'
export { describeReplyShape, parseReply, type ReplyShape } from './parse'
export { findPlaceholder, isPlaceholderLine } from './placeholders'
export {
  adjustReplacement,
  closestMatch,
  findBlock,
  type FindResult,
  type IndentShift,
  type Match
} from './match'
export {
  applyHunks,
  conformContent,
  dominantEol,
  type ApplyResult,
  type HunkOutcome
} from './apply'
export {
  BinaryFileError,
  planChanges,
  type PlanOptions,
  type WorkspaceView
} from './plan'
