// Bundles the hub process entry into a single CommonJS file that runs under plain Node or
// Electron-as-Node (the VS Code extension host's executable).
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

export const buildHub = async (outfile = path.join(root, 'dist', 'hub.cjs')) => {
  await build({
    entryPoints: [path.join(root, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    minify: false,
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning'
  })
  return outfile
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildHub()
  console.log(`hub bundle written to ${path.relative(process.cwd(), out)}`)
}
