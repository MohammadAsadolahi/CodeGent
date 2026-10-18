import fs from 'node:fs/promises'
import path from 'node:path'

const STAMP = '.codegent-version'

/**
 * Copies the bundled browser extension to a stable folder. Chrome and Edge remember an unpacked
 * extension by its path, and the folder VS Code installs this extension into changes with every
 * update — a fixed copy means the browser keeps working across updates (just press reload on the
 * extension card).
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
  const installed = await fs.readFile(path.join(target, STAMP), 'utf8').catch(() => '')
  const manifestPresent = await fs.access(path.join(target, 'manifest.json')).then(
    () => true,
    () => false
  )
  if (installed.trim() === version && manifestPresent) return target

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
  await fs.writeFile(path.join(target, STAMP), version)
  return target
}
