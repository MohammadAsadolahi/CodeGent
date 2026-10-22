import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BinaryFileError,
  parseReply,
  planChanges,
  type FileChange
} from '@codegent/engine'
import { FsWorkspace } from '../../src/workspace/fs-workspace'
import { RepoService } from '../../src/workspace/repo-service'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-fsw-'))
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }))

let counter = 0
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

/** A repo with GitHub-looking identity and a local bare repository to push to. */
const newRepo = (files: Record<string, string | Buffer> = {}) => {
  const dir = path.join(sandbox, `repo${++counter}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'core.autocrlf', 'false')
  for (const [file, content] of Object.entries({ 'README.md': '# readme\n', ...files })) {
    const full = path.join(dir, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  const bare = path.join(sandbox, `bare${counter}.git`)
  git(sandbox, 'init', '-q', '--bare', '-b', 'main', bare)
  git(dir, 'remote', 'add', 'origin', 'https://github.com/octo/project.git')
  git(dir, 'remote', 'set-url', '--push', 'origin', bare)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  const repo = new RepoService(dir)
  const workspace = new FsWorkspace({ root: dir, repo })
  return { dir, bare, repo, workspace }
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8')
const exists = (dir: string, file: string) => fs.existsSync(path.join(dir, file))
const leftovers = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((name) => String(name).includes('.codegent-'))
const meta = { runId: 'run', step: 1 }

describe('reading (the view used for planning)', () => {
  it('reads text, reports missing files, and recognises what is not editable text', async () => {
    const { workspace } = newRepo({
      'a.txt': 'hello\r\nworld\r\n',
      'bom.txt': Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('with bom\n')
      ]),
      'bin.dat': Buffer.from([1, 2, 0, 3]),
      'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), // "café\n" in Latin-1: invalid UTF-8
      'dir/inner.txt': 'x'
    })
    const { view } = workspace
    expect(await view.read('a.txt')).toBe('hello\r\nworld\r\n')
    expect(await view.read('bom.txt')).toBe('with bom\n')
    expect(await view.read('nope.txt')).toBeNull()
    expect(await view.read('dir/inner.txt/deeper')).toBeNull()
    await expect(view.read('bin.dat')).rejects.toBeInstanceOf(BinaryFileError)
    await expect(view.read('latin1.txt')).rejects.toThrow(/not UTF-8/)
    await expect(view.read('dir')).rejects.toThrow(/directory/)
  })

  it('refuses huge files', async () => {
    const { workspace } = newRepo({ 'huge.txt': 'x'.repeat(6 * 1024 * 1024) })
    await expect(workspace.view.read('huge.txt')).rejects.toThrow(/too large/)
  })

  it('sees uncommitted changes, untracked files and unsaved editor buffers as dirty', async () => {
    const { dir, repo } = newRepo({
      'clean.txt': 'c\n',
      'edited.txt': 'e\n',
      'buffered.txt': 'b\n'
    })
    const buffers = new Set<string>()
    const workspace = new FsWorkspace({
      root: dir,
      repo,
      isBufferDirty: (abs) => buffers.has(abs)
    })
    fs.writeFileSync(path.join(dir, 'edited.txt'), 'changed\n')
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n')
    buffers.add(path.join(dir, 'buffered.txt'))
    const { view } = workspace
    expect(await view.isDirty('clean.txt')).toBe(false)
    expect(await view.isDirty('edited.txt')).toBe(true)
    expect(await view.isDirty('untracked.txt')).toBe(true)
    expect(await view.isDirty('buffered.txt')).toBe(true)
  })

  it('knows ignored paths', async () => {
    const { dir, workspace } = newRepo({ '.gitignore': '.env\ndist/\n' })
    expect(await workspace.view.isIgnored!('.env')).toBe(true)
    expect(await workspace.view.isIgnored!('dist/a.js')).toBe(true)
    expect(await workspace.view.isIgnored!('src/a.ts')).toBe(false)
    void dir
  })

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'corrects the casing of paths on case-insensitive file systems, including new files in existing folders',
    async () => {
      const { workspace } = newRepo({ 'Src/App.ts': 'x\n' })
      const { canonicalCase } = workspace.view
      expect(await canonicalCase!('src/app.ts')).toBe('Src/App.ts')
      expect(await canonicalCase!('SRC/new.ts')).toBe('Src/new.ts')
      expect(await canonicalCase!('Src/App.ts')).toBeUndefined()
      expect(await canonicalCase!('other/new.ts')).toBeUndefined()
    }
  )
})

describe('applying changes', () => {
  it('creates, modifies, deletes and renames; a receipt names the paths', async () => {
    const { dir, workspace } = newRepo({
      'mod.txt': 'old\n',
      'del.txt': 'bye\n',
      'from.txt': 'move me\n'
    })
    const changes: FileChange[] = [
      { kind: 'create', path: 'deep/new/file.txt', after: 'created\n' },
      { kind: 'modify', path: 'mod.txt', before: 'old\n', after: 'new\n' },
      { kind: 'delete', path: 'del.txt', before: 'bye\n' },
      {
        kind: 'rename',
        from: 'from.txt',
        to: 'lib/to.txt',
        before: 'move me\n',
        after: 'moved\n'
      }
    ]
    const receipt = await workspace.apply(changes, meta)
    expect(read(dir, 'deep/new/file.txt')).toBe('created\n')
    expect(read(dir, 'mod.txt')).toBe('new\n')
    expect(exists(dir, 'del.txt')).toBe(false)
    expect(exists(dir, 'from.txt')).toBe(false)
    expect(read(dir, 'lib/to.txt')).toBe('moved\n')
    expect(receipt.paths).toEqual([
      'deep/new/file.txt',
      'mod.txt',
      'del.txt',
      'lib/to.txt'
    ])
    expect(leftovers(dir)).toEqual([])
  })

  it('preserves a UTF-8 BOM and CRLF line endings through an edit', async () => {
    const { dir, workspace } = newRepo({
      'crlf.txt': 'a\r\nb\r\n',
      'bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\n')])
    })
    await workspace.apply(
      [
        { kind: 'modify', path: 'crlf.txt', before: 'a\r\nb\r\n', after: 'a\r\nB\r\n' },
        { kind: 'modify', path: 'bom.txt', before: 'x\r\n', after: 'y\r\n' }
      ],
      meta
    )
    expect(fs.readFileSync(path.join(dir, 'crlf.txt'))).toEqual(Buffer.from('a\r\nB\r\n'))
    expect([...fs.readFileSync(path.join(dir, 'bom.txt'))]).toEqual([
      ...Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('y\r\n')])
    ])
  })

  it.runIf(process.platform !== 'win32')('keeps the executable bit', async () => {
    const { dir, workspace } = newRepo({ 'run.sh': '#!/bin/sh\necho a\n' })
    fs.chmodSync(path.join(dir, 'run.sh'), 0o755)
    await workspace.apply(
      [
        {
          kind: 'modify',
          path: 'run.sh',
          before: '#!/bin/sh\necho a\n',
          after: '#!/bin/sh\necho b\n'
        }
      ],
      meta
    )
    expect(fs.statSync(path.join(dir, 'run.sh')).mode & 0o777).toBe(0o755)
  })

  it('is all-or-nothing: a failure part-way rolls every earlier change back', async () => {
    const { dir, workspace } = newRepo({
      'one.txt': '1\n',
      'two.txt': '2\n',
      'three.txt': '3\n'
    })
    await expect(
      workspace.apply(
        [
          { kind: 'modify', path: 'one.txt', before: '1\n', after: 'ONE\n' },
          { kind: 'create', path: 'made.txt', after: 'new\n' },
          { kind: 'delete', path: 'two.txt', before: '2\n' },
          { kind: 'modify', path: 'three.txt', before: 'STALE\n', after: 'x\n' } // not what is on disk
        ],
        meta
      )
    ).rejects.toThrow(/modified on disk/)
    expect(read(dir, 'one.txt')).toBe('1\n')
    expect(exists(dir, 'made.txt')).toBe(false)
    expect(read(dir, 'two.txt')).toBe('2\n')
    expect(read(dir, 'three.txt')).toBe('3\n')
    expect(leftovers(dir)).toEqual([])
  })

  it('refuses to overwrite what changed on disk after planning', async () => {
    const { dir, workspace } = newRepo({ 'a.txt': 'planned\n' })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'user typed something\n')
    await expect(
      workspace.apply(
        [{ kind: 'modify', path: 'a.txt', before: 'planned\n', after: 'x\n' }],
        meta
      )
    ).rejects.toThrow(/modified on disk/)
    expect(read(dir, 'a.txt')).toBe('user typed something\n')
  })

  it('refuses to create over an existing file or directory, and to rename onto one', async () => {
    const { workspace } = newRepo({ 'exists.txt': 'x\n', 'src/a.ts': 'a\n' })
    await expect(
      workspace.apply([{ kind: 'create', path: 'exists.txt', after: 'y\n' }], meta)
    ).rejects.toThrow(/already exists/)
    await expect(
      workspace.apply([{ kind: 'create', path: 'src', after: 'y\n' }], meta)
    ).rejects.toThrow(/already exists/)
    await expect(
      workspace.apply(
        [
          {
            kind: 'rename',
            from: 'src/a.ts',
            to: 'exists.txt',
            before: 'a\n',
            after: 'a\n'
          }
        ],
        meta
      )
    ).rejects.toThrow(/already exists/)
  })

  it('never writes through a link that leaves the repository', async () => {
    const outside = path.join(sandbox, `outside${counter + 1}`)
    fs.mkdirSync(outside)
    const { dir, workspace } = newRepo()
    fs.symlinkSync(
      outside,
      path.join(dir, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(
      workspace.apply([{ kind: 'create', path: 'escape/pwned.txt', after: 'x\n' }], meta)
    ).rejects.toThrow(/outside the repository/)
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false)
  })
})

describe('undo', () => {
  it('restores every kind of change', async () => {
    const { dir, workspace } = newRepo({
      'mod.txt': 'old\n',
      'del.txt': 'bye\n',
      'from.txt': 'move me\n'
    })
    const receipt = await workspace.apply(
      [
        { kind: 'create', path: 'made.txt', after: 'created\n' },
        { kind: 'modify', path: 'mod.txt', before: 'old\n', after: 'new\n' },
        { kind: 'delete', path: 'del.txt', before: 'bye\n' },
        {
          kind: 'rename',
          from: 'from.txt',
          to: 'to.txt',
          before: 'move me\n',
          after: 'moved\n'
        }
      ],
      meta
    )
    const result = await workspace.undo(receipt.id)
    expect(result.skipped).toEqual([])
    expect(result.undone.sort()).toEqual(['del.txt', 'from.txt', 'made.txt', 'mod.txt'])
    expect(exists(dir, 'made.txt')).toBe(false)
    expect(read(dir, 'mod.txt')).toBe('old\n')
    expect(read(dir, 'del.txt')).toBe('bye\n')
    expect(read(dir, 'from.txt')).toBe('move me\n')
    expect(exists(dir, 'to.txt')).toBe(false)
    expect(workspace.isUndone(receipt.id)).toBe(true)
  })

  it('leaves files alone that were changed after the step, and says why', async () => {
    const { dir, workspace } = newRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const receipt = await workspace.apply(
      [
        { kind: 'modify', path: 'a.txt', before: 'a\n', after: 'A\n' },
        { kind: 'modify', path: 'b.txt', before: 'b\n', after: 'B\n' }
      ],
      meta
    )
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A and then the user kept typing\n')
    const result = await workspace.undo(receipt.id)
    expect(result.undone).toEqual(['b.txt'])
    expect(result.skipped).toEqual([
      { path: 'a.txt', reason: 'it was changed after this step' }
    ])
    expect(read(dir, 'a.txt')).toBe('A and then the user kept typing\n')
    expect(read(dir, 'b.txt')).toBe('b\n')
    expect(workspace.isUndone(receipt.id)).toBe(false)
  })

  it('cannot be undone twice, and unknown steps are reported', async () => {
    const { workspace } = newRepo({ 'a.txt': 'a\n' })
    const receipt = await workspace.apply(
      [{ kind: 'modify', path: 'a.txt', before: 'a\n', after: 'A\n' }],
      meta
    )
    await workspace.undo(receipt.id)
    expect((await workspace.undo(receipt.id)).skipped[0]!.reason).toMatch(
      /already undone/
    )
    expect((await workspace.undo('missing')).skipped[0]!.reason).toMatch(
      /can no longer be undone/
    )
  })
})

describe('a commit holds only what the step changed', () => {
  it('leaves the user’s modified, staged and untracked files out of the commit and the push', async () => {
    const { dir, bare, repo, workspace } = newRepo({
      'src/a.ts': 'export const a = 1\n',
      'src/mine.ts': 'export const mine = 1\n',
      'src/other.ts': 'export const other = 1\n'
    })
    // The user's own work in progress, in every state git knows.
    fs.writeFileSync(path.join(dir, 'src/mine.ts'), 'export const mine = 2 // editing\n')
    fs.writeFileSync(path.join(dir, 'staged.ts'), 'export const staged = 1\n')
    git(dir, 'add', 'staged.ts')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n')

    const changeSet = await planChanges(
      parseReply(
        '### Updated file: `src/a.ts`\n```\n<<<<<<< SEARCH\nexport const a = 1\n=======\nexport const a = 2\n>>>>>>> REPLACE\n```\n### Created file: `src/new.ts`\n```\nexport const n = 1\n```\n### Updated file: `src/mine.ts`\n```\n<<<<<<< SEARCH\nexport const mine = 2 // editing\n=======\nexport const mine = 3\n>>>>>>> REPLACE\n```'
      ).edits,
      workspace.view,
      { workspaceRoot: dir }
    )
    // The file the user is editing is protected in the first place …
    expect(
      changeSet.outcomes.map((outcome) => `${outcome.path}:${outcome.status}`)
    ).toEqual(['src/a.ts:applied', 'src/new.ts:applied', 'src/mine.ts:failed'])
    await workspace.apply(changeSet.changes, meta)
    const port = repo.gitPort()
    await port.commit(
      changeSet.changes.map((change) =>
        change.kind === 'rename' ? change.to : change.path
      ),
      'codegent: step'
    )
    await port.push()

    // … and what the user has is exactly as it was: not committed, not pushed, not unstaged.
    expect(
      git(bare, 'show', '--name-only', '--format=', 'main').split('\n').sort()
    ).toEqual(['src/a.ts', 'src/new.ts'])
    // (the helper trims the output, which drops the leading space of the first status line)
    expect(
      git(dir, 'status', '--porcelain')
        .split('\n')
        .map((line) => line.trim())
        .sort()
    ).toEqual(['?? notes.txt', 'A  staged.ts', 'M src/mine.ts'])
    expect(read(dir, 'src/mine.ts')).toBe('export const mine = 2 // editing\n')
    expect(git(bare, 'log', '--format=%s', 'main').split('\n')).toEqual([
      'codegent: step',
      'initial'
    ])
  })
})

describe('the whole pipeline on a real repository', () => {
  it('reply → parse → plan → write → commit → push, touching only what the reply named', async () => {
    const { dir, bare, repo, workspace } = newRepo({
      'src/math.ts': 'export const add = (a: number, b: number) => a - b\n',
      'src/keep.ts': 'export const keep = 1\n',
      'src/old.ts': 'export const old = 1\n',
      '.gitignore': '.env\n'
    })
    fs.writeFileSync(
      path.join(dir, 'notes.txt'),
      'the user is working on this (untracked)\n'
    )

    const reply = [
      'Fixing the bug and tidying up.',
      '',
      '### Updated file: `src/math.ts`',
      '```ts',
      '<<<<<<< SEARCH',
      'export const add = (a: number, b: number) => a - b',
      '=======',
      'export const add = (a: number, b: number) => a + b',
      '>>>>>>> REPLACE',
      '```',
      '### Created file: `src/math.test.ts`',
      '```ts',
      "import { add } from './math'",
      'console.assert(add(1, 2) === 3)',
      '```',
      '### Deleted file: `src/old.ts`',
      '### Created file: `.env`',
      '```',
      'SECRET=1',
      '```',
      '### Created file: `../escape.txt`',
      '```',
      'nope',
      '```',
      'CODEGENT_STATUS: done'
    ].join('\n')

    const changeSet = await planChanges(parseReply(reply).edits, workspace.view, {
      workspaceRoot: dir
    })
    expect(changeSet.outcomes.map((o) => `${o.path}:${o.status}`)).toEqual([
      'src/math.ts:applied',
      'src/math.test.ts:applied',
      'src/old.ts:applied',
      '.env:failed',
      '../escape.txt:failed'
    ])
    await workspace.apply(changeSet.changes, meta)
    const port = repo.gitPort()
    const paths = changeSet.changes.map((c) => (c.kind === 'rename' ? c.to : c.path))
    const committed = await port.commit(paths, 'codegent: fix add')
    await port.push()

    expect(read(dir, 'src/math.ts')).toBe(
      'export const add = (a: number, b: number) => a + b\n'
    )
    expect(exists(dir, 'src/old.ts')).toBe(false)
    expect(exists(dir, '.env')).toBe(false)
    expect(exists(path.dirname(dir), 'escape.txt')).toBe(false)
    expect(committed.committed).toBe(true)
    expect(
      git(bare, 'show', '--name-status', '--format=%s', 'main')
        .split('\n')
        .filter(Boolean)
        .sort()
    ).toEqual([
      'A\tsrc/math.test.ts',
      'D\tsrc/old.ts',
      'M\tsrc/math.ts',
      'codegent: fix add'
    ])
    expect(git(dir, 'status', '--porcelain')).toBe('?? notes.txt') // the user's file is untouched and uncommitted
  })
})
