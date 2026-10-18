import {
  MAX_ID_CHARS,
  MAX_JOB_TEXT_CHARS,
  MAX_LABEL_CHARS,
  MAX_REPLY_CHARS,
  MAX_URL_CHARS
} from './constants'
import {
  arr,
  bool,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
  ValidationError,
  type Schema
} from './schema'

export type Role = 'editor' | 'browser'

const id = str(MAX_ID_CHARS, 1)
const label = str(MAX_LABEL_CHARS)
const role = oneOf<Role>('editor', 'browser')

const httpUrl: Schema<string> = (value, path) => {
  const text = str(MAX_URL_CHARS, 1)(value, path)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new ValidationError(path, 'expected an absolute URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError(path, 'expected an http(s) URL')
  }
  return text
}

/** Everything a failed job can report. `no-browser`/`ambiguous-browser` are produced by the hub. */
export const JOB_FAILURE_CODES = [
  'no-browser',
  'ambiguous-browser',
  'busy',
  'tab-unavailable',
  'login-required',
  'composer-not-found',
  'submit-failed',
  'rate-limited',
  'page-error',
  'timeout',
  'cancelled',
  'internal'
] as const
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number]

export const browserInfoSchema = obj({
  id,
  name: label,
  profile: opt(label),
  userAgent: str(500),
  extensionVersion: str(50),
  connectedAt: int(0, Number.MAX_SAFE_INTEGER),
  chatgptTabs: int(0, 10_000)
})
export type BrowserInfo = ReturnType<typeof browserInfoSchema>

export const jobRequestSchema = obj({
  jobId: id,
  sessionId: id,
  editorId: id,
  text: str(MAX_JOB_TEXT_CHARS, 1),
  newChat: bool,
  chatUrl: httpUrl,
  autoSubmit: bool,
  timeoutMs: int(1_000, 24 * 60 * 60_000),
  browserId: opt(id)
})
export type JobRequest = ReturnType<typeof jobRequestSchema>

export const jobEventSchema = union('kind', {
  accepted: obj({ kind: lit('accepted'), tabId: int(0, 2_147_483_647) }),
  progress: obj({
    kind: lit('progress'),
    stage: oneOf('tab-ready', 'filled', 'submitted', 'generating')
  }),
  completed: obj({
    kind: lit('completed'),
    markdown: str(MAX_REPLY_CHARS),
    conversationUrl: httpUrl,
    messageId: opt(id),
    durationMs: int(0, 24 * 60 * 60_000)
  }),
  failed: obj({
    kind: lit('failed'),
    code: oneOf(...JOB_FAILURE_CODES),
    message: str(2_000)
  })
})
export type JobEvent = ReturnType<typeof jobEventSchema>
export type TerminalJobEvent = Extract<JobEvent, { kind: 'completed' | 'failed' }>

export const isTerminalEvent = (event: JobEvent): event is TerminalJobEvent =>
  event.kind === 'completed' || event.kind === 'failed'

// ── individual messages ──────────────────────────────────────────────────────────────────────
const welcome = obj({
  type: lit('welcome'),
  protocol: int(0, 10_000),
  hubVersion: str(50),
  clientId: id,
  role
})
const peers = obj({ type: lit('peers'), browsers: arr(browserInfoSchema, 50) })
const job = obj({ type: lit('job'), job: jobRequestSchema })
const cancel = obj({
  type: lit('cancel'),
  jobId: id,
  sessionId: id,
  browserId: opt(id)
})
const event = obj({
  type: lit('event'),
  editorId: id,
  jobId: id,
  seq: int(0, 1_000_000_000),
  event: jobEventSchema
})
const presence = obj({
  type: lit('presence'),
  chatgptTabs: int(0, 10_000),
  profile: opt(label)
})
const ping = obj({ type: lit('ping') })
const pong = obj({ type: lit('pong') })
const shutdown = obj({ type: lit('shutdown') })

// ── per-direction unions (anything else is rejected) ────────────────────────────────────────
export const hubToEditorSchema = union('type', { welcome, peers, event, ping })
export const hubToBrowserSchema = union('type', { welcome, job, cancel, ping })
export const editorToHubSchema = union('type', { job, cancel, pong, shutdown })
export const browserToHubSchema = union('type', { presence, event, pong })

export type HubToEditor = ReturnType<typeof hubToEditorSchema>
export type HubToBrowser = ReturnType<typeof hubToBrowserSchema>
export type EditorToHub = ReturnType<typeof editorToHubSchema>
export type BrowserToHub = ReturnType<typeof browserToHubSchema>
export type EventMessage = ReturnType<typeof event>
export type JobMessage = ReturnType<typeof job>
export type CancelMessage = ReturnType<typeof cancel>

export const serialize = (
  message: HubToEditor | HubToBrowser | EditorToHub | BrowserToHub
): string => JSON.stringify(message)
