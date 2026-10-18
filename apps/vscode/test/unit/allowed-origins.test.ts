import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedBrowserOrigins } from '../../src/bridge/allowed-origins'

const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkqBkaeFsM8YN3/R8ii9mhKWdYgT60cVBQc3VFQxIB0/W+45yWLmUzFXilrRp8aI576I1dUCxNSfpi/VgU++nM2vAJ4AI/x8MOcLwn3ZHkRAWdfKNHf4p+UY+ao6LkV6zWJBwG+M3od4RR+IXdB6qGH3KzxadLXCxteaq/enVgfyD62bfics/lMiDlmNiGf0u8uOhkWlMAEGHlXuhl9B3tacRo5Vf7KV5RKxvk2/wEf3jvc8P+B7cvjNjVOf0Bs8bl/o52Hyw7vvM4BDqNlReJp1sZY0iPDH6Ob96LclltlXbR9K4Qr2MkCSmOaPAN3YBtFsgkTOXr7luNWNCtlZ36QIDAQAB'
const OURS = 'chrome-extension://nlegpgjojmbcoenlnohofiblhfejkgco'

describe('allowedBrowserOrigins', () => {
  it('allows the bundled extension, recognised by the key in its manifest', () => {
    expect(allowedBrowserOrigins({ bundledManifestKey: KEY, extraIds: [] })).toEqual({
      origins: [OURS],
      notes: []
    })
  })

  it('adds the ids the user listed, once each, and says what it ignored', () => {
    const own = 'p'.repeat(32)
    const result = allowedBrowserOrigins({
      bundledManifestKey: KEY,
      extraIds: [own, own, 'nlegpgjojmbcoenlnohofiblhfejkgco', 'not-an-id', '']
    })
    expect(result.origins).toEqual([OURS, `chrome-extension://${own}`])
    expect(result.notes).toHaveLength(2)
    expect(result.notes.join(' ')).toContain('not-an-id')
  })

  it.each([[undefined], [''], [42], ['!!!']])(
    'does not restrict anything when the bundled key is unusable (%s) — and says so',
    (key) => {
      const result = allowedBrowserOrigins({
        bundledManifestKey: key,
        extraIds: ['p'.repeat(32)]
      })
      expect(result.origins).toEqual([])
      expect(result.notes.join(' ')).toMatch(/key/)
    }
  )

  it('matches the manifest the browser extension is actually built from', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../browser/static/manifest.json'),
        'utf8'
      )
    )
    expect(
      allowedBrowserOrigins({ bundledManifestKey: manifest.key, extraIds: [] }).origins
    ).toEqual([OURS])
  })
})
