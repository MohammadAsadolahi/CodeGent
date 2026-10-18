import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installBrowserExtension } from '../../src/browser-extension-installer'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-installer-'))
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }))

let counter = 0
const make = (files: Record<string, string>) => {
  const dir = path.join(sandbox, `d${++counter}`)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const listing = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => p.replace(/\\/g, '/')).sort()

describe('installBrowserExtension', () => {
  it('copies the bundle and stamps the version', async () => {
    const source = make({ 'manifest.json': '{}', 'background.js': 'bg', 'icons/a.png': 'png' })
    const target = path.join(sandbox, 'stable1')
    expect(await installBrowserExtension({ source, target, version: '1.0.0' })).toBe(target)
    expect(listing(target)).toEqual(['.codegent-version', 'background.js', 'icons', 'icons/a.png', 'manifest.json'])
    expect(fs.readFileSync(path.join(target, '.codegent-version'), 'utf8')).toBe('1.0.0')
  })

  it('leaves an up-to-date copy alone', async () => {
    const source = make({ 'manifest.json': '{}', 'background.js': 'v1' })
    const target = path.join(sandbox, 'stable2')
    await installBrowserExtension({ source, target, version: '1.0.0' })
    fs.writeFileSync(path.join(source, 'background.js'), 'changed in the bundle')
    await installBrowserExtension({ source, target, version: '1.0.0' })
    expect(fs.readFileSync(path.join(target, 'background.js'), 'utf8')).toBe('v1')
  })

  it('updates in place on a new version, removing files that no longer exist', async () => {
    const source = make({ 'manifest.json': '{"v":1}', 'old.js': 'old' })
    const target = path.join(sandbox, 'stable3')
    await installBrowserExtension({ source, target, version: '1.0.0' })

    fs.rmSync(path.join(source, 'old.js'))
    fs.writeFileSync(path.join(source, 'manifest.json'), '{"v":2}')
    fs.writeFileSync(path.join(source, 'new.js'), 'new')
    await installBrowserExtension({ source, target, version: '1.1.0' })

    expect(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')).toBe('{"v":2}')
    expect(listing(target)).toEqual(['.codegent-version', 'manifest.json', 'new.js'])
    expect(fs.readFileSync(path.join(target, '.codegent-version'), 'utf8')).toBe('1.1.0')
  })

  it('repairs a copy that lost its manifest even if the version matches', async () => {
    const source = make({ 'manifest.json': '{}' })
    const target = path.join(sandbox, 'stable4')
    await installBrowserExtension({ source, target, version: '1.0.0' })
    fs.rmSync(path.join(target, 'manifest.json'))
    await installBrowserExtension({ source, target, version: '1.0.0' })
    expect(fs.existsSync(path.join(target, 'manifest.json'))).toBe(true)
  })

  it('returns null when the extension does not ship a bundle', async () => {
    expect(await installBrowserExtension({ source: path.join(sandbox, 'missing'), target: path.join(sandbox, 'x'), version: '1' })).toBeNull()
  })
})
