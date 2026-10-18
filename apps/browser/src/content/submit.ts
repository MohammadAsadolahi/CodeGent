import { normalizeSpace, waitFor } from './dom-utils'
import { readComposerText } from './fill'
import {
  findSendButton,
  findStopButton,
  isButtonEnabled,
  listTurns,
  listUserMessages
} from './selectors'

export interface SubmitResult {
  ok: boolean
  via?: 'button' | 'enter'
  detail?: string
}

export const pressEnter = (el: HTMLElement): void => {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }
  el.focus()
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

/**
 * The message left the composer: a new user message or turn exists, generation started, or the
 * box emptied. `turnsBefore` is the number of turns on the page when the prompt was typed.
 */
export const submissionConfirmed = (
  doc: Document,
  composer: HTMLElement,
  userMessagesBefore: number,
  turnsBefore = Number.POSITIVE_INFINITY
): boolean =>
  listUserMessages(doc).length > userMessagesBefore ||
  listTurns(doc).length > turnsBefore ||
  findStopButton(doc) !== null ||
  normalizeSpace(readComposerText(composer)) === ''

/**
 * Sends the prompt that is currently in the composer. Prefers the send button; falls back to the
 * Enter key. Every attempt is confirmed against the page so a silent no-op is never mistaken for
 * success (and a second attempt cannot double-send, because an emptied composer ignores Enter).
 */
export const submitPrompt = async (
  doc: Document,
  composer: HTMLElement,
  options: {
    userMessagesBefore: number
    turnsBefore?: number
    signal?: AbortSignal
    confirmTimeoutMs?: number
  }
): Promise<SubmitResult> => {
  const { signal, userMessagesBefore, turnsBefore } = options
  const confirmTimeout = options.confirmTimeoutMs ?? 4_000
  const confirmed = () =>
    submissionConfirmed(doc, composer, userMessagesBefore, turnsBefore)

  // A send button that exists but is still disabled may enable any moment, so it is worth
  // waiting for; one that is not on the page at all is not — the Enter key does the same job.
  const present = await waitFor(() => findSendButton(doc, composer), {
    timeoutMs: 1_500,
    intervalMs: 80,
    signal
  })
  const button = present
    ? await waitFor(
        () => {
          const found = findSendButton(doc, composer)
          return found && isButtonEnabled(found.element) ? found.element : null
        },
        { timeoutMs: 6_000, intervalMs: 80, signal }
      )
    : null
  if (button) {
    button.click()
    if (await waitFor(confirmed, { timeoutMs: confirmTimeout, intervalMs: 80, signal })) {
      return { ok: true, via: 'button' }
    }
  }

  pressEnter(composer)
  if (await waitFor(confirmed, { timeoutMs: confirmTimeout, intervalMs: 80, signal })) {
    return { ok: true, via: 'enter' }
  }
  return {
    ok: false,
    detail: button
      ? 'The send button and the Enter key did not submit the prompt.'
      : 'No enabled send button was found and the Enter key did not submit the prompt.'
  }
}
