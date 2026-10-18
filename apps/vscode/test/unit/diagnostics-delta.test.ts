import { describe, expect, it } from 'vitest'
import type { DiagnosticItem } from '@codegent/engine'
import { newProblems, summarize } from '../../src/checks/diagnostics-delta'

const item = (over: Partial<DiagnosticItem> = {}): DiagnosticItem => ({
  path: 'src/a.ts',
  line: 10,
  column: 1,
  severity: 'error',
  message: "Type 'string' is not assignable to type 'number'.",
  code: 'TS2322',
  source: 'ts',
  ...over
})

describe('newProblems', () => {
  it('ignores problems that were already there, even if their line moved', () => {
    expect(newProblems([item({ line: 10 })], [item({ line: 25 })])).toEqual([])
  })

  it('reports problems that are new', () => {
    const fresh = item({ message: 'Cannot find name x', code: 'TS2304' })
    expect(newProblems([item()], [item(), fresh])).toEqual([fresh])
  })

  it('counts duplicates: a second identical error is new', () => {
    const result = newProblems(
      [item({ line: 1 })],
      [item({ line: 1 }), item({ line: 40 })]
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.line).toBe(40)
  })

  it('treats a different file, severity, code or source as a different problem', () => {
    const baseline = [item()]
    for (const changed of [
      { path: 'src/b.ts' },
      { severity: 'warning' as const },
      { code: 'TS9999' },
      { source: 'eslint' }
    ]) {
      expect(newProblems(baseline, [item(changed)])).toHaveLength(1)
    }
  })

  it('reports everything when there was no baseline (new files)', () => {
    expect(newProblems([], [item(), item({ path: 'src/b.ts' })])).toHaveLength(2)
  })

  it('reports nothing when problems were fixed', () => {
    expect(newProblems([item(), item({ message: 'other' })], [])).toEqual([])
  })
})

describe('summarize', () => {
  it('counts errors and warnings separately', () => {
    const summary = summarize([
      item(),
      item({ severity: 'warning' }),
      item({ severity: 'warning', message: 'w2' })
    ])
    expect(summary).toMatchObject({ errors: 1, warnings: 2 })
    expect(summary.items).toHaveLength(3)
  })

  it('is empty for no items', () => {
    expect(summarize([])).toEqual({ items: [], errors: 0, warnings: 0 })
  })
})
