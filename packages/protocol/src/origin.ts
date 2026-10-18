import type { Role } from './messages'

export type OriginKind = 'none' | 'extension' | 'other'

/**
 * Classifies the `Origin` header of a WebSocket upgrade request.
 *
 * Browsers set `Origin` themselves and page scripts cannot forge or omit it, so this is what
 * keeps arbitrary websites out of the hub. Extension contexts carry an extension origin; Node
 * clients (the VS Code extension host) send none.
 */
export const classifyOrigin = (origin: string | undefined): OriginKind => {
  if (origin === undefined || origin === '') return 'none'
  // Chromium (Chrome, Edge, …): 32 chars a–p. Firefox: a UUID. Safari: a bundle-style id.
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return 'extension'
  if (/^moz-extension:\/\/[0-9a-f-]{36}$/i.test(origin)) return 'extension'
  return 'other'
}

/** Editors must not send an Origin; browsers must send an extension Origin. */
export const isOriginAllowedForRole = (
  role: Role,
  origin: string | undefined
): boolean => {
  const kind = classifyOrigin(origin)
  return role === 'editor' ? kind === 'none' : kind === 'extension'
}

/**
 * The `Host` header must name the loopback interface on the hub's own port. This blocks DNS
 * rebinding, where a hostile domain is pointed at 127.0.0.1.
 */
export const isAllowedHostHeader = (host: string | undefined, port: number): boolean => {
  if (!host) return false
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return allowed.includes(host.toLowerCase())
}
