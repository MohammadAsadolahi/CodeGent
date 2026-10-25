import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyVersion,
  compareVersions,
  currentVersion,
  isVersion,
  manifestFiles,
  planVersion,
  resolveVersion,
  restorePlan,
  staleDownloadNames,
  writePlan
} from '../../scripts/release/version.mjs'
import { plainProject, projectFiles } from '../support/release-fixture'

describe('version numbers', () => {
  it('accepts plain major.minor.patch only (browsers refuse anything else)', () => {
    for (const good of ['0.0.0', '0.1.0', '1.2.3', '10.20.30', '65535.65535.65535']) {
      expect(isVersion(good), good).toBe(true)
    }
    for (const bad of [
      '',
      '1',
      '1.2',
      '1.2.3.4',
      '01.2.3',
      '1.2.3-beta.1',
      '1.2.3+build',
      '65536.0.0',
      'v1.2.3',
      'patch'
    ]) {
      expect(isVersion(bad), bad).toBe(false)
    }
  })

  it('compares the numbers, not the text', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('2.3.4', '2.3.4')).toBe(0)
    const sorted = ['0.10.0', '0.2.0', '0.9.1', '0.1.0'].sort(compareVersions)
    expect(sorted).toEqual(['0.1.0', '0.2.0', '0.9.1', '0.10.0'])
  })

  it('turns patch, minor, major or an exact version into the version to release', () => {
    expect(resolveVersion('0.1.0', 'patch')).toBe('0.1.1')
    expect(resolveVersion('0.1.9', 'patch')).toBe('0.1.10')
    expect(resolveVersion('0.1.4', 'minor')).toBe('0.2.0')
    expect(resolveVersion('0.1.4', 'major')).toBe('1.0.0')
    expect(resolveVersion('0.1.0', '0.3.7')).toBe('0.3.7')
    expect(resolveVersion('0.1.1', '0.1.1')).toBe('0.1.1')
  })

  it('refuses nonsense and going backwards, saying why', () => {
    expect(() => resolveVersion('0.1.0', 'latest')).toThrow(/neither patch, minor, major/)
    expect(() => resolveVersion('0.1.0', '1.0.0-rc.1')).toThrow(/browsers refuse/)
    expect(() => resolveVersion('0.2.0', '0.1.5')).toThrow(
      /older than the current version 0.2.0/
    )
  })
})

describe('finding the version', () => {
  let project: ReturnType<typeof plainProject>
  afterEach(() => project.remove())

  it('lists the root manifest, then the workspaces in the order the root declares them', () => {
    project = plainProject()
    expect(manifestFiles(project.dir)).toEqual([
      'package.json',
      'packages/engine/package.json',
      'packages/hub/package.json',
      'packages/protocol/package.json',
      'apps/browser/package.json',
      'apps/vscode/package.json'
    ])
  })

  it('reads the version every package.json agrees on', () => {
    project = plainProject('0.4.2')
    expect(currentVersion(project.dir)).toBe('0.4.2')
  })

  it('refuses to guess when the package.json files disagree', () => {
    project = plainProject('0.1.0')
    fs.writeFileSync(
      path.join(project.dir, 'packages/hub/package.json'),
      projectFiles('0.1.1')['packages/hub/package.json']!
    )
    expect(() => currentVersion(project.dir)).toThrow(
      /do not agree on the version:\n {2}package.json: 0.1.0[\s\S]*packages\/hub\/package.json: 0.1.1/
    )
  })

  it('only understands workspace patterns of the form folder/*', () => {
    project = plainProject('0.1.0', {
      'package.json': '{ "name": "x", "version": "0.1.0", "workspaces": ["apps/**"] }\n'
    })
    expect(() => manifestFiles(project.dir)).toThrow(
      /only understands workspace patterns/
    )
  })
})

describe('moving the version', () => {
  let project: ReturnType<typeof plainProject>
  const read = (file: string): string =>
    fs.readFileSync(path.join(project.dir, file), 'utf8')
  const snapshot = (): Record<string, string> =>
    Object.fromEntries(Object.keys(projectFiles()).map((file) => [file, read(file)]))
  beforeEach(() => {
    project = plainProject('0.1.0')
  })
  afterEach(() => project.remove())

  it('plans every change without writing a byte', () => {
    const before = snapshot()
    const plan = planVersion(project.dir, '0.1.0', '0.1.1')
    expect([...plan.keys()].sort()).toEqual([
      'CHANGELOG.md',
      'CITATION.cff',
      'README.md',
      'apps/browser/package.json',
      'apps/vscode/package.json',
      'package-lock.json',
      'package.json',
      'packages/engine/package.json',
      'packages/hub/package.json',
      'packages/protocol/package.json'
    ])
    expect(snapshot()).toEqual(before)
  })

  it('changes the version lines of the package.json files and keeps their formatting', () => {
    applyVersion(project.dir, '0.1.0', '0.2.0')
    const original = projectFiles('0.1.0')
    for (const file of manifestFiles(project.dir)) {
      let expected = original[file]!.replace('"version": "0.1.0"', '"version": "0.2.0"')
      // A workspace that needs a sibling's current version keeps working after a minor bump.
      expected = expected.replace(
        '"@codegent/hub": "^0.1.0"',
        '"@codegent/hub": "^0.2.0"'
      )
      expect(read(file), file).toBe(expected)
    }
    expect(read('package.json')).toContain('"workspaces": ["packages/*", "apps/*"]')
  })

  it('leaves the versions of other packages alone, even when they match', () => {
    applyVersion(project.dir, '0.1.0', '0.2.0')
    expect(read('package.json')).toContain('"some-tool": "^0.1.0"')
    expect(read('apps/browser/package.json')).toContain('"some-lib": "^0.1.0"')
    const lock = JSON.parse(read('package-lock.json'))
    expect(lock.packages['node_modules/some-lib'].version).toBe('0.1.0')
    expect(lock.packages['apps/browser'].devDependencies['some-lib']).toBe('^0.1.0')
    expect(lock.packages['apps/browser'].dependencies['@codegent/protocol']).toBe('*')
  })

  it('moves the lockfile with the manifests, so npm ci still agrees with them', () => {
    applyVersion(project.dir, '0.1.0', '0.2.0')
    const lock = JSON.parse(read('package-lock.json'))
    expect(lock.version).toBe('0.2.0')
    for (const entry of [
      '',
      'apps/browser',
      'apps/vscode',
      'packages/engine',
      'packages/hub',
      'packages/protocol'
    ]) {
      expect(lock.packages[entry].version, entry || 'root').toBe('0.2.0')
    }
    expect(lock.packages['apps/browser'].devDependencies['@codegent/hub']).toBe('^0.2.0')
    expect(read('package-lock.json')).toBe(JSON.stringify(lock, null, 2) + '\n')
  })

  it('updates CITATION.cff, the download names in the README and the CHANGELOG', () => {
    const changed = applyVersion(project.dir, '0.1.0', '0.1.1')
    expect(changed).toContain('CITATION.cff')
    expect(read('CITATION.cff')).toContain('version: 0.1.1\n')
    const readme = read('README.md')
    expect(readme).toContain('Early release (0.1.1)')
    expect(readme).toContain('code --install-extension codegent-0.1.1.vsix')
    expect(readme).toContain('codegent-bridge-browser-extension-0.1.1.zip')
    expect(readme).not.toContain('0.1.0')
    expect(read('CHANGELOG.md')).toBe(`# Changelog

## Unreleased

## 0.1.1

- Reading the reply is more robust.
- A change that needs a second line
  to be explained.

## 0.1.0

First version.
`)
  })

  it('writes nothing at all when one of the files cannot be changed', () => {
    const lockOnOneLine = JSON.stringify(JSON.parse(read('package-lock.json')))
    fs.writeFileSync(path.join(project.dir, 'package-lock.json'), lockOnOneLine)
    const before = snapshot()
    expect(() => applyVersion(project.dir, '0.1.0', '0.1.1')).toThrow(
      /not formatted the way npm writes it/
    )
    expect(snapshot()).toEqual(before)
  })

  it('stops when the files are not at the version it is asked to move from', () => {
    expect(() => applyVersion(project.dir, '0.0.9', '0.1.1')).toThrow(
      /no top-level "version": "0.0.9"/
    )
  })

  it('stops when the lockfile has no entry at the current version', () => {
    const lock = JSON.parse(read('package-lock.json'))
    lock.packages['packages/hub'].version = '0.0.5'
    fs.writeFileSync(
      path.join(project.dir, 'package-lock.json'),
      JSON.stringify(lock, null, 2) + '\n'
    )
    expect(() => applyVersion(project.dir, '0.1.0', '0.1.1')).toThrow(
      /no "packages\/hub" entry at version 0.1.0/
    )
  })

  it('stops when there is nothing in the CHANGELOG to release', () => {
    const empty = '# Changelog\n\n## Unreleased\n\n## 0.1.0\n\nFirst version.\n'
    fs.writeFileSync(path.join(project.dir, 'CHANGELOG.md'), empty)
    const before = snapshot()
    expect(() => applyVersion(project.dir, '0.1.0', '0.1.1')).toThrow(/is empty/)
    expect(snapshot()).toEqual(before)
  })

  it('stops when CITATION.cff does not carry the current version', () => {
    fs.writeFileSync(
      path.join(project.dir, 'CITATION.cff'),
      'title: CodeGent\nversion: 0.0.1\n'
    )
    expect(() => applyVersion(project.dir, '0.1.0', '0.1.1')).toThrow(
      /CITATION.cff has no/
    )
  })

  it('puts files back when a write fails half way', () => {
    const plan = planVersion(project.dir, '0.1.0', '0.1.1')
    plan.set('missing-folder/file.txt', { before: '', after: 'x' })
    const before = snapshot()
    expect(() => writePlan(project.dir, plan)).toThrow()
    expect(snapshot()).toEqual(before)
  })

  it('restores a plan that was written', () => {
    const before = snapshot()
    const plan = planVersion(project.dir, '0.1.0', '0.1.1')
    writePlan(project.dir, plan)
    expect(snapshot()).not.toEqual(before)
    restorePlan(project.dir, plan)
    expect(snapshot()).toEqual(before)
  })
})

describe('download names in the README', () => {
  it('finds the names that belong to another version', () => {
    const text =
      'codegent-0.1.1.vsix and codegent-bridge-browser-extension-0.1.0.zip, codegent-0.1.0.vsix'
    expect(staleDownloadNames(text, '0.1.1')).toEqual([
      'codegent-bridge-browser-extension-0.1.0.zip',
      'codegent-0.1.0.vsix'
    ])
    expect(staleDownloadNames('codegent-0.1.1.vsix', '0.1.1')).toEqual([])
    expect(staleDownloadNames('no downloads here', '0.1.1')).toEqual([])
  })

  it('does not take version 0.1.1 for part of 10.1.1', () => {
    expect(staleDownloadNames('codegent-10.1.1.vsix', '0.1.1')).toEqual([
      'codegent-10.1.1.vsix'
    ])
  })
})
