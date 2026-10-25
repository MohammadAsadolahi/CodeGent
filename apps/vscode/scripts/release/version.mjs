// Where the version number lives and how to move it. Everything here works on a folder, so the
// release script prepares a clean copy of the repository with it first and, once that copy has
// passed every check, the real repository with the very same code.
import fs from 'node:fs'
import path from 'node:path'
import { promoteUnreleased } from './changelog.mjs'
import { escapeRegExp, ReleaseError } from './common.mjs'

// Chrome accepts only integers (each at most 65535) as an extension version, so a semver suffix
// such as `-beta.1` could not be released.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const isVersion = (text) =>
  VERSION.test(text) && text.split('.').every((part) => Number(part) <= 65535)

const numbers = (version) => version.split('.').map(Number)

/** -1, 0 or 1, like a sort comparator. */
export const compareVersions = (a, b) => {
  const left = numbers(a)
  const right = numbers(b)
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** `patch`, `minor`, `major` or an exact version, as the version to release after `current`. */
export const resolveVersion = (current, request) => {
  const [major, minor, patch] = numbers(current)
  let next = request
  if (request === 'patch') next = `${major}.${minor}.${patch + 1}`
  if (request === 'minor') next = `${major}.${minor + 1}.0`
  if (request === 'major') next = `${major + 1}.0.0`
  if (!isVersion(next)) {
    throw new ReleaseError(
      `"${request}" is neither patch, minor, major nor a version like 1.2.3 (no suffixes: browsers refuse them)`
    )
  }
  if (compareVersions(next, current) < 0) {
    throw new ReleaseError(`${next} is older than the current version ${current}`)
  }
  return next
}

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8')
const readJson = (root, file) => JSON.parse(read(root, file))

/** The root package.json and those of every workspace, as paths relative to `root`. */
export const manifestFiles = (root) => {
  const files = ['package.json']
  for (const pattern of readJson(root, 'package.json').workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      throw new ReleaseError(
        `the release script only understands workspace patterns like "apps/*", not "${pattern}"`
      )
    }
    const base = pattern.slice(0, -2)
    const folders = fs
      .readdirSync(path.join(root, base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const folder of folders) {
      const file = `${base}/${folder}/package.json`
      if (fs.existsSync(path.join(root, file))) files.push(file)
    }
  }
  return files
}

/** The version every package.json agrees on; throws when they do not. */
export const currentVersion = (root) => {
  const versions = new Map(
    manifestFiles(root).map((file) => [file, readJson(root, file).version])
  )
  const distinct = new Set(versions.values())
  if (distinct.size !== 1) {
    const listing = [...versions].map(([file, version]) => `  ${file}: ${version}`)
    throw new ReleaseError(
      `the package.json files do not agree on the version:\n${listing.join('\n')}`
    )
  }
  return [...distinct][0]
}

/** Download file names in `text` that belong to a version other than `version`. */
export const staleDownloadNames = (text, version) => {
  const names =
    text.match(/codegent(?:-bridge-browser-extension)?-\d+\.\d+\.\d+\.(?:vsix|zip)/g) ??
    []
  return [...new Set(names)].filter((name) => !name.includes(`-${version}.`))
}

// A workspace that depends on a sibling with the range `^<old version>` would stop resolving to
// the sibling after a minor or major bump, so those ranges move with the version.
const bumpManifest = (text, file, from, to, workspaceNames) => {
  const own = new RegExp(`^(  "version": )"${escapeRegExp(from)}"`, 'm')
  if (!own.test(text)) {
    throw new ReleaseError(`${file} has no top-level "version": "${from}" to change`)
  }
  let next = text.replace(own, `$1"${to}"`)
  for (const name of workspaceNames) {
    const range = new RegExp(
      `^(\\s*"${escapeRegExp(name)}": )"\\^${escapeRegExp(from)}"`,
      'gm'
    )
    next = next.replace(range, `$1"^${to}"`)
  }
  return next
}

// The lockfile is rewritten as JSON only when that reproduces it byte for byte, which is how npm
// writes it; anything else means someone formatted it by hand and the script keeps its hands off.
const bumpLock = (text, folders, from, to, workspaceNames) => {
  const lock = JSON.parse(text)
  if (JSON.stringify(lock, null, 2) + '\n' !== text) {
    throw new ReleaseError(
      'package-lock.json is not formatted the way npm writes it (2-space JSON, LF line endings)'
    )
  }
  lock.version = to
  for (const folder of ['', ...folders]) {
    const entry = lock.packages?.[folder]
    if (!entry || entry.version !== from) {
      throw new ReleaseError(
        `package-lock.json has no "${folder}" entry at version ${from}; run npm install first`
      )
    }
    entry.version = to
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of workspaceNames) {
        if (entry[kind]?.[name] === `^${from}`) entry[kind][name] = `^${to}`
      }
    }
  }
  return JSON.stringify(lock, null, 2) + '\n'
}

/**
 * What moving the repository in `root` from version `from` to `to` would change, without writing
 * anything: every package.json, the lockfile, CITATION.cff, the download names in the README and
 * the CHANGELOG (Unreleased becomes `to`). A map from file to its old and new text.
 */
export const planVersion = (root, from, to) => {
  const manifests = manifestFiles(root)
  const workspaceNames = manifests
    .map((file) => readJson(root, file).name)
    .filter(Boolean)
  const folders = manifests.slice(1).map((file) => path.posix.dirname(file))
  const plan = new Map()
  const rewrite = (file, change) => {
    if (!fs.existsSync(path.join(root, file))) return
    const before = read(root, file)
    const after = change(before)
    if (after !== before) plan.set(file, { before, after })
  }

  for (const file of manifests) {
    rewrite(file, (text) => bumpManifest(text, file, from, to, workspaceNames))
  }
  rewrite('package-lock.json', (text) =>
    bumpLock(text, folders, from, to, workspaceNames)
  )
  rewrite('CITATION.cff', (text) => {
    const line = new RegExp(`^version: ${escapeRegExp(from)}$`, 'm')
    if (!line.test(text)) {
      throw new ReleaseError(`CITATION.cff has no "version: ${from}" line to change`)
    }
    return text.replace(line, `version: ${to}`)
  })
  rewrite('README.md', (text) =>
    text
      .replaceAll(`codegent-${from}.vsix`, `codegent-${to}.vsix`)
      .replaceAll(
        `codegent-bridge-browser-extension-${from}.zip`,
        `codegent-bridge-browser-extension-${to}.zip`
      )
      .replaceAll(`Early release (${from})`, `Early release (${to})`)
  )
  rewrite('CHANGELOG.md', (text) => promoteUnreleased(text, to))
  return plan
}

/** Puts the files of a plan back as they were before it. */
export const restorePlan = (root, plan) => {
  for (const [file, { before }] of plan) fs.writeFileSync(path.join(root, file), before)
}

/** Writes a plan; all or nothing, so a failing write leaves the files as they were. */
export const writePlan = (root, plan) => {
  const written = new Map()
  try {
    for (const [file, change] of plan) {
      fs.writeFileSync(path.join(root, file), change.after)
      written.set(file, change)
    }
  } catch (error) {
    restorePlan(root, written)
    throw error
  }
  return [...plan.keys()].sort()
}

/** Plans and writes the move to `to`; returns the files that changed. */
export const applyVersion = (root, from, to) =>
  writePlan(root, planVersion(root, from, to))
