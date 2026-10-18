import { DEFAULT_SETTINGS, type RunSettings } from '@codegent/engine'
import { DEFAULT_CHAT_URL } from '@codegent/protocol'

/** Everything the extension reads from its configuration, already validated and clamped. */
export interface Settings {
  run: RunSettings
  bridge: {
    chatUrl: string
    autoSubmit: boolean
    replyTimeoutMs: number
    browserWaitMs: number
  }
  verify: { command: string; timeoutMs: number }
  diagnosticsWaitMs: number
}

type Getter = <T>(key: string, fallback: T) => T

const ALLOWED_CHAT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com'])

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

/** A setting of the wrong type counts as unset, so the default applies. */
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/** Only chatgpt.com may be opened; anything else silently falls back to the default. */
export const sanitizeChatUrl = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_CHAT_URL
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || !ALLOWED_CHAT_HOSTS.has(url.hostname)) return DEFAULT_CHAT_URL
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return DEFAULT_CHAT_URL
  }
}

/** Builds validated settings from a key → value lookup (VS Code's configuration in production). */
export const buildSettings = (get: Getter, workspaceRoot?: string): Settings => ({
  run: {
    ...DEFAULT_SETTINGS,
    maxSteps: clamp(get('maxSteps', DEFAULT_SETTINGS.maxSteps), 1, 100, DEFAULT_SETTINGS.maxSteps),
    maxFailedSteps: clamp(get('maxFailedSteps', DEFAULT_SETTINGS.maxFailedSteps), 1, 20, DEFAULT_SETTINGS.maxFailedSteps),
    autoApply: flag(get('autoApply', DEFAULT_SETTINGS.autoApply), DEFAULT_SETTINGS.autoApply),
    autoContinue: flag(get('autoContinue', DEFAULT_SETTINGS.autoContinue), DEFAULT_SETTINGS.autoContinue),
    commit: flag(get('git.commit', DEFAULT_SETTINGS.commit), DEFAULT_SETTINGS.commit),
    push: flag(get('git.push', DEFAULT_SETTINGS.push), DEFAULT_SETTINGS.push),
    commitPrefix: text(get('git.commitPrefix', DEFAULT_SETTINGS.commitPrefix), 40).replace(/[\r\n]+/g, ' '),
    conventions: text(get('conventions', ''), 4_000).trim() || undefined,
    allowDirty: flag(get('allowEditingDirtyFiles', false), false),
    workspaceRoot
  },
  bridge: {
    chatUrl: sanitizeChatUrl(get('chatUrl', DEFAULT_CHAT_URL)),
    autoSubmit: flag(get('autoSubmit', true), true),
    replyTimeoutMs: clamp(get('replyTimeoutSeconds', 600), 30, 6 * 3600, 600) * 1_000,
    browserWaitMs: clamp(get('browserWaitSeconds', 40), 0, 600, 40) * 1_000
  },
  verify: {
    command: text(get('verifyCommand', ''), 2_000).trim(),
    timeoutMs: clamp(get('verifyTimeoutSeconds', 300), 5, 3600, 300) * 1_000
  },
  diagnosticsWaitMs: clamp(get('diagnosticsWaitSeconds', 8), 0, 120, 8) * 1_000
})
