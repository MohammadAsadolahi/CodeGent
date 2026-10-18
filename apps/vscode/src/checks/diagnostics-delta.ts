import type { DiagnosticItem, DiagnosticsSummary } from '@codegent/engine'

const keyOf = (item: DiagnosticItem): string =>
  [item.path, item.severity, item.source ?? '', item.code ?? '', item.message].join(
    '\u0000'
  )

/**
 * The problems in `current` that were not already in `baseline`. Line numbers are ignored when
 * comparing (an edit shifts them), and duplicates are counted, so two identical new errors are
 * both reported even if one identical error was there before.
 */
export const newProblems = (
  baseline: readonly DiagnosticItem[],
  current: readonly DiagnosticItem[]
): DiagnosticItem[] => {
  const known = new Map<string, number>()
  for (const item of baseline) known.set(keyOf(item), (known.get(keyOf(item)) ?? 0) + 1)
  const fresh: DiagnosticItem[] = []
  for (const item of current) {
    const key = keyOf(item)
    const remaining = known.get(key) ?? 0
    if (remaining > 0) known.set(key, remaining - 1)
    else fresh.push(item)
  }
  return fresh
}

export const summarize = (items: readonly DiagnosticItem[]): DiagnosticsSummary => ({
  items: [...items],
  errors: items.filter((item) => item.severity === 'error').length,
  warnings: items.filter((item) => item.severity === 'warning').length
})
