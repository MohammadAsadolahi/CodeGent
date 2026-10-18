import type { JobFailureCode } from '@codegent/protocol'
import { AbortedError, truncate } from './dom-utils'
import {
  detectBlockingBanner,
  findContinueButton,
  findStopButton,
  isStreaming,
  listAssistantMessages,
  listUserMessages,
  messageId,
  visibleOverlayText
} from './selectors'

/** A failure that maps directly onto a protocol failure code. */
export class ReplyError extends Error {
  constructor(
    readonly code: JobFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'ReplyError'
  }
}

export interface Snapshot {
  assistantIds: string[]
  assistantCount: number
  userCount: number
}

/** What the conversation looks like right before we send, so "new" messages can be told apart. */
export const takeSnapshot = (doc: Document): Snapshot => {
  const assistants = listAssistantMessages(doc)
  return {
    assistantIds: assistants
      .map((m) => messageId(m))
      .filter((id): id is string => id !== undefined),
    assistantCount: assistants.length,
    userCount: listUserMessages(doc).length
  }
}

export const freshAssistantMessages = (
  doc: Document,
  snapshot: Snapshot
): HTMLElement[] => {
  const all = listAssistantMessages(doc)
  if (all.every((m) => messageId(m) !== undefined)) {
    const known = new Set(snapshot.assistantIds)
    return all.filter((m) => !known.has(messageId(m)!))
  }
  return all.slice(snapshot.assistantCount)
}

export interface WaitForReplyOptions {
  snapshot: Snapshot
  timeoutMs: number
  signal?: AbortSignal
  /** Text must be unchanged and nothing streaming for this long (when streaming was observed). */
  settleMs?: number
  /** Longer settle used when no streaming indicator was ever seen (selectors may be stale). */
  degradedSettleMs?: number
  maxContinueClicks?: number
  pollMs?: number
  onGenerating?: () => void
}

export interface ReplyResult {
  messages: HTMLElement[]
  sawStreaming: boolean
}

let activeEvaluate: (() => void) | null = null

/** Lets the service worker's heartbeat re-run the check when page timers are throttled. */
export const pokeActiveWait = (): void => activeEvaluate?.()

/**
 * Resolves once a *new* assistant reply exists, nothing is streaming any more and its text has
 * stopped changing. Rejects with {@link ReplyError} (timeout, rate limit, page error) or
 * {@link AbortedError}.
 */
export const waitForReply = (
  doc: Document,
  options: WaitForReplyOptions
): Promise<ReplyResult> =>
  new Promise<ReplyResult>((resolve, reject) => {
    const settleMs = options.settleMs ?? 1_500
    const degradedSettleMs = options.degradedSettleMs ?? 6_000
    const maxContinueClicks = options.maxContinueClicks ?? 5
    const startedAt = Date.now()

    let sawStreaming = false
    let lastText = ''
    let lastChangeAt = startedAt
    let continueClicks = 0
    let bannerPolls = 0
    let finished = false
    let scheduled: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      finished = true
      observer.disconnect()
      clearInterval(interval)
      if (scheduled) clearTimeout(scheduled)
      options.signal?.removeEventListener('abort', onAbort)
      if (activeEvaluate === evaluate) activeEvaluate = null
    }
    const settle = (action: () => void) => {
      if (finished) return
      cleanup()
      action()
    }
    const onAbort = () => settle(() => reject(new AbortedError()))

    const evaluate = () => {
      if (finished) return
      const now = Date.now()

      if (now - startedAt > options.timeoutMs) {
        const hint = visibleOverlayText(doc)
        return settle(() =>
          reject(
            new ReplyError(
              'timeout',
              'ChatGPT did not finish replying in time.' +
                (hint ? ` The page is showing: “${truncate(hint, 160)}”.` : '')
            )
          )
        )
      }

      const fresh = freshAssistantMessages(doc, options.snapshot)
      const streaming = isStreaming(doc)
      if (streaming && !sawStreaming) {
        sawStreaming = true
        options.onGenerating?.()
      }

      if (fresh.length === 0) {
        const banner = detectBlockingBanner(doc)
        bannerPolls = banner && !streaming ? bannerPolls + 1 : 0
        if (banner && bannerPolls >= 3) {
          return settle(() =>
            reject(new ReplyError(banner.kind, truncate(banner.text, 300)))
          )
        }
        return
      }
      bannerPolls = 0

      const text = fresh.map((m) => m.textContent ?? '').join('\u0000')
      if (text !== lastText || streaming) {
        lastText = text
        lastChangeAt = now
      }

      // A reply cut off by the length limit offers "Continue generating". The button only exists
      // once generation has stopped, so it is trusted even if a stale streaming marker lingers.
      const continueButton = findContinueButton(doc)
      if (continueButton && !findStopButton(doc) && continueClicks < maxContinueClicks) {
        continueClicks += 1
        lastChangeAt = now
        continueButton.click()
        return
      }
      if (streaming) return

      const required = sawStreaming ? settleMs : degradedSettleMs
      if (now - lastChangeAt >= required && text.replace(/\u0000/g, '').trim() !== '') {
        settle(() => resolve({ messages: fresh, sawStreaming }))
      }
    }

    // Mutations arrive in bursts while streaming; coalesce them into one evaluation.
    const schedule = () => {
      if (scheduled || finished) return
      scheduled = setTimeout(() => {
        scheduled = undefined
        evaluate()
      }, 40)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    })
    const interval = setInterval(evaluate, options.pollMs ?? 250)
    activeEvaluate = evaluate

    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    evaluate()
  })
