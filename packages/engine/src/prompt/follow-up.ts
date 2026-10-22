import type { EditError, EditOutcome } from '../edits/types'
import { FENCED_FORMAT_REPAIR, FORMAT_REMINDER, STATUS_LINES } from './instructions'
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

/** The message sent back to ChatGPT after a step has been applied (or has failed to apply). */
export const buildFollowUpPrompt = (report: StepReport): string => {
  const applied = report.outcomes.filter((o) => o.status === 'applied')
  const failed = report.outcomes.filter((o) => o.status === 'failed')
  const skipped = report.outcomes.filter((o) => o.status === 'skipped')
  const problems = report.problems ?? []
  const failures = failed.length + problems.length
  const missingContentBlock = problems.some((problem) =>
    /without a code block holding the content/i.test(problem)
  )

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
  const next =
    failures > 0
      ? missingContentBlock
        ? 'Resend only the missing file changes using fenced content blocks; do not repeat changes already applied.'
        : 'Fix the files that were not applied first, then continue with the task.'
      : diagnosticsFailed || verifyFailed
        ? 'Fix the problems found by the checks, then continue with the task.'
        : 'Continue with the next step of the task. If everything is finished and the checks are clean, answer with a short summary and ' +
          STATUS_LINES.done +
          '.'
  sections.push(
    ['Next', next, missingContentBlock ? FENCED_FORMAT_REPAIR : FORMAT_REMINDER].join(
      '\n'
    )
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
