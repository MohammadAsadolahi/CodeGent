import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TimeTravel } from '../../src/workspace/time-travel'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-time-travel-test-'))
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }))

let counter = 0
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const makeRepo = () => {
  const dir = path.join(sandbox, 'repo-' + ++counter)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'original.txt'), 'old\n')
  fs.writeFileSync(path.join(dir, 'removed.txt'), 'remove me\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'First checkpoint')
  const first = git(dir, 'rev-parse', 'HEAD')
  fs.renameSync(path.join(dir, 'original.txt'), path.join(dir, 'renamed.txt'))
  fs.rmSync(path.join(dir, 'removed.txt'))
  fs.writeFileSync(path.join(dir, 'new file.txt'), 'new\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'Second checkpoint')
  return { dir, first, head: git(dir, 'rev-parse', 'HEAD') }
}

describe('TimeTravel', () => {
  it('lists previous checkpoints, previews changes and restores exact files without changing HEAD or index', async () => {
    const { dir, first, head } = makeRepo()
    const travel = new TimeTravel(dir)
    const points = await travel.points()
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({
      sha: head,
      current: true,
      title: 'Second checkpoint'
    })
    expect(points[1]).toMatchObject({
      sha: first,
      current: false,
      title: 'First checkpoint'
    })

    const preview = await travel.preview(first)
    expect(preview.headSha).toBe(head)
    expect(preview.files.sort()).toEqual([
      'new file.txt',
      'original.txt',
      'removed.txt',
      'renamed.txt'
    ])
    const indexBefore = fs.readFileSync(path.join(dir, '.git', 'index'))
    const marker = await travel.restore(first, preview.headSha)
    expect(fs.readFileSync(path.join(dir, 'original.txt'), 'utf8')).toBe('old\n')
    expect(fs.readFileSync(path.join(dir, 'removed.txt'), 'utf8')).toBe('remove me\n')
    expect(fs.existsSync(path.join(dir, 'renamed.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'new file.txt'))).toBe(false)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(fs.readFileSync(path.join(dir, '.git', 'index'))).toEqual(indexBefore)

    await travel.undo(marker)
    expect(fs.readFileSync(path.join(dir, 'renamed.txt'), 'utf8')).toBe('old\n')
    expect(fs.readFileSync(path.join(dir, 'new file.txt'), 'utf8')).toBe('new\n')
    expect(fs.existsSync(path.join(dir, 'original.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'removed.txt'))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('never overwrites dirty, staged, untracked, or unsaved work', async () => {
    const { dir, first, head } = makeRepo()
    const travel = new TimeTravel(dir)
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'personal\n')
    await expect(travel.restore(first, head)).rejects.toThrow(/local changes/)
    fs.rmSync(path.join(dir, 'untracked.txt'))
    fs.writeFileSync(path.join(dir, 'renamed.txt'), 'personal\n')
    await expect(travel.restore(first, head)).rejects.toThrow(/local changes/)
    git(dir, 'restore', 'renamed.txt')
    fs.writeFileSync(path.join(dir, 'renamed.txt'), 'staged\n')
    git(dir, 'add', 'renamed.txt')
    await expect(travel.restore(first, head)).rejects.toThrow(/local changes/)
    git(dir, 'reset', '-q', '--hard', 'HEAD')
    await expect(
      new TimeTravel(dir, undefined, () => true).restore(first, head)
    ).rejects.toThrow(/unsaved/)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('refuses to restore files hidden from git status by assume-unchanged or skip-worktree', async () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const { dir, first, head } = makeRepo()
      const travel = new TimeTravel(dir)
      git(dir, 'update-index', flag, 'renamed.txt')
      fs.writeFileSync(path.join(dir, 'renamed.txt'), 'my hidden edits\n')
      expect(git(dir, 'status', '--porcelain')).toBe('')
      await expect(travel.restore(first, head)).rejects.toThrow(/hiding changes/)
      expect(fs.readFileSync(path.join(dir, 'renamed.txt'), 'utf8')).toBe(
        'my hidden edits\n'
      )
    }
  })

  it('refuses undo when an affected file has new edits outside the patch context', async () => {
    const { dir } = makeRepo()
    const before =
      ['old', ...Array.from({ length: 80 }, (_, n) => 'line ' + n)].join('\n') + '\n'
    fs.writeFileSync(path.join(dir, 'renamed.txt'), before)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Long file')
    const target = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'renamed.txt'), before.replace('old\n', 'new\n'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'One-line change')
    const head = git(dir, 'rev-parse', 'HEAD')
    const travel = new TimeTravel(dir)
    const marker = await travel.restore(target, head)
    fs.appendFileSync(path.join(dir, 'renamed.txt'), 'my later work\n')

    // Git's reverse patch could match the unchanged first few lines, but an
    // undo must not mix the restored version with new work in the same file.
    await expect(travel.undo(marker)).rejects.toThrow(/changed since Time Travel/)
    expect(fs.readFileSync(path.join(dir, 'renamed.txt'), 'utf8')).toContain(
      'my later work\n'
    )
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('can undo when only unrelated user files changed', async () => {
    const { dir, first, head } = makeRepo()
    const travel = new TimeTravel(dir)
    const marker = await travel.restore(first, head)
    fs.writeFileSync(path.join(dir, 'my-notes.txt'), 'personal\n')
    git(dir, 'add', 'my-notes.txt')
    await travel.undo(marker)
    expect(fs.readFileSync(path.join(dir, 'my-notes.txt'), 'utf8')).toBe('personal\n')
    expect(git(dir, 'show', ':my-notes.txt')).toBe('personal')
    expect(fs.readFileSync(path.join(dir, 'renamed.txt'), 'utf8')).toBe('old\n')
  })

  it('refuses submodule pointer changes instead of reporting a successful no-op', async () => {
    const { dir, head } = makeRepo()
    git(dir, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',vendor')
    git(dir, 'commit', '-qm', 'Submodule pointer')
    const travel = new TimeTravel(dir)
    await expect(travel.preview(head)).rejects.toThrow(/submodule pointer/)
    await expect(travel.restore(head, git(dir, 'rev-parse', 'HEAD'))).rejects.toThrow(
      /submodule pointer/
    )
  })

  it('restores binary file contents exactly and reverses them', async () => {
    const { dir } = makeRepo()
    const file = path.join(dir, 'resource.bin')
    const previous = Buffer.from([0, 1, 2, 127, 255, 3, 4, 5])
    const current = Buffer.from([0, 8, 8, 254, 3, 2, 1, 7])
    fs.writeFileSync(file, previous)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Binary baseline')
    const target = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(file, current)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Binary update')
    const head = git(dir, 'rev-parse', 'HEAD')
    const travel = new TimeTravel(dir)

    const marker = await travel.restore(target, head)
    expect(fs.readFileSync(file)).toEqual(previous)
    await travel.undo(marker)
    expect(fs.readFileSync(file)).toEqual(current)
  })

  it('round-trips a file-to-directory transition and refuses later nested edits', async () => {
    const { dir } = makeRepo()
    fs.writeFileSync(path.join(dir, 'switch'), 'file version\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'A plain file')
    const target = git(dir, 'rev-parse', 'HEAD')

    fs.rmSync(path.join(dir, 'switch'))
    fs.mkdirSync(path.join(dir, 'switch'))
    fs.writeFileSync(path.join(dir, 'switch', 'nested.txt'), 'nested version\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'A directory')
    const head = git(dir, 'rev-parse', 'HEAD')
    const travel = new TimeTravel(dir)

    const marker = await travel.restore(target, head)
    expect(fs.readFileSync(path.join(dir, 'switch'), 'utf8')).toBe('file version\n')
    await travel.undo(marker)
    expect(fs.readFileSync(path.join(dir, 'switch', 'nested.txt'), 'utf8')).toBe(
      'nested version\n'
    )
    expect(git(dir, 'status', '--porcelain')).toBe('')

    const again = await travel.restore(target, head)
    fs.rmSync(path.join(dir, 'switch'))
    fs.mkdirSync(path.join(dir, 'switch'))
    fs.writeFileSync(path.join(dir, 'switch', 'user-note.txt'), 'keep me\n')
    await expect(travel.undo(again)).rejects.toThrow(/changed since Time Travel/)
    expect(fs.readFileSync(path.join(dir, 'switch', 'user-note.txt'), 'utf8')).toBe(
      'keep me\n'
    )
  })

  it('validates identifiers and refuses to restore commits that are not ancestors', async () => {
    const { dir, first, head } = makeRepo()
    const travel = new TimeTravel(dir)
    await expect(travel.preview('HEAD')).rejects.toThrow(/identifier/)
    await expect(travel.restore(first, '0'.repeat(40))).rejects.toThrow(/HEAD changed/)
    git(dir, 'checkout', '-q', '-b', 'other', first)
    fs.writeFileSync(path.join(dir, 'other.txt'), 'other')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Diverged')
    const divergent = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', 'main')
    await expect(travel.preview(divergent)).rejects.toThrow(/not in/)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('refuses to undo over subsequent user edits, and preserves those edits', async () => {
    const { dir, first, head } = makeRepo()
    const travel = new TimeTravel(dir)
    const marker = await travel.restore(first, head)
    fs.writeFileSync(path.join(dir, 'original.txt'), 'my new work\n')
    await expect(travel.undo(marker)).rejects.toThrow(/changed since Time Travel/)
    expect(fs.readFileSync(path.join(dir, 'original.txt'), 'utf8')).toBe('my new work\n')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })
})
