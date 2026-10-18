/**
 * Entry point of the detached hub process.
 *
 *   node hub.cjs --port 47615 [--version 1.2.3] [--idle-exit-ms 60000] [--log-file path]
 *
 * Exit codes: 0 graceful/idle, 3 port already in use (another hub won the race), 1 failure.
 */
import fs from 'node:fs'
import { Hub } from './hub'

const parseArgs = (argv: string[]): Map<string, string> => {
  const parsed = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag?.startsWith('--') && value !== undefined && !value.startsWith('--')) {
      parsed.set(flag.slice(2), value)
      i++
    }
  }
  return parsed
}

const args = parseArgs(process.argv.slice(2))
const port = Number(args.get('port'))
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.exit(1)
}

const logFile = args.get('log-file')
if (logFile) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000)
      fs.truncateSync(logFile, 0)
  } catch {
    // logging is best effort
  }
}
const log = (message: string) => {
  if (!logFile) return
  try {
    fs.appendFileSync(
      logFile,
      `${new Date().toISOString()} [${process.pid}] ${message}\n`
    )
  } catch {
    // logging is best effort
  }
}

let shuttingDown = false
const shutdown = async (code: number) => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await hub.stop()
  } finally {
    process.exit(code)
  }
}

const hub = new Hub({
  port,
  version: args.get('version'),
  idleExitMs: args.has('idle-exit-ms') ? Number(args.get('idle-exit-ms')) : undefined,
  onIdle: () => void shutdown(0),
  onShutdownRequested: () => void shutdown(0),
  log
})

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.stack ?? error.message}`)
  void shutdown(1)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${String(reason)}`)
})

hub.start().catch((error: NodeJS.ErrnoException) => {
  log(`failed to start: ${error.code ?? ''} ${error.message}`)
  process.exit(error.code === 'EADDRINUSE' ? 3 : 1)
})
