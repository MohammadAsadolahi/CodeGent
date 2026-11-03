import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
    const files = names.split('\0').filter(Boolean)
    await this.assertNoSubmodules(headSha, sha, files)
    const summary = (
      await this.git(['diff', '--shortstat', 'HEAD', sha, '--', '.'])
    ).trim()
    return { sha, headSha, files, summary }
  }

  /**
   * A plain git apply reports success for gitlink changes without actually
   * checking out a submodule. Fail explicitly rather than claim a false restore.
   */
  private async assertNoSubmodules(
    headSha: string,
    targetSha: string,
    paths: readonly string[]
  ): Promise<void> {
    if (paths.length === 0) return
    for (const sha of [headSha, targetSha]) {
      const entries = await this.git(['ls-tree', '-r', '-z', sha, '--', ...paths])
      const submodule = entries
        .split('\0')
        .find((entry) => entry.startsWith('160000 commit '))
      if (submodule) {
        const name = submodule.split('\t').slice(1).join('\t')
        throw new Error(
          'Time Travel cannot safely restore submodule pointer ' +
            name +
            '. Submodule checkouts require separate git operations.'
        )
      }
    }
  }

  /**
   * Git status and git diff can hide modified files marked assume-unchanged or
   * skip-worktree. Never run a restore through one of those paths.
   */
  private async assertVisiblePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const listing = await this.git(['ls-files', '-v', '-z', '--', ...paths])
    const hidden = listing
      .split('\0')
      .filter((entry) => entry.length > 2 && entry[0] !== 'H')
      .map((entry) => entry.slice(2))
    if (hidden.length > 0)
      throw new Error(
        'Git is hiding changes to ' +
          hidden.slice(0, 3).join(', ') +
          ' (assume-unchanged or skip-worktree). Clear those index flags before using Time Travel.'
      )
  }

  private async patchFile(
    headSha: string,
    targetSha: string
  ): Promise<{
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
    await this.assertVisiblePaths(preview.files)
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

  /** Full file check including paths Git considers untracked after a historical restore. */
  private async matchesCheckpoint(
    targetSha: string,
    paths: readonly string[]
  ): Promise<boolean> {
    const output = await this.git(['ls-tree', '-r', '-z', targetSha, '--', ...paths])
    const expected = new Map<string, { mode: string; sha: string }>()
    for (const entry of output.split('\0')) {
      if (!entry) continue
      const tab = entry.indexOf('\t')
      if (tab < 0) throw new Error('Invalid Git tree entry.')
      const [mode, , sha] = entry.slice(0, tab).split(' ')
      if (!mode || !sha) throw new Error('Invalid Git tree entry.')
      expected.set(entry.slice(tab + 1), { mode, sha })
    }
    const absolute = (relative: string) => path.join(this.root, ...relative.split('/'))
    const statOf = async (relative: string) => {
      try {
        return await fs.lstat(absolute(relative))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw error
      }
    }
    // A file-to-directory transition can leave extra untracked nested files.
    // Validate the complete directory before an inverse patch could remove it.
    const matchesDirectory = async (relative: string): Promise<boolean> => {
      const prefix = relative + '/'
      const children = new Set(
        [...expected.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length).split('/')[0]!)
      )
      const actual = await fs.readdir(absolute(relative))
      if (actual.length !== children.size || actual.some((name) => !children.has(name)))
        return false
      for (const child of children) {
        const nested = prefix + child
        if (!expected.has(nested)) {
          const stat = await statOf(nested)
          if (!stat?.isDirectory() || !(await matchesDirectory(nested))) return false
        }
      }
      return true
    }

    for (const relative of paths) {
      const wanted = expected.get(relative)
      const state = await statOf(relative)
      if (!wanted) {
        const wasDirectory = [...expected.keys()].some((name) =>
          name.startsWith(relative + '/')
        )
        if (wasDirectory) {
          if (!state?.isDirectory() || !(await matchesDirectory(relative))) return false
        } else if (state) {
          return false
        }
        continue
      }
      if (!state) return false
      if (wanted.mode === '120000') {
        if (!state.isSymbolicLink()) return false
        const contents = Buffer.from(await fs.readlink(absolute(relative)))
        const actual = createHash('sha1')
          .update('blob ' + contents.length + '\0')
          .update(contents)
          .digest('hex')
        if (actual !== wanted.sha) return false
      } else if (wanted.mode === '100644' || wanted.mode === '100755') {
        if (!state.isFile()) return false
        const actual = (
          await this.git(['hash-object', '--path=' + relative, '--', relative])
        ).trim()
        if (actual !== wanted.sha) return false
        if (
          process.platform !== 'win32' &&
          ((state.mode & 0o111) !== 0) !== (wanted.mode === '100755')
        )
          return false
      } else {
        return false
      }
    }
    return true
  }

  /** Reverses only the restore patch, refusing conflicts with later edits. */
  async undo(marker: RestoreMarker): Promise<void> {
    if (
      marker.root !== this.root ||
      !COMMIT_SHA.test(marker.targetSha) ||
      !COMMIT_SHA.test(marker.headSha)
    )
      throw new Error('This restore belongs to a different repository.')
    const preview = await this.preview(marker.targetSha)
    if (preview.headSha !== marker.headSha)
      throw new Error('HEAD changed since the restore; the undo is no longer safe.')
    if (this.hasUnsavedEditors())
      throw new Error(
        'Save or discard unsaved editor changes before undoing the restore.'
      )
    const staged = await this.runner(
      ['diff', '--cached', '--quiet', 'HEAD', '--', ...preview.files],
      { cwd: this.root }
    )
    if (staged.code !== 0)
      throw new Error(
        'The index has staged changes to restored files; undo cannot safely proceed.'
      )

    await this.assertVisiblePaths(preview.files)
    // Reversing a patch is not a full-file equality test: if the user edits lines
    // outside its context, git apply --reverse can succeed but silently leave
    // those later edits in place. Undo only when every affected file exactly
    // matches the selected checkpoint (unrelated paths may remain dirty).
    if (!(await this.matchesCheckpoint(marker.targetSha, preview.files)))
      throw new Error(
        'Files affected by this restore have changed since Time Travel. Undo was cancelled without changing any files.'
      )
    await this.applyPatch(marker.headSha, marker.targetSha, true)
  }
}
