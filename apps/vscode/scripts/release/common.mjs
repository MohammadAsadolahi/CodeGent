/** A problem the person making a release can act on: shown as a message, without a stack trace. */
export class ReleaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseError'
  }
}

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `owner/name` of a GitHub remote, from its https or ssh URL. */
export const parseRepo = (url) => {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match) throw new ReleaseError(`"${url.trim()}" is not a GitHub repository URL`)
  return match[1]
}

export const formatSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MB`
