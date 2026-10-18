import { describe, expect, it } from 'vitest'
import { applyHunks, conformContent, findBlock, type Hunk } from '../src'

const L = (text: string): string[] => (text === '' ? [] : text.split('\n'))
const hunk = (search: string, replace: string): Hunk => ({ search: L(search), replace: L(replace) })
const apply = (content: string, ...hunks: Array<[string, string]>) =>
  applyHunks(content, hunks.map(([s, r]) => hunk(s, r)))

describe('exact matches', () => {
  it('replaces a single line, leaving everything else byte-identical', () => {
    const result = apply('one\ntwo\nthree\n', ['two', 'TWO'])
    expect(result).toMatchObject({ ok: true, content: 'one\nTWO\nthree\n' })
    expect(result.hunks[0]).toMatchObject({ ok: true, tier: 'exact', startLine: 2, endLine: 2 })
  })

  it('handles the first line, the last line and the whole file', () => {
    expect(apply('a\nb\nc\n', ['a', 'A']).content).toBe('A\nb\nc\n')
    expect(apply('a\nb\nc\n', ['c', 'C']).content).toBe('a\nb\nC\n')
    expect(apply('a\nb\nc\n', ['a\nb\nc', 'x']).content).toBe('x\n')
  })

  it('replaces multi-line blocks with a different number of lines', () => {
    expect(apply('a\nb\nc\nd\n', ['b\nc', 'B1\nB2\nB3']).content).toBe('a\nB1\nB2\nB3\nd\n')
    expect(apply('a\nb\nc\nd\n', ['b\nc', 'X']).content).toBe('a\nX\nd\n')
  })

  it('deletes lines when the replacement is empty', () => {
    expect(applyHunks('a\nb\nc\n', [{ search: ['b'], replace: [] }]).content).toBe('a\nc\n')
    expect(applyHunks('a\n', [{ search: ['a'], replace: [] }]).content).toBe('')
  })

  it('inserts by repeating an anchor line', () => {
    expect(apply('a\nb\n', ['a', 'a\ninserted']).content).toBe('a\ninserted\nb\n')
  })

  it('applies hunks in order, each seeing the previous result', () => {
    const result = apply('x = 1\n', ['x = 1', 'x = 2'], ['x = 2', 'x = 3'])
    expect(result).toMatchObject({ ok: true, content: 'x = 3\n' })
  })

  it('preserves a missing final newline, even when the last line changes', () => {
    expect(apply('a\nb', ['b', 'c']).content).toBe('a\nc')
    expect(apply('a\nb', ['b', 'b\nc']).content).toBe('a\nb\nc')
  })

  it('treats a lone-line file correctly', () => {
    expect(apply('only', ['only', 'ONLY']).content).toBe('ONLY')
    expect(apply('only\n', ['only', 'ONLY']).content).toBe('ONLY\n')
  })
})

describe('ambiguity and failure', () => {
  it('refuses to guess when the SEARCH text matches several places', () => {
    const result = apply('x\nfoo\nbar\nfoo\n', ['foo', 'FOO'])
    expect(result.ok).toBe(false)
    expect(result.content).toBe('x\nfoo\nbar\nfoo\n')
    expect(result.hunks[0]!.error).toMatchObject({ code: 'ambiguous', candidates: [2, 4], hunk: 1 })
  })

  it('succeeds once more context makes the match unique', () => {
    expect(apply('x\nfoo\nbar\nfoo\n', ['bar\nfoo', 'bar\nFOO']).content).toBe('x\nfoo\nbar\nFOO\n')
  })

  it('reports not-found and points at the closest text', () => {
    const file = ['function area(r) {', '  return Math.PI * r * r', '}', '', 'export { area }'].join('\n') + '\n'
    const result = apply(file, ['function area(radius) {\n  return Math.PI * radius * radius\n}', 'x'])
    expect(result.ok).toBe(false)
    const error = result.hunks[0]!.error!
    expect(error.code).toBe('not-found')
    expect(error.closest).toMatchObject({ startLine: 1, endLine: 3 })
    expect(error.closest!.snippet[0]).toBe('function area(r) {')
    expect(error.closest!.score).toBeGreaterThan(0.5)
  })

  it('reports not-found without a closest match when nothing resembles the text', () => {
    const result = apply('alpha\nbeta\ngamma\n', ['completely different content here\nnothing similar', 'x'])
    expect(result.hunks[0]!.error).toMatchObject({ code: 'not-found' })
    expect(result.hunks[0]!.error!.closest).toBeUndefined()
  })

  it('is atomic: one failing hunk leaves the content untouched and reports every hunk', () => {
    const content = 'a\nb\nc\n'
    const result = apply(content, ['a', 'A'], ['zzz', 'Z'], ['c', 'C'])
    expect(result.ok).toBe(false)
    expect(result.content).toBe(content)
    expect(result.hunks.map((h) => h.ok)).toEqual([true, false, true])
    expect(result.hunks[1]!.index).toBe(2)
  })

  it('rejects an empty SEARCH on a non-empty file, but lets it fill an empty one', () => {
    const nonEmpty = applyHunks('a\n', [{ search: [], replace: ['x'] }])
    expect(nonEmpty.hunks[0]!.error).toMatchObject({ code: 'empty-search' })
    const blankOnly = applyHunks('a\n', [{ search: ['', '  '], replace: ['x'] }])
    expect(blankOnly.ok).toBe(false)
    const empty = applyHunks('', [{ search: [], replace: ['line one', 'line two'] }])
    expect(empty).toMatchObject({ ok: true, content: 'line one\nline two\n' })
  })
})

describe('looser matches (the model copied the code slightly differently)', () => {
  it('ignores trailing whitespace', () => {
    const result = apply('a   \nb\t\nc\n', ['a\nb', 'A\nB'])
    expect(result.content).toBe('A\nB\nc\n')
    expect(result.hunks[0]).toMatchObject({ tier: 'trailing-space' })
  })

  it('ignores indentation and re-indents the replacement to the file (deeper file)', () => {
    const file = ['class A {', '    method() {', '        return 1', '    }', '}', ''].join('\n')
    const result = apply(file, ['method() {\n    return 1\n}', 'method() {\n    return 2\n}'])
    expect(result.ok).toBe(true)
    expect(result.content).toBe(['class A {', '    method() {', '        return 2', '    }', '}', ''].join('\n'))
    expect(result.hunks[0]).toMatchObject({ tier: 'trim' })
    expect(result.hunks[0]!.note).toMatch(/indentation of the replacement was adjusted/)
  })

  it('removes surplus indentation when the SEARCH text was over-indented', () => {
    const file = 'if (x) {\n  y()\n}\n'
    const result = apply(file, ['      if (x) {\n        y()\n      }', '      if (x) {\n        z()\n      }'])
    expect(result.content).toBe('if (x) {\n  z()\n}\n')
  })

  it('keeps blank lines inside the replacement unindented', () => {
    const file = '    a()\n    b()\n'
    const result = apply(file, ['a()\nb()', 'a()\n\nc()\nb()'])
    expect(result.content).toBe('    a()\n\n    c()\n    b()\n')
  })

  it('inserts as written, and says so, when indentation differs inconsistently', () => {
    const file = '\ta()\n        b()\n'
    const result = apply(file, ['    a()\n    b()', 'x()'])
    expect(result.ok).toBe(true)
    expect(result.hunks[0]!.note).toMatch(/differed inconsistently/)
  })

  it('collapses runs of spaces inside lines', () => {
    const result = apply('const   a  =   1\nconst b = 2\n', ['const a = 1', 'const a = 5'])
    expect(result.content).toBe('const a = 5\nconst b = 2\n')
    expect(result.hunks[0]).toMatchObject({ tier: 'collapse-space' })
  })

  it('ignores differences in blank lines between the matched lines', () => {
    const file = 'a()\n\n\nb()\nc()\n'
    const result = apply(file, ['a()\nb()', 'A()\nB()'])
    expect(result.content).toBe('A()\nB()\nc()\n')
    expect(result.hunks[0]).toMatchObject({ tier: 'ignore-blank-lines' })
  })

  it('drops blank lines at the edges of the SEARCH text that the file does not have', () => {
    const result = applyHunks('a\nb\nc\n', [{ search: ['', 'b', ''], replace: ['', 'B', ''] }])
    expect(result.content).toBe('a\nB\nc\n')
  })

  it('still refuses to guess among several loose matches', () => {
    const result = apply('  foo\n    foo\n', ['foo', 'bar'])
    expect(result.ok).toBe(false)
    expect(result.hunks[0]!.error).toMatchObject({ code: 'ambiguous' })
  })
})

describe('line endings', () => {
  it('keeps CRLF files CRLF, including the new lines', () => {
    const result = apply('a\r\nb\r\nc\r\n', ['b', 'B1\nB2'])
    expect(result.content).toBe('a\r\nB1\r\nB2\r\nc\r\n')
  })

  it('does not touch the endings of lines it did not change in a mixed file', () => {
    const result = apply('a\r\nb\nc\r\nd\n', ['d', 'D'])
    expect(result.content).toBe('a\r\nb\nc\r\nD\n')
  })

  it('matches CRLF text against LF SEARCH text', () => {
    expect(apply('x\r\ny\r\n', ['x\ny', 'z']).content).toBe('z\r\n')
  })

  it('treats CRLF-only files without a final newline correctly', () => {
    expect(apply('a\r\nb', ['b', 'B\nC']).content).toBe('a\r\nB\r\nC')
  })
})

describe('conformContent (whole-file replacements)', () => {
  it('uses the original file’s line endings and final-newline convention', () => {
    expect(conformContent('a\nb', 'x\r\ny\r\n')).toBe('a\r\nb\r\n')
    expect(conformContent('a\nb\n', 'x\ny')).toBe('a\nb\n')
    expect(conformContent('a\r\nb\r\n', null)).toBe('a\nb\n')
  })

  it('gives new files LF endings and a final newline, and keeps empty content empty', () => {
    expect(conformContent('hello', null)).toBe('hello\n')
    expect(conformContent('', null)).toBe('')
    expect(conformContent('', 'something\n')).toBe('')
  })
})

describe('findBlock', () => {
  it('reports the line numbers of every candidate for ambiguous text', () => {
    const found = findBlock(['x', 'dup', 'y', 'dup', 'z', 'dup'], ['dup'])
    expect(found).toEqual({ ok: false, reason: 'ambiguous', candidates: [2, 4, 6] })
  })

  it('reports an empty SEARCH', () => {
    expect(findBlock(['a'], ['', '  '])).toEqual({ ok: false, reason: 'empty' })
  })

  it('copes with a SEARCH longer than the file', () => {
    expect(findBlock(['a'], ['a', 'b', 'c']).ok).toBe(false)
  })

  it('handles a large file quickly', () => {
    const content = Array.from({ length: 40_000 }, (_, i) => `line ${i} of the file with some text`)
    const started = Date.now()
    const found = findBlock(content, ['line 39990 of the file with some text', 'line 39991 of the file with some text'])
    expect(found).toMatchObject({ ok: true, match: { start: 39_990, end: 39_992 } })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
