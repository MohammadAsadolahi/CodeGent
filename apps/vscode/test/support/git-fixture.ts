import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Runs git and returns its output without the trailing newline (leading spaces are kept: ` M file`). */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trimEnd()

export const write = (cwd: string, file: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
  fs.writeFileSync(path.join(cwd, file), content)
}

export interface GithubLikeRepo {
  dir: string
  bare: string
  /** The commit everything starts from. */
  base: string
  /** Throws away everything a test did: local commits, files, and what was pushed. */
  reset(): void
}

/** Wraps a repository made by `githubLikeRepo` (possibly in another process) for use in tests. */
export const attachRepo = (parent: string, name: string): GithubLikeRepo => {
  const dir = path.join(parent, name)
  const bare = path.join(parent, `${name}.git`)
  const base = git(dir, 'rev-list', '--max-parents=0', 'HEAD')
  return {
    dir,
    bare,
    base,
    reset: () => {
      git(dir, 'checkout', '-q', '-f', 'main')
      git(dir, 'reset', '-q', '--hard', base)
      git(dir, 'clean', '-fdq')
      git(dir, 'push', '-q', '--force', 'origin', 'main')
    }
  }
}

/**
 * A repository whose fetch URL looks like GitHub (`octo/project`) while pushes go to a local bare
 * repository, so the whole commit-and-push pipeline can run without a network.
 */
export const githubLikeRepo = (
  parent: string,
  name: string,
  files: Record<string, string>
): GithubLikeRepo => {
  const dir = path.join(parent, name)
  const bare = path.join(parent, `${name}.git`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'tester@example.com')
  git(dir, 'config', 'user.name', 'Tester')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'commit.gpgsign', 'false')
  for (const [file, content] of Object.entries(files)) write(dir, file, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  git(parent, 'init', '-q', '--bare', '-b', 'main', bare)
  git(dir, 'remote', 'add', 'origin', 'https://github.com/octo/project.git')
  git(dir, 'remote', 'set-url', '--push', 'origin', bare)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  return attachRepo(parent, name)
}
