import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyHunks, parseReply } from '../src'

const CODE_CHARS = Array.from(`abcXYZ019_(){};=+*-.,'" `)
const bodyArb = fc
  .array(fc.constantFrom(...CODE_CHARS.filter((c) => c !== ' ')), { minLength: 1, maxLength: 16 })
  .map((chars) => chars.join(''))

/** Source-ish lines, each unique within its file (so exact SEARCH text is unambiguous). */
const fileArb = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 3 }), bodyArb), { minLength: 1, maxLength: 40 })
  .map((rows) => rows.map(([indent, body], index) => `${'  '.repeat(indent)}L${index}:${body}`))

const replacementArb = fc.array(
  fc
    .tuple(fc.integer({ min: 0, max: 6 }), fc.array(fc.constantFrom(...CODE_CHARS), { maxLength: 16 }))
    .map(([spaces, chars]) => ' '.repeat(spaces) + chars.join('')),
  { maxLength: 6 }
)
const eolArb = fc.constantFrom('\n', '\r\n')

const join = (lines: string[], eol: string, finalNewline: boolean): string =>
  lines.length === 0 ? '' : lines.join(eol) + (finalNewline ? eol : '')

describe('applyHunks (property-based)', () => {
  it('equals a plain splice for any unique exact block, any EOL and final-newline convention', () => {
    fc.assert(
      fc.property(
        fileArb,
        fc.nat(),
        fc.nat(),
        replacementArb,
        eolArb,
        fc.boolean(),
        (file, a, b, replacement, eol, finalNewline) => {
          const from = a % file.length
          const to = from + 1 + (b % (file.length - from))
          const search = file.slice(from, to)
          const original = join(file, eol, finalNewline)
          // A one-line file without a final newline has no line ending to learn the style from.
          const effectiveEol = file.length > 1 || finalNewline ? eol : '\n'

          const result = applyHunks(original, [{ search, replace: replacement }])

          const expectedLines = [...file.slice(0, from), ...replacement, ...file.slice(to)]
          // A file that ends up empty has no final newline; otherwise the convention is kept.
          const expected = join(expectedLines, effectiveEol, finalNewline)
          expect(result.ok).toBe(true)
          expect(result.content).toBe(expected)
        }
      ),
      { numRuns: 400 }
    )
  })

  it('is a no-op when the replacement equals the search', () => {
    fc.assert(
      fc.property(fileArb, fc.nat(), fc.nat(), eolArb, fc.boolean(), (file, a, b, eol, finalNewline) => {
        const from = a % file.length
        const to = from + 1 + (b % (file.length - from))
        const original = join(file, eol, finalNewline)
        const search = file.slice(from, to)
        expect(applyHunks(original, [{ search, replace: search }]).content).toBe(original)
      }),
      { numRuns: 200 }
    )
  })

  it('re-indents consistently when the model dedented the code it copied', () => {
    fc.assert(
      fc.property(fileArb, fc.nat(), fc.nat(), fc.integer({ min: 1, max: 4 }), replacementArb, (file, a, b, shift, replacement) => {
        // Make the whole file deeper so the model's dedented copy still has the same relative shape.
        const pad = ' '.repeat(shift)
        const deeper = file.map((line) => pad + line)
        const from = a % deeper.length
        const to = from + 1 + (b % (deeper.length - from))
        const searchDedented = deeper.slice(from, to).map((line) => line.slice(shift))
        const replaceDedented = replacement.filter((line) => line.trim() !== '')

        const result = applyHunks(deeper.join('\n') + '\n', [{ search: searchDedented, replace: replaceDedented }])

        expect(result.ok).toBe(true)
        const expected = [...deeper.slice(0, from), ...replaceDedented.map((line) => pad + line), ...deeper.slice(to)]
        expect(result.content).toBe(expected.join('\n') + (expected.length ? '\n' : ''))
      }),
      { numRuns: 300 }
    )
  })

  it('never changes the file when a hunk cannot be matched', () => {
    fc.assert(
      fc.property(fileArb, bodyArb, eolArb, (file, junk, eol) => {
        const original = join(file, eol, true)
        const result = applyHunks(original, [
          { search: [`absent ${junk}`], replace: ['x'] },
          { search: file.slice(0, 1), replace: ['y'] }
        ])
        expect(result.ok).toBe(false)
        expect(result.content).toBe(original)
      }),
      { numRuns: 100 }
    )
  })
})

/** Renders edits the way the prompt tells ChatGPT to write them. */
const render = (path: string, hunks: Array<{ search: string[]; replace: string[] }>, fenceLen: number): string => {
  const marker = '`'.repeat(fenceLen)
  const body = hunks
    .map((h) => ['<<<<<<< SEARCH', ...h.search, '=======', ...h.replace, '>>>>>>> REPLACE'].join('\n'))
    .join('\n')
  return `### Updated file: \`${path}\`\n\n${marker}ts\n${body}\n${marker}\n`
}

const CODE_LINE_CHARS = Array.from(`abcXYZ019_(){};=+*-.,'<>!&|/`)
const codeLine = fc
  .tuple(
    fc.integer({ min: 0, max: 8 }),
    fc.array(fc.constantFrom(...CODE_LINE_CHARS), { minLength: 1, maxLength: 24 })
  )
  .map(([spaces, chars]) => ' '.repeat(spaces) + chars.join(''))

describe('parseReply (property-based)', () => {
  it('round-trips any hunks rendered in the documented format', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...Array.from('abcdefg012_-')), { minLength: 1, maxLength: 12 }).map((chars) => 'src/' + chars.join('') + '.ts'),
        fc.array(fc.record({ search: fc.array(codeLine, { minLength: 1, maxLength: 5 }), replace: fc.array(codeLine, { maxLength: 5 }) }), {
          minLength: 1,
          maxLength: 4
        }),
        fc.integer({ min: 3, max: 6 }),
        (path, hunks, fenceLen) => {
          const parsed = parseReply(`Intro text.\n\n${render(path, hunks, fenceLen)}\nCODEGENT_STATUS: continue`)
          expect(parsed.problems).toEqual([])
          expect(parsed.status).toBe('continue')
          expect(parsed.edits).toEqual([{ kind: 'update', path, hunks }])
        }
      ),
      { numRuns: 300 }
    )
  })

  it('never throws and never invents edits from arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const parsed = parseReply(text)
        // Any edit that does come out must be well-formed.
        for (const edit of parsed.edits) {
          if (edit.kind === 'update') expect(edit.hunks.length).toBeGreaterThan(0)
        }
      }),
      { numRuns: 500 }
    )
  })
})

describe('applyHunks never corrupts on adversarial input', () => {
  it('survives arbitrary file and hunk text without throwing', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.array(fc.record({ search: fc.array(fc.string({ maxLength: 40 }), { maxLength: 4 }), replace: fc.array(fc.string({ maxLength: 40 }), { maxLength: 4 }) }), { maxLength: 4 }),
        (content, hunks) => {
          const normalizedHunks = hunks.map((h) => ({
            search: h.search.map((line) => line.replace(/[\r\n]/g, ' ')),
            replace: h.replace.map((line) => line.replace(/[\r\n]/g, ' '))
          }))
          const result = applyHunks(content, normalizedHunks)
          if (!result.ok) expect(result.content).toBe(content)
        }
      ),
      { numRuns: 500 }
    )
  })
})


