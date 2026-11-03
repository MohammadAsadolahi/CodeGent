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
    await expect(travel.undo(marker)).rejects.toThrow(/git apply failed/)
    expect(fs.readFileSync(path.join(dir, 'original.txt'), 'utf8')).toBe('my new work\n')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })
})
