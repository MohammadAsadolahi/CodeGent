import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const STAMP = '.codegent-version'

/** Every file below `dir`, as paths relative to it with forward slashes, in a stable order. */
const filesBelow = async (dir: string, prefix = ''): Promise<string[]> => {
  const files: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory())
      files.push(...(await filesBelow(path.join(dir, entry.name), relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

/** A short fingerprint of what the bundle contains (names and bytes), not of when it was built. */
const fingerprint = async (dir: string): Promise<string> => {
  const hash = createHash('sha256')
  for (const file of await filesBelow(dir)) {
    hash.update(file)
    hash.update('\0')
    hash.update(await fs.readFile(path.join(dir, file)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * Copies the bundled browser extension to a stable folder. Chrome and Edge remember an unpacked
 * extension by its path, and the folder VS Code installs this extension into changes with every
 * update — a fixed copy means the browser keeps working across updates (just press reload on the
 * extension card).
 *
 * The copy is replaced whenever the bundle's *content* differs from it, not only when the version
 * number does: while the extension is developed or built locally the version stays the same, and
 * a copy kept because of that would go on running the old page-reading code.
 *
 * Returns the folder to load, or null when the bundle is missing.
 */
export const installBrowserExtension = async (options: {
  /** The folder shipped inside this extension. */
  source: string
  /** The stable folder (inside VS Code's global storage). */
  target: string
  version: string
}): Promise<string | null> => {
  const { source, target, version } = options
  try {
    await fs.access(path.join(source, 'manifest.json'))
  } catch {
    return null
  }
  const stamp = `${version}+${await fingerprint(source)}`
  const installed = await fs.readFile(path.join(target, STAMP), 'utf8').catch(() => '')
  const manifestPresent = await fs.access(path.join(target, 'manifest.json')).then(
    () => true,
    () => false
  )
  if (installed.trim() === stamp && manifestPresent) return target

  // Replace in place (rather than delete-then-copy) so a browser holding the folder open
  // never sees it vanish.
  await fs.mkdir(target, { recursive: true })
  const stale = new Set(await fs.readdir(target).catch(() => [] as string[]))
  for (const entry of await fs.readdir(source)) {
    await fs.cp(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      force: true
    })
    stale.delete(entry)
  }
  stale.delete(STAMP)
  for (const entry of stale)
    await fs.rm(path.join(target, entry), { recursive: true, force: true })
  await fs.writeFile(path.join(target, STAMP), stamp)
  return target
}
