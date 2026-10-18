import type { SelfTestCheck, SelfTestReport } from '../shared/messages'
import { clearComposer, fillComposer } from './fill'
import {
  COMPOSER_SELECTORS,
  detectBlockingBanner,
  detectChallengePage,
  detectLoggedOut,
  findComposer,
  findSendButton,
  findStopButton,
  isStreaming,
  listAssistantMessages,
  messageId
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
    const send = findSendButton(doc)
    check(
      'Send button',
      send !== null,
      send ? `via “${send.selector}”` : 'not found while text is present'
    )
    await clearComposer(composer.element)
  } else {
    const send = findSendButton(doc)
    check(
      'Send button',
      send !== null,
      send ? `via “${send.selector}”` : 'not visible (normal while the box is empty)'
    )
  }

  const stop = findStopButton(doc)
  check(
    'Idle (no reply streaming)',
    !isStreaming(doc),
    stop
      ? `stop button via “${stop.selector}”`
      : isStreaming(doc)
        ? 'streaming signals present'
        : 'idle'
  )

  const assistants = listAssistantMessages(doc)
  check('Assistant messages', true, `${assistants.length} on the page`)
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
    checks
  }
}
