import { describe, expect, it } from 'vitest'
import { applyHunks, findPlaceholder, isPlaceholderLine, planChanges } from '../src'

describe('isPlaceholderLine', () => {
  it.each([
    '// ... existing code ...',
    '  # ... rest of the file unchanged',
    '/* ... other methods ... */',
    '<!-- ... remaining sections ... -->',
    '... (rest unchanged)',
    '// rest of the implementation ...',
    '// ...',
    '# ...',
    '-- ... existing migrations ...'
  ])('recognises %s', (line) => {
    expect(isPlaceholderLine(line)).toBe(true)
  })

  it.each([
    '...', // Python's Ellipsis, e.g. in a Protocol stub
    '  ...',
    'const rest = [...items]',
    'print("... existing")',
    '# Note: ... existing behaviour is kept when the flag is off',
    'console.log("rest of file...")',
    'def existing(): ...',
    '',
    'x'.repeat(200) + ' ...'
  ])('leaves %s alone', (line) => {
    expect(isPlaceholderLine(line)).toBe(false)
  })
})

describe('findPlaceholder', () => {
  it('ignores a placeholder-looking line the file already has', () => {
    expect(
      findPlaceholder(['a', '// ... existing code ...'], ['// ... existing code ...'])
    ).toBe(undefined)
    expect(findPlaceholder(['a', '// ... existing code ...'], ['a'])).toBe(
      '// ... existing code ...'
    )
  })
})

describe('placeholders in edits', () => {
  it('refuses a hunk whose REPLACE text stands in for code', () => {
    const result = applyHunks('function a() {\n  one()\n  two()\n}\n', [
      {
        search: ['  one()', '  two()'],
        replace: ['  // ... existing code ...']
      }
    ])
    expect(result.ok).toBe(false)
    expect(result.content).toBe('function a() {\n  one()\n  two()\n}\n')
    expect(result.hunks[0]!.error).toMatchObject({
      code: 'conflict',
      hunk: 1,
      message: expect.stringMatching(/placeholder line/)
    })
  })

  it('accepts such a line when it is already in the code being replaced', () => {
    const result = applyHunks('// ... existing code ...\nx\n', [
      {
        search: ['// ... existing code ...', 'x'],
        replace: ['// ... existing code ...', 'y']
      }
    ])
    expect(result.ok).toBe(true)
    expect(result.content).toBe('// ... existing code ...\ny\n')
  })

  it('refuses a whole-file replacement that elides part of the file', async () => {
    const before = 'line one\nline two\nline three\nline four\n'
    const view = { read: async () => before, isDirty: async () => false }
    const changeSet = await planChanges(
      [
        {
          kind: 'replace',
          path: 'a.txt',
          content: 'line one\n// ... rest of the file unchanged ...\n'
        }
      ],
      view
    )
    expect(changeSet.changes).toEqual([])
    expect(changeSet.outcomes[0]).toMatchObject({
      status: 'failed',
      errors: [
        { code: 'conflict', message: expect.stringMatching(/every line of the file/) }
      ]
    })
  })

  it('does not mind placeholders in a brand-new file', async () => {
    const view = { read: async () => null, isDirty: async () => false }
    const changeSet = await planChanges(
      [{ kind: 'create', path: 'new.txt', content: '// ... to be written ...\n' }],
      view
    )
    expect(changeSet.changes).toHaveLength(1)
  })
})
