/** Bumped whenever a wire-incompatible change is made. Peers with different values never talk. */
export const PROTOCOL_VERSION = 1

/** Value of `service` in the hub's `/health` response; lets clients tell our hub from any other program. */
export const HUB_SERVICE_NAME = 'codegent-hub'

/** The hub only ever listens on the loopback interface. */
export const HUB_HOST = '127.0.0.1'

/**
 * Candidate ports, probed in order. If a foreign program owns one of them the next is used, so no
 * configuration is needed on either side. None of these fall in the OS ephemeral range.
 */
export const HUB_PORTS: readonly number[] = [47615, 47616, 47617, 47618, 47619]

/** Hub → client application-level ping cadence (also keeps MV3 service workers awake). */
export const HEARTBEAT_INTERVAL_MS = 10_000

/** A peer silent for this long is considered dead and its socket is terminated. */
export const HEARTBEAT_DEAD_AFTER_MS = 35_000

/** The hub exits after this long with no editor connected, so it never lingers or locks files. */
export const HUB_IDLE_EXIT_MS = 60_000

/** Upper bound for a single WebSocket message (a long ChatGPT reply is well below this). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** Bounds for events held for an editor that is momentarily disconnected (e.g. window reload). */
export const MAILBOX_MAX_EVENTS = 200
export const MAILBOX_TTL_MS = 15 * 60_000

/** Limits applied while validating inbound messages. */
export const MAX_JOB_TEXT_CHARS = 400_000
export const MAX_REPLY_CHARS = 2_000_000
export const MAX_ID_CHARS = 100
export const MAX_URL_CHARS = 2_048
export const MAX_LABEL_CHARS = 200

export const DEFAULT_CHAT_URL = 'https://chatgpt.com/'
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000

/** Close codes used by the hub (4000+ is the application range). */
export const CLOSE_REPLACED = 4000
export const CLOSE_PROTOCOL_VIOLATION = 4001
export const CLOSE_STALE = 4002
export const CLOSE_SHUTDOWN = 4003
