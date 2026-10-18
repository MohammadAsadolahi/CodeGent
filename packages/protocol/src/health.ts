import { HUB_HOST, HUB_PORTS, HUB_SERVICE_NAME, PROTOCOL_VERSION } from './constants'
import { bool, int, lit, obj, str, type Schema } from './schema'

export const hubHealthSchema = obj({
  ok: bool,
  service: lit(HUB_SERVICE_NAME),
  protocol: int(0, 10_000),
  version: str(50),
  pid: int(0, 2_147_483_647),
  startedAt: int(0, Number.MAX_SAFE_INTEGER),
  editors: int(0, 1_000_000),
  browsers: int(0, 1_000_000)
})
export type HubHealth = ReturnType<typeof hubHealthSchema>

export const isCompatibleHub = (health: HubHealth): boolean =>
  health.ok && health.protocol === PROTOCOL_VERSION

export interface FoundHub {
  port: number
  health: HubHealth
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

const parseHealth = (data: unknown, schema: Schema<HubHealth> = hubHealthSchema) => {
  try {
    return schema(data, '$')
  } catch {
    return null
  }
}

/** Asks one port for `/health`. Returns null for "nothing there", "not ours" or "too slow". */
export const probeHub = async (
  port: number,
  options: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<HubHealth | null> => {
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 800)
  try {
    const response = await doFetch(`http://${HUB_HOST}:${port}/health`, {
      signal: controller.signal
    })
    if (!response.ok) return null
    return parseHealth(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probes every candidate port in parallel and returns the first (by port order) healthy hub that
 * speaks our protocol version, or null.
 */
export const findHub = async (
  options: { ports?: readonly number[]; fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<FoundHub | null> => {
  const ports = options.ports ?? HUB_PORTS
  const results = await Promise.all(
    ports.map(async (port) => ({ port, health: await probeHub(port, options) }))
  )
  for (const { port, health } of results) {
    if (health && isCompatibleHub(health)) return { port, health }
  }
  return null
}
