import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RepoService } from '../../src/workspace/repo-service'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-repo-'))
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }))

let counter = 0
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const write = (cwd: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
  fs.writeFileSync(path.join(cwd, file), content)
}
const newRepo = () => {
  const dir = path.join(sandbox, `r${++counter}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'core.autocrlf', 'false')
  return dir
}
const commit = (dir: string, file: string, content: string, message = 'c') => {
  write(dir, file, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

/** A repo whose fetch URL looks like GitHub but whose pushes go to a local bare repository. */
const githubLikeRepo = () => {
  const dir = newRepo()
  commit(dir, 'README.md', '# hi\n', 'initial')
  const bare = path.join(sandbox, `bare${counter}.git`)
  git(sandbox, 'init', '-q', '--bare', '-b', 'main', bare)
  git(dir, 'remote', 'add', 'origin', 'https://github.com/octo/project.git')
  git(dir, 'remote', 'set-url', '--push', 'origin', bare)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  return { dir, bare }
}

describe('RepoService.status', () => {
  it.each([
    [
      'a folder that is not a repository',
      () => fs.mkdtempSync(path.join(sandbox, 'plain-')),
      'no-repo'
    ],
    ['a repository without commits', () => newRepo(), 'no-commits'],
    [
      'a repository without a remote',
      () => {
        const dir = newRepo()
        commit(dir, 'a.txt', 'a\n')
        return dir
      },
      'no-remote'
    ],
    [
      'a repository whose only remote is a local path',
      () => {
        const dir = newRepo()
        commit(dir, 'a.txt', 'a\n')
        git(dir, 'remote', 'add', 'origin', path.join(sandbox, 'nowhere.git'))
        return dir
      },
      'no-remote'
    ],
    [
      'a detached head',
      () => {
        const { dir } = githubLikeRepo()
        git(dir, 'checkout', '-q', '--detach')
        return dir
      },
      'detached'
    ]
  ] as const)('explains %s', async (_name, make, problem) => {
    const status = await new RepoService(make()).status()
    expect(status).toMatchObject({ ok: false, problem })
    expect((status as { reason: string }).reason.length).toBeGreaterThan(10)
  })

  it('describes a healthy repository with no warnings', async () => {
    const { dir } = githubLikeRepo()
    const status = await new RepoService(dir).status()
    expect(status).toMatchObject({
      ok: true,
      host: 'github.com',
      owner: 'octo',
      name: 'project',
      webUrl: 'https://github.com/octo/project',
      branch: 'main',
      subject: 'initial',
      upstream: { ref: 'origin/main', ahead: 0, behind: 0 },
      dirtyCount: 0,
      warnings: []
    })
    if (status.ok) expect(status.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('warns about uncommitted changes, unpushed commits and a branch that is not on GitHub', async () => {
    const { dir } = githubLikeRepo()
    commit(dir, 'local.txt', 'y\n', 'local only')
    write(dir, 'wip.txt', 'x\n')
    write(dir, 'wip2.txt', 'x\n')
    const status = await new RepoService(dir).status()
    expect(status.ok && status.warnings.join('\n')).toMatch(
      /1 local commit is not pushed/
    )
    expect(status.ok && status.warnings.join('\n')).toMatch(
      /2 files have uncommitted changes/
    )
    expect(status.ok && status.dirtyFiles).toEqual(['wip.txt', 'wip2.txt'])

    git(dir, 'checkout', '-q', '-b', 'feature')
    const fresh = await new RepoService(dir).status()
    expect(fresh.ok && fresh.warnings.join('\n')).toMatch(
      /Branch "feature" is not on GitHub yet/
    )
  })

  it('warns when GitHub is ahead of the local branch', async () => {
    const { dir, bare } = githubLikeRepo()
    const other = path.join(sandbox, `other${counter}`)
    git(sandbox, 'clone', '-q', bare, other)
    git(other, 'config', 'user.email', 'o@example.com')
    git(other, 'config', 'user.name', 'O')
    commit(other, 'theirs.txt', 't\n', 'theirs')
    git(other, 'push', '-q')

    // Until something fetches, the local view of GitHub is out of date.
    expect((await new RepoService(dir).status()).ok && 'no warning yet').toBe(
      'no warning yet'
    )
    const stale = await new RepoService(dir).status()
    expect(stale.ok && stale.warnings).toEqual([])
    // The fake GitHub URL cannot be fetched from, so update the tracking ref from the bare repo.
    git(dir, 'fetch', '-q', bare, 'main:refs/remotes/origin/main')
    const fresh = await new RepoService(dir).status()
    expect(fresh.ok && fresh.warnings.join('\n')).toMatch(
      /GitHub has 1 commit you do not have locally/
    )
  })

  it('treats an unreachable remote as "no news" when asked to fetch', async () => {
    const { dir } = githubLikeRepo()
    git(dir, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/octo/project.git') // refuses connections
    const status = await new RepoService(dir).status({ fetch: true })
    expect(status).toMatchObject({ ok: true, name: 'project' })
  })

  it('warns about non-GitHub hosts', async () => {
    const dir = newRepo()
    commit(dir, 'a.txt', 'a\n')
    git(dir, 'remote', 'add', 'origin', 'https://gitlab.com/group/project.git')
    const status = await new RepoService(dir).status()
    expect(status.ok && status.warnings.join('\n')).toMatch(/gitlab\.com/)
  })

  it('caps the list of dirty files but keeps the count', async () => {
    const { dir } = githubLikeRepo()
    for (let i = 0; i < 45; i++)
      write(dir, `many/f${String(i).padStart(2, '0')}.txt`, 'x\n')
    const status = await new RepoService(dir).status()
    expect(status.ok && status.dirtyCount).toBe(45)
    expect(status.ok && status.dirtyFiles.length).toBe(30)
  })
})

describe('RepoService.gitPort', () => {
  it('provides the repository context for the agent', async () => {
    const { dir } = githubLikeRepo()
    const context = await new RepoService(dir).gitPort().context()
    expect(context).toMatchObject({
      owner: 'octo',
      name: 'project',
      host: 'github.com',
      branch: 'main',
      subject: 'initial'
    })
  })

  it('refuses a repository ChatGPT could not read', async () => {
    const dir = newRepo()
    commit(dir, 'a.txt', 'a\n')
    await expect(new RepoService(dir).gitPort().context()).rejects.toThrow(
      /no GitHub remote/
    )
  })

  it('commits and pushes through the port', async () => {
    const { dir, bare } = githubLikeRepo()
    const port = new RepoService(dir).gitPort()
    write(dir, 'new.txt', 'n\n')
    write(dir, 'untouched.txt', 'u\n')
    const committed = await port.commit(['new.txt'], 'codegent: add new')
    expect(committed).toMatchObject({ committed: true })
    expect(await port.push()).toEqual({ branch: 'main', remote: 'origin' })
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('codegent: add new')
    expect(git(dir, 'status', '--porcelain')).toBe('?? untouched.txt')
  })

  it('pushNow pushes the current branch', async () => {
    const { dir, bare } = githubLikeRepo()
    commit(dir, 'local.txt', 'l\n', 'local commit')
    await new RepoService(dir).pushNow()
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('local commit')
  })
})
