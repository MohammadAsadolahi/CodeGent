import { describe, expect, it } from 'vitest'
import { describeReplyShape, parseReply, type FileEdit } from '../src'

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

describe('replies written in other shapes', () => {
  it('reads headings that were written inside the code block (one fence for the whole answer)', () => {
    const reply = [
      'Two fixes.',
      '',
      fence(
        [
          'Updated file: apps/backend/app/prompts/manual_tailor.py',
          hunk('one', 'uno'),
          '',
          hunk('two', 'dos'),
          '',
          'Updated file: apps/backend/tests/unit/test_manual_tailor.py',
          hunk('def test_a():\n    pass', 'def test_a():\n    assert True')
        ].join('\n'),
        'text'
      ),
      '',
      'CODEGENT_STATUS: continue'
    ].join('\n')
    const parsed = parseReply(reply)
    expect(parsed.problems).toEqual([])
    expect(parsed.status).toBe('continue')
    expect(parsed.summary).toBe('Two fixes.')
    expect(parsed.edits).toEqual([
      {
        kind: 'update',
        path: 'apps/backend/app/prompts/manual_tailor.py',
        hunks: [
          { search: ['one'], replace: ['uno'] },
          { search: ['two'], replace: ['dos'] }
        ]
      },
      {
        kind: 'update',
        path: 'apps/backend/tests/unit/test_manual_tailor.py',
        hunks: [
          {
            search: ['def test_a():', '    pass'],
            replace: ['def test_a():', '    assert True']
          }
        ]
      }
    ])
  })

  it('does not report a missing block when the block repeats the heading of the file above it', () => {
    const reply = `### Updated file: \`a.ts\`\n\n${fence(`Updated file: a.ts\n${hunk('x', 'y')}`)}`
    expect(only(reply)).toEqual({
      kind: 'update',
      path: 'a.ts',
      hunks: [{ search: ['x'], replace: ['y'] }]
    })
  })

  it('reads a whole reply wrapped in one markdown fence, like the example in the prompt', () => {
    const inner = [
      'The greeting now takes a name.',
      '',
      '### Updated file: `src/greeting.js`',
      '',
      fence(hunk('hello()', 'hello(name)'), 'js'),
      '',
      '### Created file: `src/names.js`',
      '',
      fence('export const names = []', 'js'),
      '',
      '### Deleted file: `src/unused.js`',
      '',
      'CODEGENT_STATUS: done'
    ].join('\n')
    const parsed = parseReply(fence(inner, 'markdown', '````'))
    expect(parsed.problems).toEqual([])
    expect(parsed.status).toBe('done')
    expect(parsed.edits.map((edit) => edit.kind)).toEqual(['update', 'create', 'delete'])
  })

  it('takes the complete content of a created file written inside a block, up to the next heading', () => {
    const reply = fence(
      [
        'Created file: `src/a.ts`',
        'export const a = 1',
        '',
        'export const b = 2',
        '',
        'Created file: `src/b.ts`',
        'export const c = 3',
        '',
        'CODEGENT_STATUS: done'
      ].join('\n'),
      'text'
    )
    const parsed = parseReply(reply)
    expect(parsed.problems).toEqual([])
    expect(parsed.status).toBe('done')
    expect(parsed.edits).toEqual([
      {
        kind: 'create',
        path: 'src/a.ts',
        content: 'export const a = 1\n\nexport const b = 2'
      },
      { kind: 'create', path: 'src/b.ts', content: 'export const c = 3' }
    ])
  })

  it('keeps a bundle that was cut off: complete files are used, the last one is reported', () => {
    const reply = `\`\`\`text\nUpdated file: a.ts\n${hunk('x', 'y')}\n\nUpdated file: b.ts\n<<<<<<< SEARCH\np\n=======\nq`
    const parsed = parseReply(reply)
    expect(parsed.truncated).toBe(true)
    expect(parsed.edits).toEqual([
      { kind: 'update', path: 'a.ts', hunks: [{ search: ['x'], replace: ['y'] }] }
    ])
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]).toMatchObject({ path: 'b.ts', kind: 'unclosed-markers' })
  })

  it.each([
    ['`src/a.ts`'],
    ['**`src/a.ts`**'],
    ['**File:** `src/a.ts`'],
    ['File: src/a.ts'],
    ['### src/a.ts'],
    ['### `src/a.ts`:'],
    ['- `src/a.ts`'],
    ['src/a.ts']
  ])('uses a bare file name above a fenced SEARCH/REPLACE block (%s)', (name) => {
    expect(only(`${name}\n\n${fence(hunk('x', 'y'), 'python')}`)).toEqual({
      kind: 'update',
      path: 'src/a.ts',
      hunks: [{ search: ['x'], replace: ['y'] }]
    })
  })

  it('uses a bare file name above SEARCH/REPLACE text that has no fence', () => {
    expect(only(`\`src/a.ts\`\n${hunk('x', 'y')}`)).toMatchObject({
      kind: 'update',
      path: 'src/a.ts'
    })
  })

  it('never turns a code sample under a bare file name into an edit', () => {
    const parsed = parseReply(
      `Use it like this, from \`src/index.ts\`:\n\nsrc/index.ts\n\n${fence('import { a } from "./a"')}\n\nCODEGENT_STATUS: done`
    )
    expect(parsed.edits).toEqual([])
    expect(parsed.problems).toEqual([])
  })

  it('does not take ordinary words or commands for file names', () => {
    for (const line of ['Done.', 'e.g.:', '`npm run build`', 'Step 1.', 'Note:']) {
      const parsed = parseReply(`${line}\n\n${fence(hunk('x', 'y'))}`)
      expect(parsed.edits, line).toEqual([])
      expect(parsed.problems[0]?.kind, line).toBe('orphan-block')
    }
  })

  it('treats a code sample that merely mentions a heading as a sample', () => {
    const parsed = parseReply(
      fence('# the reply format uses\nUpdated file: a.ts\nand then a block', 'text')
    )
    expect(parsed.edits).toEqual([])
    expect(parsed.problems).toEqual([])
  })

  it('leaves the content of a created file alone even if it ends like a status line', () => {
    const parsed = parseReply(
      `### Created file: \`docs/protocol.md\`\n${fence('Reply with:\n\nCODEGENT_STATUS: done', 'md')}\n\nCODEGENT_STATUS: continue`
    )
    expect(parsed.edits).toEqual([
      {
        kind: 'create',
        path: 'docs/protocol.md',
        content: 'Reply with:\n\nCODEGENT_STATUS: done'
      }
    ])
    expect(parsed.status).toBe('continue')
  })

  it('does not cut an unfenced SEARCH/REPLACE pair at a line that only looks like a heading', () => {
    const reply = [
      '### Updated file: `CHANGELOG.md`',
      '<<<<<<< SEARCH',
      '- **Updated file** handling',
      '=======',
      '- **Updated file: `x.ts`** handling',
      '>>>>>>> REPLACE'
    ].join('\n')
    expect(only(reply)).toMatchObject({
      kind: 'update',
      path: 'CHANGELOG.md',
      hunks: [
        {
          search: ['- **Updated file** handling'],
          replace: ['- **Updated file: `x.ts`** handling']
        }
      ]
    })
  })
})

describe('problems say what is wrong', () => {
  // What the browser extension hands over when the SEARCH/REPLACE text was not in a code block:
  // the chat page renders it as ordinary markdown (see the capture tests of the extension).
  const rendered = [
    'This fixes the layout notes.',
    '',
    'Updated file: apps/backend/app/prompts/manual_tailor.py <<<<<<< SEARCH',
    '',
    '- The page is A4. Keep the resume as it is. =======',
    '- The page is A4. Leave space unused.',
    '',
    '> > > > > > > REPLACE',
    '',
    'CODEGENT_STATUS: continue'
  ].join('\n')

  it('names text that is visible but was not inside a fence', () => {
    const parsed = parseReply(rendered)
    expect(parsed.edits).toEqual([])
    expect(parsed.problems).toEqual([
      {
        path: 'apps/backend/app/prompts/manual_tailor.py',
        operation: 'update',
        message: expect.stringMatching(/not inside a fenced code block/),
        kind: 'unfenced-markers'
      }
    ])
  })

  it('also sees the remains of the markers on the heading line itself', () => {
    const parsed = parseReply(
      'Updated file: src/a.ts <<<<<<< SEARCH before ======= after\n\nCODEGENT_STATUS: continue'
    )
    expect(parsed.problems).toMatchObject([
      { path: 'src/a.ts', kind: 'unfenced-markers' }
    ])
  })

  it('names a heading that nothing follows', () => {
    expect(
      parseReply('### Updated file: `a.ts`\n\nCODEGENT_STATUS: continue').problems
    ).toEqual([
      {
        path: 'a.ts',
        operation: 'update',
        message: expect.stringMatching(/without a code block/),
        kind: 'heading-without-block'
      }
    ])
  })

  it.each([
    ['unclosed-markers', fence('<<<<<<< SEARCH\nx\n=======\ny')],
    [
      'malformed-markers',
      fence('<<<<<<< SEARCH\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE')
    ],
    ['stray-text', fence(`some code\n${hunk('x', 'y')}`)]
  ])('names a %s problem', (kind, block) => {
    const parsed = parseReply(`### Updated file: \`a.ts\`\n${block}`)
    expect(parsed.edits).toEqual([])
    expect(parsed.problems[0]).toMatchObject({ path: 'a.ts', kind })
  })

  it('names markers with no heading, markers in a complete file and a cut-off block', () => {
    expect(parseReply(fence(hunk('x', 'y'))).problems[0]?.kind).toBe('orphan-block')
    expect(
      parseReply(`### Created file: \`a.ts\`\n${fence(hunk('x', 'y'))}`).problems[0]?.kind
    ).toBe('markers-in-complete-file')
    expect(
      parseReply('### Created file: `a.ts`\n```ts\nconst half =').problems[0]?.kind
    ).toBe('cut-off')
  })
})

describe('describeReplyShape', () => {
  it('counts what a reply is made of, without keeping any of its content', () => {
    const shape = describeReplyShape(
      `Done.\n\n### Updated file: \`a.ts\`\n\n${fence(hunk('x', 'y'))}\n\nCODEGENT_STATUS: done`
    )
    expect(shape).toEqual({
      chars: expect.any(Number),
      lines: 13,
      fenceLines: 2,
      markerLines: 1,
      headingLines: 1
    })
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

  it('treats the unfenced pairs of one file as one block: a broken last pair means nothing of that file is applied', () => {
    const reply = [
      '### Updated file: `a.ts`',
      hunk('one', '1'),
      '',
      hunk('two', '2'),
      '',
      '<<<<<<< SEARCH',
      'three',
      '=======',
      '3',
      '',
      '### Updated file: `b.ts`',
      hunk('x', 'y')
    ].join('\n')
    const parsed = parseReply(reply)
    expect(parsed.edits).toEqual([
      { kind: 'update', path: 'b.ts', hunks: [{ search: ['x'], replace: ['y'] }] }
    ])
    expect(parsed.problems).toMatchObject([{ path: 'a.ts', kind: 'unclosed-markers' }])
  })

  it('joins complete unfenced pairs of one file into a single edit', () => {
    const reply = `### Updated file: \`a.ts\`\n${hunk('one', '1')}\n\n${hunk('two', '2')}\nCODEGENT_STATUS: done`
    expect(only(reply)).toEqual({
      kind: 'update',
      path: 'a.ts',
      hunks: [
        { search: ['one'], replace: ['1'] },
        { search: ['two'], replace: ['2'] }
      ]
    })
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
