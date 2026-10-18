import { spawn, spawnSync } from 'node:child_process'
import type { VerifyResult } from '@codegent/engine'

export interface VerifyOptions {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  /** How much trailing output to keep (characters). */
  tailChars?: number
}

const killTree = (pid: number | undefined): void => {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL') // the child leads its own process group
    }
  } catch {
    // already gone
  }
}

/**
 * Runs the user's verify command through the shell and returns how it ended plus the tail of
 * its combined output. The whole process tree is killed on timeout or abort (a test runner that
 * spawns workers must not be left running).
 */
export const runVerifyCommand = (options: VerifyOptions): Promise<VerifyResult> =>
  new Promise((resolve) => {
    const tailLimit = options.tailChars ?? 12_000
    let tail = ''
    let finished = false
    let timedOut = false

    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' }
    })

    const append = (chunk: Buffer) => {
      tail += chunk.toString('utf8')
      if (tail.length > tailLimit * 2) tail = tail.slice(-tailLimit)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const finish = (exitCode: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const output = tail.length > tailLimit ? tail.slice(-tailLimit) : tail
      resolve({
        command: options.command,
        exitCode,
        timedOut: timedOut || undefined,
        outputTail: output.replace(/\u001b\[[0-9;]*m/g, '')
      })
    }

    const onAbort = () => {
      killTree(child.pid)
      finish(null)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      finish(null)
    }, options.timeoutMs)

    child.on('error', (error) => {
      tail += `\n${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))

    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
