import { describe, expect, it } from 'vitest'
import {
  buildFollowUpPrompt,
  buildInitialPrompt,
  buildNoChangesPrompt,
  buildTruncatedPrompt,
  FORMAT_RULES,
  parseReply,
  REPLY_FORMAT_EXAMPLE,
  type DiagnosticItem,
  type EditOutcome,
  type RepoContext,
  type StepReport
} from '../src'

const repo: RepoContext = {
  owner: 'octo',
  name: 'project',
  host: 'github.com',
  webUrl: 'https://github.com/octo/project',
  branch: 'main',
  sha: 'a'.repeat(40),
  shortSha: 'aaaaaaa',
  subject: 'Initial commit'
}

describe('the format example in the prompt', () => {
  it('parses into exactly the edits it advertises (prompt and parser cannot drift apart)', () => {
    const parsed = parseReply(REPLY_FORMAT_EXAMPLE)
    expect(parsed.problems).toEqual([])
    expect(parsed.warnings).toEqual([])
    expect(parsed.status).toBe('continue')
    expect(parsed.edits.map((edit) => edit.kind)).toEqual([
      'update',
      'create',
      'delete',
      'rename'
    ])
    expect(parsed.edits[0]).toMatchObject({
      path: 'src/greeting.js',
      hunks: [
        {
          search: ['export function greet() {', '  return "Hello"', '}'],
          replace: ['export function greet(name) {', '  return `Hello, ${name}`', '}']
        }
      ]
    })
    expect(parsed.edits[3]).toEqual({
      kind: 'rename',
      from: 'src/old-name.js',
      to: 'src/new-name.js',
      hunks: []
    })
    expect(parsed.summary).toMatch(/greeting now takes a name/)
  })
})

describe('buildInitialPrompt', () => {
  const prompt = buildInitialPrompt({
    repo,
    task: 'Add a /health endpoint.\nIt must return {"ok":true}.'
  })

  it('tells the model which repository, branch and commit to read, and to re-read before editing', () => {
    expect(prompt).toContain('octo/project')
    expect(prompt).toContain('https://github.com/octo/project')
    expect(prompt).toContain('Branch: main')
    expect(prompt).toContain(`aaaaaaa “Initial commit” (${'a'.repeat(40)})`)
    expect(prompt).toMatch(/read the CURRENT contents of every file/)
    expect(prompt).toMatch(/CODEGENT_STATUS: blocked/)
  })

  it('carries the task verbatim', () => {
    expect(prompt).toContain(
      '## Task\nAdd a /health endpoint.\nIt must return {"ok":true}.'
    )
  })

  it('includes the reply format, the example and the status rules', () => {
    expect(prompt).toContain(FORMAT_RULES)
    expect(prompt).toContain(REPLY_FORMAT_EXAMPLE)
    expect(prompt).toContain('Status line')
    for (const status of ['continue', 'done', 'blocked'])
      expect(prompt).toContain(`CODEGENT_STATUS: ${status}`)
  })

  it('wraps the example in a longer fence so its own code blocks do not end it', () => {
    expect(prompt).toContain('````markdown\n' + REPLY_FORMAT_EXAMPLE + '\n````')
  })

  it('adds project conventions only when given', () => {
    expect(prompt).not.toContain('## Project conventions')
    const withConventions = buildInitialPrompt({
      repo,
      task: 't',
      conventions: '  Use pnpm. Strict TypeScript.  '
    })
    expect(withConventions).toContain(
      '## Project conventions\nUse pnpm. Strict TypeScript.'
    )
    expect(buildInitialPrompt({ repo, task: 't', conventions: '   ' })).not.toContain(
      'Project conventions'
    )
  })

  it('flattens a multi-line or huge commit subject and never prints "undefined"', () => {
    const odd = buildInitialPrompt({
      repo: { ...repo, subject: `line one\nline two ${'x'.repeat(500)}` },
      task: 't'
    })
    expect(odd).toMatch(/“line one line two x+…”/)
    expect(prompt).not.toMatch(/undefined|\[object/)
  })

  it('stays a reasonable size', () => {
    expect(prompt.length).toBeLessThan(6_500)
  })
})

const applied = (path: string, detail = '1 hunk'): EditOutcome => ({
  edit: { kind: 'update', path, hunks: [] },
  path,
  status: 'applied',
  detail,
  errors: [],
  notes: []
})
const created = (path: string): EditOutcome => ({
  edit: { kind: 'create', path, content: '' },
  path,
  status: 'applied',
  detail: 'created',
  errors: [],
  notes: []
})
const notFound = (path: string): EditOutcome => ({
  edit: { kind: 'update', path, hunks: [] },
  path,
  status: 'failed',
  detail: 'x',
  notes: [],
  errors: [
    {
      code: 'not-found',
      hunk: 2,
      message: 'SEARCH text of hunk 2 was not found. The closest text is at lines 40–42.',
      closest: {
        startLine: 40,
        endLine: 42,
        score: 0.8,
        snippet: ['function area(r) {', '  return r * r', '}']
      }
    }
  ]
})

const report = (over: Partial<StepReport> = {}): StepReport => ({
  step: 1,
  repo,
  outcomes: [],
  ...over
})

describe('buildFollowUpPrompt', () => {
  it('reports success, then asks for the next step and shows how to finish', () => {
    const text = buildFollowUpPrompt(
      report({ outcomes: [applied('src/a.ts', '2 hunks'), created('src/b.ts')] })
    )
    expect(text).toMatch(/^CodeGent result — step 1\n\nAll 2 changes were applied\./)
    expect(text).toContain('- `src/a.ts` — updated (2 hunks)')
    expect(text).toContain('- `src/b.ts` — created')
    expect(text).toMatch(/Continue with the next step/)
    expect(text).toContain('CODEGENT_STATUS: done')
    expect(text).not.toContain('Not applied')
  })

  it('lists failures with the closest text, asks to fix them first, and keeps applied files separate', () => {
    const text = buildFollowUpPrompt(
      report({ outcomes: [applied('src/a.ts'), notFound('src/d.ts')] })
    )
    expect(text).toContain('1 change applied, 1 could not be.')
    expect(text).toContain('Not applied (these files were left exactly as they were)')
    expect(text).toContain('`src/d.ts` — SEARCH text of hunk 2 was not found')
    expect(text).toContain(
      '(lines 40–42) is:\n  ```\n  function area(r) {\n    return r * r\n  }\n  ```'
    )
    expect(text).toMatch(/copy the SEARCH text from it exactly/)
    expect(text).toMatch(/Fix the files that were not applied first/)
  })

  it('says nothing could be applied when everything failed', () => {
    expect(buildFollowUpPrompt(report({ outcomes: [notFound('a.ts')] }))).toContain(
      'Nothing could be applied.'
    )
  })

  it('reports problems found while reading the reply itself', () => {
    const text = buildFollowUpPrompt(
      report({
        outcomes: [],
        problems: [
          '“src/x.ts”: a SEARCH/REPLACE section was never closed; nothing from this block was used'
        ]
      })
    )
    expect(text).toContain('Not applied')
    expect(text).toContain('never closed')
  })

  it('shows skipped edits and matching notes', () => {
    const skipped: EditOutcome = {
      ...applied('src/s.ts'),
      status: 'skipped',
      detail: 'already absent'
    }
    const noted: EditOutcome = {
      ...applied('src/n.ts'),
      notes: ['hunk 1: matched ignoring indentation']
    }
    const text = buildFollowUpPrompt(report({ outcomes: [skipped, noted] }))
    expect(text).toContain(
      'Already in place (no change needed)\n- `src/s.ts` — already absent'
    )
    expect(text).toContain('Notes\n- `src/n.ts` — hunk 1: matched ignoring indentation')
  })

  describe('checks', () => {
    const item = (over: Partial<DiagnosticItem>): DiagnosticItem => ({
      path: 'src/a.ts',
      line: 12,
      column: 5,
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'.",
      code: 'TS2322',
      source: 'ts',
      ...over
    })

    it('lists diagnostics, errors first, and asks to fix them', () => {
      const text = buildFollowUpPrompt(
        report({
          outcomes: [applied('src/a.ts')],
          diagnostics: {
            items: [item({ severity: 'warning', line: 1 }), item({})],
            errors: 1,
            warnings: 1
          }
        })
      )
      expect(text).toContain(
        'Editor diagnostics for the changed files: 1 error, 1 warning.'
      )
      expect(text.indexOf('12:5 error ts TS2322')).toBeLessThan(
        text.indexOf('1:5 warning')
      )
      expect(text).toMatch(/Fix the problems found by the checks/)
    })

    it('says so when there are none, and keeps going', () => {
      const text = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          diagnostics: { items: [], errors: 0, warnings: 0 }
        })
      )
      expect(text).toContain('none (no errors or warnings)')
      expect(text).toMatch(/Continue with the next step/)
    })

    it('caps a flood of diagnostics', () => {
      const items = Array.from({ length: 300 }, (_, i) => item({ line: i + 1 }))
      const text = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          diagnostics: { items, errors: 300, warnings: 0 }
        })
      )
      expect(text).toContain('… and 275 more')
      expect(text.length).toBeLessThan(10_000)
    })

    it('shows a failed check with its output tail, and only a line when it passes', () => {
      const failed = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          verify: {
            command: 'npm test',
            exitCode: 1,
            outputTail: 'FAIL src/a.test.ts\n  expected 1, got 2\n'
          }
        })
      )
      expect(failed).toContain('Check `npm test` failed (exit code 1). Last output:')
      expect(failed).toContain('expected 1, got 2')
      expect(failed).toMatch(/Fix the problems found by the checks/)

      const passed = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          verify: { command: 'npm test', exitCode: 0, outputTail: 'lots of output' }
        })
      )
      expect(passed).toContain('Check `npm test` passed.')
      expect(passed).not.toContain('lots of output')
    })

    it('bounds enormous check output', () => {
      const text = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          verify: { command: 'npm test', exitCode: 1, outputTail: 'x'.repeat(2_000_000) }
        })
      )
      expect(text.length).toBeLessThan(8_000)
    })

    it('describes timeouts and commands that could not run', () => {
      expect(
        buildFollowUpPrompt(
          report({
            verify: { command: 'make', exitCode: null, timedOut: true, outputTail: '' }
          })
        )
      ).toContain('Check `make` timed out.')
      expect(
        buildFollowUpPrompt(
          report({ verify: { command: 'make', exitCode: null, outputTail: '' } })
        )
      ).toContain('Check `make` could not run.')
    })
  })

  describe('repository state', () => {
    it('tells the model exactly which commit to look for', () => {
      const text = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          publish: {
            state: 'pushed',
            sha: 'b'.repeat(40),
            shortSha: 'bbbbbbb',
            message: 'codegent: add health',
            branch: 'main',
            remote: 'origin'
          }
        })
      )
      expect(text).toContain(
        'Committed bbbbbbb “codegent: add health” and pushed it to origin/main.'
      )
      expect(text).toContain(`must show commit bbbbbbb (${'b'.repeat(40)})`)
      expect(text).toMatch(/reply with CODEGENT_STATUS: blocked/)
    })

    it('does not claim a commit is visible when it was only made locally', () => {
      const text = buildFollowUpPrompt(
        report({
          outcomes: [applied('a.ts')],
          publish: {
            state: 'committed',
            sha: 'c'.repeat(40),
            shortSha: 'ccccccc',
            message: 'm',
            reason: 'push is turned off'
          }
        })
      )
      expect(text).toContain('NOT on GitHub (push is turned off)')
      expect(text).not.toMatch(/pushed it to/)
    })

    it('mentions when nothing was committed', () => {
      expect(
        buildFollowUpPrompt(
          report({ publish: { state: 'skipped', reason: 'nothing changed' } })
        )
      ).toContain('Nothing was committed or pushed (nothing changed).')
    })
  })

  it('stays bounded with many failures at once', () => {
    const outcomes = Array.from({ length: 100 }, (_, i) => notFound(`src/file${i}.ts`))
    const text = buildFollowUpPrompt(report({ outcomes }))
    expect(text).toContain('… and 85 more files')
    expect(text.length).toBeLessThan(20_000)
  })
})

describe('nudges', () => {
  it('asks for changes when a reply had none', () => {
    const text = buildNoChangesPrompt()
    expect(text).toContain('did not contain any file changes')
    expect(text).toContain('CODEGENT_STATUS: done')
    expect(text).toContain('CODEGENT_STATUS: blocked')
  })

  it('explains a cut-off reply and which changes survived', () => {
    expect(buildTruncatedPrompt([])).toContain('nothing from it was used')
    expect(buildTruncatedPrompt(['a.ts', 'b.ts'])).toContain('`a.ts`, `b.ts`')
  })
})
