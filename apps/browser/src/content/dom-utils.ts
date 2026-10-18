/** Thrown when a job is cancelled while one of the waiting helpers is running. */
export class AbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortedError'
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Polls `probe` until it returns something truthy, the timeout elapses (→ null) or abort. */
export const waitFor = async <T>(
  probe: () => T | null | undefined | false,
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal }
): Promise<T | null> => {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await sleep(Math.min(options.intervalMs ?? 100, remaining), options.signal)
  }
}

export const normalizeSpace = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Whether an element is rendered. Uses `checkVisibility` where the browser has it (it accounts
 * for hidden ancestors) and falls back to computed styles elsewhere (e.g. in jsdom tests).
 */
export const isVisible = (
  element: Element | null | undefined
): element is HTMLElement => {
  if (!(element instanceof HTMLElement)) return false
  if (element.hidden) return false
  const withCheck = element as HTMLElement & {
    checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean
  }
  if (typeof withCheck.checkVisibility === 'function') {
    return withCheck.checkVisibility({ checkVisibilityCSS: true })
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return !(style && (style.display === 'none' || style.visibility === 'hidden'))
}

/** First element (in selector order) that matches and is visible. */
export const queryVisible = (
  root: ParentNode,
  selectors: readonly string[]
): { element: HTMLElement; selector: string } | null => {
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      if (isVisible(element)) return { element, selector }
    }
  }
  return null
}

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`
