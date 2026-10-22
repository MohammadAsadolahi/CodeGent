import type { JobEvent, JobRequest } from '@codegent/protocol'
import { AbortedError, sleep, truncate, waitFor } from './dom-utils'
import { describePage } from './describe'
import { fillComposer, type FillOptions } from './fill'
import { messagesToMarkdown, replyBodies } from './markdown'
import {
  freshReplyElements,
  ReplyError,
  takeSnapshot,
  waitForReply,
  type WaitForReplyOptions
} from './observe'
import {
  detectChallengePage,
  detectLoggedOut,
  findComposer,
  findStopButton,
  isConversationUrl,
  isGenerating,
  listAssistantMessages,
  listTurns,
  listUserMessages,
  messageId,
  turnKey
} from './selectors'
import { recoverEditBlocks } from './recover'
import { submissionConfirmed, submitPrompt } from './submit'

/** Delays that are fixed in production; tests shorten them. */
export interface RunnerTiming {
  /** How long to wait for the page to show a usable composer. */
  composerTimeoutMs?: number
  /** Pause after the composer appears so the header (login buttons) can render. */
  headerRenderMs?: number
  /** How long a previous reply may keep streaming before we stop it / give up. */
  idleWaitMs?: number
  /** Pause before snapshotting a brand-new chat. */
  newChatPauseMs?: number
  /** Longest wait for a restored conversation to render its history. */
  conversationSettleMs?: number
  /** The history must be unchanged for this long to count as rendered. */
  historyStableMs?: number
  /** How long to wait for the page to confirm that a send took effect. */
  submitConfirmMs?: number
}

export interface RunnerDeps {
  doc: Document
  emit: (event: JobEvent) => void
  signal: AbortSignal
  fill?: Omit<FillOptions, 'signal' | 'requireSendEnabled'>
  wait?: Partial<Omit<WaitForReplyOptions, 'snapshot' | 'timeoutMs' | 'signal'>>
  timing?: RunnerTiming
}

const failure = (error: unknown): JobEvent => {
  if (error instanceof AbortedError) {
    return { kind: 'failed', code: 'cancelled', message: 'The run was cancelled.' }
  }
  if (error instanceof ReplyError) {
    return { kind: 'failed', code: error.code, message: truncate(error.message, 1_900) }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'failed', code: 'internal', message: truncate(message, 1_900) }
}

export const stopGeneration = (doc: Document): void => {
  findStopButton(doc)?.element.click()
}

const waitForUsablePage = async (
  deps: RunnerDeps,
  budgetMs: number
): Promise<HTMLElement> => {
  const { doc, signal } = deps
  const found = await waitFor(
    () => {
      if (detectChallengePage(doc)) {
        throw new ReplyError(
          'page-error',
          'ChatGPT is showing a verification challenge. Complete it in the tab, then retry.'
        )
      }
      return findComposer(doc)
    },
    {
      timeoutMs: Math.min(deps.timing?.composerTimeoutMs ?? 60_000, budgetMs),
      intervalMs: 150,
      signal
    }
  )
  if (!found) {
    if (detectLoggedOut(doc)) {
      throw new ReplyError(
        'login-required',
        'Sign in to ChatGPT in this tab, then retry.'
      )
    }
    throw new ReplyError(
      'composer-not-found',
      'The ChatGPT message box was not found on the page.'
    )
  }
  // The header (with its login buttons) can render a moment after the composer does.
  await sleep(deps.timing?.headerRenderMs ?? 400, signal)
  if (detectLoggedOut(doc)) {
    throw new ReplyError(
      'login-required',
      'You are not signed in to ChatGPT. Sign in (the GitHub connector needs an account), then retry.'
    )
  }
  return found.element
}

const waitForIdle = async (deps: RunnerDeps, budgetMs: number): Promise<void> => {
  const { doc, signal } = deps
  const idle = await waitFor(() => !isGenerating(doc), {
    timeoutMs: Math.min(deps.timing?.idleWaitMs ?? 120_000, budgetMs),
    intervalMs: 100,
    signal
  })
  if (idle) return
  stopGeneration(doc)
  const stopped = await waitFor(() => !isGenerating(doc), {
    timeoutMs: Math.min(4_000, Math.max(300, deps.timing?.idleWaitMs ?? 4_000)),
    intervalMs: 100,
    signal
  })
  if (stopped) return
  throw new ReplyError('busy', 'ChatGPT is still busy with another reply in this tab.')
}

/** A restored conversation renders its history asynchronously; do not snapshot before it settles. */
const waitForConversationSettled = async (
  job: JobRequest,
  deps: RunnerDeps
): Promise<void> => {
  const { doc, signal } = deps
  const expectsHistory = !job.newChat && isConversationUrl(doc.location.href)
  if (!expectsHistory) {
    await sleep(deps.timing?.newChatPauseMs ?? 300, signal)
    return
  }
  const limit = Date.now() + (deps.timing?.conversationSettleMs ?? 15_000)
  const stableFor = deps.timing?.historyStableMs ?? 800
  let lastCount = -1
  let lastChange = Date.now()
  while (Date.now() < limit) {
    const count = Math.max(
      listAssistantMessages(doc).length + listUserMessages(doc).length,
      listTurns(doc).length
    )
    if (count !== lastCount) {
      lastCount = count
      lastChange = Date.now()
    } else if (count > 0 && Date.now() - lastChange >= stableFor) {
      return
    }
    await sleep(50, signal)
  }
}

/**
 * Drives one job to completion and reports every outcome as an event; never throws. The whole
 * run — page readiness, typing, sending and waiting for the reply — shares one deadline.
 */
export const runJob = async (job: JobRequest, deps: RunnerDeps): Promise<void> => {
  const { doc, signal, emit } = deps
  const startedAt = Date.now()
  const deadline = startedAt + job.timeoutMs
  const remaining = (): number => {
    const left = deadline - Date.now()
    if (left <= 0)
      throw new ReplyError('timeout', 'The run ran out of time before ChatGPT replied.')
    return left
  }

  try {
    const composer = await waitForUsablePage(deps, remaining())
    emit({ kind: 'progress', stage: 'tab-ready' })

    await waitForIdle(deps, remaining())
    await waitForConversationSettled(job, deps)
    const snapshot = takeSnapshot(doc)

    const fill = await fillComposer(composer, job.text, {
      ...deps.fill,
      signal,
      requireSendEnabled: job.autoSubmit
    })
    if (!fill.ok) {
      throw new ReplyError(
        'submit-failed',
        `Could not enter the prompt into the ChatGPT message box (${fill.detail ?? 'unknown reason'}).`
      )
    }
    emit({ kind: 'progress', stage: 'filled' })

    if (job.autoSubmit) {
      const sent = await submitPrompt(doc, composer, {
        userMessagesBefore: snapshot.userCount,
        turnsBefore: snapshot.turnCount,
        signal,
        confirmTimeoutMs: deps.timing?.submitConfirmMs
      })
      if (!sent.ok)
        throw new ReplyError('submit-failed', sent.detail ?? 'The prompt was not sent.')
    } else {
      const sent = await waitFor(
        () => submissionConfirmed(doc, composer, snapshot.userCount, snapshot.turnCount),
        { timeoutMs: remaining(), intervalMs: 200, signal }
      )
      if (!sent) {
        throw new ReplyError(
          'timeout',
          'The prompt was filled in but never sent. Press Enter in the ChatGPT tab to send it.'
        )
      }
    }
    emit({ kind: 'progress', stage: 'submitted' })

    const reply = await waitForReply(doc, {
      ...deps.wait,
      snapshot,
      signal,
      promptText: job.text,
      timeoutMs: remaining(),
      onGenerating: () => emit({ kind: 'progress', stage: 'generating' })
    })
    const messages = reply.messages.length
      ? reply.messages
      : freshReplyElements(doc, snapshot, job.text)
    const markdown = recoverEditBlocks(
      messagesToMarkdown(messages),
      messages.flatMap(replyBodies)
    )
    if (markdown === '') {
      throw new ReplyError(
        'page-error',
        'ChatGPT replied, but no text could be read from its answer (the layout of the ' +
          `site may have changed). [Page: ${describePage(doc)}]`
      )
    }
    const last = messages.at(-1)
    emit({
      kind: 'completed',
      markdown,
      conversationUrl: doc.location.href,
      messageId: last
        ? (messageId(last) ?? turnKey(last))?.slice(0, 100) || undefined
        : undefined,
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    if (error instanceof AbortedError) stopGeneration(doc)
    emit(failure(error))
  }
}
