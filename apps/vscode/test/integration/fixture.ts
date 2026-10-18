import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import { FakeBrowser } from '../support/fake-browser'
import { getApi, setSetting, workRepo } from './env'

export const REPO = 'octo/project'
export const CONVERSATION = 'https://chatgpt.com/c/test-conversation'

export interface RunContext {
  api: CodeGentApi
  /** A fake browser extension, connected to the hub for the duration of each test. */
  browser: FakeBrowser
}

/**
 * Hooks for tests that run the agent: before each test the repository is back at its first commit,
 * the settings are the defaults, publishing is allowed, and a fresh fake browser is connected.
 */
export const installRunHooks = (): RunContext => {
  const context = {} as RunContext
  const repo = workRepo()

  before(async () => {
    context.api = await getApi()
    await context.api.waitFor((state) => state.connection.hub === 'connected', 30_000)
  })

  beforeEach(async () => {
    const { api } = context
    repo.reset()
    await api.send({ type: 'dismissRun' })
    await api.send({ type: 'clearHistory' })
    await api.setPublishingConsent(REPO, 'allow')
    await api.send({ type: 'refreshRepo' })
    context.browser = await new FakeBrowser(api.hub().port!).connect()
    await api.waitFor((state) => state.connection.browsers.length === 1)
  })

  afterEach(async () => {
    const { api, browser } = context
    await api.send({ type: 'stop' })
    await api.waitFor((state) => !state.run || state.run.state !== 'running', 15_000)
    browser.close()
    await api.waitFor((state) => state.connection.browsers.length === 0)
    for (const key of ['autoApply', 'autoContinue', 'git.push', 'git.commit', 'verifyCommand']) {
      await setSetting(key, undefined)
    }
    await setSetting('diagnosticsWaitSeconds', 0) // the test instance's own default (see scripts/integration.mjs)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  return context
}
