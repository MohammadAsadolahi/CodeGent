export type PathResult = { ok: true; path: string } | { ok: false; reason: string }

export interface PathOptions {
  /** Absolute workspace root; absolute paths inside it are converted to repo-relative ones. */
  workspaceRoot?: string
}

const MAX_PATH_CHARS = 1_000
const FORBIDDEN_CHARS = /[\u0000-\u001f<>"|?*]/

const toPosix = (value: string): string => value.replace(/\\/g, '/')

/**
 * Turns whatever path ChatGPT wrote into a clean repo-relative POSIX path, or explains why it is
 * not acceptable. Nothing that could leave the repository, or touch git's own data, gets through.
 */
export const normalizeRepoPath = (raw: string, options: PathOptions = {}): PathResult => {
  let path = raw.trim().replace(/^[`"']+|[`"']+$/g, '').trim()
  if (path === '') return { ok: false, reason: 'the path is empty' }
  if (FORBIDDEN_CHARS.test(path)) {
    return { ok: false, reason: 'the path contains characters that are not allowed' }
  }
  path = toPosix(path)

  const root = options.workspaceRoot ? toPosix(options.workspaceRoot).replace(/\/+$/, '') : undefined
  const driveLetter = /^[A-Za-z]:\//.test(path)
  if (driveLetter || path.startsWith('/')) {
    const inside = root !== undefined && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    if (inside) {
      path = path.slice(root.length + 1)
    } else if (driveLetter) {
      return { ok: false, reason: 'absolute paths outside the repository are not allowed' }
    } else {
      path = path.replace(/^\/+/, '') // "/src/a.ts" means "from the repository root"
    }
  }

  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { ok: false, reason: 'the path leaves the repository ("..")' }
    if (segment.toLowerCase() === '.git') {
      return { ok: false, reason: 'git’s own data (.git) cannot be edited' }
    }
    segments.push(segment)
  }
  if (segments.length === 0) return { ok: false, reason: 'the path is empty' }
  if (path.endsWith('/')) return { ok: false, reason: 'the path names a directory, not a file' }

  const normalized = segments.join('/')
  if (normalized.length > MAX_PATH_CHARS) return { ok: false, reason: 'the path is too long' }
  return { ok: true, path: normalized }
}
