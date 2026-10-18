// Builds the unpacked browser extension into `dist/` (load it via chrome://extensions →
// "Load unpacked"). `buildExtension` is also used by the end-to-end tests with test ports.
import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const buildExtension = async ({
  outDir = path.join(root, 'dist'),
  hubPorts,
  minify = false
} = {}) => {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  await build({
    entryPoints: {
      background: path.join(root, 'src/background/index.ts'),
      content: path.join(root, 'src/content/index.ts'),
      popup: path.join(root, 'src/popup/popup.ts')
    },
    outdir: outDir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome116',
    minify,
    sourcemap: false,
    define: hubPorts ? { __CODEGENT_HUB_PORTS__: JSON.stringify(hubPorts) } : {},
    logLevel: 'warning'
  })

  await cp(path.join(root, 'static'), outDir, { recursive: true })
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const manifestPath = path.join(outDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = pkg.version
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return outDir
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildExtension({ minify: process.argv.includes('--minify') })
  console.log(`browser extension built → ${path.relative(process.cwd(), out)}`)
}
