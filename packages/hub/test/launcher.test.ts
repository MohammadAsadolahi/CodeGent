import { afterEach, describe, expect, it } from 'vitest'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHub, probeHub } from '@codegent/protocol'
import { ensureHub, HubStartError } from '../src'
import { connect, EXT_ORIGIN, sleep } from './helpers'
import { Hub } from '../src'

const hubScriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.tmp',
  'hub.cjs'
)

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

const spawnedPids = new Set<number>()
const foreign: Array<{ server: net.Server; sockets: Set<net.Socket> }> = []

/** A stand-in for some other program that owns a port and never speaks HTTP. */
const holdPort = async (port: number) => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  foreign.push({ server, sockets })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
}

const track = <T extends { health: { pid: number } }>(found: T): T => {
  spawnedPids.add(found.health.pid)
  return found
}

afterEach(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
  }
  spawnedPids.clear()
  await Promise.all(
    foreign.splice(0).map(({ server, sockets }) => {
      sockets.forEach((socket) => socket.destroy())
      return new Promise((resolve) => server.close(resolve))
    })
  )
  await sleep(100)
})

const waitUntilGone = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probeHub(port, { timeoutMs: 200 }))) return true
    await sleep(100)
  }
  return false
}

describe('ensureHub (real child processes)', () => {
  it('spawns a hub when none is running and reuses it afterwards', async () => {
    const ports = [await freePort(), await freePort()]
    const first = track(await ensureHub({ hubScriptPath, ports, version: '1.2.3' }))
    expect(ports).toContain(first.port)
    expect(first.health).toMatchObject({ ok: true, version: '1.2.3', editors: 0 })
    expect(first.health.pid).not.toBe(process.pid)

    const second = await ensureHub({ hubScriptPath, ports })
    expect(second.health.pid).toBe(first.health.pid)
    expect(second.port).toBe(first.port)
  })

  it('serves real WebSocket clients from the spawned process', async () => {
    const ports = [await freePort()]
    const { port } = track(await ensureHub({ hubScriptPath, ports }))
    // reuse the in-process test client against the child by faking the Hub shape it needs
    const proxy = { port } as unknown as Hub
    const editor = await connect(proxy, { role: 'editor' })
    expect((await editor.next((m) => m.type === 'welcome')).role).toBe('editor')
    editor.close()
  })

  it('passes the allow-list of browser extensions on to the hub process, which enforces it', async () => {
    const ours = `chrome-extension://${'b'.repeat(32)}`
    const ports = [await freePort()]
    const { port } = track(
      await ensureHub({ hubScriptPath, ports, allowedOrigins: [ours] })
    )
    const proxy = { port } as unknown as Hub

    const browser = await connect(proxy, { role: 'browser', origin: ours })
    expect((await browser.next((m) => m.type === 'welcome')).role).toBe('browser')
    browser.close()

    const stranger = await connect(proxy, { role: 'browser', origin: EXT_ORIGIN }).then(
      () => undefined,
      (error) => error
    )
    expect(stranger).toMatchObject({ status: 403 })
    expect(String(stranger.body)).toMatch(/not on the allow-list/)
  })

  it('converges on a single hub when many windows start at once', async () => {
    const ports = [await freePort(), await freePort(), await freePort()]
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureHub({ hubScriptPath, ports }))
    )
    results.forEach(track)
    expect(new Set(results.map((r) => r.port)).size).toBe(1)
    expect(new Set(results.map((r) => r.health.pid)).size).toBe(1)
    const alive = await Promise.all(ports.map((p) => probeHub(p, { timeoutMs: 300 })))
    expect(alive.filter(Boolean)).toHaveLength(1)
  })

  it('skips a port held by a foreign program', async () => {
    const taken = await freePort()
    const spare = await freePort()
    await holdPort(taken)

    const found = track(await ensureHub({ hubScriptPath, ports: [taken, spare] }))
    expect(found.port).toBe(spare)
    expect(await findHub({ ports: [taken, spare] })).toMatchObject({ port: spare })
  })

  it('exits by itself after the idle period when no editor connects', async () => {
    const port = await freePort()
    const found = track(
      await ensureHub({ hubScriptPath, ports: [port], idleExitMs: 300 })
    )
    expect(found.port).toBe(port)
    expect(await waitUntilGone(port, 4_000)).toBe(true)
  })

  it('stays alive while an editor is connected and exits after it leaves', async () => {
    const port = await freePort()
    track(await ensureHub({ hubScriptPath, ports: [port], idleExitMs: 400 }))
    const editor = await connect({ port } as unknown as Hub, { role: 'editor' })
    await sleep(900)
    expect(await probeHub(port, { timeoutMs: 300 })).not.toBeNull()
    editor.close()
    expect(await waitUntilGone(port, 4_000)).toBe(true)
  })

  it('exits when an editor sends shutdown', async () => {
    const port = await freePort()
    track(await ensureHub({ hubScriptPath, ports: [port] }))
    const editor = await connect({ port } as unknown as Hub, { role: 'editor' })
    editor.send({ type: 'shutdown' })
    expect(await waitUntilGone(port, 4_000)).toBe(true)
  })

  it('reports a clear error when the hub cannot start', async () => {
    const ports = [await freePort(), await freePort()]
    const error = await ensureHub({
      hubScriptPath: path.join(path.dirname(hubScriptPath), 'does-not-exist.cjs'),
      ports,
      startupTimeoutMs: 3_000
    }).then(
      () => undefined,
      (e) => e
    )
    expect(error).toBeInstanceOf(HubStartError)
    expect(String(error.message)).toMatch(/Could not start the CodeGent hub/)
    expect(String(error.message)).toContain(String(ports[0]))
  })

  it('starts the hub outside any project folder, as a detached process with the Electron-as-Node switch', async () => {
    const port = await freePort()
    const calls: Array<{
      command: string
      args: string[]
      options: Record<string, unknown>
    }> = []
    const error = await ensureHub({
      hubScriptPath,
      ports: [port],
      startupTimeoutMs: 300,
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options })
        throw new Error('stop here')
      }) as never
    }).then(
      () => undefined,
      (e) => e
    )
    expect(error).toBeInstanceOf(HubStartError)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args.slice(0, 3)).toEqual([hubScriptPath, '--port', String(port)])
    expect(calls[0]!.options).toMatchObject({
      cwd: os.tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    expect((calls[0]!.options.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reports spawn failures without throwing from inside', async () => {
    const port = await freePort()
    const error = await ensureHub({
      hubScriptPath,
      ports: [port],
      spawn: (() => {
        throw new Error('EACCES')
      }) as never
    }).then(
      () => undefined,
      (e) => e
    )
    expect(error).toBeInstanceOf(HubStartError)
    expect(String(error.message)).toMatch(/spawn failed: EACCES/)
  })
})
