// Runs the integration tests inside a real VS Code. Two suites, each in its own VS Code launch with
// its own throw-away profile and git repository:
//   protocol  the extension against a scripted browser that speaks the real protocol
//   chain     the extension against the REAL browser extension in a real Chromium, talking to a
//             pretend chatgpt.com (the whole product, minus the actual ChatGPT)
// Usage: node scripts/integration.mjs [title filter] [--suite=protocol|chain] [--vsix]
//   --vsix                                      test the package made by `npm run package`, installed
//                                               like a user would (protocol suite only)
//   CODEGENT_VSCODE=<path to Code.exe / code>   use a specific VS Code (default: the installed one,
//                                                else the latest stable build is downloaded)
//   CODEGENT_IT_NO_BROWSER=1                    skip the chain suite
//   CODEGENT_MINIFY=1                           test the minified build that is released
import { build } from 'esbuild'
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} from '@vscode/test-electron'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { buildAll } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_PORTS = [47680, 47681]

// The hub only accepts the real browser extension, recognised by the id its manifest key fixes
// (SHA-256 of the key, first 16 bytes, written with the letters a–p). The scripted browsers of
// the protocol suite present that origin. This is deliberately a second implementation of the
// derivation in packages/hub: if the two ever disagreed, the hub would turn the tests away.
const bundledExtensionOrigin = () => {
  const { key } = JSON.parse(
    fs.readFileSync(path.join(root, '..', 'browser', 'static', 'manifest.json'), 'utf8')
  )
  const hex = createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
  const id = [...hex]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join('')
  return `chrome-extension://${id}`
}

const args = process.argv.slice(2)
const wantedSuite = args
  .find((arg) => arg.startsWith('--suite='))
  ?.slice('--suite='.length)
const grep = args.find((arg) => !arg.startsWith('--')) ?? ''
// --vsix: test the packaged extension (built by `npm run package`) instead of the sources.
const useVsix = args.includes('--vsix')

const installedVsCode = () =>
  [
    process.env.CODEGENT_VSCODE,
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code'
  ].find((candidate) => candidate && fs.existsSync(candidate))

const isUp = async (port) => {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
    ).ok
  } catch {
    return false
  }
}

/** Asks a running hub to exit (the same message the extension's "restart hub" sends) and waits for it. */
const stopHub = async (port) => {
  if (!(await isUp(port))) return
  await new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?role=editor&id=${crypto.randomUUID()}&protocol=1`
    )
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'shutdown' }))
      setTimeout(resolve, 200)
    })
    socket.once('error', resolve)
  })
  for (let i = 0; i < 50 && (await isUp(port)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (await isUp(port))
    throw new Error(`a hub keeps running on port ${port}; stop it and try again`)
}
const stopTestHubs = async () => {
  for (const port of TEST_PORTS) await stopHub(port)
}

/** VS Code's helper processes can still be shutting down; leftovers in the temp folder are harmless. */
const removeDir = async (dir) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  console.warn(`could not remove ${dir}; delete it by hand`)
}

// ── preparing ────────────────────────────────────────────────────────────────────────────────────
await stopTestHubs() // a hub left over from an earlier run would be old code
const vsixPath = path.join(
  root,
  `codegent-${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}.vsix`
)
if (useVsix) {
  if (!fs.existsSync(vsixPath))
    throw new Error(`${vsixPath} does not exist; run npm run package first`)
} else {
  // CODEGENT_MINIFY=1 runs everything against the minified build that is released.
  await buildAll({
    hubPorts: TEST_PORTS,
    production: process.env.CODEGENT_MINIFY === '1'
  })
}

const outTest = path.join(root, 'out-test')
fs.rmSync(outTest, { recursive: true, force: true })
const entryPoints = {
  'git-fixture': path.join(root, 'test', 'support', 'git-fixture.ts')
}
for (const file of fs.readdirSync(path.join(root, 'test', 'integration'))) {
  if (file.endsWith('.ts')) {
    entryPoints[file.slice(0, -3)] = path.join(root, 'test', 'integration', file)
  }
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
// The chain harness runs in Node (not in VS Code) and is loaded as an ES module.
await build({
  entryPoints: {
    'chain-harness': path.join(root, 'test', 'support', 'chain-harness.ts')
  },
  outdir: outTest,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning'
})
const { githubLikeRepo } = createRequire(import.meta.url)(
  path.join(outTest, 'git-fixture.js')
)

// The installed VS Code must not think it is a child of the VS Code this script may be run from.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key]
}
const vscodeExecutablePath = installedVsCode() ?? (await downloadAndUnzipVSCode('stable'))
console.log(`running the integration tests in ${vscodeExecutablePath}`)

// ── one suite = one VS Code launch ───────────────────────────────────────────────────────────────
const runSuite = async (suite) => {
  console.log(`\n=== suite: ${suite} ===`)
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-it-'))
  let chain
  try {
    await stopTestHubs()
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

    // The real browser extension starts first: it has to find the hub when VS Code starts it.
    if (suite === 'chain') {
      const { startChain } = await import(
        pathToFileURL(path.join(outTest, 'chain-harness.mjs')).href
      )
      chain = await startChain({
        extensionDir: path.join(root, 'out', 'browser-extension'),
        profileDir: path.join(sandbox, 'chromium-profile'),
        mockPageEntry: path.join(root, '..', 'browser', 'e2e', 'mock', 'mock-page.ts')
      })
    }

    // Normally the extension is loaded from its sources. With --vsix it is installed from the
    // package, exactly as a user would, and an empty extension stands in as the one "under development".
    const extensionsDir = path.join(sandbox, 'extensions')
    let extensionDevelopmentPath = root
    if (useVsix) {
      // On Windows the CLI is a .cmd file and needs a shell, which means quoting the paths.
      const shell = process.platform === 'win32'
      const quote = (value) => (shell ? `"${value}"` : value)
      const [cli, ...cliArgs] =
        resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath)
      const install = spawnSync(
        quote(cli),
        [
          ...cliArgs.map(quote),
          '--install-extension',
          quote(vsixPath),
          quote(`--extensions-dir=${extensionsDir}`),
          quote(`--user-data-dir=${userData}`)
        ],
        { encoding: 'utf8', shell }
      )
      if (install.status !== 0) {
        throw new Error(
          `installing the package failed: ${install.stdout}${install.stderr}`
        )
      }
      extensionDevelopmentPath = path.join(sandbox, 'test-host')
      fs.mkdirSync(extensionDevelopmentPath)
      fs.writeFileSync(
        path.join(extensionDevelopmentPath, 'package.json'),
        JSON.stringify({
          name: 'codegent-test-host',
          publisher: 'codegent-tests',
          version: '0.0.0',
          engines: { vscode: '^1.96.0' }
        })
      )
    }

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: path.join(outTest, 'index.js'),
      launchArgs: [
        path.join(sandbox, 'work'),
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-extension=vscode.git',
        '--disable-workspace-trust'
      ],
      extensionTestsEnv: {
        CODEGENT_TEST_API: '1',
        CODEGENT_IT_EXT_ORIGIN: bundledExtensionOrigin(),
        CODEGENT_IT_VSIX: useVsix ? '1' : '',
        CODEGENT_IT_DIR: sandbox,
        CODEGENT_IT_PORTS: TEST_PORTS.join(','),
        CODEGENT_IT_SUITE: suite,
        CODEGENT_IT_MOCK_PORT: chain ? String(chain.mockPort) : '',
        // Optional: run only the tests whose title matches.
        CODEGENT_IT_GREP: grep,
        // Fetching the pretend GitHub address must fail at once instead of reaching the real one.
        GIT_ALLOW_PROTOCOL: 'file'
      }
    })
    return true
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    return false
  } finally {
    await chain?.close().catch(() => undefined)
    await stopTestHubs().catch((error) => console.error(error.message))
    await removeDir(sandbox)
  }
}

let ok = true
for (const suite of ['protocol', 'chain']) {
  if (wantedSuite && wantedSuite !== suite) continue
  // The package carries the browser extension for the real ports; the chain suite uses test ports.
  if (suite === 'chain' && (useVsix || process.env.CODEGENT_IT_NO_BROWSER)) continue
  ok = (await runSuite(suite)) && ok
}
process.exit(ok ? 0 : 1)
