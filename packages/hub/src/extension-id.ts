import { createHash } from 'node:crypto'

/**
 * The id Chromium gives an unpacked extension whose manifest carries a `key`: the first 128 bits of
 * the SHA-256 of the DER-encoded public key, written with the letters a–p instead of 0–f. Knowing
 * the key means knowing the id (and so the `Origin`) before the extension has ever run.
 */
export const extensionIdFromKey = (manifestKey: string): string => {
  const der = Buffer.from(manifestKey, 'base64')
  if (der.length === 0) throw new Error('the manifest key is empty or not base64')
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('')
}

export const isExtensionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-p]{32}$/.test(value)

/** The `Origin` Chromium sends for pages and workers of the extension. */
export const extensionOrigin = (id: string): string => `chrome-extension://${id}`
