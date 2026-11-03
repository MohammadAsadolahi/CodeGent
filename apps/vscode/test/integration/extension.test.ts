import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import { FakeBrowser, until } from '../support/fake-browser'
import {
  configuration,
  getApi,
  hubPorts,
  itFromSources,
  replaceWindowFunction,
  setSetting,
  workRepo
} from './env'
import { git } from '../support/git-fixture'

describe('the extension in VS Code', () => {
  let api: CodeGentApi

  before(async () => {
    api = await getApi()
  })

  it('starts the hub and connects to it', async () => {
    await api.waitFor((state) => state.connection.hub === 'connected', 30_000)
    const { port, editorId } = api.hub()
    assert.ok(port !== null && hubPorts().includes(port), `unexpected hub port ${port}`)
    assert.ok(editorId)
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      service: string
      protocol: number
    }
    assert.equal(health.service, 'codegent-hub')
    assert.equal(health.protocol, 1)
  })

  it('registers every command it declares', async () => {
    const declared = (
      vscode.extensions.getExtension('codegent.codegent')!.packageJSON.contributes
        .commands as Array<{ command: string }>
    ).map((entry) => entry.command)
    assert.ok(declared.length >= 8)
    const registered = new Set(await vscode.commands.getCommands(true))
    for (const command of declared)
      assert.ok(registered.has(command), `${command} is declared but not registered`)
  })

  it('puts the browser extension where the user can load it', () => {
    const folder = api.browserExtensionPath()
    assert.ok(folder, 'no browser extension folder')
    const manifest = JSON.parse(
      fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')
    )
    assert.equal(manifest.name, 'CodeGent Bridge')
    assert.equal(manifest.manifest_version, 3)
    for (const file of ['background.js', 'content.js', 'popup.html', 'popup.js']) {
      assert.ok(fs.existsSync(path.join(folder, file)), `${file} is missing`)
    }
  })

  it('shows the panel, and the webview runs and talks back', async () => {
    await vscode.commands.executeCommand('codegent.focus')
    await until(() => api.webview().resolved, 'the panel to be created', 20_000)
    await until(
      () => api.webview().received.includes('ready'),
      'the webview script to start and say hello',
      20_000
    )
  })

  it('describes the repository that is open', async () => {
    await api.send({ type: 'refreshRepo' })
    const { repo } = api.state()
    assert.equal(repo.ok, true)
    if (!repo.ok) return
    assert.equal(repo.fullName, 'octo/project')
    assert.equal(repo.branch, 'main')
    assert.equal(repo.dirtyCount, 0)
    assert.equal(repo.hasUpstream, true)
    assert.equal(repo.subject, 'initial')
  })

  it('shows the browsers that connect and disconnect', async () => {
    const browser = await new FakeBrowser(api.hub().port!).connect()
    try {
      const state = await api.waitFor((s) => s.connection.browsers.length === 1)
      assert.match(state.connection.browsers[0]!.label, /Chrome/)
      assert.match(state.connection.hint ?? '', /chatgpt\.com/) // connected, but no ChatGPT tab yet
    } finally {
      browser.close()
    }
    await api.waitFor((s) => s.connection.browsers.length === 0)
  })

  it('turns away any browser extension other than the bundled one', async () => {
    const stranger = new FakeBrowser(
      api.hub().port!,
      undefined,
      `chrome-extension://${'p'.repeat(32)}`
    )
    await assert.rejects(stranger.connect(), /403/)
    assert.equal(api.state().connection.browsers.length, 0)
  })

  it('lets the user allow the id of their own build of the browser extension', async () => {
    const own = 'p'.repeat(32)
    const connectOwn = () =>
      new FakeBrowser(api.hub().port!, undefined, `chrome-extension://${own}`).connect()
    const restartHub = async () => {
      await vscode.commands.executeCommand('codegent.restartHub')
      await api.waitFor((s) => s.connection.hub === 'connected', 30_000)
    }
    try {
      await setSetting('advanced.extraBrowserExtensionIds', [own, 'not an id'])
      await restartHub() // the list is handed to the hub when it starts
      const browser = await connectOwn()
      try {
        await api.waitFor((s) => s.connection.browsers.length === 1)
      } finally {
        browser.close()
      }
      await api.waitFor((s) => s.connection.browsers.length === 0)
    } finally {
      await setSetting('advanced.extraBrowserExtensionIds', undefined)
      await restartHub()
    }
    await assert.rejects(connectOwn(), /403/)
  })

  itFromSources('restores a historical checkpoint and undoes it through the extension API', async () => {
    const fixture = workRepo()
    fixture.reset()
    const file = path.join(fixture.dir, 'src/greeting.txt')
    const dialogs: string[] = []
    let confirmRestore: ((choice: string) => void) | undefined
    const restoreDialog = replaceWindowFunction(
      'showWarningMessage',
      async (message: string, options?: { modal?: boolean }, ...buttons: string[]) => {
        if (!options?.modal) return undefined
        dialogs.push(message)
        if (message.startsWith('Restore '))
          return await new Promise<string>((resolve) => {
            confirmRestore = resolve
          })
        return buttons[0]
      }
    )
    try {
      fs.writeFileSync(file, 'changed by a committed agent step\n')
      git(fixture.dir, 'add', '-A')
      git(fixture.dir, 'commit', '-qm', 'CodeGent integration checkpoint')
      const current = git(fixture.dir, 'rev-parse', 'HEAD')
      await api.send({ type: 'refreshRepo' })
      const points = api.state().timeTravel?.points ?? []
      assert.equal(points[0]?.sha, current)
      assert.equal(points[1]?.sha, fixture.base)

      const restoring = api.send({ type: 'restorePoint', sha: fixture.base })
      await until(() => confirmRestore !== undefined, 'the restore dialog to open', 15_000)
      assert.equal(api.state().busy, true)
      await api.send({ type: 'start', task: 'This must not run during a restore' })
      assert.match(api.state().notice?.text ?? '', /Time Travel is in progress/)
      confirmRestore!('Restore files')
      await restoring
      confirmRestore = undefined
      assert.equal(api.state().busy, false)
      assert.equal(fs.readFileSync(file, 'utf8'), 'hello\nworld\n')
      assert.equal(api.state().timeTravel?.undoAvailable, true)
      const restoredRepo = api.state().repo
      assert.equal(restoredRepo.ok, true)
      if (!restoredRepo.ok) throw new Error('Expected the repository to remain valid')
      assert.equal(restoredRepo.dirtyCount, 1)

      await api.send({ type: 'undoTimeTravel' })
      assert.equal(fs.readFileSync(file, 'utf8'), 'changed by a committed agent step\n')
      assert.equal(git(fixture.dir, 'rev-parse', 'HEAD'), current)
      assert.equal(git(fixture.dir, 'status', '--porcelain'), '')
      assert.equal(api.state().timeTravel?.undoAvailable, false)
      assert.equal(dialogs.length, 2)
      assert.match(dialogs[0]!, /Restore/)
      assert.match(dialogs[1]!, /Undo/)
    } finally {
      confirmRestore?.('Restore files')
      restoreDialog()
      fixture.reset()
      await api.send({ type: 'refreshRepo' })
    }
  })

  it('keeps the toggles in sync with the VS Code settings', async () => {
    try {
      await api.send({ type: 'setToggle', key: 'autoApply', value: false })
      await api.waitFor((s) => !s.toggles.autoApply)
      assert.equal(configuration().get('autoApply'), false)

      // And the other way round: editing settings.json updates the panel.
      await setSetting('autoApply', true)
      await api.waitFor((s) => s.toggles.autoApply)
    } finally {
      await setSetting('autoApply', undefined)
    }
  })

  it('starts a fresh hub when asked to restart it, and browsers can join that one', async () => {
    await vscode.commands.executeCommand('codegent.restartHub')
    await api.waitFor((s) => s.connection.hub === 'connected', 30_000)
    const { port } = api.hub()
    assert.ok(port !== null)
    assert.ok(
      (await fetch(`http://127.0.0.1:${port}/health`)).ok,
      'the new hub does not answer'
    )

    const browser = await new FakeBrowser(port).connect()
    try {
      await api.waitFor((s) => s.connection.browsers.length === 1)
    } finally {
      browser.close()
    }
  })
})
