import { GitClient, type GitPort, type RepoContext } from '@codegent/engine'

export interface RepoOk {
  ok: true
  root: string
  host: string
  owner: string
  name: string
  webUrl: string
  remoteName: string
  branch: string
  sha: string
  shortSha: string
  subject: string
  upstream: { ref: string; ahead: number; behind: number } | null
  dirtyFiles: string[]
  dirtyCount: number
  /** Things worth telling the user before a run starts. */
  warnings: string[]
}

export type RepoProblem = 'no-git' | 'no-repo' | 'no-commits' | 'no-remote' | 'detached'

export interface RepoBad {
  ok: false
  problem: RepoProblem
  reason: string
}

export type RepoStatus = RepoOk | RepoBad

const MAX_LISTED_DIRTY = 30

export class RepoService {
  private readonly git: GitClient

  constructor(
    readonly folder: string,
    git?: GitClient
  ) {
    this.git = git ?? new GitClient(folder)
  }

  /** The git client for the folder, for adapters that need more than the status. */
  get client(): GitClient {
    return this.git
  }

  async status(options: { fetch?: boolean } = {}): Promise<RepoStatus> {
    if (!(await this.git.available())) {
      return { ok: false, problem: 'no-git', reason: 'Git was not found. Install git and make sure it is on your PATH.' }
    }
    if (!(await this.git.isRepo())) {
      return { ok: false, problem: 'no-repo', reason: 'This folder is not a git repository.' }
    }
    if (!(await this.git.hasCommits())) {
      return { ok: false, problem: 'no-commits', reason: 'The repository has no commits yet. Commit and push something first so ChatGPT has code to read.' }
    }
    const remote = await this.git.remote()
    if (!remote) {
      return {
        ok: false,
        problem: 'no-remote',
        reason: 'The repository has no GitHub remote. Add one (git remote add origin …) and push, so ChatGPT can read the code through its GitHub connector.'
      }
    }
    const head = await this.git.head()
    if (!head.branch) {
      return { ok: false, problem: 'detached', reason: 'HEAD is detached. Check out a branch first.' }
    }
    if (options.fetch) await this.git.fetch()
    const upstream = await this.git.upstream()
    const dirty = [...(await this.git.dirtyPaths())].sort()

    const warnings: string[] = []
    if (remote.host !== 'github.com') {
      warnings.push(`The remote is on ${remote.host}; ChatGPT's connector works with github.com repositories.`)
    }
    if (!upstream) {
      warnings.push(`Branch "${head.branch}" is not on GitHub yet. It will be pushed with the first step; until then ChatGPT cannot read it.`)
    } else {
      if (upstream.behind > 0) {
        warnings.push(`GitHub has ${upstream.behind} commit${upstream.behind === 1 ? '' : 's'} you do not have locally. Pull first — ChatGPT reads GitHub, so its changes would not match your files.`)
      }
      if (upstream.ahead > 0) {
        warnings.push(`${upstream.ahead} local commit${upstream.ahead === 1 ? ' is' : 's are'} not pushed, so ChatGPT cannot see ${upstream.ahead === 1 ? 'it' : 'them'} yet. Push first.`)
      }
    }
    if (dirty.length > 0) {
      warnings.push(`${dirty.length} file${dirty.length === 1 ? ' has' : 's have'} uncommitted changes. ChatGPT cannot see them, and CodeGent will not edit those files.`)
    }

    return {
      ok: true,
      root: await this.git.root(),
      host: remote.host,
      owner: remote.owner,
      name: remote.repo,
      webUrl: remote.webUrl,
      remoteName: remote.name,
      branch: head.branch,
      sha: head.sha,
      shortSha: head.shortSha,
      subject: head.subject,
      upstream,
      dirtyFiles: dirty.slice(0, MAX_LISTED_DIRTY),
      dirtyCount: dirty.length,
      warnings
    }
  }

  /** Pushes the current branch (the repository card's "Push now"). */
  async pushNow(): Promise<{ branch: string; remote: string }> {
    return this.git.push()
  }

  /** The git side of an agent run. */
  gitPort(): GitPort {
    return {
      context: async (): Promise<RepoContext> => {
        const status = await this.status()
        if (!status.ok) throw new Error(status.reason)
        return {
          owner: status.owner,
          name: status.name,
          host: status.host,
          webUrl: status.webUrl,
          branch: status.branch,
          sha: status.sha,
          shortSha: status.shortSha,
          subject: status.subject
        }
      },
      commit: (paths, message) => this.git.commitPaths(paths, message),
      push: () => this.git.push()
    }
  }
}
