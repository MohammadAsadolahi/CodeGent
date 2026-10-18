// Builds everything the VS Code extension ships into `out/`:
//   extension.js         the extension host bundle (`vscode` stays external)
//   hub.cjs              the local hub process the extension starts
//   webview/             the side panel (main.js, main.css)
//   browser-extension/   the unpacked browser extension the user loads once
// `buildAll` is also used by the integration tests (with their own hub ports).
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHub } from '../../../packages/hub/scripts/build.mjs'
import { buildExtension as buildBrowserExtension } from '../../browser/scripts/build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const buildAll = async ({ outDir = path.join(root, 'out'), production = false, hubPorts } = {}) => {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  await build({
    entryPoints: [path.join(root, 'src/extension.ts')],
    outfile: path.join(outDir, 'extension.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    minify: production,
    logLevel: 'warning'
  })

  await buildHub(path.join(outDir, 'hub.cjs'))

  await build({
    entryPoints: { main: path.join(root, 'webview/main.tsx') },
    outdir: path.join(outDir, 'webview'),
    tsconfig: path.join(root, 'tsconfig.webview.json'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: production,
    logLevel: 'warning'
  })

  await buildBrowserExtension({ outDir: path.join(outDir, 'browser-extension'), hubPorts, minify: production })
  return outDir
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const production = process.argv.includes('--production')
  const out = await buildAll({ production })
  console.log(`extension built (${production ? 'production' : 'development'}) → ${path.relative(process.cwd(), out)}`)
}
