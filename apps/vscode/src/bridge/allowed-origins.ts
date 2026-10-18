import { extensionIdFromKey, extensionOrigin, isExtensionId } from '@codegent/hub'

export interface AllowedOrigins {
  /** The `Origin`s the hub should accept as "the browser". Empty means: no restriction. */
  origins: string[]
  /** Things worth writing to the log. */
  notes: string[]
}

/**
 * Which browser extensions may act as the browser: the one bundled with this extension (known by
 * the `key` in its manifest, which fixes its id) plus any ids the user added for their own build.
 * Without the check, any extension installed in the same browser could connect to the hub.
 */
export const allowedBrowserOrigins = (options: {
  bundledManifestKey: unknown
  extraIds: readonly string[]
}): AllowedOrigins => {
  const notes: string[] = []
  if (
    typeof options.bundledManifestKey !== 'string' ||
    options.bundledManifestKey === ''
  ) {
    notes.push(
      'The bundled browser extension has no key, so any browser extension may connect.'
    )
    return { origins: [], notes }
  }
  let bundled: string
  try {
    bundled = extensionOrigin(extensionIdFromKey(options.bundledManifestKey))
  } catch (error) {
    notes.push(
      `The bundled browser extension's key is unusable (${(error as Error).message}).`
    )
    return { origins: [], notes }
  }
  const origins = [bundled]
  for (const id of options.extraIds) {
    if (isExtensionId(id)) origins.push(extensionOrigin(id))
    else
      notes.push(
        `Ignoring "${String(id)}": a browser extension id is 32 letters from a to p.`
      )
  }
  return { origins: [...new Set(origins)], notes }
}
