import { execFile } from 'node:child_process'
import { parseRemoteUrl, type RemoteIdentity } from './remote-url'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export type GitRunner = (
  args: string[],
  options: { cwd: string; timeoutMs?: number }
) => Promise<GitResult>

/**
 * Runs the real `git` binary: no shell, English messages, and never an interactive prompt —
 * a background run has nobody to answer one, so missing credentials must fail fast and clearly.
 */
export const execGit: GitRunner = (args, { cwd, timeoutMs = 60_000 }) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          LC_ALL: 'C',
          LANG: 'C'
        }
      },
      (error, stdout, stderr) => {
        const exit = (error as NodeJS.ErrnoException | null)?.code
        const code =
          error === null ? 0 : typeof exit === 'number' ? exit : (error as { killed?: boolean }).killed ? 124 : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') })
      }
    )
  })

export type GitFailureKind =
  | 'auth'
  | 'non-fast-forward'
  | 'protected-branch'
  | 'network'
  | 'no-remote'
  | 'detached-head'
  | 'timeout'
  | 'unknown'

export class GitError extends Error {
  constructor(
    readonly kind: GitFailureKind,
    message: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export const classifyPushFailure = (stderr: string): GitFailureKind => {
  const text = stderr.toLowerCase()
  if (/gh006|protected branch|protected-branch|hook declined/.test(text)) return 'protected-branch'
  if (/non-fast-forward|fetch first|updates were rejected|tip of your current branch is behind/.test(text)) {
    return 'non-fast-forward'
  }
  if (
    /authentication failed|could not read username|could not read password|permission denied|invalid username|terminal prompts disabled|returned error: 40[13]|access denied|repository not found|interactive.*(disabled|never)/.test(
      text
    )
  ) {
    return 'auth'
  }
  if (
    /could not resolve host|unable to access|connection timed out|network is unreachable|connection refused|failed to connect|ssl/.test(
      text
    )
  ) {
    return 'network'
  }
  if (/no configured push destination|does not appear to be a git repository|no such remote|invalid remote/.test(text)) {
    return 'no-remote'
  }
  return 'unknown'
}

export interface HeadInfo {
  sha: string
  shortSha: string
  /** null when HEAD is detached. */
  branch: string | null
  subject: string
}

export interface UpstreamInfo {
  ref: string
  ahead: number
  behind: number
}

export interface StatusEntry {
  path: string
  /** Index and working-tree status letters from `git status --porcelain`. */
  x: string
  y: string
  /** For renames: the previous path. */
  from?: string
}

export interface CommitResult {
  committed: boolean
  sha?: string
  shortSha?: string
  /** The paths that went into the commit. */
  paths?: string[]
}

/** Remote URLs may embed credentials; only ever expose them without. */
export const sanitizeRemoteUrl = (url: string): string =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')

/** Thin, well-tested wrapper around the git commands CodeGent needs. */
export class GitClient {
  constructor(
    readonly cwd: string,
    private readonly run: GitRunner = execGit
  ) {}

  private git(args: string[], timeoutMs?: number): Promise<GitResult> {
    return this.run(args, { cwd: this.cwd, timeoutMs })
  }

  private async ok(args: string[], timeoutMs?: number): Promise<string> {
    const result = await this.git(args, timeoutMs)
    if (result.code !== 0) {
      throw new GitError('unknown', `git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    return result.stdout
  }

  /** Whether the `git` executable can be run at all. */
  async available(): Promise<boolean> {
    return (await this.git(['--version'])).code === 0
  }

  async isRepo(): Promise<boolean> {
    const result = await this.git(['rev-parse', '--is-inside-work-tree'])
    return result.code === 0 && result.stdout.trim() === 'true'
  }

  async root(): Promise<string> {
    return (await this.ok(['rev-parse', '--show-toplevel'])).trim()
  }

  /** The repository this clone came from, using `origin` when it exists. */
  async remote(): Promise<(RemoteIdentity & { name: string; url: string }) | null> {
    const listing = await this.git(['remote', '-v'])
    if (listing.code !== 0) return null
    const fetchRemotes = new Map<string, string>()
    for (const line of listing.stdout.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
      if (match) fetchRemotes.set(match[1]!, match[2]!)
    }
    const ordered = [...fetchRemotes.entries()].sort(([a], [b]) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0))
    for (const [name, url] of ordered) {
      const parsed = parseRemoteUrl(url)
      if (parsed) return { ...parsed, name, url: sanitizeRemoteUrl(url) }
    }
    return null
  }

  /** Whether the repository has any commit at all. */
  async hasCommits(): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
  }

  async head(): Promise<HeadInfo> {
    const sha = (await this.ok(['rev-parse', 'HEAD'])).trim()
    const branch = await this.git(['symbolic-ref', '--short', '-q', 'HEAD'])
    const subject = (await this.git(['log', '-1', '--format=%s'])).stdout.trim()
    return {
      sha,
      shortSha: sha.slice(0, 7),
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      subject
    }
  }

  async upstream(): Promise<UpstreamInfo | null> {
    const ref = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (ref.code !== 0) return null
    const counts = await this.git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
    if (counts.code !== 0) return null
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number)
    return { ref: ref.stdout.trim(), ahead: ahead ?? 0, behind: behind ?? 0 }
  }

  /** Best-effort `git fetch`, so ahead/behind reflects what GitHub has now. */
  async fetch(timeoutMs = 30_000): Promise<boolean> {
    return (await this.git(['fetch', '--quiet', '--prune'], timeoutMs)).code === 0
  }

  /** Working-tree status, optionally limited to `paths`. */
  async status(paths: readonly string[] = []): Promise<StatusEntry[]> {
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
    if (paths.length > 0) args.push('--', ...paths)
    const parts = (await this.ok(args)).split('\0')
    const entries: StatusEntry[] = []
    for (let i = 0; i < parts.length; i++) {
      const record = parts[i]!
      if (record.length < 4) continue
      const x = record[0]!
      const y = record[1]!
      const path = record.slice(3)
      entries.push(x === 'R' || x === 'C' ? { path, x, y, from: parts[++i] } : { path, x, y })
    }
    return entries
  }

  /** Whether `.gitignore` rules exclude the path (a tracked file is never "ignored"). */
  async isIgnored(path: string): Promise<boolean> {
    return (await this.git(['check-ignore', '-q', '--', path])).code === 0
  }

  async dirtyPaths(): Promise<Set<string>> {
    const dirty = new Set<string>()
    for (const entry of await this.status()) {
      dirty.add(entry.path)
      if (entry.from) dirty.add(entry.from)
    }
    return dirty
  }

  /**
   * Commits exactly `paths` (new, modified, deleted) and nothing else — anything the user has
   * staged for other files stays staged. Returns `committed: false` when there is nothing to commit.
   */
  async commitPaths(
    paths: readonly string[],
    message: string,
    options: { noVerify?: boolean } = {}
  ): Promise<CommitResult> {
    // `git status` omits ignored files, so those can never slip into the commit.
    const changed = new Set<string>()
    const toStage = new Set<string>()
    for (const entry of await this.status(paths)) {
      changed.add(entry.path)
      if (entry.from) changed.add(entry.from) // rename source: already staged, nothing to add
      else if (!(entry.x === 'D' && entry.y === ' ')) toStage.add(entry.path) // staged deletion likewise
    }
    if (changed.size === 0) return { committed: false }
    const list = [...changed]
    if (toStage.size > 0) await this.ok(['add', '-A', '--', ...toStage])
    const args = ['commit', '-m', message]
    if (options.noVerify ?? true) args.push('--no-verify')
    const result = await this.git([...args, '--', ...list])
    if (result.code !== 0) {
      throw new GitError('unknown', `git commit failed: ${(result.stderr || result.stdout).trim()}`)
    }
    const head = await this.head()
    return { committed: true, sha: head.sha, shortSha: head.shortSha, paths: list }
  }

  /** Pushes the current branch (to its upstream's remote, else `origin`), setting the upstream if missing. */
  async push(timeoutMs = 120_000): Promise<{ branch: string; remote: string }> {
    const head = await this.head()
    if (!head.branch) throw new GitError('detached-head', 'HEAD is detached; check out a branch before pushing.')
    const upstream = await this.upstream()
    const remote = upstream?.ref.split('/')[0] ?? (await this.remote())?.name ?? 'origin'
    const result = await this.git(['push', '--set-upstream', remote, `HEAD:refs/heads/${head.branch}`], timeoutMs)
    if (result.code !== 0) {
      const kind = result.code === 124 ? 'timeout' : classifyPushFailure(result.stderr)
      throw new GitError(kind, `git push failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    return { branch: head.branch, remote }
  }
}
