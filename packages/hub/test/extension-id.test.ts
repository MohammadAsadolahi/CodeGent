import { describe, expect, it } from 'vitest'
import { extensionIdFromKey, extensionOrigin, isExtensionId } from '../src/extension-id'

// A key and the id derived from it by an independent route:
//   echo "$KEY" | base64 -d | openssl dgst -sha256 -binary | xxd -p -l 16 | tr '0-9a-f' 'a-p'
const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkqBkaeFsM8YN3/R8ii9mhKWdYgT60cVBQc3VFQxIB0/W+45yWLmUzFXilrRp8aI576I1dUCxNSfpi/VgU++nM2vAJ4AI/x8MOcLwn3ZHkRAWdfKNHf4p+UY+ao6LkV6zWJBwG+M3od4RR+IXdB6qGH3KzxadLXCxteaq/enVgfyD62bfics/lMiDlmNiGf0u8uOhkWlMAEGHlXuhl9B3tacRo5Vf7KV5RKxvk2/wEf3jvc8P+B7cvjNjVOf0Bs8bl/o52Hyw7vvM4BDqNlReJp1sZY0iPDH6Ob96LclltlXbR9K4Qr2MkCSmOaPAN3YBtFsgkTOXr7luNWNCtlZ36QIDAQAB'
const ID = 'nlegpgjojmbcoenlnohofiblhfejkgco'

describe('extensionIdFromKey', () => {
  it('derives the id the way Chromium does', () => {
    expect(extensionIdFromKey(KEY)).toBe(ID)
  })

  it('always yields a well-formed id and origin', () => {
    expect(isExtensionId(extensionIdFromKey(KEY))).toBe(true)
    expect(extensionOrigin(ID)).toBe(`chrome-extension://${ID}`)
  })

  it('rejects an empty key', () => {
    expect(() => extensionIdFromKey('')).toThrow(/empty/)
  })
})

describe('isExtensionId', () => {
  it.each([
    [ID, true],
    ['a'.repeat(32), true],
    ['a'.repeat(31), false],
    ['a'.repeat(33), false],
    ['q'.repeat(32), false], // only a–p
    ['A'.repeat(32), false],
    [undefined, false],
    [42, false]
  ])('%s → %s', (value, expected) => {
    expect(isExtensionId(value)).toBe(expected)
  })
})
