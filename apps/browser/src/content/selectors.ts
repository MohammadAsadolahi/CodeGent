/**
 * Everything CodeGent knows about the ChatGPT page lives in this file. The site changes its
 * markup from time to time, so every lookup tries several selectors in order of confidence and
 * reports which one matched (the popup's self-test shows that). Fixing a site change should only
 * ever require editing this file.
 */
import { isVisible, normalizeSpace, queryVisible } from './dom-utils'

export const COMPOSER_SELECTORS = [
  'div#prompt-textarea[contenteditable="true"]',
  '#prompt-textarea[contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea#prompt-textarea',
  'textarea[name="prompt-textarea"]',
  'main div[contenteditable="true"]'
] as const

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button#composer-submit-button',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]'
] as const

export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label^="Stop"]'
] as const

/** The square "stop" glyph, used when the button's test id / label are not found. */
const STOP_ICON_PATH = 'path[d^="M4.5 5.75C4.5 5.05964"]'

export const ASSISTANT_MESSAGE = '[data-message-author-role="assistant"]'
export const USER_MESSAGE = '[data-message-author-role="user"]'

const LOGGED_OUT_MARKERS = [
  '[data-testid="login-button"]',
  '[data-testid="signup-button"]',
  '[data-testid="welcome-login-button"]'
] as const

const OVERLAY_SELECTORS = [
  '[role="alert"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-testid*="toast"]',
  '[data-testid*="error"]'
] as const

const RATE_LIMIT_PATTERN =
  /(usage|message|free plan|rate|request)s?\s*(cap|limit)|too many (requests|messages)|reached (the|our|your) .{0,40}limit|hit (the|your) .{0,30}limit|try again (later|after|in)\b/i
const PAGE_ERROR_PATTERN =
  /something went wrong|network error|an error occurred|error generating|failed to (load|send)|unusual activity|verify you are human|too many concurrent/i
const IN_PROGRESS_STATE =
  /^(stream|generat|in[_-]?progress|pending|running|think|loading)/i

export interface Located<T extends Element> {
  element: T
  selector: string
}

export const findComposer = (doc: Document): Located<HTMLElement> | null =>
  queryVisible(doc, COMPOSER_SELECTORS)

export const findSendButton = (doc: Document): Located<HTMLElement> | null =>
  queryVisible(doc, SEND_BUTTON_SELECTORS)

export const isButtonEnabled = (button: HTMLElement): boolean =>
  !(button as HTMLButtonElement).disabled &&
  button.getAttribute('aria-disabled') !== 'true'

export const findStopButton = (doc: Document): Located<HTMLElement> | null => {
  const direct = queryVisible(doc, STOP_BUTTON_SELECTORS)
  if (direct) return direct
  for (const path of doc.querySelectorAll(`button ${STOP_ICON_PATH}`)) {
    const button = path.closest('button')
    if (isVisible(button))
      return { element: button, selector: `button ${STOP_ICON_PATH}` }
  }
  return null
}

export const listAssistantMessages = (doc: Document): HTMLElement[] =>
  Array.from(doc.querySelectorAll<HTMLElement>(ASSISTANT_MESSAGE))

export const listUserMessages = (doc: Document): HTMLElement[] =>
  Array.from(doc.querySelectorAll<HTMLElement>(USER_MESSAGE))

export const messageId = (element: Element): string | undefined =>
  element.getAttribute('data-message-id') ?? undefined

/** True while ChatGPT is producing (or about to produce) a reply. */
export const isStreaming = (doc: Document): boolean => {
  if (findStopButton(doc)) return true
  if (doc.querySelector('.result-streaming')) return true
  for (const turn of doc.querySelectorAll('[data-talvt-turn-state]')) {
    const state = turn.getAttribute('data-talvt-turn-state') ?? ''
    if (IN_PROGRESS_STATE.test(state) && turn.querySelector(ASSISTANT_MESSAGE))
      return true
  }
  return false
}

export const detectLoggedOut = (doc: Document): boolean =>
  queryVisible(doc, LOGGED_OUT_MARKERS) !== null

/**
 * A verification challenge (Cloudflare "Just a moment…", "Verify you are human") shown instead
 * of the app. The interstitial is recognisable by its orchestration script and challenge widgets.
 */
export const detectChallengePage = (doc: Document): boolean =>
  /just a moment|attention required|verify you are human/i.test(doc.title) ||
  doc.querySelector(
    'iframe[src*="challenges.cloudflare.com"], #challenge-form, #challenge-running, ' +
      'script[src*="/cdn-cgi/challenge-platform/"][src*="orchestrate"]'
  ) !== null

export interface Banner {
  kind: 'rate-limited' | 'page-error'
  text: string
}

/**
 * Looks for site-level warnings (dialogs, alerts, toasts). Message bodies are never scanned, so
 * a reply that merely talks about "limits" cannot trigger it.
 */
export const detectBlockingBanner = (doc: Document): Banner | null => {
  for (const selector of OVERLAY_SELECTORS) {
    for (const element of doc.querySelectorAll(selector)) {
      if (!isVisible(element)) continue
      if (element.closest(`${ASSISTANT_MESSAGE}, ${USER_MESSAGE}`)) continue
      const text = normalizeSpace(element.textContent ?? '')
      if (!text || text.length > 600) continue
      if (RATE_LIMIT_PATTERN.test(text)) return { kind: 'rate-limited', text }
      if (PAGE_ERROR_PATTERN.test(text)) return { kind: 'page-error', text }
    }
  }
  return null
}

/** Text of any visible dialog/alert — used to hint at things like a connector approval prompt. */
export const visibleOverlayText = (doc: Document): string | null => {
  for (const selector of OVERLAY_SELECTORS) {
    for (const element of doc.querySelectorAll(selector)) {
      if (!isVisible(element)) continue
      const text = normalizeSpace(element.textContent ?? '')
      if (text) return text.slice(0, 200)
    }
  }
  return null
}

/** The "Continue generating" button that appears when a reply hits the length limit. */
export const findContinueButton = (doc: Document): HTMLElement | null => {
  for (const button of doc.querySelectorAll('button')) {
    if (
      isVisible(button) &&
      /^continue generating$/i.test(normalizeSpace(button.textContent ?? ''))
    ) {
      return button
    }
  }
  return null
}

export const isConversationUrl = (url: string): boolean => /\/c\/[\w-]+/.test(url)
