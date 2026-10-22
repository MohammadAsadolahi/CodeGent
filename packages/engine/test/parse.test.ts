import { describe, expect, it } from 'vitest'
import { parseReply, type FileEdit } from '../src'

const fence = (body: string, lang = 'ts', marker = '```') =>
  `${marker}${lang}\n${body}\n${marker}`
const hunk = (search: string, replace: string, label = ['SEARCH', 'REPLACE']) =>
  `<<<<<<< ${label[0]}\n${search}\n=======\n${replace}\n>>>>>>> ${label[1]}`

const only = (reply: string): FileEdit => {
  const parsed = parseReply(reply)
  expect(parsed.problems).toEqual([])
  expect(parsed.edits).toHaveLength(1)
  return parsed.edits[0]!
}

describe('the canonical format', () => {
  it('parses every operation, the summary and the status line', () => {
    const reply = [
      'I will rename the helper and add logging.',
      '',
      '### Updated file: `src/utils/math.ts`',
      '',
      fence(
        `${hunk('export const add = (a, b) => a - b', 'export const add = (a, b) => a + b')}\n${hunk('// TODO', '// done')}`
      ),
      '',
      '### Created file: `src/utils/log.ts`',
      '',
      fence('export const log = console.log'),
      '',
      '### Deleted file: `src/old.ts`',
      '',
      '### Renamed file: `src/a.ts` (old) `src/b.ts` (new)',
      '',
      'More text here.',
      '',
      'CODEGENT_STATUS: continue'
    ].join('\n')

    const parsed = parseReply(reply)

    expect(parsed.problems).toEqual([])
    expect(parsed.warnings).toEqual([])
    expect(parsed.truncated).toBe(false)
    expect(parsed.status).toBe('continue')
    expect(parsed.summary).toBe(
      'I will rename the helper and add logging.\n\nMore text here.'
    )
    expect(parsed.edits).toEqual([
      {
        kind: 'update',
        path: 'src/utils/math.ts',
        hunks: [
          {
            search: ['export const add = (a, b) => a - b'],
            replace: ['export const add = (a, b) => a + b']
          },
          { search: ['// TODO'], replace: ['// done'] }
        ]
      },
      {
        kind: 'create',
        path: 'src/utils/log.ts',
        content: 'export const log = console.log'
      },
      { kind: 'delete', path: 'src/old.ts' },
      { kind: 'rename', from: 'src/a.ts', to: 'src/b.ts', hunks: [] }
    ])
  })

  it('keeps multi-line hunks, indentation and blank lines verbatim', () => {
    const search = 'function a() {\n\n  return 1\n}'
    const replace = 'function a() {\n  return 2\n}\n'
    const edit = only(`### Updated file: \`a.ts\`\n${fence(hunk(search, replace))}`)
    expect(edit).toEqual({
      kind: 'update',
      path: 'a.ts',
      hunks: [
        {
          search: ['function a() {', '', '  return 1', '}'],
          replace: ['function a() {', '  return 2', '}', '']
        }
      ]
    })
  })

  it('supports empty REPLACE sections (deletions) and empty SEARCH+REPLACE bodies', () => {
    const edit = only(
      `### Updated file: \`a.ts\`\n${fence('<<<<<<< SEARCH\nremove me\n=======\n>>>>>>> REPLACE')}`
    )
    expect(edit).toMatchObject({
      kind: 'update',
      hunks: [{ search: ['remove me'], replace: [] }]
    })
  })

  it('accepts SEARCH/REPLACE pairs directly below a file heading without a code fence', () => {
    const parsed = parseReply(
      `### Updated file: \`a.ts\`\n${hunk('before', 'after')}\nCODEGENT_STATUS: continue`
    )
    expect(parsed).toMatchObject({
      edits: [
        {
          kind: 'update',
          path: 'a.ts',
          hunks: [{ search: ['before'], replace: ['after'] }]
        }
      ],
      status: 'continue',
      problems: [],
      truncated: false
    })
  })
})

describe('tolerated variations', () => {
  it.each([
    ['### Updated file: `a.ts`'],
    ['### Updated `a.ts`'],
    ['#### Updated file: a.ts'],
    ['**Updated file:** `a.ts`'],
    ['**Updated file: `a.ts`**'],
    ['- **Modified file:** `a.ts`'],
    ['## Edited file `a.ts`'],
    ['### Updated file — `a.ts`'],
    ['Updated file: `a.ts`'],
    ['### UPDATED FILE: `a.ts`']
  ])('recognises the heading %s', (heading) => {
    expect(only(`${heading}\n\n${fence(hunk('x', 'y'))}`)).toMatchObject({
      kind: 'update',
      path: 'a.ts'
    })
  })

  it.each([
    ['### Created file: `a.ts`', 'create'],
    ['### New file: `a.ts`', 'create'],
    ['### Added file: `a.ts`', 'create'],
    ['### Replaced file: `a.ts`', 'replace'],
    ['### Rewrote file: `a.ts`', 'replace']
  ])('maps %s to %s', (heading, kind) => {
    expect(only(`${heading}\n${fence('content')}`)).toMatchObject({
      kind,
      path: 'a.ts',
      content: 'content'
    })
  })

  it('accepts other conflict-marker labels and lengths', () => {
    const edit = only(
      `### Updated file: \`a.ts\`\n${fence('<<<<< ORIGINAL\nx\n=====\ny\n>>>>> UPDATED')}\n`
    )
    expect(edit).toMatchObject({ hunks: [{ search: ['x'], replace: ['y'] }] })
  })

  it('accepts tilde fences and longer fences that contain shorter ones', () => {
    expect(
      only(`### Created file: \`a.md\`\n${fence('hello', 'md', '~~~')}`)
    ).toMatchObject({ content: 'hello' })
    const nested = fence('# Title\n\n```ts\nconst x = 1\n```\n\nEnd', 'md', '````')
    expect(only(`### Created file: \`README.md\`\n${nested}`)).toMatchObject({
      content: '# Title\n\n```ts\nconst x = 1\n```\n\nEnd'
    })
  })

  it('strips the indentation of a fence nested in a list item', () => {
    const reply =
      '1. Next:\n\n   ### Created file: `a.ts`\n\n   ```ts\n   const x = 1\n     const y = 2\n   ```'
    expect(only(reply)).toMatchObject({
      kind: 'create',
      content: 'const x = 1\n  const y = 2'
    })
  })

  it('accepts CRLF input', () => {
    const reply = `### Created file: \`a.ts\`\r\n\`\`\`ts\r\nline1\r\nline2\r\n\`\`\`\r\nCODEGENT_STATUS: done\r\n`
    const parsed = parseReply(reply)
    expect(parsed.edits).toEqual([
      { kind: 'create', path: 'a.ts', content: 'line1\nline2' }
    ])
    expect(parsed.status).toBe('done')
  })

  it('reads renames in either order when annotated, and with arrows', () => {
    expect(only('### Renamed file: `new.ts` (new) `old.ts` (old)')).toEqual({
      kind: 'rename',
      from: 'old.ts',
      to: 'new.ts',
      hunks: []
    })
    expect(only('### Renamed file: `old.ts` → `new.ts`')).toMatchObject({
      from: 'old.ts',
      to: 'new.ts'
    })
    expect(only('### Renamed file: old/a.ts -> new/a.ts')).toMatchObject({
      from: 'old/a.ts',
      to: 'new/a.ts'
    })
  })

  it('lets a rename carry an edit', () => {
    const reply = `### Renamed file: \`a.ts\` (old) \`b.ts\` (new)\n${fence(hunk('x', 'y'))}`
    expect(only(reply)).toEqual({
      kind: 'rename',
      from: 'a.ts',
      to: 'b.ts',
      hunks: [{ search: ['x'], replace: ['y'] }]
    })
  })

  it('keeps raw paths (spaces, backslashes) for the planner to validate', () => {
    expect(only('### Deleted file: `dir with space\\file.ts`')).toEqual({
      kind: 'delete',
      path: 'dir with space\\file.ts'
    })
  })

  it('accepts an update block without markers as a complete file, with a warning', () => {
    const parsed = parseReply(`### Updated file: \`a.ts\`\n${fence('whole file')}`)
    expect(parsed.edits).toEqual([
      { kind: 'replace', path: 'a.ts', content: 'whole file' }
    ])
    expect(parsed.warnings[0]).toMatch(/complete new file/)
  })
})

describe('status line', () => {
  it.each([
    ['CODEGENT_STATUS: continue', 'continue'],
    ['CODEGENT_STATUS: done', 'done'],
    ['CODEGENT_STATUS: blocked', 'blocked'],
    ['**CODEGENT_STATUS: done**', 'done'],
    ['`CODEGENT_STATUS: continue`', 'continue'],
    ['> CODEGENT_STATUS: blocked', 'blocked'],
    ['codegent_status: DONE', 'done'],
    ['CODEGENT_STATUS: done (all finished)', 'done'],
    ['### CODEGENT_STATUS: continue', 'continue']
  ])('%s', (line, expected) => {
    expect(parseReply(`text\n\n${line}\n`).status).toBe(expected)
  })

  it('uses the last status and also finds one alone in a code block', () => {
    expect(
      parseReply('CODEGENT_STATUS: continue\nlater\nCODEGENT_STATUS: done').status
    ).toBe('done')
    expect(parseReply('Done.\n\n```\nCODEGENT_STATUS: done\n```').status).toBe('done')
  })

  it('is undefined when absent or invalid', () => {
    expect(parseReply('just text').status).toBeUndefined()
    expect(parseReply('CODEGENT_STATUS: maybe').status).toBeUndefined()
  })

  it('does not leak the status line into the summary', () => {
    expect(parseReply('Hello.\n\nCODEGENT_STATUS: done').summary).toBe('Hello.')
  })
})

describe('things that must NOT become edits', () => {
  it('ignores code samples that are not attached to a file heading', () => {
    const parsed = parseReply(
      `Run this:\n\n${fence('npm test', 'bash')}\n\nCODEGENT_STATUS: done`
    )
    expect(parsed.edits).toEqual([])
    expect(parsed.problems).toEqual([])
  })

  it('does not treat ordinary sentences as headings', () => {
    const prose = [
      'Updated the config to use `src/a.ts` instead.',
      'Created file structure for the new module.',
      'Added tests for `parser.ts`.',
      'I deleted the old approach.'
    ]
    for (const line of prose) {
      const parsed = parseReply(`${line}\n\n${fence('x')}`)
      expect(parsed.edits, line).toEqual([])
    }
  })

  it('only lets the FIRST block after a heading define the file; later marker-less blocks are commentary', () => {
    const reply = [
      '### Updated file: `a.ts`',
      fence(hunk('x', 'y')),
      '',
      'Then run the tests:',
      fence('npm test', 'bash'),
      'And this snippet shows usage:',
      fence('use(a)', 'ts')
    ].join('\n')
    const parsed = parseReply(reply)
    expect(parsed.edits).toEqual([
      { kind: 'update', path: 'a.ts', hunks: [{ search: ['x'], replace: ['y'] }] }
    ])
    expect(parsed.problems).toEqual([])
  })

  it('lets a later block WITH markers add hunks to the same file', () => {
    const reply = `### Updated file: \`a.ts\`\n${fence(hunk('x', 'y'))}\n\nand also:\n${fence(hunk('p', 'q'))}`
    expect(only(reply)).toEqual({
      kind: 'update',
      path: 'a.ts',
      hunks: [
        { search: ['x'], replace: ['y'] },
        { search: ['p'], replace: ['q'] }
      ]
    })
  })

  it('ignores a second block under a create heading', () => {
    const reply = `### Created file: \`a.ts\`\n${fence('real')}\n\nusage:\n${fence('example')}`
    expect(only(reply)).toMatchObject({ content: 'real' })
  })

  it('reports a heading without a block and a marker block without a heading', () => {
    const noBlock = parseReply('### Updated file: `a.ts`\n\nCODEGENT_STATUS: done')
    expect(noBlock.edits).toEqual([])
    expect(noBlock.problems[0]).toMatchObject({
      path: 'a.ts',
      message: expect.stringMatching(/without a code block/),
      kind: 'heading-without-block'
    })

    const noHeading = parseReply(fence(hunk('x', 'y')))
    expect(noHeading.edits).toEqual([])
    expect(noHeading.problems[0]!.message).toMatch(/not preceded by a file heading/)
  })

  it('reports an unterminated unfenced marker pair without consuming the next file heading', () => {
    const parsed = parseReply(
      [
        '### Updated file: `a.ts`',
        '<<<<<<< SEARCH',
        'before',
        '=======',
        'after',
        '### Created file: `b.ts`',
        '```ts',
        'content',
        '```'
      ].join('\n')
    )
    expect(parsed.edits).toEqual([{ kind: 'create', path: 'b.ts', content: 'content' }])
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]!.message).toMatch(/never closed/)
  })

  it('drops blocks with text outside the markers, malformed or unterminated markers', () => {
    const stray = parseReply(
      `### Updated file: \`a.ts\`\n${fence(`some code\n${hunk('x', 'y')}`)}`
    )
    expect(stray.edits).toEqual([])
    expect(stray.problems[0]!.message).toMatch(/outside the SEARCH\/REPLACE markers/)

    const unterminated = parseReply(
      `### Updated file: \`a.ts\`\n${fence('<<<<<<< SEARCH\nx\n=======\ny')}`
    )
    expect(unterminated.edits).toEqual([])
    expect(unterminated.problems[0]!.message).toMatch(/never closed/)

    const nested = parseReply(
      `### Updated file: \`a.ts\`\n${fence('<<<<<<< SEARCH\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE')}`
    )
    expect(nested.edits).toEqual([])
    expect(nested.problems[0]!.message).toMatch(/malformed/)
  })

  it('rejects markers inside a create block', () => {
    const parsed = parseReply(`### Created file: \`a.ts\`\n${fence(hunk('x', 'y'))}`)
    expect(parsed.edits).toEqual([])
    expect(parsed.problems[0]!.message).toMatch(/not valid in a complete-file block/)
  })

  it('ignores a code block after a delete heading (it is commentary)', () => {
    const parsed = parseReply(`### Deleted file: \`a.ts\`\n${fence('whatever')}`)
    expect(parsed.edits).toEqual([{ kind: 'delete', path: 'a.ts' }])
    expect(parsed.problems).toEqual([])
  })
})

describe('truncated replies', () => {
  it('flags an unclosed code fence and discards that block', () => {
    const parsed = parseReply(
      `### Created file: \`a.ts\`\n\`\`\`ts\nconst x = 1\nconst y =`
    )
    expect(parsed.truncated).toBe(true)
    expect(parsed.edits).toEqual([])
    expect(parsed.problems[0]!.message).toMatch(/cut off/)
  })

  it('keeps the complete edits that came before the cut-off block', () => {
    const reply = [
      '### Created file: `a.ts`',
      fence('ok'),
      '### Created file: `b.ts`',
      '```ts',
      'half a file'
    ].join('\n')
    const parsed = parseReply(reply)
    expect(parsed.truncated).toBe(true)
    expect(parsed.edits).toEqual([{ kind: 'create', path: 'a.ts', content: 'ok' }])
  })
})

describe('summary', () => {
  it('contains only prose, with blank runs collapsed', () => {
    const parsed = parseReply(
      `First.\n\n\n\n### Created file: \`a.ts\`\n${fence('code')}\n\nSecond.\nCODEGENT_STATUS: done`
    )
    expect(parsed.summary).toBe('First.\n\nSecond.')
  })

  it('copes with empty input', () => {
    expect(parseReply('')).toMatchObject({
      edits: [],
      status: undefined,
      summary: '',
      truncated: false
    })
  })
})
