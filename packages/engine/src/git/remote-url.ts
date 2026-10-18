export interface RemoteIdentity {
  host: string
  /** Everything before the repository name (an organisation, or a group path on other hosts). */
  owner: string
  repo: string
  /** Browser URL of the repository, without any credentials. */
  webUrl: string
}

const clean = (segments: string[]): { owner: string; repo: string } | null => {
  const parts = segments.filter(Boolean)
  if (parts.length < 2) return null
  const repo = parts.at(-1)!.replace(/\.git$/i, '')
  if (!repo) return null
  return { owner: parts.slice(0, -1).join('/'), repo }
}

const identity = (host: string, path: string[]): RemoteIdentity | null => {
  const parts = clean(path)
  if (!parts || !host) return null
  const lowerHost = host.toLowerCase()
  return {
    host: lowerHost,
    owner: parts.owner,
    repo: parts.repo,
    webUrl: `https://${lowerHost}/${parts.owner}/${parts.repo}`
  }
}

/**
 * Reads owner/repo out of a git remote URL (https, ssh, scp-like or git://). Credentials that
 * may be embedded in the URL are dropped and never appear in the result. Local paths are not
 * GitHub repositories and yield null.
 */
export const parseRemoteUrl = (raw: string): RemoteIdentity | null => {
  const url = raw.trim()
  if (!url || /^file:/i.test(url)) return null

  if (/^(?:https?|ssh|git):\/\//i.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    return identity(parsed.hostname, decodeURIComponent(parsed.pathname).split('/'))
  }

  // scp-like: [user@]host:owner/repo.git — but not a Windows drive path such as C:\repo
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?![\\/]{2}|\\)([^\s]+)$/.exec(url)
  if (scp && !/^[A-Za-z]$/.test(scp[1]!)) {
    return identity(scp[1]!, scp[2]!.split('/'))
  }
  return null
}
