import { applyHunks, conformContent } from './apply'
import { normalizeRepoPath } from './paths'
import { findPlaceholder } from './placeholders'
import type { ChangeSet, EditError, EditOutcome, FileChange, FileEdit } from './types'

/** Thrown by a {@link WorkspaceView} when a file is not text. */
export class BinaryFileError extends Error {
  constructor(message = 'binary file') {
    super(message)
    this.name = 'BinaryFileError'
  }
}

/** Read-only access to the workspace; all the planner needs to know about the outside world. */
export interface WorkspaceView {
  /** File text, or null when it does not exist. Throw {@link BinaryFileError} for binary files. */
  read(path: string): Promise<string | null>
  /** Whether the file has uncommitted local changes. */
  isDirty(path: string): Promise<boolean>
  /** The real casing of an existing path on case-insensitive file systems, if different. */
  canonicalCase?(path: string): Promise<string | undefined>
  /** Whether git ignores the path (so ChatGPT cannot see it and it would never be committed). */
  isIgnored?(path: string): Promise<boolean>
}

export interface PlanOptions {
  workspaceRoot?: string
  /** Allow editing files that have uncommitted local changes. */
  allowDirty?: boolean
}

/** A whole-file replacement that shrinks a sizeable file this much is almost certainly a mistake. */
const SHRINK_GUARD_MIN_CHARS = 400
const SHRINK_GUARD_RATIO = 0.2

/**
 * Resolves parsed edits against the workspace in memory — nothing is written. Edits run in
 * order and see each other's results. Each edit is atomic; a failed edit leaves its file as it
 * was and is reported with enough detail for the author to correct it.
 */
export const planChanges = async (
  edits: readonly FileEdit[],
  view: WorkspaceView,
  options: PlanOptions = {}
): Promise<ChangeSet> => {
  const originals = new Map<string, string | null>()
  const overlay = new Map<string, string | null>()
  const dirty = new Map<string, boolean>()
  const renamedFrom = new Map<string, string>()
  const touched: string[] = []

  const original = async (path: string): Promise<string | null> => {
    if (!originals.has(path)) originals.set(path, await view.read(path))
    return originals.get(path) ?? null
  }
  const current = async (path: string): Promise<string | null> => {
    if (overlay.has(path)) return overlay.get(path) ?? null
    return original(path)
  }
  const write = async (path: string, content: string | null): Promise<void> => {
    await original(path) // remember what was there before the first change
    if (!touched.includes(path)) touched.push(path)
    overlay.set(path, content)
  }
  const isDirty = async (path: string): Promise<boolean> => {
    if (!dirty.has(path)) dirty.set(path, await view.isDirty(path))
    return dirty.get(path)!
  }
  const resolve = async (raw: string) => {
    const normalized = normalizeRepoPath(raw, { workspaceRoot: options.workspaceRoot })
    if (!normalized.ok) return normalized
    const canonical = await view.canonicalCase?.(normalized.path)
    const path = canonical ?? normalized.path
    if (await view.isIgnored?.(path)) {
      return {
        ok: false as const,
        reason:
          'it is ignored by git (.gitignore), so ChatGPT cannot see it and it would never be committed'
      }
    }
    return { ok: true as const, path }
  }

  const failure = (
    edit: FileEdit,
    path: string,
    errors: EditError[],
    notes: string[] = []
  ): EditOutcome => ({
    edit,
    path,
    status: 'failed',
    detail: errors[0]?.message ?? 'failed',
    errors,
    notes
  })
  const success = (
    edit: FileEdit,
    path: string,
    detail: string,
    notes: string[] = []
  ): EditOutcome => ({
    edit,
    path,
    status: 'applied',
    detail,
    errors: [],
    notes
  })
  const skipped = (edit: FileEdit, path: string, detail: string): EditOutcome => ({
    edit,
    path,
    status: 'skipped',
    detail,
    errors: [],
    notes: []
  })

  /** Reads a file, turning "binary" into an ordinary edit error. */
  const readText = async (
    path: string
  ): Promise<{ ok: true; text: string | null } | { ok: false; error: EditError }> => {
    try {
      return { ok: true, text: await current(path) }
    } catch (error) {
      if (error instanceof BinaryFileError) {
        return {
          ok: false,
          error: {
            code: 'binary-file',
            message: `\`${path}\` is a binary file and cannot be edited as text.`
          }
        }
      }
      throw error
    }
  }

  /** The "never touch files the model could not have seen" rule. */
  const dirtyError = async (path: string): Promise<EditError | undefined> => {
    if (options.allowDirty) return undefined
    // A file this same reply already changed is our own work, not the user's.
    if (overlay.has(path)) return undefined
    if ((await original(path)) === null) return undefined // nothing on disk to protect
    return (await isDirty(path))
      ? {
          code: 'dirty-file',
          message: `\`${path}\` has uncommitted local changes, so it was left alone (ChatGPT cannot see them). Commit or stash them, then ask for the change again.`
        }
      : undefined
  }

  const replaceExisting = async (
    edit: FileEdit,
    path: string,
    before: string,
    content: string,
    notes: string[]
  ): Promise<EditOutcome> => {
    const after = conformContent(content, before)
    if (after === before)
      return skipped(edit, path, 'no change (the file already has this content)')
    const placeholder = findPlaceholder(after.split(/\r?\n/), before.split(/\r?\n/))
    if (placeholder !== undefined) {
      return failure(edit, path, [
        {
          code: 'conflict',
          message: `The replacement for \`${path}\` contains a placeholder line (“${placeholder.trim()}”) instead of the real code. Whole-file replacements must contain every line of the file.`
        }
      ])
    }
    if (
      before.length >= SHRINK_GUARD_MIN_CHARS &&
      after.length < before.length * SHRINK_GUARD_RATIO
    ) {
      return failure(edit, path, [
        {
          code: 'conflict',
          message: `The replacement for \`${path}\` is far shorter than the file (${after.length} vs ${before.length} characters). Whole-file replacements must contain the complete file; otherwise use SEARCH/REPLACE blocks.`
        }
      ])
    }
    await write(path, after)
    return success(edit, path, 'replaced the whole file', notes)
  }

  const outcomes: EditOutcome[] = []

  for (const edit of edits) {
    switch (edit.kind) {
      case 'update': {
        const resolved = await resolve(edit.path)
        if (!resolved.ok) {
          outcomes.push(
            failure(edit, edit.path, [
              {
                code: 'path',
                message: `Invalid path \`${edit.path}\`: ${resolved.reason}.`
              }
            ])
          )
          break
        }
        const { path } = resolved
        const read = await readText(path)
        if (!read.ok) {
          outcomes.push(failure(edit, path, [read.error]))
          break
        }
        if (read.text === null) {
          outcomes.push(
            failure(edit, path, [
              {
                code: 'missing-file',
                message: `\`${path}\` does not exist. To add a new file use “Created file” with its full content.`
              }
            ])
          )
          break
        }
        const blocked = await dirtyError(path)
        if (blocked) {
          outcomes.push(failure(edit, path, [blocked]))
          break
        }
        const result = applyHunks(read.text, edit.hunks)
        if (!result.ok) {
          const errors = result.hunks.flatMap((hunk) => (hunk.error ? [hunk.error] : []))
          outcomes.push(failure(edit, path, errors))
          break
        }
        if (result.content === read.text) {
          outcomes.push(
            skipped(edit, path, 'no change (the replacement equals the original text)')
          )
          break
        }
        await write(path, result.content)
        const notes = result.hunks.flatMap((hunk) =>
          hunk.note ? [`hunk ${hunk.index}: ${hunk.note}`] : []
        )
        outcomes.push(
          success(
            edit,
            path,
            `${edit.hunks.length} ${edit.hunks.length === 1 ? 'hunk' : 'hunks'}`,
            notes
          )
        )
        break
      }

      case 'replace':
      case 'create': {
        const resolved = await resolve(edit.path)
        if (!resolved.ok) {
          outcomes.push(
            failure(edit, edit.path, [
              {
                code: 'path',
                message: `Invalid path \`${edit.path}\`: ${resolved.reason}.`
              }
            ])
          )
          break
        }
        const { path } = resolved
        const read = await readText(path)
        if (!read.ok) {
          outcomes.push(failure(edit, path, [read.error]))
          break
        }
        if (read.text === null) {
          const content = conformContent(edit.content, null)
          await write(path, content)
          outcomes.push(
            success(
              edit,
              path,
              'created',
              edit.kind === 'replace' ? ['the file did not exist, so it was created'] : []
            )
          )
          break
        }
        const blocked = await dirtyError(path)
        if (blocked) {
          outcomes.push(failure(edit, path, [blocked]))
          break
        }
        outcomes.push(
          await replaceExisting(
            edit,
            path,
            read.text,
            edit.content,
            edit.kind === 'create'
              ? ['the file already existed; its content was replaced']
              : []
          )
        )
        break
      }

      case 'delete': {
        const resolved = await resolve(edit.path)
        if (!resolved.ok) {
          outcomes.push(
            failure(edit, edit.path, [
              {
                code: 'path',
                message: `Invalid path \`${edit.path}\`: ${resolved.reason}.`
              }
            ])
          )
          break
        }
        const { path } = resolved
        const read = await readText(path)
        if (!read.ok) {
          outcomes.push(failure(edit, path, [read.error]))
          break
        }
        if (read.text === null) {
          outcomes.push(skipped(edit, path, 'already absent'))
          break
        }
        const blocked = await dirtyError(path)
        if (blocked) {
          outcomes.push(failure(edit, path, [blocked]))
          break
        }
        await write(path, null)
        outcomes.push(success(edit, path, 'deleted'))
        break
      }

      case 'rename': {
        const [from, to] = await Promise.all([resolve(edit.from), resolve(edit.to)])
        if (!from.ok || !to.ok) {
          const reason = !from.ok ? from.reason : !to.ok ? to.reason : ''
          outcomes.push(
            failure(edit, edit.to, [
              { code: 'path', message: `Invalid rename path: ${reason}.` }
            ])
          )
          break
        }
        const source = await readText(from.path)
        if (!source.ok) {
          outcomes.push(failure(edit, to.path, [source.error]))
          break
        }
        if (source.text === null) {
          outcomes.push(
            failure(edit, to.path, [
              {
                code: 'missing-file',
                message: `Cannot rename \`${from.path}\`: it does not exist.`
              }
            ])
          )
          break
        }
        if (from.path === to.path) {
          outcomes.push(skipped(edit, to.path, 'source and destination are the same'))
          break
        }
        const destination = await current(to.path)
        if (destination !== null) {
          outcomes.push(
            failure(edit, to.path, [
              {
                code: 'exists',
                message: `Cannot rename to \`${to.path}\`: a file with that name already exists.`
              }
            ])
          )
          break
        }
        const blocked = await dirtyError(from.path)
        if (blocked) {
          outcomes.push(failure(edit, to.path, [blocked]))
          break
        }
        let content = source.text
        const notes: string[] = []
        if (edit.hunks.length > 0) {
          const result = applyHunks(content, edit.hunks)
          if (!result.ok) {
            outcomes.push(
              failure(
                edit,
                to.path,
                result.hunks.flatMap((hunk) => (hunk.error ? [hunk.error] : []))
              )
            )
            break
          }
          content = result.content
          notes.push(
            ...result.hunks.flatMap((hunk) =>
              hunk.note ? [`hunk ${hunk.index}: ${hunk.note}`] : []
            )
          )
        }
        await write(to.path, content)
        await write(from.path, null)
        renamedFrom.set(to.path, renamedFrom.get(from.path) ?? from.path)
        renamedFrom.delete(from.path)
        outcomes.push(success(edit, to.path, `renamed from \`${from.path}\``, notes))
        break
      }
    }
  }

  // Net effect per path, with create+delete pairs collapsed into renames.
  const changes: FileChange[] = []
  const covered = new Set<string>()
  for (const [to, from] of renamedFrom) {
    const before = originals.get(from)
    const after = overlay.get(to)
    if (
      typeof before === 'string' &&
      typeof after === 'string' &&
      overlay.get(from) === null
    ) {
      changes.push({ kind: 'rename', from, to, before, after })
      covered.add(from)
      covered.add(to)
    }
  }
  for (const path of touched) {
    if (covered.has(path)) continue
    const before = originals.get(path) ?? null
    const after = overlay.get(path) ?? null
    if (before === null && after !== null) changes.push({ kind: 'create', path, after })
    else if (before !== null && after === null)
      changes.push({ kind: 'delete', path, before })
    else if (before !== null && after !== null && before !== after)
      changes.push({ kind: 'modify', path, before, after })
  }

  return { outcomes, changes }
}
