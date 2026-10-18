import type { SelfTestCheck, SelfTestReport } from '../shared/messages'
import { pageOutline } from './describe'
import { normalizeSpace } from './dom-utils'
import { clearComposer, fillComposer } from './fill'
import {
  COMPOSER_SELECTORS,
  detectBlockingBanner,
  detectChallengePage,
  detectLoggedOut,
  findComposer,
  findSendButton,
  findStopButton,
  hasStreamingMarkers,
  isGenerating,
  listAssistantMessages,
  listTurns,
  messageId,
  turnRole,
  turnState
} from './selectors'

/**
 * Reports what the content script can see on the current page so that a site change can be
 * diagnosed in seconds. With `probeFill` it also types a harmless marker into the composer
 * (and clears it again) to prove that entering text works on the live page. Nothing is sent.
 */
export const runSelfTest = async (
  doc: Document,
  options: { probeFill: boolean }
): Promise<SelfTestReport> => {
  const checks: SelfTestCheck[] = []
  const check = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail })

  const host = doc.location.hostname
  check('ChatGPT page', /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(host), host)
  check(
    'Not a verification challenge',
    !detectChallengePage(doc),
    detectChallengePage(doc) ? 'challenge page detected' : 'ok'
  )
  check(
    'Signed in',
    !detectLoggedOut(doc),
    detectLoggedOut(doc) ? 'login/sign-up buttons are visible' : 'no login buttons'
  )

  const composer = findComposer(doc)
  check(
    'Message box',
    composer !== null,
    composer
      ? `<${composer.element.localName}> via “${composer.selector}”`
      : `none of ${COMPOSER_SELECTORS.length} selectors matched`
  )

  if (composer && options.probeFill) {
    const marker = 'codegent self-test — safe to ignore'
    const result = await fillComposer(composer.element, marker, {
      requireSendEnabled: true
    })
    check(
      'Entering text works',
      result.ok,
      result.ok
        ? `strategy “${result.strategy}”${result.sendButtonSeen ? ', send button enabled' : ', send button not detected'}`
        : (result.detail ?? 'failed')
    )
    const send = findSendButton(doc, composer.element)
    check(
      'Send button',
      send !== null,
      send ? `via “${send.selector}”` : 'not found while text is present'
    )
    await clearComposer(composer.element)
  } else {
    const send = findSendButton(doc, composer?.element)
    check(
      'Send button',
      send !== null,
      send ? `via “${send.selector}”` : 'not visible (normal while the box is empty)'
    )
  }

  const stop = findStopButton(doc)
  const generating = isGenerating(doc)
  const hinted = hasStreamingMarkers(doc)
  check(
    'Idle (no reply streaming)',
    !generating && !hinted,
    stop
      ? `stop button via “${stop.selector}”`
      : hinted
        ? 'a streaming hint is present on the page (no stop button)'
        : 'idle'
  )

  const turns = listTurns(doc)
  check(
    'Conversation turns',
    true,
    turns.length
      ? `${turns.length} on the page; last: ${turns
          .slice(-3)
          .map((turn) => `${turnRole(turn) ?? 'role unknown'}/${turnState(turn) ?? 'no state'}`)
          .join(', ')}`
      : 'none on the page (normal for a new chat)'
  )
  const readable = turns.filter(
    (turn) => turnRole(turn) !== 'user' && normalizeSpace(turn.textContent ?? '') !== ''
  )
  if (turns.length > 0) {
    check(
      'Reply readable',
      readable.length > 0,
      readable.length > 0
        ? `${readable.length} turn(s) with text that are not yours`
        : 'turns exist but none has text outside your own messages'
    )
  }

  const assistants = listAssistantMessages(doc)
  check('Assistant messages', true, `${assistants.length} marked as such on the page`)
  const last = assistants.at(-1)
  if (last) {
    check(
      'Message ids',
      messageId(last) !== undefined,
      messageId(last) ?? 'data-message-id missing'
    )
    check(
      'Reply body',
      last.querySelector('.markdown') !== null,
      last.querySelector('.markdown')
        ? '.markdown found'
        : 'no .markdown element; falling back to the whole message'
    )
    check(
      'Code blocks readable',
      true,
      `${last.querySelectorAll('pre').length} <pre> in the last reply (${last.querySelectorAll('pre code').length} with <code>)`
    )
  }
  const turnStates = Array.from(doc.querySelectorAll('[data-talvt-turn-state]'), (el) =>
    el.getAttribute('data-talvt-turn-state')
  )
  check(
    'Turn-state attribute',
    true,
    turnStates.length
      ? `values: ${[...new Set(turnStates)].join(', ')}`
      : 'absent (falls back to other signals)'
  )
  const banner = detectBlockingBanner(doc)
  check(
    'No blocking banner',
    banner === null,
    banner ? `${banner.kind}: ${banner.text.slice(0, 120)}` : 'none'
  )

  return {
    url: doc.location.href,
    at: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks,
    outline: pageOutline(doc)
  }
}
