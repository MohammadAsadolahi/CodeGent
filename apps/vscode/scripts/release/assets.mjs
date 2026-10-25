// The files people download: the browser extension zip, and the checks that what is about to be
// published is what was meant to be published.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { sectionFor } from './changelog.mjs'
import { ReleaseError } from './common.mjs'

/** Where the browser extension sits inside the .vsix. */
const EXTENSION_FOLDER = 'extension/out/browser-extension/'

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** The files (not folders) of a zip, by name. */
const filesOf = async (data) => {
  const zip = await JSZip.loadAsync(data)
  const files = new Map()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files.set(name, await entry.async('nodebuffer'))
  }
  return files
}

/**
 * The browser extension as a zip, made from the copy inside the .vsix so that both downloads hold
 * the very same bytes (the integration tests rebuild `out/` with test ports, so that folder is
 * not to be trusted once they have run). The files sit at the top of the zip, and `date` is
 * stored for every one of them: the same .vsix always gives the same zip.
 */
export const browserExtensionZip = async (vsix, date) => {
  const inside = await filesOf(fs.readFileSync(vsix))
  const names = [...inside.keys()]
    .filter((name) => name.startsWith(EXTENSION_FOLDER))
    .sort()
  if (!names.includes(`${EXTENSION_FOLDER}manifest.json`)) {
    throw new ReleaseError(
      `${path.basename(vsix)} does not contain the browser extension`
    )
  }
  const zip = new JSZip()
  for (const name of names) {
    zip.file(name.slice(EXTENSION_FOLDER.length), inside.get(name), {
      date,
      createFolders: false,
      unixPermissions: 0o100644
    })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX'
  })
}

/** The ports a released browser extension and hub use, as `HUB_PORTS` in the protocol package. */
export const defaultHubPorts = (root) => {
  const file = path.join(root, 'packages', 'protocol', 'src', 'constants.ts')
  const match = /HUB_PORTS[^=]*=\s*\[([^\]]+)\]/.exec(fs.readFileSync(file, 'utf8'))
  const ports = match?.[1].split(',').map((port) => Number(port.trim())) ?? []
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port))) {
    throw new ReleaseError(
      'cannot read HUB_PORTS from packages/protocol/src/constants.ts; update the release script'
    )
  }
  return ports
}

const hostOf = (pattern) =>
  /^(?:\*|https?|ftp|file):\/\/(?:\*\.)?([^/*]+)/.exec(pattern)?.[1] ?? pattern

// Everything a manifest asks the browser for, keyed so two manifests can be compared, with the
// word that docs/safety-and-privacy.md has to contain to have documented it.
const grants = (manifest) => {
  const list = (value) => value ?? []
  const sites = [
    ...list(manifest.host_permissions),
    ...list(manifest.optional_host_permissions),
    ...list(manifest.content_scripts).flatMap((script) => list(script.matches))
  ]
  return new Map([
    ...[...list(manifest.permissions), ...list(manifest.optional_permissions)].map(
      (name) => [`permission ${name}`, name]
    ),
    ...sites.map((pattern) => [`site ${pattern}`, hostOf(pattern)])
  ])
}

/**
 * Permissions and sites that `current` asks for, `previous` did not, and `docs` never mentions.
 * New access needs a documented reason before it ships (docs/safety-and-privacy.md).
 */
export const undocumentedGrants = (previous, current, docs) => {
  const known = grants(previous)
  return [...grants(current)]
    .filter(([key, word]) => !known.has(key) && !docs.includes(word))
    .map(([key]) => key)
}

/**
 * Looks inside the finished files and throws, listing every problem found, when they are not what
 * a release should be: wrong version, a different browser extension in each file, files the
 * manifest points to that are missing, a build made for the test ports, new permissions nobody
 * documented.
 * @param {{
 *   vsix: string,
 *   zip: string,
 *   version: string,
 *   hubPorts?: number[],
 *   previousManifest?: any,
 *   docs?: string
 * }} input
 */
export const verifyRelease = async ({
  vsix,
  zip,
  version,
  hubPorts = [],
  previousManifest = null,
  docs = ''
}) => {
  const problems = []
  const packaged = await filesOf(fs.readFileSync(vsix))
  const extension = await filesOf(fs.readFileSync(zip))

  const packageJson = packaged.get('extension/package.json')
  if (!packageJson) problems.push('the .vsix has no extension/package.json')
  else if (JSON.parse(packageJson.toString('utf8')).version !== version) {
    problems.push(`the .vsix is not version ${version}`)
  }
  for (const name of [
    'extension/out/extension.js',
    'extension/out/hub.cjs',
    'extension/out/webview/main.js',
    'extension/out/webview/main.css',
    'extension/README.md',
    'extension/CHANGELOG.md'
  ]) {
    if (!packaged.has(name)) problems.push(`the .vsix is missing ${name}`)
  }
  const changelog = packaged.get('extension/CHANGELOG.md')?.toString('utf8')
  if (changelog !== undefined && !sectionFor(changelog, version)) {
    problems.push(`the CHANGELOG inside the .vsix has no entries for ${version}`)
  }
  for (const name of packaged.keys()) {
    if (
      name.endsWith('.map') ||
      name.includes('/node_modules/') ||
      /^extension\/(src|test|scripts|webview)\//.test(name)
    ) {
      problems.push(`the .vsix contains ${name}, which should not ship`)
    }
  }

  // The zip is the browser extension of the .vsix, nothing more and nothing different.
  const shipped = [...packaged.keys()].filter((name) => name.startsWith(EXTENSION_FOLDER))
  if (shipped.length !== extension.size) {
    problems.push(
      `the zip has ${extension.size} files but the .vsix carries ${shipped.length} for the browser`
    )
  }
  for (const [name, data] of extension) {
    if (!data.equals(packaged.get(EXTENSION_FOLDER + name) ?? Buffer.alloc(0))) {
      problems.push(`${name} differs between the zip and the .vsix`)
    }
  }

  const manifestFile = extension.get('manifest.json')
  const manifest = manifestFile ? JSON.parse(manifestFile.toString('utf8')) : null
  if (!manifest) problems.push('the zip has no manifest.json at its top')
  else {
    if (manifest.version !== version) {
      problems.push(
        `the browser extension is version ${manifest.version}, not ${version}`
      )
    }
    const referenced = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
      ...(manifest.content_scripts ?? []).flatMap((script) => [
        ...(script.js ?? []),
        ...(script.css ?? [])
      ])
    ].filter(Boolean)
    for (const file of referenced) {
      if (!extension.has(file))
        problems.push(`manifest.json names ${file}, which is missing`)
    }
    for (const [name, data] of extension) {
      if (!name.endsWith('.html')) continue
      for (const [, reference] of data
        .toString('utf8')
        .matchAll(/(?:src|href)="([^"#?:]+)"/g)) {
        if (!extension.has(reference))
          problems.push(`${name} names ${reference}, which is missing`)
      }
    }
    if (previousManifest) {
      for (const grant of undocumentedGrants(previousManifest, manifest, docs)) {
        problems.push(
          `the browser extension newly asks for ${grant}; document why in docs/safety-and-privacy.md first`
        )
      }
    }
  }

  // A released extension talks to the default ports. A build made for the tests (they rebuild
  // out/ with ports of their own) leaves those out.
  const background = extension.get('background.js')?.toString('utf8') ?? ''
  for (const port of hubPorts) {
    if (!background.includes(String(port))) {
      problems.push(
        `background.js lacks the default hub port ${port}: was it built for the test ports?`
      )
    }
  }

  if (problems.length > 0) {
    throw new ReleaseError(
      `the release files have problems:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`
    )
  }
}
