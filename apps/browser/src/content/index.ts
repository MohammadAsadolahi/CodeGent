import type { JobEvent, JobRequest } from '@codegent/protocol'
import type {
  ContentReadyReply,
  FromContent,
  RunJobReply,
  ToContent
} from '../shared/messages'
import { runSelfTest } from './diagnostics'
import { pokeActiveWait } from './observe'
import { runJob } from './runner'

interface ContentGlobal {
  __codegentContent?: boolean
}

/** Retries a message to the service worker; terminal events must never be lost to a restart. */
const sendToWorker = async <T>(
  message: FromContent,
  attempts = 8
): Promise<T | undefined> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return (await chrome.runtime.sendMessage(message)) as T
    } catch (error) {
      const text = String((error as Error)?.message ?? error)
      if (/context invalidated/i.test(text)) return undefined // extension was reloaded; this script is orphaned
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  return undefined
}

interface CurrentRun {
  jobId: string
  controller: AbortController
}
let current: CurrentRun | null = null

const startJob = (job: JobRequest): RunJobReply => {
  if (current) return { accepted: false, reason: 'busy' }
  const controller = new AbortController()
  const run: CurrentRun = { jobId: job.jobId, controller }
  current = run
  let seq = 100 // 0–99 are reserved for events produced by the service worker itself
  const emit = (event: JobEvent) => {
    void sendToWorker<void>({
      type: 'job-event',
      editorId: job.editorId,
      jobId: job.jobId,
      seq: seq++,
      event
    })
  }
  void runJob(job, { doc: document, emit, signal: controller.signal }).finally(() => {
    if (current === run) current = null
  })
  return { accepted: true }
}

const boot = () => {
  chrome.runtime.onMessage.addListener((message: ToContent, _sender, sendResponse) => {
    switch (message?.type) {
      case 'run-job':
        sendResponse(startJob(message.job))
        return false
      case 'cancel-job':
        if (current?.jobId === message.jobId) current.controller.abort()
        sendResponse({ ok: true })
        return false
      case 'tick':
        pokeActiveWait()
        sendResponse({ ok: true })
        return false
      case 'self-test':
        void runSelfTest(document, { probeFill: message.probeFill }).then(sendResponse)
        return true // async response
      default:
        return false
    }
  })

  void sendToWorker<ContentReadyReply>(
    { type: 'content-ready', url: location.href },
    4
  ).then((reply) => {
    if (reply?.job) startJob(reply.job)
  })

  // A service worker that Chromium terminated is only woken by events; this one makes sure it
  // is back within seconds (and reconnected to the hub) whenever a ChatGPT tab is open.
  const keepAlive = setInterval(() => {
    chrome.runtime
      .sendMessage({ type: 'content-ping' } satisfies FromContent)
      .catch((error) => {
        if (/context invalidated/i.test(String(error?.message ?? error)))
          clearInterval(keepAlive)
      })
  }, 10_000)
}

const flagged = globalThis as unknown as ContentGlobal
if (!flagged.__codegentContent) {
  flagged.__codegentContent = true
  boot()
}
