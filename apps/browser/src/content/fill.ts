import { normalizeSpace, sleep, waitFor } from './dom-utils'
import { findSendButton, isButtonEnabled } from './selectors'

export type FillStrategyName = 'inner-text' | 'paste-event' | 'exec-command'

export const DEFAULT_FILL_ORDER: readonly FillStrategyName[] = [
  'inner-text',
  'paste-event',
  'exec-command'
]

export interface FillOptions {
  signal?: AbortSignal
  strategies?: readonly FillStrategyName[]
  /** Wait for the send button to enable (when it can be found) before accepting a strategy. */
  requireSendEnabled?: boolean
}

export interface FillResult {
  ok: boolean
  strategy?: FillStrategyName
  /** Why other strategies were rejected, or why filling failed. */
  detail?: string
  sendButtonSeen?: boolean
}

const isTextarea = (el: HTMLElement): el is HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement

export const readComposerText = (el: HTMLElement): string =>
  isTextarea(el) ? el.value : (el.innerText ?? el.textContent ?? '')

const setNativeValue = (el: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const selectContents = (el: HTMLElement): void => {
  const doc = el.ownerDocument
  const selection = doc.defaultView?.getSelection()
  if (!selection) return
  const range = doc.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

const execCommand = (doc: Document, command: string, value?: string): boolean => {
  const fn = (doc as Document & { execCommand?: Document['execCommand'] }).execCommand
  return typeof fn === 'function' ? fn.call(doc, command, false, value) : false
}

export const clearComposer = async (
  el: HTMLElement,
  signal?: AbortSignal
): Promise<boolean> => {
  if (isTextarea(el)) {
    setNativeValue(el, '')
    return el.value === ''
  }
  el.focus()
  selectContents(el)
  execCommand(el.ownerDocument, 'delete')
  if (normalizeSpace(readComposerText(el)) === '') return true
  el.innerHTML = '<p><br></p>'
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }))
  await sleep(60, signal)
  return normalizeSpace(readComposerText(el)) === ''
}

/** Whether the composer holds (essentially) exactly `expected`, ignoring whitespace layout. */
export const composerHolds = (el: HTMLElement, expected: string): boolean => {
  const have = normalizeSpace(readComposerText(el))
  const want = normalizeSpace(expected)
  if (!want) return have === ''
  if (!have.includes(want.slice(0, 80)) || !have.includes(want.slice(-80))) return false
  return (
    Math.abs(have.length - want.length) <= Math.max(16, Math.round(want.length * 0.02))
  )
}

const STRATEGIES: Record<FillStrategyName, (el: HTMLElement, text: string) => void> = {
  // Assign the text and tell the editor its DOM changed.
  'inner-text': (el, text) => {
    el.innerText = text
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    )
  },
  // Dispatch a paste carrying plain text; rich editors turn it into paragraphs themselves.
  'paste-event': (el, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.focus()
    selectContents(el)
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      })
    )
  },
  // Ask the browser to insert text at the caret, as if typed.
  'exec-command': (el, text) => {
    el.focus()
    selectContents(el)
    execCommand(el.ownerDocument, 'insertText', text)
  }
}

/**
 * Puts `text` into the composer. Each strategy is verified by reading the composer back (and,
 * when possible, by the send button becoming enabled — proof the editor registered the change);
 * the composer is cleared between attempts so a half-accepted strategy can never duplicate text.
 */
export const fillComposer = async (
  composer: HTMLElement,
  text: string,
  options: FillOptions = {}
): Promise<FillResult> => {
  const { signal } = options
  const doc = composer.ownerDocument

  if (isTextarea(composer)) {
    setNativeValue(composer, text)
    return composer.value === text
      ? { ok: true, strategy: 'inner-text' }
      : { ok: false, detail: 'textarea rejected the value' }
  }

  const failures: string[] = []
  for (const name of options.strategies ?? DEFAULT_FILL_ORDER) {
    if (!(await clearComposer(composer, signal))) {
      failures.push(`${name}: composer could not be cleared`)
      continue
    }
    try {
      STRATEGIES[name](composer, text)
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message}`)
      continue
    }

    let sendButtonSeen = false
    const accepted = await waitFor(
      () => {
        if (!composerHolds(composer, text)) return false
        if (!options.requireSendEnabled) return true
        const button = findSendButton(doc)
        if (!button) return false
        sendButtonSeen = true
        return isButtonEnabled(button.element)
      },
      { timeoutMs: 1_500, intervalMs: 60, signal }
    )
    if (accepted) return { ok: true, strategy: name, sendButtonSeen }
    // The text is there but no send button ever showed up: selectors may simply be stale, so
    // trust the read-back rather than discarding a strategy that did work.
    if (options.requireSendEnabled && !sendButtonSeen && composerHolds(composer, text)) {
      return {
        ok: true,
        strategy: name,
        sendButtonSeen: false,
        detail: 'send button not detected'
      }
    }
    failures.push(`${name}: text was not accepted by the editor`)
  }
  await clearComposer(composer, signal)
  return { ok: false, detail: failures.join('; ') }
}
