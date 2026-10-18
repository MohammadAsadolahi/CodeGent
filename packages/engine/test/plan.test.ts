import { describe, expect, it } from 'vitest'
import { BinaryFileError, parseReply, planChanges, type FileEdit, type WorkspaceView } from '../src'

class MemoryView implements WorkspaceView {
  files = new Map<string, string>()
  dirty = new Set<string>()
  binary = new Set<string>()
  reads: string[] = []

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.files.set(path, content)
  }
  async read(path: string) {
    this.reads.push(path)
    if (this.binary.has(path)) throw new BinaryFileError()
    return this.files.get(path) ?? null
  }
  async isDirty(path: string) {
    return this.dirty.has(path)
  }
  async canonicalCase(path: string) {
    const lower = path.toLowerCase()
    return [...this.files.keys()].find((key) => key.toLowerCase() === lower)
  }
  isIgnored?: (path: string) => Promise<boolean>
}

const update = (path: string, search: string, replace: string): FileEdit => ({
  kind: 'update',
  path,
  hunks: [{ search: search.split('\n'), replace: replace === '' ? [] : replace.split('\n') }]
})

const plan = (edits: FileEdit[], view: MemoryView, options = {}) => planChanges(edits, view, options)

describe('updates', () => {
  it('produces a modify change with before/after and a hunk count', async () => {
    const view = new MemoryView({ 'src/a.ts': 'const a = 1\nconst b = 2\n' })
    const result = await plan([update('src/a.ts', 'const a = 1', 'const a = 10')], view)
    expect(result.changes).toEqual([
      { kind: 'modify', path: 'src/a.ts', before: 'const a = 1\nconst b = 2\n', after: 'const a = 10\nconst b = 2\n' }
    ])
    expect(result.outcomes[0]).toMatchObject({ status: 'applied', path: 'src/a.ts', detail: '1 hunk' })
  })

  it('never writes anything: the view is only read', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n' })
    await plan([update('a.ts', 'x', 'y')], view)
    expect(view.files.get('a.ts')).toBe('x\n')
  })

  it('fails with missing-file (pointing at "Created file") when the file does not exist', async () => {
    const result = await plan([update('nope.ts', 'x', 'y')], new MemoryView())
    expect(result.changes).toEqual([])
    expect(result.outcomes[0]!.errors[0]).toMatchObject({ code: 'missing-file' })
    expect(result.outcomes[0]!.errors[0]!.message).toMatch(/Created file/)
  })

  it('reports each failing hunk with its detail and leaves the file alone', async () => {
    const view = new MemoryView({ 'a.ts': 'one\ntwo\n' })
    const result = await plan(
      [
        {
          kind: 'update',
          path: 'a.ts',
          hunks: [
            { search: ['one'], replace: ['1'] },
            { search: ['three'], replace: ['3'] }
          ]
        }
      ],
      view
    )
    expect(result.changes).toEqual([])
    expect(result.outcomes[0]).toMatchObject({ status: 'failed' })
    expect(result.outcomes[0]!.errors).toHaveLength(1)
    expect(result.outcomes[0]!.errors[0]).toMatchObject({ code: 'not-found', hunk: 2 })
  })

  it('treats an update that changes nothing as skipped', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n' })
    const result = await plan([update('a.ts', 'x', 'x')], view)
    expect(result.outcomes[0]!.status).toBe('skipped')
    expect(result.changes).toEqual([])
  })

  it('surfaces matching notes (e.g. indentation adjusted)', async () => {
    const view = new MemoryView({ 'a.ts': '    keep()\n    me()\n' })
    const result = await plan([update('a.ts', 'keep()', 'kept()')], view)
    expect(result.outcomes[0]!.notes[0]).toMatch(/hunk 1: matched ignoring indentation/)
    expect(result.changes[0]).toMatchObject({ after: '    kept()\n    me()\n' })
  })
})

describe('creating, replacing and deleting', () => {
  it('creates files (LF, final newline) including in new directories', async () => {
    const result = await plan([{ kind: 'create', path: 'new/dir/file.ts', content: 'export {}' }], new MemoryView())
    expect(result.changes).toEqual([{ kind: 'create', path: 'new/dir/file.ts', after: 'export {}\n' }])
  })

  it('replaces an existing file when a "create" targets it, and says so', async () => {
    const view = new MemoryView({ 'a.ts': 'old\n' })
    const result = await plan([{ kind: 'create', path: 'a.ts', content: 'new' }], view)
    expect(result.changes).toEqual([{ kind: 'modify', path: 'a.ts', before: 'old\n', after: 'new\n' }])
    expect(result.outcomes[0]!.notes[0]).toMatch(/already existed/)
  })

  it('skips a create whose content is identical to what is there', async () => {
    const view = new MemoryView({ 'a.ts': 'same\n' })
    const result = await plan([{ kind: 'create', path: 'a.ts', content: 'same' }], view)
    expect(result.outcomes[0]!.status).toBe('skipped')
  })

  it('creates a file for a "replace" of one that does not exist', async () => {
    const result = await plan([{ kind: 'replace', path: 'a.ts', content: 'x' }], new MemoryView())
    expect(result.changes).toEqual([{ kind: 'create', path: 'a.ts', after: 'x\n' }])
    expect(result.outcomes[0]!.notes[0]).toMatch(/did not exist/)
  })

  it('keeps the original file’s CRLF endings for whole-file replacements', async () => {
    const view = new MemoryView({ 'a.ts': 'a\r\nb\r\n' })
    const result = await plan([{ kind: 'replace', path: 'a.ts', content: 'x\ny' }], view)
    expect(result.changes[0]).toMatchObject({ after: 'x\r\ny\r\n' })
  })

  it('refuses a whole-file replacement that would shrink a big file to almost nothing', async () => {
    const view = new MemoryView({ 'big.ts': 'line of code\n'.repeat(100) })
    const result = await plan([{ kind: 'replace', path: 'big.ts', content: '// ...' }], view)
    expect(result.outcomes[0]).toMatchObject({ status: 'failed' })
    expect(result.outcomes[0]!.errors[0]).toMatchObject({ code: 'conflict' })
    expect(result.changes).toEqual([])
  })

  it('allows a small file to be rewritten freely', async () => {
    const view = new MemoryView({ 'small.ts': 'a\nb\n' })
    const result = await plan([{ kind: 'replace', path: 'small.ts', content: 'x' }], view)
    expect(result.outcomes[0]!.status).toBe('applied')
  })

  it('deletes files, and treats deleting a missing file as already done', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n' })
    const result = await plan([{ kind: 'delete', path: 'a.ts' }, { kind: 'delete', path: 'ghost.ts' }], view)
    expect(result.changes).toEqual([{ kind: 'delete', path: 'a.ts', before: 'x\n' }])
    expect(result.outcomes.map((o) => o.status)).toEqual(['applied', 'skipped'])
  })
})

describe('renames', () => {
  it('moves a file, optionally editing it', async () => {
    const view = new MemoryView({ 'old.ts': 'name = "old"\n' })
    const result = await plan(
      [{ kind: 'rename', from: 'old.ts', to: 'lib/new.ts', hunks: [{ search: ['name = "old"'], replace: ['name = "new"'] }] }],
      view
    )
    expect(result.changes).toEqual([
      { kind: 'rename', from: 'old.ts', to: 'lib/new.ts', before: 'name = "old"\n', after: 'name = "new"\n' }
    ])
  })

  it('fails when the source is missing or the destination exists', async () => {
    const view = new MemoryView({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const missing = await plan([{ kind: 'rename', from: 'zzz.ts', to: 'c.ts', hunks: [] }], view)
    expect(missing.outcomes[0]!.errors[0]).toMatchObject({ code: 'missing-file' })
    const exists = await plan([{ kind: 'rename', from: 'a.ts', to: 'b.ts', hunks: [] }], view)
    expect(exists.outcomes[0]!.errors[0]).toMatchObject({ code: 'exists' })
  })

  it('follows a chain of renames and later edits to the new name', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n' })
    const result = await plan(
      [
        { kind: 'rename', from: 'a.ts', to: 'b.ts', hunks: [] },
        { kind: 'rename', from: 'b.ts', to: 'c.ts', hunks: [] },
        update('c.ts', 'x', 'y')
      ],
      view
    )
    expect(result.changes).toEqual([{ kind: 'rename', from: 'a.ts', to: 'c.ts', before: 'x\n', after: 'y\n' }])
  })

  it('does not rename a file onto itself', async () => {
    const result = await plan([{ kind: 'rename', from: 'a.ts', to: './a.ts', hunks: [] }], new MemoryView({ 'a.ts': 'x\n' }))
    expect(result.outcomes[0]!.status).toBe('skipped')
  })
})

describe('edits that build on each other within one reply', () => {
  it('create then update the new file', async () => {
    const result = await plan(
      [{ kind: 'create', path: 'n.ts', content: 'one\ntwo' }, update('n.ts', 'two', 'TWO')],
      new MemoryView()
    )
    expect(result.changes).toEqual([{ kind: 'create', path: 'n.ts', after: 'one\nTWO\n' }])
  })

  it('update then update again sees the first result', async () => {
    const view = new MemoryView({ 'a.ts': 'a\n' })
    const result = await plan([update('a.ts', 'a', 'b'), update('a.ts', 'b', 'c')], view)
    expect(result.changes).toEqual([{ kind: 'modify', path: 'a.ts', before: 'a\n', after: 'c\n' }])
  })

  it('create then delete leaves no trace', async () => {
    const result = await plan([{ kind: 'create', path: 't.ts', content: 'x' }, { kind: 'delete', path: 't.ts' }], new MemoryView())
    expect(result.changes).toEqual([])
  })

  it('a failed edit does not poison independent files', async () => {
    const view = new MemoryView({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    const result = await plan([update('a.ts', 'zzz', 'x'), update('b.ts', 'b', 'B')], view)
    expect(result.outcomes.map((o) => o.status)).toEqual(['failed', 'applied'])
    expect(result.changes).toEqual([{ kind: 'modify', path: 'b.ts', before: 'b\n', after: 'B\n' }])
  })

  it('works with edits parsed from a real reply', async () => {
    const reply = [
      '### Updated file: `src/a.ts`',
      '```ts',
      '<<<<<<< SEARCH',
      'export const a = 1',
      '=======',
      'export const a = 2',
      '>>>>>>> REPLACE',
      '```',
      '### Created file: `src/b.ts`',
      '```ts',
      'export const b = 1',
      '```'
    ].join('\n')
    const view = new MemoryView({ 'src/a.ts': 'export const a = 1\n' })
    const result = await plan(parseReply(reply).edits, view)
    expect(result.changes.map((c) => c.kind)).toEqual(['modify', 'create'])
  })
})

describe('safety rules', () => {
  it.each([
    ['../outside.ts', /leaves the repository/],
    ['.git/hooks/pre-commit', /\.git/],
    ['C:\\Windows\\x.dll', /outside the repository/]
  ])('rejects the path %s', async (path, reason) => {
    const result = await plan([{ kind: 'create', path, content: 'x' }], new MemoryView())
    expect(result.changes).toEqual([])
    expect(result.outcomes[0]!.errors[0]).toMatchObject({ code: 'path' })
    expect(result.outcomes[0]!.errors[0]!.message).toMatch(reason)
  })

  it('never touches paths outside the repository even via rename or delete', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n' })
    const result = await plan(
      [
        { kind: 'rename', from: 'a.ts', to: '../stolen.ts', hunks: [] },
        { kind: 'delete', path: '../../etc/passwd' }
      ],
      view
    )
    expect(result.changes).toEqual([])
    expect(result.outcomes.every((o) => o.status === 'failed')).toBe(true)
    expect(view.reads.some((p) => p.includes('..'))).toBe(false)
  })

  it('converts absolute paths inside the workspace to relative ones', async () => {
    const view = new MemoryView({ 'src/a.ts': 'x\n' })
    const result = await plan([update('/work/proj/src/a.ts', 'x', 'y')], view, { workspaceRoot: '/work/proj' })
    expect(result.changes[0]).toMatchObject({ path: 'src/a.ts' })
  })

  it('leaves files with uncommitted local changes alone (they cannot be committed cleanly)', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n', 'b.ts': 'y\n', 'c.ts': 'z\n' })
    view.dirty.add('a.ts').add('b.ts').add('c.ts')
    const result = await plan(
      [
        update('a.ts', 'x', 'X'),
        { kind: 'replace', path: 'b.ts', content: 'Y' },
        { kind: 'delete', path: 'c.ts' }
      ],
      view
    )
    expect(result.changes).toEqual([])
    for (const outcome of result.outcomes) {
      expect(outcome.errors[0]).toMatchObject({ code: 'dirty-file' })
    }
  })

  it('edits dirty files when explicitly allowed', async () => {
    const view = new MemoryView({ 'a.ts': 'x\n' })
    view.dirty.add('a.ts')
    const result = await plan([update('a.ts', 'x', 'X')], view, { allowDirty: true })
    expect(result.changes).toHaveLength(1)
  })

  it('does not call a file dirty just because this same reply already changed it', async () => {
    const view = new MemoryView({ 'a.ts': 'a\n' })
    view.dirty.add('a.ts')
    const result = await plan([update('a.ts', 'a', 'b')], view)
    expect(result.outcomes[0]!.errors[0]).toMatchObject({ code: 'dirty-file' })
    const clean = new MemoryView({ 'a.ts': 'a\n' })
    const twice = await plan([update('a.ts', 'a', 'b'), update('a.ts', 'b', 'c')], clean)
    expect(twice.outcomes.map((o) => o.status)).toEqual(['applied', 'applied'])
  })

  it('refuses files that git ignores, for every kind of edit', async () => {
    const view = new MemoryView({ '.env': 'SECRET=1\n', 'dist/a.js': 'x\n' })
    view.isIgnored = async (path) => path === '.env' || path.startsWith('dist/')
    const result = await plan(
      [
        update('.env', 'SECRET=1', 'SECRET=2'),
        { kind: 'create', path: 'dist/new.js', content: 'x' },
        { kind: 'delete', path: 'dist/a.js' },
        { kind: 'rename', from: 'dist/a.js', to: 'src/a.js', hunks: [] },
        { kind: 'create', path: 'src/fine.ts', content: 'x' }
      ],
      view
    )
    expect(result.outcomes.map((o) => o.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'applied'])
    expect(result.outcomes[0]!.errors[0]!.message).toMatch(/ignored by git/)
    expect(result.changes).toEqual([{ kind: 'create', path: 'src/fine.ts', after: 'x\n' }])
  })

  it('reports binary files instead of corrupting them', async () => {
    const view = new MemoryView({ 'logo.png': '\u0000PNG' })
    view.binary.add('logo.png')
    const result = await plan([update('logo.png', 'x', 'y'), { kind: 'delete', path: 'logo.png' }], view)
    expect(result.outcomes.map((o) => o.errors[0]?.code)).toEqual(['binary-file', 'binary-file'])
  })

  it('uses the real casing of an existing file on case-insensitive systems', async () => {
    const view = new MemoryView({ 'src/App.ts': 'x\n' })
    const result = await plan([update('src/app.ts', 'x', 'y')], view)
    expect(result.changes[0]).toMatchObject({ path: 'src/App.ts' })
  })
})
