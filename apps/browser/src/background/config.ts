import { HUB_PORTS } from '@codegent/protocol'

/** Replaced at build time by the end-to-end test build so tests never touch a real hub. */
declare const __CODEGENT_HUB_PORTS__: readonly number[] | undefined

export const hubPorts: readonly number[] =
  typeof __CODEGENT_HUB_PORTS__ !== 'undefined' ? __CODEGENT_HUB_PORTS__ : HUB_PORTS

/** Pages the extension is willing to open or drive. */
export const CHAT_ORIGINS: readonly string[] = [
  'https://chatgpt.com',
  'https://chat.openai.com'
]
export const CHAT_TAB_PATTERNS: string[] = CHAT_ORIGINS.map((origin) => `${origin}/*`)

export const isChatUrl = (url: string | undefined): boolean => {
  if (!url) return false
  try {
    return CHAT_ORIGINS.includes(new URL(url).origin)
  } catch {
    return false
  }
}

export const KEEPALIVE_ALARM = 'codegent-keepalive'

/** How long a freshly opened tab may take to announce its content script. */
export const CONTENT_READY_TIMEOUT_MS = 45_000
