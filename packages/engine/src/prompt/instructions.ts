/**
 * The wording that teaches ChatGPT how to answer. It is the other half of the parser's contract:
 * `REPLY_FORMAT_EXAMPLE` is parsed in the tests to prove that what the prompt asks for is
 * exactly what `parseReply` understands.
 */

export const STATUS_LINES = {
  continue: 'CODEGENT_STATUS: continue',
  done: 'CODEGENT_STATUS: done',
  blocked: 'CODEGENT_STATUS: blocked'
} as const

/** A complete, minimal reply in the requested format (shown to the model inside a 4-backtick fence). */
export const REPLY_FORMAT_EXAMPLE = [
  'The greeting now takes a name, and I removed the unused helper.',
  '',
  '### Updated file: `src/greeting.js`',
  '',
  '```text',
  '<<<<<<< SEARCH',
  'export function greet() {',
  '  return "Hello"',
  '}',
  '=======',
  'export function greet(name) {',
  '  return `Hello, ${name}`',
  '}',
  '>>>>>>> REPLACE',
  '```',
  '',
  '### Created file: `src/names.js`',
  '',
  '```text',
  'export const names = ["Ada", "Linus"]',
  '```',
  '',
  '### Deleted file: `src/unused.js`',
  '',
  '### Renamed file: `src/old-name.js` (old) `src/new-name.js` (new)',
  '',
  STATUS_LINES.continue
].join('\n')

export const FORMAT_RULES = `Format rules
- A heading names the operation and the file. Always put file content in a fenced code block, including SEARCH/REPLACE pairs. Always write the path in backticks, relative to the repository root, with forward slashes.
- Open every code block with \`\`\`text (the word text, not the language of the file): the chat page then shows it as plain text, which CodeGent reads exactly.
- Updated file: include one or more SEARCH/REPLACE pairs, applied from top to bottom. Between \`<<<<<<< SEARCH\` and \`=======\` copy the existing lines EXACTLY (same characters, same indentation, no "..." or other abbreviations). Between \`=======\` and \`>>>>>>> REPLACE\` write what replaces them. Include enough surrounding lines for the SEARCH text to match exactly one place in the file. To delete lines leave the REPLACE part empty. To insert code, repeat one neighbouring line in both parts.
- Created file: the code block contains the complete content of the new file.
- Deleted file: the heading alone, no code block.
- Renamed file: the heading alone (a SEARCH/REPLACE block may follow it to edit the file after the move).
- To change several places in one file, use several SEARCH/REPLACE pairs in the same code block, never several blocks that repeat the file.
- Do not put anything else that looks like code to apply outside this format; illustrative snippets are fine as long as they are not under one of these headings.
- If a code block you write contains triple backticks, wrap that block in four backticks.
- Before you send, check every file: a heading line, then ONE fenced code block (a line of three backticks before the content and one after it), and in every SEARCH/REPLACE pair all three marker lines. Text that is not inside a code block is reformatted by the chat page and arrives scrambled, so CodeGent cannot apply it.
- Make only the changes the task needs; keep the project's existing style.`

export const STATUS_RULES = `Status line (the very last line of your reply, outside any code block)
- ${STATUS_LINES.continue}  — more work remains after these changes. CodeGent will apply them, run its checks and send you the result so you can do the next step.
- ${STATUS_LINES.done}  — the task is complete and nothing more needs to change.
- ${STATUS_LINES.blocked}  — you cannot go on (for example you cannot read the repository). Explain why in the text above it.`

/** One-line reminder used in follow-up messages. */
export const FORMAT_REMINDER =
  'Reply in the same format as before: one heading per file with SEARCH/REPLACE blocks (or full content for new files), then the CODEGENT_STATUS line.'

/**
 * A fill-in-the-blanks answer for one file, in exactly the shape CodeGent reads: the heading line
 * and ONE fenced code block. Used in corrections, where the model has just got the shape wrong.
 */
export const fileTemplate = (
  operation: 'update' | 'create' | 'replace',
  path = 'path/to/file.ext'
): string =>
  operation === 'update'
    ? [
        `### Updated file: \`${path}\``,
        '',
        '```text',
        '<<<<<<< SEARCH',
        'exact lines copied from the current file',
        '=======',
        'the new lines',
        '>>>>>>> REPLACE',
        '```'
      ].join('\n')
    : [
        `### ${operation === 'create' ? 'Created' : 'Replaced'} file: \`${path}\``,
        '',
        '```text',
        'the complete content of the file',
        '```'
      ].join('\n')

/** The rule behind every template: the heading is plain text, the content is inside one fence. */
export const FENCE_RULE =
  'The heading line is plain text; the content goes inside ONE fenced code block: a line with three backticks, the content, then a line with three backticks. Never write SEARCH/REPLACE text outside such a block — the chat page reformats it and CodeGent receives it scrambled.'
