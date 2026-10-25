// A small repository that looks like this one where the release script looks (package.json files
// formatted by Prettier, a lockfile written the way npm writes it, README, CHANGELOG, the browser
// manifest), and a builder for the .vsix that `npm run package` would make from it.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

export const PORTS = [47615, 47616, 47617]

export const GITHUB_URL = 'https://github.com/example/codegent.git'

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'

export const CHANGELOG = `# Changelog

## Unreleased

- Reading the reply is more robust.
- A change that needs a second line
  to be explained.

## 0.1.0

First version.
`

export const DOCS = `# Safety and privacy

The browser extension asks for access to \`chatgpt.com\`, \`127.0.0.1\` and the \`storage\`,
\`alarms\` and \`scripting\` permissions.
`

export const browserManifest = (version = '0.0.0') => ({
  manifest_version: 3,
  name: 'CodeGent Bridge',
  version,
  icons: { '16': 'icons/icon-16.png' },
  permissions: ['storage', 'alarms', 'scripting'],
  host_permissions: ['https://chatgpt.com/*', 'http://127.0.0.1/*'],
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['content.js'] }],
  action: { default_popup: 'popup.html', default_icon: { '16': 'icons/icon-16.png' } }
})

const workspace = (name: string, version: string, extra = ''): string => `{
  "name": "${name}",
  "version": "${version}",
  "private": true${extra}
}
`

/** Every file of the project at `version`, by path. */
export const projectFiles = (version = '0.1.0'): Record<string, string> => ({
  '.gitignore': 'node_modules/\nrelease/\n',
  'package.json': `{
  "name": "codegent",
  "private": true,
  "version": "${version}",
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "build": "echo build"
  },
  "devDependencies": {
    "some-tool": "^0.1.0"
  }
}
`,
  'apps/browser/package.json': workspace(
    '@codegent/browser-extension',
    version,
    `,
  "dependencies": {
    "@codegent/protocol": "*"
  },
  "devDependencies": {
    "@codegent/hub": "^${version}",
    "some-lib": "^0.1.0"
  }`
  ),
  'apps/vscode/package.json': workspace('codegent', version),
  'packages/engine/package.json': workspace('@codegent/engine', version),
  'packages/hub/package.json': workspace('@codegent/hub', version),
  'packages/protocol/package.json': workspace('@codegent/protocol', version),
  'package-lock.json': json({
    name: 'codegent',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'codegent',
        version,
        workspaces: ['packages/*', 'apps/*'],
        devDependencies: { 'some-tool': '^0.1.0' }
      },
      'apps/browser': {
        name: '@codegent/browser-extension',
        version,
        dependencies: { '@codegent/protocol': '*' },
        devDependencies: { '@codegent/hub': `^${version}`, 'some-lib': '^0.1.0' }
      },
      'apps/vscode': { name: 'codegent', version },
      'packages/engine': { name: '@codegent/engine', version },
      'packages/hub': { name: '@codegent/hub', version },
      'packages/protocol': { name: '@codegent/protocol', version },
      'node_modules/@codegent/hub': { resolved: 'packages/hub', link: true },
      'node_modules/some-lib': { version: '0.1.0', dev: true }
    }
  }),
  'CITATION.cff': `cff-version: 1.2.0
title: CodeGent
version: ${version}
repository-code: https://github.com/example/codegent
`,
  'README.md': `# CodeGent

> **Early release (${version}).** It works.

1. Download \`codegent-${version}.vsix\` and run \`code --install-extension codegent-${version}.vsix\`.
2. Or unzip \`codegent-bridge-browser-extension-${version}.zip\` and load the folder.
`,
  'CHANGELOG.md': CHANGELOG,
  'docs/safety-and-privacy.md': DOCS,
  'packages/protocol/src/constants.ts': `export const HUB_PORTS: readonly number[] = [${PORTS.join(', ')}]\n`,
  'apps/browser/static/manifest.json': json(browserManifest())
})

export interface VsixOptions {
  version: string
  /** The CHANGELOG that is packaged; by default one with a section for `version`. */
  changelog?: string
  /** The browser extension's files, by name; null removes a default file. */
  browser?: Record<string, string | Buffer | null>
  /** Other files of the package, by full name; null removes a default file. */
  extra?: Record<string, string | Buffer | null>
}

/** What `vsce package` would make: the extension, its README/CHANGELOG, the browser extension. */
export const makeVsix = async (options: VsixOptions): Promise<Buffer> => {
  const { version } = options
  const changelog =
    options.changelog ?? `# Changelog\n\n## Unreleased\n\n## ${version}\n\n- Something.\n`
  const browser: Record<string, string | Buffer | null> = {
    'manifest.json': json(browserManifest(version)),
    'background.js': `const ports=[${PORTS.join(',')}];`,
    'content.js': 'console.log("content")',
    'popup.js': 'console.log("popup")',
    'popup.html':
      '<script src="popup.js"></script><link rel="stylesheet" href="popup.css">',
    'popup.css': 'body{}',
    'icons/icon-16.png': Buffer.from([1, 2, 3]),
    ...options.browser
  }
  const files: Record<string, string | Buffer | null> = {
    'extension/package.json': json({ name: 'codegent', version }),
    'extension/README.md': '# CodeGent\n',
    'extension/CHANGELOG.md': changelog,
    'extension/out/extension.js': 'module.exports={}',
    'extension/out/hub.cjs': 'module.exports={}',
    'extension/out/webview/main.js': 'void 0',
    'extension/out/webview/main.css': 'body{}',
    ...Object.fromEntries(
      Object.entries(browser).map(([name, data]) => [
        `extension/out/browser-extension/${name}`,
        data
      ])
    ),
    ...options.extra
  }
  const zip = new JSZip()
  for (const [name, data] of Object.entries(files)) {
    if (data !== null) zip.file(name, data)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** Writes files (a null removes the file from a default set) below `dir`. */
export const writeFiles = (dir: string, files: Record<string, string | null>): void => {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) continue
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
}

/** The project as plain files in a new temp folder, without git. */
export const plainProject = (
  version?: string,
  overrides: Record<string, string | null> = {}
): { dir: string; remove: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-release-test-'))
  const files: Record<string, string | null> = { ...projectFiles(version), ...overrides }
  for (const [file, text] of Object.entries(files)) if (text === null) delete files[file]
  writeFiles(dir, files)
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

export interface Project {
  /** The working repository, on main. */
  dir: string
  /** The bare repository it pushes to. */
  origin: string
  /** Runs git in the working repository (or in `cwd`) and returns its output. */
  git: (args: string[], cwd?: string) => string
  /** Runs git against the bare origin. */
  originGit: (args: string[]) => string
  write: (file: string, text: string) => void
  read: (file: string) => string
  commit: (message: string) => void
  /** Someone else pushes a commit to origin's main. */
  pushFromElsewhere: (file: string, text: string) => void
  remove: () => void
}

export const createProject = (
  options: {
    version?: string
    files?: Record<string, string | null>
    tag?: string | null
  } = {}
): Project => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-release-test-'))
  const dir = path.join(root, 'work')
  const origin = path.join(root, 'origin.git')
  fs.mkdirSync(dir)
  const run = (args: string[], cwd: string): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trimEnd()
  const git = (args: string[], cwd = dir): string => run(args, cwd)

  writeFiles(dir, { ...projectFiles(options.version), ...options.files })
  run(['init', '--quiet', '--bare', '--initial-branch=main', origin], root)
  git(['init', '--quiet', '--initial-branch=main'])
  for (const [key, value] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false']
  ] as const) {
    git(['config', key, value])
  }
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'initial'])
  // The remote looks like GitHub's (the script reads the repository's name from it) and git
  // redirects it to the bare repository next to the working one.
  git(['remote', 'add', 'origin', GITHUB_URL])
  git(['config', `url.${origin.replaceAll('\\', '/')}.insteadOf`, GITHUB_URL])
  const tag = options.tag === undefined ? 'v0.1.0' : options.tag
  if (tag) git(['tag', tag])
  git(['push', '--quiet', 'origin', 'main', '--tags'])

  return {
    dir,
    origin,
    git,
    originGit: (args) => run(['--git-dir', origin, ...args], root),
    write: (file, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), text)
    },
    read: (file) => fs.readFileSync(path.join(dir, file), 'utf8'),
    commit: (message) => {
      git(['add', '-A'])
      git(['commit', '--quiet', '-m', message])
    },
    pushFromElsewhere: (file, text) => {
      const other = path.join(root, 'other')
      run(['clone', '--quiet', origin, other], root)
      for (const [key, value] of [
        ['user.name', 'Someone'],
        ['user.email', 'someone@example.com'],
        ['commit.gpgsign', 'false']
      ] as const) {
        run(['config', key, value], other)
      }
      fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true })
      fs.writeFileSync(path.join(other, file), text)
      run(['add', '-A'], other)
      run(['commit', '--quiet', '-m', 'elsewhere'], other)
      run(['push', '--quiet', 'origin', 'main'], other)
    },
    remove: () => fs.rmSync(root, { recursive: true, force: true })
  }
}
