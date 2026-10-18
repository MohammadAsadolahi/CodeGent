import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import { FakeBrowser, until } from '../support/fake-browser'
import { configuration, getApi, hubPorts, setSetting } from './env'

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
