/**
 * Everything CodeGent knows about the ChatGPT page lives in this file. The site changes its
 * markup from time to time (the last big redesign dropped most `data-testid` hooks and the
 * per-message author attributes the page used to carry), so every lookup tries several
 * selectors in order of confidence and reports which one matched (the popup's self-test shows
 * that). Fixing a site change should only ever require editing this file.
 */
import { isVisible, normalizeSpace, queryVisible } from './dom-utils'

export const COMPOSER_SELECTORS = [
  'div#prompt-textarea[contenteditable="true"]',
  '#prompt-textarea[contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea#prompt-textarea',
  'textarea[name="prompt-textarea"]',
  'main div[contenteditable="true"]',
  'div[contenteditable="true"]'
] as const

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button#composer-submit-button',
  'button[data-composer-submit]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]'
] as const

export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label^="Stop"]'
] as const

/** The square "stop" glyph, used when the button has neither a test id nor a label. */
const STOP_ICON_PATH = 'path[d^="M4.5 5.75C4.5 5.05964"]'

export const ASSISTANT_MESSAGE = '[data-message-author-role="assistant"]'
export const USER_MESSAGE = '[data-message-author-role="user"]'

/**
 * What a conversation turn looks like. Listed from the newest markup to the oldest; a turn is
 * the outermost element matching any of them, so it does not matter which of these the page
 * actually carries.
 */
export const TURN_SELECTORS = [
  '[data-talvt-turn-state]',
  '[data-testid^="conversation-turn"]',
  '[data-turn]',
  'article',
  '[data-message-author-role]'
] as const

const LOGGED_OUT_MARKERS = [
  '[data-testid="login-button"]',
  '[data-testid="signup-button"]',
  '[data-testid="welcome-login-button"]'
] as const
/** The sign-in buttons carry no test id any more; they are recognised by their label. */
const LOGGED_OUT_LABEL = /^(log ?in|sign ?up( for free)?)$/i

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
  /^(stream|generat|in[_-]?progress|pending|running|think|loading|start|activ|work|writ|process)/i
const STOP_LABEL = /^\s*stop\b/i

export interface Located<T extends Element> {
  element: T
  selector: string
}

export const findComposer = (doc: Document): Located<HTMLElement> | null =>
  queryVisible(doc, COMPOSER_SELECTORS)

export const isButtonEnabled = (button: HTMLElement): boolean =>
  !(button as HTMLButtonElement).disabled &&
  button.getAttribute('aria-disabled') !== 'true'

const isStopLabelled = (button: Element): boolean =>
  STOP_LABEL.test(button.getAttribute('aria-label') ?? '')

/**
 * The button that sends the prompt. On the current page it is one button that turns into the
 * stop button while a reply streams, so anything labelled "Stop" is never a send button. When no
 * known selector matches, the composer's own form is asked for its submit button.
 */
export const findSendButton = (
  doc: Document,
  composer?: Element | null
): Located<HTMLElement> | null => {
  for (const selector of SEND_BUTTON_SELECTORS) {
    for (const element of doc.querySelectorAll(selector)) {
      if (isVisible(element) && !isStopLabelled(element)) return { element, selector }
    }
  }
  const form = composer?.closest('form')
  if (form) {
    for (const element of form.querySelectorAll('button[type="submit"]')) {
      if (isVisible(element) && !isStopLabelled(element)) {
        return { element, selector: 'form button[type="submit"]' }
      }
    }
  }
  return null
}

export const findStopButton = (doc: Document): Located<HTMLElement> | null => {
  const direct = queryVisible(doc, STOP_BUTTON_SELECTORS)
  if (direct) return direct
  // The single send/stop button announces its stop state through the label it advertises.
  for (const button of doc.querySelectorAll('button[data-composer-submit]')) {
    const stopLabel = button.getAttribute('data-stop-label')
    if (
      stopLabel &&
      button.getAttribute('aria-label') === stopLabel &&
      isVisible(button)
    ) {
      return { element: button, selector: 'button[data-composer-submit] (stop label)' }
    }
  }
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

// ── conversation turns ───────────────────────────────────────────────────────────────────────
/** The conversation turns in document order (outermost match only, so nothing is counted twice). */
export const listTurns = (doc: Document): HTMLElement[] => {
  const selector = TURN_SELECTORS.join(',')
  const scope = doc.querySelector('main')
  let found = scope ? Array.from(scope.querySelectorAll<HTMLElement>(selector)) : []
  if (found.length === 0 && doc.body)
    found = Array.from(doc.body.querySelectorAll<HTMLElement>(selector))
  const all = new Set(found)
  return found.filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (all.has(parent)) return false
    }
    return true
  })
}

/** 'user' / 'assistant' when the turn says so (on itself or on the message inside it). */
export const turnRole = (turn: Element): string | undefined => {
  const own =
    turn.getAttribute('data-turn') ?? turn.getAttribute('data-message-author-role')
  const inner = turn
    .querySelector('[data-message-author-role]')
    ?.getAttribute('data-message-author-role')
  return (own ?? inner)?.toLowerCase() || undefined
}

export const turnState = (turn: Element): string | undefined =>
  turn.getAttribute('data-talvt-turn-state') ?? undefined

/** A stable identity for a turn when the page provides one. */
export const turnKey = (turn: Element): string | undefined =>
  turn.getAttribute('data-turn-id') ??
  turn.getAttribute('data-message-id') ??
  turn.querySelector('[data-message-id]')?.getAttribute('data-message-id') ??
  (/^conversation-turn-\d+$/.test(turn.getAttribute('data-testid') ?? '')
    ? turn.getAttribute('data-testid')!
    : undefined)

// ── streaming ────────────────────────────────────────────────────────────────────────────────
/** True while ChatGPT is certainly producing a reply: its stop button is on the page. */
export const isGenerating = (doc: Document): boolean => findStopButton(doc) !== null

/**
 * Weaker hints that a reply is in progress (a streaming class, a turn that has not reached its
 * final state). They can go stale, so a reply is accepted once its text has stopped changing for
 * a while even if one of them is still present.
 */
export const hasStreamingMarkers = (doc: Document): boolean => {
  if (doc.querySelector('.result-streaming')) return true
  for (const turn of doc.querySelectorAll('[data-talvt-turn-state]')) {
    if (turnRole(turn) === 'user') continue
    if (IN_PROGRESS_STATE.test(turnState(turn) ?? '')) return true
  }
  return false
}

export const isStreaming = (doc: Document): boolean =>
  isGenerating(doc) || hasStreamingMarkers(doc)

// ── page state ───────────────────────────────────────────────────────────────────────────────
export const detectLoggedOut = (doc: Document): boolean => {
  if (queryVisible(doc, LOGGED_OUT_MARKERS) !== null) return true
  const inConversation = TURN_SELECTORS.join(',')
  for (const control of doc.querySelectorAll('button, a')) {
    if (
      LOGGED_OUT_LABEL.test(normalizeSpace(control.textContent ?? '')) &&
      !control.closest(inConversation) &&
      isVisible(control)
    )
      return true
  }
  return false
}

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
