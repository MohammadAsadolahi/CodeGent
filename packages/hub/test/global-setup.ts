import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - plain .mjs build script without type declarations
import { buildHub } from '../scripts/build.mjs'

/** Builds the real hub bundle once so process-level tests exercise the shipped artifact. */
export default async function setup(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const outDir = path.join(root, '.tmp')
  mkdirSync(outDir, { recursive: true })
  await buildHub(path.join(outDir, 'hub.cjs'))
}
