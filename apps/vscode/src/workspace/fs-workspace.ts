import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BinaryFileError,
  type ApplyReceipt,
  type FileChange,
  type WorkspacePort,
  type WorkspaceView
} from '@codegent/engine'
import type { RepoService } from './repo-service'

export interface UndoResult {
  undone: string[]
  skipped: Array<{ path: string; reason: string }>
}

export interface FsWorkspaceOptions {
  /** The repository root; every path ChatGPT names is relative to it. */
  root: string
  repo: RepoService
  /** Whether an editor holds unsaved changes for this absolute path. */
  isBufferDirty?: (absolutePath: string) => boolean
  log?: (line: string) => void
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const MAX_TEXT_BYTES = 5 * 1024 * 1024
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

const hasBom = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf

const isInside = (root: string, candidate: string): boolean => {
  const a = CASE_INSENSITIVE ? root.toLowerCase() : root
  const b = CASE_INSENSITIVE ? candidate.toLowerCase() : candidate
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}

const pathsOf = (changes: readonly FileChange[]): string[] =>
  changes.map((change) => (change.kind === 'rename' ? change.to : change.path))

interface Receipt {
  changes: FileChange[]
  undone: boolean
}

/**
 * The files side of an agent run: reads for planning, all-or-nothing writes with rollback,
 * and undo. Plain Node `fs` — the same code works in a VS Code remote and in tests.
 */
export class FsWorkspace implements WorkspacePort {
  private readonly receipts = new Map<string, Receipt>()
  private counter = 0

  constructor(private readonly options: FsWorkspaceOptions) {}

  get root(): string {
    return this.options.root
  }

  private abs(relative: string): string {
    return path.join(this.options.root, ...relative.split('/'))
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────────
  private async readBytes(relative: string): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(this.abs(relative))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      if (code === 'EISDIR') throw new BinaryFileError('is a directory')
      throw error
    }
  }

  private decode(bytes: Uint8Array): string {
    if (bytes.length > MAX_TEXT_BYTES) throw new BinaryFileError('too large to edit')
    if (bytes.subarray(0, 8_000).includes(0)) throw new BinaryFileError('binary file')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new BinaryFileError('not UTF-8 text')
    }
  }

  readonly view: WorkspaceView = {
    read: async (relative) => {
      const bytes = await this.readBytes(relative)
      return bytes === null ? null : this.decode(bytes)
    },

    isDirty: async (relative) => {
      if (this.options.isBufferDirty?.(this.abs(relative))) return true
      return (await this.options.repo.client.status([relative])).length > 0
    },

    isIgnored: (relative) => this.options.repo.client.isIgnored(relative),

    // On case-insensitive file systems the model may spell a path differently from the file.
    canonicalCase: async (relative) => {
      if (!CASE_INSENSITIVE) return undefined
      const parts = relative.split('/')
      const out: string[] = []
      let current = this.options.root
      for (let i = 0; i < parts.length; i++) {
        const entries = await fs.readdir(current).catch(() => null)
        const wanted = parts[i]!
        const hit = entries?.includes(wanted)
          ? wanted
          : entries?.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
        if (!hit) {
          out.push(...parts.slice(i)) // the rest does not exist yet; keep it as written
          break
        }
        out.push(hit)
        current = path.join(current, hit)
      }
      const canonical = out.join('/')
      return canonical === relative ? undefined : canonical
    }
  }

  // ── writing ──────────────────────────────────────────────────────────────────────────────────
  /** Nothing may be written through a symlink or junction that leaves the repository. */
  private async assertInside(relative: string): Promise<void> {
    const rootReal = await fs.realpath(this.options.root)
    let probe = this.abs(relative)
    for (;;) {
      try {
        const real = await fs.realpath(probe)
        if (!isInside(rootReal, real))
          throw new Error(`\`${relative}\` resolves outside the repository`)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        const parent = path.dirname(probe)
        if (parent === probe) throw error
        probe = parent
      }
    }
  }

  private async writeAtomic(
    absolute: string,
    bytes: Uint8Array,
    mode?: number
  ): Promise<void> {
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const temp = `${absolute}.codegent-${process.pid}-${Date.now()}.tmp`
    try {
      await fs.writeFile(temp, bytes, mode === undefined ? undefined : { mode })
      let lastError: unknown
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fs.rename(temp, absolute)
          return
        } catch (error) {
          lastError = error
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
          await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
        }
      }
      // Something (an antivirus scan, an indexer) holds the target; fall back to writing in place.
      try {
        await fs.writeFile(absolute, bytes, mode === undefined ? undefined : { mode })
        await fs.rm(temp, { force: true })
        return
      } catch {
        throw lastError
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async modeOf(absolute: string): Promise<number | undefined> {
    if (process.platform === 'win32') return undefined
    try {
      return (await fs.stat(absolute)).mode & 0o777
    } catch {
      return undefined
    }
  }

  /** Reads the current bytes and insists they still equal what the plan was based on. */
  private async currentMatching(relative: string, expected: string): Promise<Uint8Array> {
    const bytes = await this.readBytes(relative)
    if (bytes === null)
      throw new Error(`\`${relative}\` disappeared while the change was being prepared`)
    if (this.decode(bytes) !== expected) {
      throw new Error(
        `\`${relative}\` was modified on disk while the change was being prepared; nothing was written`
      )
    }
    return bytes
  }

  private encode(text: string, bom: boolean): Uint8Array {
    const body = Buffer.from(text, 'utf8')
    return bom ? Buffer.concat([BOM, body]) : body
  }

  async apply(
    changes: readonly FileChange[],
    meta: { runId: string; step: number }
  ): Promise<ApplyReceipt> {
    const rollback: Array<() => Promise<void>> = []
    try {
      for (const change of changes) await this.applyOne(change, rollback)
    } catch (error) {
      for (const undo of rollback.reverse()) {
        try {
          await undo()
        } catch (rollbackError) {
          this.options.log?.(`rollback step failed: ${(rollbackError as Error).message}`)
        }
      }
      throw error
    }
    const id = `${meta.runId}:${meta.step}:${++this.counter}`
    this.receipts.set(id, { changes: [...changes], undone: false })
    return { id, paths: pathsOf(changes) }
  }

  private async applyOne(
    change: FileChange,
    rollback: Array<() => Promise<void>>
  ): Promise<void> {
    switch (change.kind) {
      case 'create': {
        const target = this.abs(change.path)
        await this.assertInside(change.path)
        if ((await this.readBytes(change.path).catch(() => new Uint8Array())) !== null) {
          throw new Error(`\`${change.path}\` already exists`)
        }
        await this.writeAtomic(target, this.encode(change.after, false))
        rollback.push(() => fs.rm(target, { force: true }))
        return
      }
      case 'modify': {
        const target = this.abs(change.path)
        await this.assertInside(change.path)
        const old = await this.currentMatching(change.path, change.before)
        const mode = await this.modeOf(target)
        await this.writeAtomic(target, this.encode(change.after, hasBom(old)), mode)
        rollback.push(() => this.writeAtomic(target, old, mode))
        return
      }
      case 'delete': {
        const target = this.abs(change.path)
        await this.assertInside(change.path)
        const old = await this.currentMatching(change.path, change.before)
        const mode = await this.modeOf(target)
        await fs.rm(target, { force: true })
        rollback.push(() => this.writeAtomic(target, old, mode))
        return
      }
      case 'rename': {
        const from = this.abs(change.from)
        const to = this.abs(change.to)
        await this.assertInside(change.from)
        await this.assertInside(change.to)
        const old = await this.currentMatching(change.from, change.before)
        if ((await this.readBytes(change.to).catch(() => new Uint8Array())) !== null) {
          throw new Error(`\`${change.to}\` already exists`)
        }
        const mode = await this.modeOf(from)
        await this.writeAtomic(to, this.encode(change.after, hasBom(old)), mode)
        rollback.push(() => fs.rm(to, { force: true }))
        await fs.rm(from, { force: true })
        rollback.push(() => this.writeAtomic(from, old, mode))
        return
      }
    }
  }

  // ── undo ─────────────────────────────────────────────────────────────────────────────────────
  receiptChanges(id: string): FileChange[] | undefined {
    return this.receipts.get(id)?.changes
  }

  isUndone(id: string): boolean {
    return this.receipts.get(id)?.undone ?? false
  }

  /**
   * Puts the files of one step back as they were — but only those that still look exactly as
   * the step left them, so work done afterwards is never clobbered.
   */
  async undo(id: string): Promise<UndoResult> {
    const receipt = this.receipts.get(id)
    const result: UndoResult = { undone: [], skipped: [] }
    if (!receipt)
      return {
        undone: [],
        skipped: [
          {
            path: '',
            reason:
              'this step can no longer be undone (it was made before the window was reloaded)'
          }
        ]
      }
    if (receipt.undone)
      return {
        undone: [],
        skipped: [{ path: '', reason: 'this step was already undone' }]
      }

    const matches = async (
      relative: string,
      expected: string
    ): Promise<{ bytes: Uint8Array } | 'absent' | 'different'> => {
      const bytes = await this.readBytes(relative).catch(() => null)
      if (bytes === null) return 'absent'
      try {
        return this.decode(bytes) === expected ? { bytes } : 'different'
      } catch {
        return 'different'
      }
    }

    for (const change of [...receipt.changes].reverse()) {
      try {
        if (change.kind === 'create') {
          const state = await matches(change.path, change.after)
          if (state === 'absent') result.undone.push(change.path)
          else if (state === 'different')
            result.skipped.push({
              path: change.path,
              reason: 'it was changed after this step'
            })
          else {
            await fs.rm(this.abs(change.path), { force: true })
            result.undone.push(change.path)
          }
        } else if (change.kind === 'modify') {
          const state = await matches(change.path, change.after)
          if (state === 'absent')
            result.skipped.push({ path: change.path, reason: 'it no longer exists' })
          else if (state === 'different')
            result.skipped.push({
              path: change.path,
              reason: 'it was changed after this step'
            })
          else {
            await this.writeAtomic(
              this.abs(change.path),
              this.encode(change.before, hasBom(state.bytes)),
              await this.modeOf(this.abs(change.path))
            )
            result.undone.push(change.path)
          }
        } else if (change.kind === 'delete') {
          if ((await this.readBytes(change.path).catch(() => null)) !== null) {
            result.skipped.push({
              path: change.path,
              reason: 'a file with that name exists again'
            })
          } else {
            await this.writeAtomic(
              this.abs(change.path),
              this.encode(change.before, false)
            )
            result.undone.push(change.path)
          }
        } else {
          const state = await matches(change.to, change.after)
          const sourceBack =
            (await this.readBytes(change.from).catch(() => null)) !== null
          if (state === 'different' || state === 'absent' || sourceBack) {
            result.skipped.push({
              path: change.to,
              reason: 'it was changed or moved after this step'
            })
          } else {
            await this.writeAtomic(
              this.abs(change.from),
              this.encode(change.before, hasBom(state.bytes))
            )
            await fs.rm(this.abs(change.to), { force: true })
            result.undone.push(change.from)
          }
        }
      } catch (error) {
        result.skipped.push({
          path: pathsOf([change])[0]!,
          reason: (error as Error).message
        })
      }
    }
    if (result.skipped.length === 0) receipt.undone = true
    return result
  }
}
