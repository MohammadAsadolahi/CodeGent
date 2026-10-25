import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  browserExtensionZip,
  defaultHubPorts,
  sha256,
  undocumentedGrants,
  verifyRelease
} from '../../scripts/release/assets.mjs'
import {
  browserManifest,
  DOCS,
  makeVsix,
  PORTS,
  plainProject,
  type VsixOptions
} from '../support/release-fixture'

const DATE = new Date('2026-10-25T06:38:10Z')

describe('checksums', () => {
  it('are SHA-256 in hex', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('the default hub ports', () => {
  it('are read from the protocol package', () => {
    const project = plainProject()
    try {
      expect(defaultHubPorts(project.dir)).toEqual(PORTS)
    } finally {
      project.remove()
    }
  })

  it('are not guessed when the constant is not where it was', () => {
    const project = plainProject('0.1.0', {
      'packages/protocol/src/constants.ts': 'export const OTHER = 1\n'
    })
    try {
      expect(() => defaultHubPorts(project.dir)).toThrow(/cannot read HUB_PORTS/)
    } finally {
      project.remove()
    }
  })
})

describe('permissions nobody documented', () => {
  const before = browserManifest('0.1.0')
  const docs = 'chatgpt.com 127.0.0.1 storage alarms scripting'

  it('are none when the manifest asks for the same as before', () => {
    expect(undocumentedGrants(before, browserManifest('0.2.0'), docs)).toEqual([])
  })

  it('are listed when a new permission is not mentioned in the docs', () => {
    const after = { ...before, permissions: [...before.permissions, 'tabs'] }
    expect(undocumentedGrants(before, after, docs)).toEqual(['permission tabs'])
  })

  it('are not listed once the docs mention them', () => {
    const after = { ...before, permissions: [...before.permissions, 'tabs'] }
    expect(undocumentedGrants(before, after, `${docs} tabs`)).toEqual([])
  })

  it('include a new site, documented by its host name', () => {
    const after = {
      ...before,
      host_permissions: [...before.host_permissions, 'https://*.example.com/*']
    }
    expect(undocumentedGrants(before, after, docs)).toEqual([
      'site https://*.example.com/*'
    ])
    expect(undocumentedGrants(before, after, `${docs} example.com`)).toEqual([])
  })

  it('include a new site only a content script matches', () => {
    const after = {
      ...before,
      content_scripts: [{ matches: ['https://other.example.org/*'], js: ['content.js'] }]
    }
    expect(undocumentedGrants(before, after, docs)).toEqual([
      'site https://other.example.org/*'
    ])
  })

  it('do not include access that was given up', () => {
    const after = { ...before, permissions: ['storage'] }
    expect(undocumentedGrants(before, after, docs)).toEqual([])
  })

  it('cannot be documented by a host name when they cover every site', () => {
    const after = { ...before, host_permissions: ['<all_urls>'] }
    expect(undocumentedGrants(before, after, docs)).toEqual(['site <all_urls>'])
  })
})

describe('the release files', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-assets-test-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const writeVsix = async (options: Partial<VsixOptions> = {}, name = 'a.vsix') => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, await makeVsix({ version: '0.2.0', ...options }))
    return file
  }
  const writeZipOf = async (vsix: string, name = 'a.zip') => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, await browserExtensionZip(vsix, DATE))
    return file
  }
  const verify = (vsix: string, zip: string, extra: Record<string, unknown> = {}) =>
    verifyRelease({
      vsix,
      zip,
      version: '0.2.0',
      hubPorts: PORTS,
      previousManifest: browserManifest('0.1.0'),
      docs: DOCS,
      ...extra
    })

  describe('the browser extension zip', () => {
    it('holds the files of the browser extension inside the .vsix, at its top', async () => {
      const vsix = await writeVsix()
      const zip = await JSZip.loadAsync(await browserExtensionZip(vsix, DATE))
      expect(Object.keys(zip.files).sort()).toEqual([
        'background.js',
        'content.js',
        'icons/icon-16.png',
        'manifest.json',
        'popup.css',
        'popup.html',
        'popup.js'
      ])
      expect(await zip.file('background.js')!.async('string')).toBe(
        `const ports=[${PORTS.join(',')}];`
      )
      expect(JSON.parse(await zip.file('manifest.json')!.async('string')).version).toBe(
        '0.2.0'
      )
    })

    it('has no folder entries and gives every file the date it was asked to', async () => {
      const zip = await JSZip.loadAsync(
        await browserExtensionZip(await writeVsix(), DATE)
      )
      expect(Object.values(zip.files).filter((entry) => entry.dir)).toEqual([])
      for (const entry of Object.values(zip.files)) {
        expect(entry.date.toISOString(), entry.name).toBe('2026-10-25T06:38:10.000Z')
      }
    })

    it('is the same bytes every time for the same .vsix and date', async () => {
      const vsix = await writeVsix()
      const first = await browserExtensionZip(vsix, DATE)
      const second = await browserExtensionZip(vsix, DATE)
      expect(sha256(first)).toBe(sha256(second))
    })

    it('differs when the content differs', async () => {
      const one = await browserExtensionZip(await writeVsix(), DATE)
      const other = await writeVsix({ browser: { 'content.js': 'changed' } }, 'b.vsix')
      expect(sha256(await browserExtensionZip(other, DATE))).not.toBe(sha256(one))
    })

    it('is refused for a .vsix that does not carry the browser extension', async () => {
      const vsix = await writeVsix({
        browser: {
          'manifest.json': null,
          'background.js': null,
          'content.js': null,
          'popup.js': null,
          'popup.html': null,
          'popup.css': null,
          'icons/icon-16.png': null
        }
      })
      await expect(browserExtensionZip(vsix, DATE)).rejects.toThrow(
        /does not contain the browser extension/
      )
    })
  })

  describe('checked before they are published', () => {
    it('pass when the .vsix and the zip are consistent', async () => {
      const vsix = await writeVsix()
      await expect(verify(vsix, await writeZipOf(vsix))).resolves.toBeUndefined()
    })

    it('fail when the .vsix is of another version', async () => {
      const vsix = await writeVsix({ version: '0.1.9' })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /the \.vsix is not version 0\.2\.0/
      )
    })

    it('fail when the CHANGELOG packaged in the .vsix lacks the version (packed before the bump)', async () => {
      const vsix = await writeVsix({
        changelog: '# Changelog\n\n## Unreleased\n\n- Entry.\n'
      })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /CHANGELOG inside the \.vsix has no entries for 0\.2\.0/
      )
    })

    it('fail when something the extension needs is not in the .vsix', async () => {
      const vsix = await writeVsix({ extra: { 'extension/out/hub.cjs': null } })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /missing extension\/out\/hub\.cjs/
      )
    })

    it('fail when the README or the CHANGELOG did not make it into the .vsix', async () => {
      const vsix = await writeVsix({
        extra: { 'extension/readme.md': null, 'extension/changelog.md': null }
      })
      const rejected = verify(vsix, await writeZipOf(vsix))
      await expect(rejected).rejects.toThrow(/missing extension\/readme\.md/)
      await expect(rejected).rejects.toThrow(/missing extension\/changelog\.md/)
    })

    it('read the README and CHANGELOG whatever the case of their names', async () => {
      const vsix = await writeVsix({
        extra: {
          'extension/readme.md': null,
          'extension/changelog.md': null,
          'extension/README.md': '# CodeGent\n',
          'extension/CHANGELOG.md': '## 0.2.0\n\n- Entry.\n'
        }
      })
      await expect(verify(vsix, await writeZipOf(vsix))).resolves.toBeUndefined()
    })

    it('fail when sources, source maps or dependencies ship in the .vsix', async () => {
      const vsix = await writeVsix({
        extra: {
          'extension/out/extension.js.map': '{}',
          'extension/src/extension.ts': 'x',
          'extension/node_modules/left-pad/index.js': 'x',
          'extension/webview/main.tsx': 'x'
        }
      })
      const rejected = verify(vsix, await writeZipOf(vsix))
      await expect(rejected).rejects.toThrow(/extension\.js\.map, which should not ship/)
      await expect(rejected).rejects.toThrow(/extension\/src\/extension\.ts/)
      await expect(rejected).rejects.toThrow(/node_modules\/left-pad/)
      await expect(rejected).rejects.toThrow(/extension\/webview\/main\.tsx/)
    })

    it('fail when the zip holds a different browser extension than the .vsix', async () => {
      const vsix = await writeVsix()
      const other = await writeVsix({ browser: { 'content.js': 'changed' } }, 'b.vsix')
      await expect(verify(vsix, await writeZipOf(other, 'b.zip'))).rejects.toThrow(
        /content\.js differs between the zip and the \.vsix/
      )
    })

    it('fail when the zip lacks a file the .vsix carries', async () => {
      const vsix = await writeVsix()
      const smaller = await writeVsix(
        { browser: { 'popup.css': null, 'popup.html': null } },
        'b.vsix'
      )
      await expect(verify(vsix, await writeZipOf(smaller, 'b.zip'))).rejects.toThrow(
        /the zip has 5 files but the \.vsix carries 7/
      )
    })

    it('fail when the browser extension is not of the version', async () => {
      const stale = { ...browserManifest('0.1.9') }
      const vsix = await writeVsix({
        browser: { 'manifest.json': JSON.stringify(stale) }
      })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /browser extension is version 0\.1\.9, not 0\.2\.0/
      )
    })

    it('fail when the manifest names a file that is not there', async () => {
      const broken = {
        ...browserManifest('0.2.0'),
        background: { service_worker: 'worker.js' }
      }
      const vsix = await writeVsix({
        browser: { 'manifest.json': JSON.stringify(broken) }
      })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /manifest\.json names worker\.js, which is missing/
      )
    })

    it('fail when the popup names a script that is not there', async () => {
      const vsix = await writeVsix({ browser: { 'popup.js': null } })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /popup\.html names popup\.js, which is missing/
      )
    })

    it('fail when the browser extension was built for other hub ports (a test build)', async () => {
      const vsix = await writeVsix({
        browser: { 'background.js': 'const ports=[47680,47681];' }
      })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /background\.js lacks the default hub port 47615: was it built for the test ports\?/
      )
    })

    it('fail when the browser extension newly asks for something the docs never mention', async () => {
      const wider = {
        ...browserManifest('0.2.0'),
        permissions: ['storage', 'alarms', 'scripting', 'tabs']
      }
      const vsix = await writeVsix({
        browser: { 'manifest.json': JSON.stringify(wider) }
      })
      await expect(verify(vsix, await writeZipOf(vsix))).rejects.toThrow(
        /newly asks for permission tabs; document why in docs\/safety-and-privacy\.md first/
      )
      await expect(
        verify(vsix, await writeZipOf(vsix), { docs: `${DOCS} tabs` })
      ).resolves.toBeUndefined()
    })

    it('skip the permission comparison when there is no earlier release to compare with', async () => {
      const wider = { ...browserManifest('0.2.0'), permissions: ['tabs'] }
      const vsix = await writeVsix({
        browser: { 'manifest.json': JSON.stringify(wider) }
      })
      await expect(
        verify(vsix, await writeZipOf(vsix), { previousManifest: null })
      ).resolves.toBeUndefined()
    })

    it('report every problem at once, not just the first', async () => {
      const vsix = await writeVsix({
        version: '0.1.9',
        extra: { 'extension/out/hub.cjs': null },
        browser: { 'background.js': 'nothing' }
      })
      const rejected = verify(vsix, await writeZipOf(vsix))
      await expect(rejected).rejects.toThrow(/release files have problems:/)
      await expect(rejected).rejects.toThrow(/not version 0\.2\.0/)
      await expect(rejected).rejects.toThrow(/missing extension\/out\/hub\.cjs/)
      await expect(rejected).rejects.toThrow(/lacks the default hub port/)
    })
  })
})
