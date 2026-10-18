// Runs the integration tests inside a real VS Code: builds the extension, bundles the tests,
// prepares a throw-away git repository and an isolated VS Code profile, launches the installed VS
// Code with the extension loaded, and always shuts the test hub down afterwards.
//   CODEGENT_VSCODE=<path to Code.exe / code>   use a specific VS Code (default: the installed one,
//                                                else the latest stable build is downloaded)
import { build } from 'esbuild'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { buildAll } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_PORTS = [47680, 47681]

const installedVsCode = () =>
  [
    process.env.CODEGENT_VSCODE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code'
  ].find((candidate) => candidate && fs.existsSync(candidate))

const isUp = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok
  } catch {
    return false
  }
}

/** Asks a running hub to exit (the same message the extension's "restart hub" sends) and waits for it. */
const stopHub = async (port) => {
  if (!(await isUp(port))) return
  await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=editor&id=${crypto.randomUUID()}&protocol=1`)
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'shutdown' }))
      setTimeout(resolve, 200)
    })
    socket.once('error', resolve)
  })
  for (let i = 0; i < 50 && (await isUp(port)); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  if (await isUp(port)) throw new Error(`a hub keeps running on port ${port}; stop it and try again`)
}
const stopTestHubs = async () => {
  for (const port of TEST_PORTS) await stopHub(port)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-it-'))

/** VS Code's helper processes can still be shutting down; leftovers in the temp folder are harmless. */
const removeSandbox = async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  console.warn(`could not remove ${sandbox}; delete it by hand`)
}

let exitCode = 1
try {
  await stopTestHubs() // a hub left over from an earlier run would be old code

  await buildAll({ hubPorts: TEST_PORTS })

  const outTest = path.join(root, 'out-test')
  fs.rmSync(outTest, { recursive: true, force: true })
  const entryPoints = { 'git-fixture': path.join(root, 'test', 'support', 'git-fixture.ts') }
  for (const file of fs.readdirSync(path.join(root, 'test', 'integration'))) {
    if (file.endsWith('.ts')) entryPoints[file.slice(0, -3)] = path.join(root, 'test', 'integration', file)
  }
  await build({
    entryPoints,
    outdir: outTest,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha'],
    logLevel: 'warning'
  })

  const { githubLikeRepo } = createRequire(import.meta.url)(path.join(outTest, 'git-fixture.js'))
  githubLikeRepo(sandbox, 'work', {
    'README.md': '# Demo project\n',
    'src/greeting.txt': 'hello\nworld\n',
    'src/keep.txt': 'untouched\n'
  })

  const userData = path.join(sandbox, 'user-data')
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'codegent.advanced.hubPorts': TEST_PORTS,
        'codegent.diagnosticsWaitSeconds': 0,
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'git.enabled': false,
        'chat.disableAIFeatures': true
      },
      null,
      2
    )
  )

  // The test VS Code must not think it is a child of the VS Code this script may be run from.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key]
  }

  const vscodeExecutablePath = installedVsCode() ?? (await downloadAndUnzipVSCode('stable'))
  console.log(`running the integration tests in ${vscodeExecutablePath}`)
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(outTest, 'index.js'),
    launchArgs: [
      path.join(sandbox, 'work'),
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(sandbox, 'extensions')}`,
      '--disable-extension=vscode.git',
      '--disable-workspace-trust'
    ],
    extensionTestsEnv: {
      CODEGENT_IT_DIR: sandbox,
      CODEGENT_IT_PORTS: TEST_PORTS.join(','),
      // Optional: run only the tests whose title matches (`npm run test:integration -- "undo"`).
      CODEGENT_IT_GREP: process.argv[2] ?? '',
      // Fetching the pretend GitHub address must fail at once instead of reaching the real one.
      GIT_ALLOW_PROTOCOL: 'file'
    }
  })
  exitCode = 0
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  await stopTestHubs().catch((error) => console.error(error.message))
  await removeSandbox()
}
process.exit(exitCode)
