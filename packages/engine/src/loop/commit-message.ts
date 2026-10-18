const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''

const stripMarkdown = (text: string): string =>
  text
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const firstSentence = (text: string): string => {
  const line = stripMarkdown(firstLine(text))
  const match = /^(.+?[.!?])(\s|$)/.exec(line)
  return (match ? match[1]! : line).replace(/[.!?]+$/, '').trim()
}

/** `codegent: <what this step did>` with a short body naming the step. Always a single-line subject ≤ 72 chars. */
export const buildCommitMessage = (options: {
  prefix: string
  task: string
  summary: string
  step: number
}): string => {
  const what = firstSentence(options.summary) || firstSentence(options.task) || 'apply changes'
  const subject = `${options.prefix}${what}`
  const clipped = subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject
  return `${clipped}\n\nCodeGent step ${options.step}.`
}
