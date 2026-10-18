import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyPushFailure,
  GitClient,
  GitError,
  parseRemoteUrl,
  sanitizeRemoteUrl
} from '../src'

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/octo/repo.git', 'github.com', 'octo', 'repo'],
    ['https://github.com/octo/repo', 'github.com', 'octo', 'repo'],
    ['https://github.com/octo/repo/', 'github.com', 'octo', 'repo'],
    ['https://github.com/octo/repo.GIT', 'github.com', 'octo', 'repo'],
    ['https://ghp_SECRETTOKEN@github.com/octo/repo.git', 'github.com', 'octo', 'repo'],
    ['https://user:p%40ss@github.com/octo/repo.git', 'github.com', 'octo', 'repo'],
    ['git@github.com:octo/repo.git', 'github.com', 'octo', 'repo'],
    ['github.com:octo/repo', 'github.com', 'octo', 'repo'],
    ['ssh://git@github.com/octo/repo.git', 'github.com', 'octo', 'repo'],
    ['ssh://git@github.com:22/octo/repo.git', 'github.com', 'octo', 'repo'],
    ['git://github.com/octo/repo.git', 'github.com', 'octo', 'repo'],
    ['https://GitHub.com/Octo/Repo.git', 'github.com', 'Octo', 'Repo'],
    [
      'https://github.example.corp/team/service.git',
      'github.example.corp',
      'team',
      'service'
    ],
    ['git@gitlab.com:group/sub/project.git', 'gitlab.com', 'group/sub', 'project'],
    ['https://github.com/octo/my.dotted.repo.git', 'github.com', 'octo', 'my.dotted.repo']
  ])('%s', (url, host, owner, repo) => {
    const parsed = parseRemoteUrl(url)
    expect(parsed).toMatchObject({ host, owner, repo })
    expect(parsed!.webUrl).toBe(`https://${host}/${owner}/${repo}`)
    expect(parsed!.webUrl).not.toMatch(/SECRET|p%40ss|@/)
  })

  it.each([
    [''],
    ['   '],
    ['/home/me/repos/project.git'],
    ['C:\\repos\\project.git'],
    ['C:/repos/project.git'],
    ['file:///srv/repos/project.git'],
    ['../sibling'],
    ['https://github.com/only-owner']
  ])('is not a hosted repository: %j', (url) => {
    expect(parseRemoteUrl(url)).toBeNull()
  })

  it('strips credentials from displayable URLs', () => {
    expect(sanitizeRemoteUrl('https://ghp_x@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git'
    )
    expect(sanitizeRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
  })
})

describe('classifyPushFailure', () => {
  it.each([
    ['! [rejected]        main -> main (non-fast-forward)', 'non-fast-forward'],
    ['hint: Updates were rejected because the remote contains work', 'non-fast-forward'],
    ['! [rejected] main -> main (fetch first)', 'non-fast-forward'],
    ['remote: error: GH006: Protected branch update failed', 'protected-branch'],
    ['remote: error: protected branch hook declined', 'protected-branch'],
    ["fatal: Authentication failed for 'https://github.com/o/r.git/'", 'auth'],
    [
      'fatal: could not read Username for https://github.com: terminal prompts disabled',
      'auth'
    ],
    ['git@github.com: Permission denied (publickey).', 'auth'],
    ['remote: Repository not found.', 'auth'],
    [
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      'network'
    ],
    ['ssh: connect to host github.com port 22: Connection timed out', 'network'],
    ['fatal: No configured push destination.', 'no-remote'],
    ["fatal: 'origin' does not appear to be a git repository", 'no-remote'],
    ['something unexpected', 'unknown']
  ])('%s → %s', (stderr, kind) => {
    expect(classifyPushFailure(stderr)).toBe(kind)
  })
})

// ── real repositories ─────────────────────────────────────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-git-'))
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }))

let counter = 0
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

const write = (cwd: string, file: string, content: string) => {
  const full = path.join(cwd, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

const initRepo = (name = `repo${++counter}`) => {
  const dir = path.join(sandbox, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  return dir
}

/** A repo with one commit and a bare "origin" it has been pushed to. */
const withRemote = () => {
  const dir = initRepo()
  write(dir, 'README.md', '# hi\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  const bare = path.join(sandbox, `bare${counter}.git`)
  git(sandbox, 'init', '-q', '--bare', '-b', 'main', bare)
  git(dir, 'remote', 'add', 'origin', bare)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  return { dir, bare }
}

describe('GitClient', () => {
  let dir: string
  let client: GitClient

  beforeEach(() => {
    dir = initRepo()
    write(dir, 'a.txt', 'a\n')
    write(dir, 'b.txt', 'b\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first commit')
    client = new GitClient(dir)
  })

  it('knows whether it is in a repository and where the root is', async () => {
    expect(await client.available()).toBe(true)
    expect(await client.isRepo()).toBe(true)
    expect(path.normalize(await client.root()).toLowerCase()).toBe(
      path.normalize(dir).toLowerCase().replace(/\\$/, '')
    )
    expect(await new GitClient(os.tmpdir()).isRepo()).toBe(false)
  })

  it('reports head, branch and subject — and a detached head as no branch', async () => {
    const head = await client.head()
    expect(head).toMatchObject({ branch: 'main', subject: 'first commit' })
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(head.shortSha).toBe(head.sha.slice(0, 7))
    git(dir, 'checkout', '-q', '--detach')
    expect((await client.head()).branch).toBeNull()
  })

  it('detects a repository with no commits', async () => {
    const empty = initRepo()
    expect(await new GitClient(empty).hasCommits()).toBe(false)
    expect(await client.hasCommits()).toBe(true)
  })

  it('lists dirty paths: modified, untracked, deleted, renamed, odd names', async () => {
    write(dir, 'a.txt', 'changed\n')
    write(dir, 'new file ü.txt', 'x\n')
    write(dir, 'sub/dir/deep.txt', 'x\n')
    fs.rmSync(path.join(dir, 'b.txt'))
    const dirty = await client.dirtyPaths()
    expect(dirty).toEqual(
      new Set(['a.txt', 'new file ü.txt', 'sub/dir/deep.txt', 'b.txt'])
    )
    git(dir, 'add', '-A')
    git(dir, 'mv', 'a.txt', 'renamed.txt')
    const afterRename = await client.dirtyPaths()
    expect(afterRename.has('renamed.txt')).toBe(true)
    expect(afterRename.has('a.txt')).toBe(true)
  })

  it('reports a clean tree as clean', async () => {
    expect((await client.dirtyPaths()).size).toBe(0)
  })

  it('knows which paths .gitignore excludes (but never a tracked file)', async () => {
    write(dir, '.gitignore', '.env\ndist/\n*.log\n')
    git(dir, 'add', '.gitignore')
    git(dir, 'commit', '-q', '-m', 'ignore')
    write(dir, 'forced.log', 'tracked anyway\n')
    git(dir, 'add', '-f', 'forced.log')
    git(dir, 'commit', '-q', '-m', 'force')
    expect(await client.isIgnored('.env')).toBe(true)
    expect(await client.isIgnored('dist/bundle.js')).toBe(true)
    expect(await client.isIgnored('server.log')).toBe(true)
    expect(await client.isIgnored('src/app.ts')).toBe(false)
    expect(await client.isIgnored('forced.log')).toBe(false)
    expect(await client.isIgnored('--weird')).toBe(false)
  })

  describe('commitPaths', () => {
    it('commits only the requested paths, leaving other changes (even staged ones) untouched', async () => {
      write(dir, 'a.txt', 'for codegent\n')
      write(dir, 'mine.txt', 'the user is working on this\n')
      write(dir, 'staged.txt', 'staged by the user\n')
      git(dir, 'add', 'staged.txt')

      const result = await client.commitPaths(['a.txt'], 'codegent: change a')

      expect(result.committed).toBe(true)
      expect(result.paths).toEqual(['a.txt'])
      expect(git(dir, 'show', '--name-only', '--format=%s', 'HEAD').split('\n')).toEqual([
        'codegent: change a',
        '',
        'a.txt'
      ])
      expect(git(dir, 'status', '--porcelain').split('\n').sort()).toEqual([
        '?? mine.txt',
        'A  staged.txt'
      ])
    })

    it('commits new files, deletions and renames', async () => {
      write(dir, 'created.txt', 'x\n')
      fs.rmSync(path.join(dir, 'b.txt'))
      git(dir, 'mv', 'a.txt', 'moved.txt')
      const result = await client.commitPaths(
        ['created.txt', 'b.txt', 'a.txt', 'moved.txt'],
        'multi'
      )
      expect(result.committed).toBe(true)
      expect(git(dir, 'status', '--porcelain')).toBe('')
      expect(git(dir, 'ls-files').split('\n').sort()).toEqual([
        'created.txt',
        'moved.txt'
      ])
    })

    it('returns committed:false when there is nothing to commit', async () => {
      expect(await client.commitPaths(['a.txt'], 'noop')).toEqual({ committed: false })
      expect(await client.commitPaths([], 'noop')).toEqual({ committed: false })
    })

    it('ignores paths that do not exist and were never tracked (e.g. created then deleted)', async () => {
      write(dir, 'a.txt', 'changed\n')
      const result = await client.commitPaths(['ghost.txt', 'a.txt'], 'ghost')
      expect(result.paths).toEqual(['a.txt'])
    })

    it('handles paths with spaces, dashes and unicode', async () => {
      write(dir, '--weird name.txt', 'x\n')
      write(dir, 'dossier é/ü file.md', 'x\n')
      const result = await client.commitPaths(
        ['--weird name.txt', 'dossier é/ü file.md'],
        'odd names'
      )
      expect(result.committed).toBe(true)
      expect(git(dir, 'status', '--porcelain')).toBe('')
    })

    it('does not run commit hooks by default', async () => {
      const hook = path.join(dir, '.git', 'hooks', 'pre-commit')
      fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      write(dir, 'a.txt', 'x\n')
      expect((await client.commitPaths(['a.txt'], 'skips hook')).committed).toBe(true)
    })

    it('surfaces a failing commit as an error', async () => {
      const hook = path.join(dir, '.git', 'hooks', 'pre-commit')
      fs.writeFileSync(hook, '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 })
      write(dir, 'a.txt', 'x\n')
      await expect(
        client.commitPaths(['a.txt'], 'with hook', { noVerify: false })
      ).rejects.toBeInstanceOf(GitError)
    })
  })
})

describe('pushing and syncing', () => {
  it('pushes the branch, sets the upstream, and reports ahead/behind', async () => {
    const { dir, bare } = withRemote()
    const client = new GitClient(dir)
    expect(await client.upstream()).toEqual({ ref: 'origin/main', ahead: 0, behind: 0 })

    write(dir, 'x.txt', 'x\n')
    await client.commitPaths(['x.txt'], 'add x')
    expect(await client.upstream()).toEqual({ ref: 'origin/main', ahead: 1, behind: 0 })

    expect(await client.push()).toEqual({ branch: 'main', remote: 'origin' })
    expect(await client.upstream()).toEqual({ ref: 'origin/main', ahead: 0, behind: 0 })
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('add x')
  })

  it('sets the upstream on the first push of a new branch', async () => {
    const { dir } = withRemote()
    const client = new GitClient(dir)
    git(dir, 'checkout', '-q', '-b', 'feature/x')
    write(dir, 'f.txt', 'f\n')
    await client.commitPaths(['f.txt'], 'feature')
    expect(await client.upstream()).toBeNull()
    expect(await client.push()).toEqual({ branch: 'feature/x', remote: 'origin' })
    expect((await client.upstream())?.ref).toBe('origin/feature/x')
  })

  it('classifies a non-fast-forward rejection and reports behind after a fetch', async () => {
    const { dir, bare } = withRemote()
    const client = new GitClient(dir)

    // somebody else pushes first
    const other = path.join(sandbox, `other${counter}`)
    git(sandbox, 'clone', '-q', bare, other)
    git(other, 'config', 'user.email', 'o@example.com')
    git(other, 'config', 'user.name', 'Other')
    write(other, 'theirs.txt', 't\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'theirs')
    git(other, 'push', '-q')

    write(dir, 'mine.txt', 'm\n')
    await client.commitPaths(['mine.txt'], 'mine')
    expect(await client.fetch()).toBe(true)
    expect(await client.upstream()).toEqual({ ref: 'origin/main', ahead: 1, behind: 1 })

    const failure = await client.push().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(GitError)
    expect((failure as GitError).kind).toBe('non-fast-forward')
  })

  it('fails clearly without a remote, and on a detached head', async () => {
    const dir = initRepo()
    write(dir, 'a.txt', 'a\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'c')
    const client = new GitClient(dir)
    expect(await client.remote()).toBeNull()
    await expect(client.push()).rejects.toMatchObject({ kind: 'no-remote' })
    git(dir, 'checkout', '-q', '--detach')
    await expect(client.push()).rejects.toMatchObject({ kind: 'detached-head' })
  })

  it('identifies the hosted repository from origin, never leaking embedded credentials', async () => {
    const dir = initRepo()
    git(dir, 'remote', 'add', 'upstream', 'https://github.com/other/fork.git')
    git(
      dir,
      'remote',
      'add',
      'origin',
      'https://ghp_TOKEN123@github.com/octo/project.git'
    )
    const remote = await new GitClient(dir).remote()
    expect(remote).toMatchObject({
      name: 'origin',
      owner: 'octo',
      repo: 'project',
      host: 'github.com'
    })
    expect(remote!.url).toBe('https://github.com/octo/project.git')
    expect(JSON.stringify(remote)).not.toMatch(/TOKEN123/)
  })

  it('has no GitHub identity for a local remote', async () => {
    const { dir } = withRemote()
    expect(await new GitClient(dir).remote()).toBeNull()
  })
})
