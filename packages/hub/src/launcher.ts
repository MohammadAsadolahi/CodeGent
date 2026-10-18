import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import {
  findHub,
  HUB_PORTS,
  isCompatibleHub,
  probeHub,
  type FoundHub
} from '@codegent/protocol'

export class HubStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubStartError'
  }
}

export interface EnsureHubOptions {
  /** Absolute path of the bundled hub entry (`hub.cjs`). */
  hubScriptPath: string
  ports?: readonly number[]
  /** Defaults to `process.execPath` (inside VS Code that is Electron, run as plain Node). */
  execPath?: string
  version?: string
  idleExitMs?: number
  logFile?: string
  /** How long to wait for a spawned hub to answer `/health`, per port. */
  startupTimeoutMs?: number
  spawn?: typeof nodeSpawn
  env?: NodeJS.ProcessEnv
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Returns a running, compatible hub: reuses one if any candidate port answers, otherwise spawns
 * a detached hub on the first port that works. Safe to call from many windows at once — when
 * two hubs race for the same port the loser exits and both callers find the winner.
 */
export const ensureHub = async (options: EnsureHubOptions): Promise<FoundHub> => {
  const ports = options.ports ?? HUB_PORTS
  const existing = await findHub({ ports })
  if (existing) return existing

  const failures: string[] = []
  for (const port of ports) {
    const outcome = await startOnPort(port, ports, options)
    if ('found' in outcome) return outcome.found
    failures.push(`${port}: ${outcome.reason}`)
  }
  throw new HubStartError(`Could not start the CodeGent hub (${failures.join('; ')})`)
}

const startOnPort = async (
  port: number,
  ports: readonly number[],
  options: EnsureHubOptions
): Promise<{ found: FoundHub } | { reason: string }> => {
  const args = [options.hubScriptPath, '--port', String(port)]
  if (options.version) args.push('--version', options.version)
  if (options.idleExitMs !== undefined)
    args.push('--idle-exit-ms', String(options.idleExitMs))
  if (options.logFile) args.push('--log-file', options.logFile)

  const spawnFn = options.spawn ?? nodeSpawn
  let child: ChildProcess
  try {
    child = spawnFn(options.execPath ?? process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }
    })
  } catch (error) {
    return { reason: `spawn failed: ${(error as Error).message}` }
  }

  let exitCode: number | undefined
  let spawnError: Error | undefined
  child.once('exit', (code) => {
    exitCode = code ?? -1
  })
  child.once('error', (error) => {
    spawnError = error
  })

  const deadline = Date.now() + (options.startupTimeoutMs ?? 6_000)
  while (Date.now() < deadline) {
    if (spawnError) return { reason: `spawn error: ${spawnError.message}` }
    if (exitCode !== undefined) {
      // Another window may have won the race for this port; if so, use its hub.
      const winner = await findHub({ ports })
      if (winner) return { found: winner }
      return { reason: `hub process exited with code ${exitCode}` }
    }
    const health = await probeHub(port, { timeoutMs: 300 })
    if (health && isCompatibleHub(health)) {
      child.unref()
      return { found: { port, health } }
    }
    await sleep(60)
  }
  child.kill()
  return { reason: 'timed out waiting for /health' }
}
