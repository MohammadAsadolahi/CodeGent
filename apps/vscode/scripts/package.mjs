// Builds the extension for release and wraps it into `codegent-<version>.vsix` in this folder.
// The marketplace page is the repository's README and CHANGELOG, copied in for the packaging only.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAll } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(root, '..', '..')
const pages = ['README.md', 'CHANGELOG.md']

// No port override: the released browser extension and the released hub use the default ports.
await buildAll({ production: true })

for (const page of pages)
  fs.copyFileSync(path.join(repoRoot, page), path.join(root, page))
try {
  const vsce = createRequire(import.meta.url).resolve('@vscode/vsce/vsce')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const flags = ['--no-dependencies', '--skip-license']
  // Until the owner adds a "repository" to package.json there is nothing to point relative links at.
  if (!manifest.repository)
    flags.push('--allow-missing-repository', '--no-rewrite-relative-links')
  const result = spawnSync(process.execPath, [vsce, 'package', ...flags], {
    cwd: root,
    stdio: 'inherit'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
} finally {
  for (const page of pages) fs.rmSync(path.join(root, page), { force: true })
}
