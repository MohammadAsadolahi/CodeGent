import type { JobFailureCode } from '@codegent/protocol'
import { describePage } from './describe'
import { AbortedError, hasReadableText, normalizeSpace, truncate } from './dom-utils'
import {
  detectBlockingBanner,
  findContinueButton,
  hasStreamingMarkers,
  isGenerating,
  listAssistantMessages,
  listTurns,
  listUserMessages,
  messageId,
  turnKey,
  turnRole,
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
  turnKeys: string[]
  turnCount: number
}

/** What the conversation looks like right before we send, so "new" messages can be told apart. */
export const takeSnapshot = (doc: Document): Snapshot => {
  const assistants = listAssistantMessages(doc)
  const turns = listTurns(doc)
  return {
    assistantIds: assistants
      .map((m) => messageId(m))
      .filter((id): id is string => id !== undefined),
    assistantCount: assistants.length,
    userCount: listUserMessages(doc).length,
    turnKeys: turns
      .map((t) => turnKey(t))
      .filter((key): key is string => key !== undefined),
    turnCount: turns.length
  }
}

/** New assistant messages, for pages that mark every message with its author. */
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

/**
 * What a turn contributes to the reply when the page does not mark its messages. A turn may hold
 * only the assistant's answer, only our prompt, or both (the page wraps one exchange in a single
 * container): whatever follows our prompt inside it is the answer, and a turn that does not
 * contain the prompt is taken whole.
 */
const replyPartsOf = (turn: HTMLElement, promptText: string): HTMLElement[] => {
  const head = normalizeSpace(promptText).slice(0, 60)
  const holds = (element: Element) =>
    normalizeSpace(element.textContent ?? '').includes(head)
  if (head === '' || !holds(turn)) return [turn]

  // Walk down to the smallest element that still contains the whole start of our prompt.
  let prompt: HTMLElement = turn
  for (;;) {
    const inner = Array.from(prompt.children).find(holds) as HTMLElement | undefined
    if (!inner) break
    prompt = inner
  }
  const parts: HTMLElement[] = []
  for (
    let node = prompt;
    node !== turn && node.parentElement;
    node = node.parentElement
  ) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (hasReadableText(next)) parts.push(next as HTMLElement)
    }
  }
  return parts
}

/**
 * New assistant output, for pages whose messages carry no author marker. Turns only ever append
 * during a run, so everything after the ones that existed at send time is new.
 */
export const freshAssistantTurns = (
  doc: Document,
  snapshot: Snapshot,
  promptText = ''
): HTMLElement[] => {
  const turns = listTurns(doc)
  const keys = turns.map((turn) => turnKey(turn))
  const usable =
    snapshot.turnKeys.length === snapshot.turnCount &&
    keys.every((key) => key !== undefined) &&
    new Set(keys).size === keys.length
  const known = new Set(snapshot.turnKeys)
  const fresh = usable
    ? turns.filter((_, index) => !known.has(keys[index]!))
    : turns.slice(snapshot.turnCount)
  // Our own message is in the first new turn (alone, or together with the reply); a later turn
  // is taken whole even if it happens to repeat the first words of the prompt.
  return fresh.flatMap((turn, index) => {
    const role = turnRole(turn)
    if (role === 'user') return []
    if (role === 'assistant' || index > 0) return [turn]
    return replyPartsOf(turn, promptText)
  })
}

/** The elements that hold the reply to the prompt that was just sent, newest page layout or old. */
export const freshReplyElements = (
  doc: Document,
  snapshot: Snapshot,
  promptText = ''
): HTMLElement[] => {
  const messages = freshAssistantMessages(doc, snapshot)
  return messages.length > 0 ? messages : freshAssistantTurns(doc, snapshot, promptText)
}

export interface WaitForReplyOptions {
  snapshot: Snapshot
  timeoutMs: number
  signal?: AbortSignal
  /** The prompt that was sent; lets the reply be told apart from it on pages without author roles. */
  promptText?: string
  /** Text must be unchanged and nothing streaming for this long (when streaming was observed). */
  settleMs?: number
  /** Longer settle used when no streaming indicator was ever seen (selectors may be stale). */
  degradedSettleMs?: number
  /** Settle used while only a weak streaming hint (not the stop button) is still present. */
  softSettleMs?: number
  /** How long after the stop button vanished a missing reply is tolerated before giving up. */
  noReplyGraceMs?: number
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

const bucket = (length: number): number =>
  length <= 0 ? 0 : 10 ** Math.ceil(Math.log10(length))

/**
 * Resolves once a *new* assistant reply exists, nothing is streaming any more and its text has
 * stopped changing. Rejects with {@link ReplyError} (timeout, rate limit, page error) or
 * {@link AbortedError}. A run never waits silently for a reply it cannot see: if generation
 * visibly ended and no reply can be found on the page, it fails right away, naming what the
 * page looked like.
 */
export const waitForReply = (
  doc: Document,
  options: WaitForReplyOptions
): Promise<ReplyResult> =>
  new Promise<ReplyResult>((resolve, reject) => {
    const settleMs = options.settleMs ?? 1_500
    const degradedSettleMs = options.degradedSettleMs ?? 6_000
    const softSettleMs = options.softSettleMs ?? 6_000
    const noReplyGraceMs = options.noReplyGraceMs ?? 25_000
    const maxContinueClicks = options.maxContinueClicks ?? 5
    const startedAt = Date.now()

    let sawStreaming = false
    let sawStopButton = false
    let lastStopAt = startedAt
    let lastText = ''
    let lastChangeAt = startedAt
    let continueClicks = 0
    let bannerPolls = 0
    let finished = false
    let scheduled: ReturnType<typeof setTimeout> | undefined

    // What was seen, newest last: shown when the wait fails so the cause is visible.
    const trace: string[] = []
    let lastTrace = ''
    const note = (now: number, entry: string) => {
      if (entry === lastTrace) return
      lastTrace = entry
      trace.push(`+${Math.round((now - startedAt) / 1000)}s ${entry}`)
      if (trace.length > 12) trace.shift()
    }
    const diagnosis = () =>
      `[Page: ${describePage(doc)}. Seen: ${trace.join(' → ') || 'nothing'}]`

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
                (hint ? ` The page is showing: “${truncate(hint, 160)}”.` : '') +
                ` ${diagnosis()}`
            )
          )
        )
      }

      const fresh = freshReplyElements(doc, options.snapshot, options.promptText)
      const generating = isGenerating(doc)
      const hinted = !generating && hasStreamingMarkers(doc)
      if ((generating || hinted) && !sawStreaming) {
        sawStreaming = true
        options.onGenerating?.()
      }
      if (generating) {
        sawStopButton = true
        lastStopAt = now
      }

      const text = fresh.map((m) => m.textContent ?? '').join('\u0000')
      note(
        now,
        `${generating ? 'generating' : hinted ? 'hint' : 'idle'} turns=${listTurns(doc).length} reply=${fresh.length}/${bucket(text.length)}ch`
      )

      if (fresh.length === 0) {
        const banner = detectBlockingBanner(doc)
        bannerPolls = banner && !generating && !hinted ? bannerPolls + 1 : 0
        if (banner && bannerPolls >= 3) {
          return settle(() =>
            reject(new ReplyError(banner.kind, truncate(banner.text, 300)))
          )
        }
        // Generation ran and ended, yet there is nothing to read: the page's layout is not one
        // we understand. Say so now instead of waiting for the full timeout.
        if (
          sawStopButton &&
          !generating &&
          now - lastStopAt > noReplyGraceMs &&
          !visibleOverlayText(doc)
        ) {
          return settle(() =>
            reject(
              new ReplyError(
                'page-error',
                'ChatGPT stopped generating, but CodeGent could not find its reply on the ' +
                  `page (the site's layout may have changed). ${diagnosis()}`
              )
            )
          )
        }
        return
      }
      bannerPolls = 0

      if (text !== lastText || generating) {
        lastText = text
        lastChangeAt = now
      }

      // A reply cut off by the length limit offers "Continue generating". The button only exists
      // once generation has stopped, so it is trusted even if a stale streaming marker lingers.
      const continueButton = findContinueButton(doc)
      if (continueButton && !generating && continueClicks < maxContinueClicks) {
        continueClicks += 1
        lastChangeAt = now
        continueButton.click()
        return
      }
      if (generating) return

      const required = hinted ? softSettleMs : sawStreaming ? settleMs : degradedSettleMs
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
