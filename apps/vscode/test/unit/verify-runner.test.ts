import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runVerifyCommand } from '../../src/checks/verify-runner'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-verify-'))
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }))

const run = (
  command: string,
  over: Partial<Parameters<typeof runVerifyCommand>[0]> = {}
) => runVerifyCommand({ command, cwd, timeoutMs: 20_000, ...over })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('runVerifyCommand', () => {
  it('reports success with the combined output', async () => {
    const result = await run(
      `node -e "console.log('out-line'); console.error('err-line')"`
    )
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBeUndefined()
    expect(result.outputTail).toContain('out-line')
    expect(result.outputTail).toContain('err-line')
    expect(result.command).toContain('node -e')
  })

  it('reports the exit code of a failing command', async () => {
    const result = await run(`node -e "console.log('boom'); process.exit(3)"`)
    expect(result.exitCode).toBe(3)
    expect(result.outputTail).toContain('boom')
  })

  it('runs in the given directory with CI=true and no colours', async () => {
    fs.writeFileSync(path.join(cwd, 'marker.txt'), 'here')
    const result = await run(
      `node -e "console.log(require('fs').existsSync('marker.txt'), process.env.CI, process.env.NO_COLOR)"`
    )
    expect(result.outputTail.trim()).toBe('true true 1')
  })

  it('treats an unknown command as a failure, not a crash', async () => {
    const result = await run('definitely-not-a-real-command-xyz')
    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBeNull()
    expect(result.outputTail.length).toBeGreaterThan(0)
  })

  it('keeps only the tail of enormous output', async () => {
    const result = await run(
      `node -e "for (let i = 0; i < 20000; i++) console.log('line ' + i + ' ' + 'x'.repeat(60)); console.log('THE-END')"`,
      { tailChars: 5_000 }
    )
    expect(result.exitCode).toBe(0)
    expect(result.outputTail.length).toBeLessThanOrEqual(5_000)
    expect(result.outputTail.trimEnd().endsWith('THE-END')).toBe(true)
  })

  it('strips ANSI colour codes', async () => {
    const result = await run(`node -e "console.log('\\u001b[31mred\\u001b[0m')"`)
    expect(result.outputTail).not.toMatch(/\u001b/)
    expect(result.outputTail).toContain('red')
  })

  it('kills the whole process tree on timeout', async () => {
    const pidFile = path.join(cwd, 'child.pid').replace(/\\/g, '/')
    const script = `require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)`
    const started = Date.now()
    const result = await run(`node -e "${script}"`, { timeoutMs: 1_500 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    await sleep(500)
    expect(alive(pid)).toBe(false)
  })

  it('stops promptly when aborted', async () => {
    const controller = new AbortController()
    const pending = run(`node -e "setInterval(() => {}, 1000)"`, {
      signal: controller.signal
    })
    await sleep(500)
    const started = Date.now()
    controller.abort()
    const result = await pending
    expect(result.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('does not start when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run(`node -e "console.log('should not matter')"`, {
      signal: controller.signal
    })
    expect(result.exitCode).toBeNull()
  })
})
