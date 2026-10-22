import type { EditError, EditOutcome, ParseProblem } from '../edits/types'
import { FENCE_RULE, fileTemplate, FORMAT_REMINDER, STATUS_LINES } from './instructions'
import type { RepoContext } from './initial'

export interface DiagnosticItem {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning'
  message: string
  code?: string
  source?: string
}

export interface DiagnosticsSummary {
  items: DiagnosticItem[]
  errors: number
  warnings: number
}

export interface VerifyResult {
  command: string
  /** null when the process was killed (timeout) or could not start. */
  exitCode: number | null
  timedOut?: boolean
  outputTail: string
}

export type PublishResult =
  | {
      state: 'pushed'
      sha: string
      shortSha: string
      message: string
      branch: string
      remote: string
    }
  /** Committed locally, but the push was disabled or failed — ChatGPT cannot see this commit. */
  | { state: 'committed'; sha: string; shortSha: string; message: string; reason: string }
  | { state: 'skipped'; reason: string }

export interface StepReport {
  /** 1-based number of the step whose changes this report describes. */
  step: number
  repo: RepoContext
  outcomes: EditOutcome[]
  /** Problems found while reading the reply itself (e.g. an unterminated SEARCH block). */
  problems?: string[]
  /** The same problems with their kinds, so the correction can name the exact mistake. */
  problemDetails?: ParseProblem[]
  /**
   * Files whose SEARCH/REPLACE edit failed again after a correction. SEARCH text that does not
   * match is the commonest way a model keeps failing, so these are asked for as complete files.
   */
  wholeFile?: string[]
  /** A correction of the reply format was already sent: ask for one file at a time. */
  oneFileOnly?: boolean
  diagnostics?: DiagnosticsSummary
  verify?: VerifyResult
  publish?: PublishResult
}

const MAX_FAILED_FILES = 15
const MAX_DIAGNOSTICS = 25
const MAX_SNIPPET_LINES = 8
const MAX_LINE_CHARS = 160
const MAX_VERIFY_CHARS = 3_000

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`
const indent = (text: string, spaces: number): string =>
  text
    .split('\n')
    .map((line) => (line ? ' '.repeat(spaces) + line : line))
    .join('\n')

const block = (lines: readonly string[], spaces = 2): string =>
  indent(
    ['```', ...lines.map((line) => clip(line, MAX_LINE_CHARS)), '```'].join('\n'),
    spaces
  )

const appliedLine = (outcome: EditOutcome): string => {
  const edit = outcome.edit
  switch (edit.kind) {
    case 'create':
      return `- \`${outcome.path}\` — created`
    case 'delete':
      return `- \`${outcome.path}\` — deleted`
    case 'rename':
      return `- \`${edit.from}\` → \`${outcome.path}\` — renamed`
    case 'replace':
      return `- \`${outcome.path}\` — replaced as a whole file`
    default:
      return `- \`${outcome.path}\` — updated (${outcome.detail})`
  }
}

const failedBlock = (outcome: EditOutcome): string => {
  const parts = outcome.errors.map((error: EditError) => {
    let text = `- \`${outcome.path}\` — ${error.message}`
    if (error.closest) {
      const snippet = error.closest.snippet.slice(0, MAX_SNIPPET_LINES)
      text += `\n  The closest text in the file (lines ${error.closest.startLine}–${error.closest.endLine}) is:\n${block(snippet)}`
      text += '\n  Re-read the file from GitHub and copy the SEARCH text from it exactly.'
    }
    return text
  })
  return parts.join('\n')
}

const diagnosticsBlock = (summary: DiagnosticsSummary): string => {
  if (summary.errors === 0 && summary.warnings === 0)
    return '- Editor diagnostics for the changed files: none (no errors or warnings).'
  const sorted = [...summary.items].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1
  )
  const shown = sorted.slice(0, MAX_DIAGNOSTICS)
  const lines = shown.map((item) => {
    const label = [item.source, item.code].filter(Boolean).join(' ')
    return `  - \`${item.path}\` ${item.line}:${item.column} ${item.severity}${label ? ` ${label}` : ''}: ${clip(item.message.replace(/\s+/g, ' '), 240)}`
  })
  const more =
    summary.items.length > shown.length
      ? [`  - … and ${summary.items.length - shown.length} more`]
      : []
  return [
    `- Editor diagnostics for the changed files: ${summary.errors} error${summary.errors === 1 ? '' : 's'}, ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}.`,
    ...lines,
    ...more
  ].join('\n')
}

const verifyBlock = (verify: VerifyResult): string => {
  const outcome = verify.timedOut
    ? 'timed out'
    : verify.exitCode === 0
      ? 'passed'
      : verify.exitCode === null
        ? 'could not run'
        : `failed (exit code ${verify.exitCode})`
  const head = `- Check \`${clip(verify.command, 120)}\` ${outcome}.`
  if (verify.exitCode === 0 || !verify.outputTail.trim()) return head
  const tail =
    verify.outputTail.length > MAX_VERIFY_CHARS
      ? `…${verify.outputTail.slice(-MAX_VERIFY_CHARS)}`
      : verify.outputTail
  return `${head} Last output:\n${block(tail.trimEnd().split('\n').slice(-60), 2)}`
}

const publishBlock = (publish: PublishResult): string => {
  switch (publish.state) {
    case 'pushed':
      return [
        `- Committed ${publish.shortSha} “${clip(publish.message, 100)}” and pushed it to ${publish.remote}/${publish.branch}.`,
        `  Read the files again from branch "${publish.branch}" before you continue; the connector must show commit ${publish.shortSha} (${publish.sha}). If you can only see an older version, reply with ${STATUS_LINES.blocked} and say what you see.`
      ].join('\n')
    case 'committed':
      return `- Committed ${publish.shortSha} locally but it is NOT on GitHub (${publish.reason}). You cannot see these changes through the connector; rely on what you wrote and on this report.`
    case 'skipped':
      return `- Nothing was committed or pushed (${publish.reason}).`
  }
}

/**
 * Problems that are about the *shape* of the reply — the content never reached CodeGent — as
 * opposed to content that arrived but could not be applied.
 */
const SHAPE_KINDS: ReadonlySet<string | undefined> = new Set([
  'heading-without-block',
  'unfenced-markers',
  'orphan-block'
])

/** The structured problems of a report; reports built from text alone are read back from it. */
const problemDetails = (report: StepReport): ParseProblem[] => {
  if (report.problemDetails) return report.problemDetails
  return (report.problems ?? []).map((text) => {
    const named = /^“([^”]+)”: ([\s\S]*)$/.exec(text)
    const message = named?.[2] ?? text
    return {
      path: named?.[1],
      operation: /“create file”/.test(message)
        ? 'create'
        : /“replace file”/.test(message)
          ? 'replace'
          : 'update',
      message,
      kind: /without a code block holding the content/i.test(message)
        ? 'heading-without-block'
        : /not inside a fenced code block/i.test(message)
          ? 'unfenced-markers'
          : undefined
    } satisfies ParseProblem
  })
}

const MAX_REPAIR_FILES = 3

const shapeProblemText = (problem: ParseProblem): string => {
  const file = problem.path ? `\`${problem.path}\`: ` : ''
  switch (problem.kind) {
    case 'unfenced-markers':
      return `- ${file}the SEARCH/REPLACE text was written outside a fenced code block. The chat page reformats such text, so CodeGent received it scrambled.`
    case 'orphan-block':
      return '- A SEARCH/REPLACE block had no file heading above it, so CodeGent could not tell which file it belongs to.'
    default:
      return `- ${file}the heading arrived but no code block came after it, so CodeGent has no content for this file.`
  }
}

/**
 * The correction for a reply whose file contents did not reach CodeGent: what was wrong with each
 * file, and the exact shape to answer in, filled in with the file names. Never a general lecture.
 */
const shapeRepair = (problems: readonly ParseProblem[], oneFileOnly: boolean): string => {
  const targets: ParseProblem[] = []
  for (const problem of problems) {
    if (!problem.path || targets.some((target) => target.path === problem.path)) continue
    targets.push(problem)
  }
  const shown = targets.slice(0, oneFileOnly ? 1 : MAX_REPAIR_FILES)
  const templates = (shown.length > 0 ? shown : [{} as ParseProblem]).map((problem) =>
    fileTemplate(
      problem.operation === 'create' || problem.operation === 'replace'
        ? problem.operation
        : 'update',
      problem.path
    )
  )
  const rest = targets.length - shown.length
  return [
    'CodeGent could not read the file contents of your last reply, so these were NOT changed:',
    ...problems.slice(0, 6).map(shapeProblemText),
    '',
    oneFileOnly
      ? `This is the second time. Send ONLY ${shown[0]?.path ? `\`${shown[0].path}\`` : 'the first file'} in your next reply${rest > 0 || targets.length > 1 ? ' (the other files afterwards, one reply each)' : ''}, written exactly like this:`
      : `Resend ${shown.length > 1 ? 'these files' : 'it'}${rest > 0 ? ` (and the ${rest} other file${rest === 1 ? '' : 's'} afterwards)` : ''}, written exactly like this:`,
    '',
    templates.join('\n\n'),
    '',
    FENCE_RULE,
    'Do not repeat files that were already applied. Finish with the CODEGENT_STATUS line.'
  ].join('\n')
}

/** The correction for files whose SEARCH/REPLACE edits keep failing: send them whole instead. */
const wholeFileRepair = (paths: readonly string[]): string =>
  [
    `SEARCH/REPLACE failed twice for ${paths
      .slice(0, MAX_REPAIR_FILES)
      .map((path) => `\`${path}\``)
      .join(', ')}${paths.length > MAX_REPAIR_FILES ? ' and others' : ''}. Do not use SEARCH/REPLACE for ${paths.length === 1 ? 'it' : 'them'} again. Read ${paths.length === 1 ? 'the file' : 'each file'} from GitHub and send its COMPLETE new content, written exactly like this:`,
    '',
    fileTemplate('replace', paths[0]),
    '',
    FENCE_RULE
  ].join('\n')

/** The message sent back to ChatGPT after a step has been applied (or has failed to apply). */
export const buildFollowUpPrompt = (report: StepReport): string => {
  const applied = report.outcomes.filter((o) => o.status === 'applied')
  const failed = report.outcomes.filter((o) => o.status === 'failed')
  const skipped = report.outcomes.filter((o) => o.status === 'skipped')
  const problems = report.problems ?? []
  const failures = failed.length + problems.length
  const shapeProblems = problemDetails(report).filter((problem) =>
    SHAPE_KINDS.has(problem.kind)
  )
  const wholeFile = report.wholeFile ?? []

  const count = (n: number) => `${n} change${n === 1 ? '' : 's'}`
  const headline =
    applied.length === 0 && failures === 0
      ? 'No file changes were needed.'
      : failures === 0
        ? applied.length === 1
          ? 'The change was applied.'
          : `All ${applied.length} changes were applied.`
        : applied.length === 0
          ? 'Nothing could be applied.'
          : `${count(applied.length)} applied, ${failures} could not be.`

  const sections: string[] = [`CodeGent result — step ${report.step}`, headline]

  if (applied.length > 0)
    sections.push(['Applied', ...applied.map(appliedLine)].join('\n'))
  if (skipped.length > 0) {
    sections.push(
      [
        'Already in place (no change needed)',
        ...skipped.map((o) => `- \`${o.path}\` — ${o.detail}`)
      ].join('\n')
    )
  }
  if (failures > 0) {
    const shown = failed.slice(0, MAX_FAILED_FILES).map(failedBlock)
    const more =
      failed.length > MAX_FAILED_FILES
        ? [`- … and ${failed.length - MAX_FAILED_FILES} more files`]
        : []
    sections.push(
      [
        'Not applied (these files were left exactly as they were)',
        ...shown,
        ...more,
        ...problems.map((problem) => `- ${problem}`)
      ].join('\n')
    )
  }
  const noted = applied.flatMap((o) => o.notes.map((note) => `- \`${o.path}\` — ${note}`))
  if (noted.length > 0) sections.push(['Notes', ...noted.slice(0, 10)].join('\n'))

  const checks: string[] = []
  if (report.diagnostics) checks.push(diagnosticsBlock(report.diagnostics))
  if (report.verify) checks.push(verifyBlock(report.verify))
  if (checks.length > 0) sections.push(['Checks', ...checks].join('\n'))

  if (report.publish)
    sections.push(['Repository', publishBlock(report.publish)].join('\n'))

  const diagnosticsFailed = (report.diagnostics?.errors ?? 0) > 0
  const verifyFailed = report.verify ? report.verify.exitCode !== 0 : false
  const corrections: string[] = []
  if (failures > 0) {
    if (wholeFile.length > 0) corrections.push(wholeFileRepair(wholeFile))
    if (shapeProblems.length > 0)
      corrections.push(shapeRepair(shapeProblems, report.oneFileOnly === true))
    if (corrections.length === 0)
      corrections.push('Fix the files that were not applied first, then continue with the task.')
  }
  const next =
    failures > 0
      ? corrections.join('\n\n')
      : diagnosticsFailed || verifyFailed
        ? 'Fix the problems found by the checks, then continue with the task.'
        : 'Continue with the next step of the task. If everything is finished and the checks are clean, answer with a short summary and ' +
          STATUS_LINES.done +
          '.'
  sections.push(
    ['Next', next, shapeProblems.length > 0 ? undefined : FORMAT_REMINDER]
      .filter((line) => line !== undefined)
      .join('\n')
  )

  return sections.join('\n\n')
}

/** Sent when the reply contained no file changes although the task is not finished. */
export const buildNoChangesPrompt = (): string =>
  [
    'CodeGent result — no changes found',
    '',
    'Your last reply did not contain any file changes in the required format, so nothing was applied.',
    '',
    'Send the complete implementation now, not a plan or recap. Use one heading per file and fenced code blocks for all file content. For example:',
    '',
    '### Updated file: `path/to/file.ext`',
    '',
    '```text',
    '<<<<<<< SEARCH',
    'exact existing lines',
    '=======',
    'replacement lines',
    '>>>>>>> REPLACE',
    '```',
    '',
    'For a new file, put its complete content inside the fence. Finish with a CODEGENT_STATUS line. If the task is already complete, answer with a short summary and ' +
      STATUS_LINES.done +
      '; if you cannot continue, explain why and answer with ' +
      STATUS_LINES.blocked +
      '.'
  ].join('\n')

/** Sent when the reply was cut off (an unclosed code block). */
export const buildTruncatedPrompt = (appliedPaths: readonly string[]): string =>
  [
    'CodeGent result — your reply was cut off',
    appliedPaths.length > 0
      ? `The code block at the end of your reply was never closed, so it was not used. These changes before it were applied: ${appliedPaths.map((p) => `\`${p}\``).join(', ')}.`
      : 'The code block at the end of your reply was never closed, so nothing from it was used.',
    'Please resend only the changes that are still missing, in smaller pieces if the reply is long (one file per heading), and finish with a CODEGENT_STATUS line.'
  ].join('\n\n')
