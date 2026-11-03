import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execGit, type GitRunner } from '@codegent/engine'

export interface TimePoint {
  sha: string
  shortSha: string
  title: string
  timestamp: number
  current: boolean
}

export interface RestorePreview {
  sha: string
  headSha: string
  files: string[]
  summary: string
}

export interface RestoreMarker {
  root: string
  headSha: string
  targetSha: string
}

const MAX_PATCH_BYTES = 20 * 1024 * 1024
const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * Browse previous commits and restore their file trees without changing HEAD, the index,
 * branches or remotes. Git patches preserve additions, deletions, renames, binary files
 * and executable bits. Every restore can be reversed until the affected files change.
 */
export class TimeTravel {
  constructor(
    private readonly root: string,
    private readonly runner: GitRunner = execGit,
    private readonly hasUnsavedEditors: () => boolean = () => false
  ) {}

  private async git(args: string[]): Promise<string> {
    const result = await this.runner(args, { cwd: this.root })
    if (result.code !== 0)
      throw new Error(
        'git ' + args[0] + ' failed: ' + (result.stderr.trim() || result.stdout.trim())
      )
    return result.stdout
  }

  private async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim()
  }

  async points(): Promise<TimePoint[]> {
    const output = await this.git([
      'log',
      '--first-parent',
      '--max-count=30',
      '--format=%H%x00%ct%x00%s'
    ])
    return output
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        const [sha, seconds, ...title] = line.split('\0')
        if (!sha || !COMMIT_SHA.test(sha)) throw new Error('Invalid git log entry')
        return {
          sha,
          shortSha: sha.slice(0, 7),
          timestamp: Number(seconds) * 1000,
          title: title.join(' ').slice(0, 300),
          current: index === 0
        }
      })
  }

  async preview(sha: string): Promise<RestorePreview> {
    if (!COMMIT_SHA.test(sha)) throw new Error('Invalid checkpoint identifier.')
    const headSha = await this.head()
    const ancestor = await this.runner(['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd: this.root
    })
    if (ancestor.code !== 0)
      throw new Error('That checkpoint is not in the current branch history.')
    const names = await this.git([
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      'HEAD',
      sha,
      '--',
      '.'
    ])
    const summary = (
      await this.git(['diff', '--shortstat', 'HEAD', sha, '--', '.'])
    ).trim()
    return {
      sha,
      headSha,
      files: names.split('\0').filter(Boolean),
      summary
    }
  }

  private async patchFile(headSha: string, targetSha: string): Promise<{
    file: string
    cleanup: () => Promise<void>
  }> {
    const patch = await this.git([
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
      headSha,
      targetSha,
      '--',
      '.'
    ])
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES)
      throw new Error('The restore exceeds the 20 MB patch safety limit.')
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'codegent-travel-'))
    const file = path.join(folder, 'restore.patch')
    try {
      await fs.writeFile(file, patch, { mode: 0o600 })
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true })
      throw error
    }
    return {
      file,
      cleanup: () => fs.rm(folder, { recursive: true, force: true })
    }
  }

  private async applyPatch(
    headSha: string,
    targetSha: string,
    reverse: boolean
  ): Promise<void> {
    const patch = await this.patchFile(headSha, targetSha)
    try {
      const flags = ['apply', '--binary', '--whitespace=nowarn']
      if (reverse) flags.push('--reverse')
      // No --index or --cached: staging and commit history are never changed.
      await this.git([...flags, '--check', '--', patch.file])
      await this.git([...flags, '--', patch.file])
    } finally {
      await patch.cleanup()
    }
  }

  async restore(sha: string, expectedHead: string): Promise<RestoreMarker> {
    const preview = await this.preview(sha)
    if (preview.headSha !== expectedHead)
      throw new Error('HEAD changed since the preview. Refresh Time Travel first.')
    if (this.hasUnsavedEditors())
      throw new Error('Save or discard unsaved editor changes before restoring.')
    if (
      (await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
        .length > 0
    )
      throw new Error('Commit, stash, or discard all local changes before restoring.')
    if (preview.files.length === 0)
      throw new Error('This checkpoint already matches the working tree.')
    await this.applyPatch(preview.headSha, sha, false)
    return { root: this.root, headSha: preview.headSha, targetSha: sha }
  }

  /** Reverses only the restore patch, refusing conflicts with later edits. */
  async undo(marker: RestoreMarker): Promise<void> {
    if (marker.root !== this.root || !COMMIT_SHA.test(marker.targetSha))
      throw new Error('This restore belongs to a different repository.')
    if ((await this.head()) !== marker.headSha)
      throw new Error('HEAD changed since the restore; the undo is no longer safe.')
    if (this.hasUnsavedEditors())
      throw new Error('Save or discard unsaved editor changes before undoing the restore.')
    const staged = await this.runner(['diff', '--cached', '--quiet', 'HEAD'], {
      cwd: this.root
    })
    if (staged.code !== 0)
      throw new Error('The index has staged changes; undo cannot safely proceed.')
    await this.applyPatch(marker.headSha, marker.targetSha, true)
  }
}
