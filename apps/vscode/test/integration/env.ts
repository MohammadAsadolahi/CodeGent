import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import { attachRepo, type GithubLikeRepo } from '../support/git-fixture'

export const sandbox = (): string => {
  const dir = process.env.CODEGENT_IT_DIR
  if (!dir)
    throw new Error(
      'CODEGENT_IT_DIR is not set; run these tests with `npm run test:integration`.'
    )
  return dir
}

export const hubPorts = (): number[] =>
  (process.env.CODEGENT_IT_PORTS ?? '').split(',').map(Number)

export const workRepo = (): GithubLikeRepo => attachRepo(sandbox(), 'work')

/** The extension's test API, once it has finished activating. */
export const getApi = async (): Promise<CodeGentApi> => {
  const extension = vscode.extensions.getExtension<CodeGentApi>('codegent.codegent')
  if (!extension)
    throw new Error('The CodeGent extension is not installed in the test instance.')
  const api = extension.isActive ? extension.exports : await extension.activate()
  if (!api)
    throw new Error(
      'The extension did not return its test API (CODEGENT_TEST_API=1 is set by scripts/integration.mjs).'
    )
  return api
}

export const configuration = () => vscode.workspace.getConfiguration('codegent')

/** Sets a user-level setting (the test instance's own settings.json). */
export const setSetting = async (key: string, value: unknown): Promise<void> => {
  await configuration().update(key, value, vscode.ConfigurationTarget.Global)
}

/**
 * Replaces one of VS Code's `window.*` functions (to answer a dialog that nobody can click in a
 * test). Returns the function that puts the original back.
 */
export const replaceWindowFunction = (
  name: 'showInformationMessage' | 'showQuickPick' | 'showInputBox',
  replacement: (...args: any[]) => unknown
): (() => void) => {
  const window = vscode.window as unknown as Record<string, unknown>
  const original = window[name]
  window[name] = replacement
  return () => {
    window[name] = original
  }
}

/**
 * Tests that replace functions of the `vscode` module (to answer dialogs nobody can click). That
 * only reaches the extension when both share one `vscode` object — i.e. when the extension is loaded
 * from its sources — so they are skipped when the installed package is tested (`--vsix`).
 */
export const itFromSources = process.env.CODEGENT_IT_VSIX ? it.skip : it
export const describeFromSources = process.env.CODEGENT_IT_VSIX ? describe.skip : describe
