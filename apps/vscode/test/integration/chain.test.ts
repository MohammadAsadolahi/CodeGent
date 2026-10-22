// The whole product except the real ChatGPT: VS Code (this extension) → hub → the REAL browser
// extension in a real Chromium → a pretend chatgpt.com page with a real ProseMirror composer.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import { git } from '../support/git-fixture'
import { MockChatGpt } from '../support/mock-client'
import { chatReply, createdFile, updatedFile } from '../support/replies'
import { getApi, setSetting, workRepo } from './env'
import { REPO } from './fixture'

describe('the whole chain, with the real browser extension', function () {
  let api: CodeGentApi
  let mock: MockChatGpt
  const repo = workRepo()
  const run = () => api.state().run!
  const start = (task: string) => api.send({ type: 'start', task })
  const read = (relative: string) =>
    fs.readFileSync(path.join(repo.dir, ...relative.split('/')), 'utf8')

  before(async function () {
    this.timeout(120_000)
    const port = Number(process.env.CODEGENT_IT_MOCK_PORT)
    if (!port) return this.skip()
    mock = new MockChatGpt(port)
    api = await getApi()
    await api.waitFor((state) => state.connection.hub === 'connected', 30_000)
    // The browser extension was started first and has been probing for a hub; it must find this one.
    await api.waitFor((state) => state.connection.browsers.length === 1, 60_000)
  })

  beforeEach(async () => {
    repo.reset()
    await mock.reset()
    await api.send({ type: 'dismissRun' })
    await api.send({ type: 'clearHistory' })
    await api.setPublishingConsent(REPO, 'allow')
    await api.send({ type: 'refreshRepo' })
    await api.waitFor((state) => state.connection.browsers.length === 1, 30_000)
  })

  afterEach(async () => {
    await mock.release() // never leave the page "generating"
    await api.send({ type: 'stop' })
    await api.waitFor((state) => !state.run || state.run.state !== 'running', 30_000)
    await mock.setLoggedOut(false)
    for (const key of ['autoApply', 'git.push', 'git.commit'])
      await setSetting(key, undefined)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  it('finds the hub that VS Code started, although the browser extension was running first', () => {
    const { browsers } = api.state().connection
    assert.equal(browsers.length, 1)
    assert.match(browsers[0]!.label, /Chrom/i)
  })

  it('types the task into a real ChatGPT tab, reads the answer, applies it, commits and pushes it', async function () {
    this.timeout(120_000)
    await mock.queueReply(
      chatReply(
        'Added the greeting.',
        [createdFile('hello.txt', 'Hello from the chain')],
        'done'
      )
    )

    await start('Create hello.txt')

    assert.equal(run().outcome, 'done', JSON.stringify(run()))
    assert.equal(read('hello.txt'), 'Hello from the chain\n')
    assert.match(git(repo.dir, 'log', '-1', '--format=%s'), /^codegent: /)
    assert.equal(git(repo.bare, 'rev-parse', 'main'), git(repo.dir, 'rev-parse', 'HEAD'))

    // What arrived in the page is the whole prompt, line breaks included.
    const { sent } = await mock.log()
    assert.equal(sent.length, 1)
    assert.ok(sent[0]!.includes(REPO) && sent[0]!.includes('Create hello.txt'), sent[0])
    assert.ok(
      sent[0]!.includes('CODEGENT_STATUS'),
      'the reply-format instructions arrived'
    )
    assert.ok(sent[0]!.split('\n').length > 10, 'the prompt kept its line breaks')

    assert.ok(
      run().conversationUrl?.startsWith('https://chatgpt.com/'),
      run().conversationUrl
    )
    assert.ok(api.state().connection.chatgptTabs >= 1)
  })

  it('does the same against the redesigned ChatGPT page (one send/stop button, no test ids)', async function () {
    this.timeout(120_000)
    await mock.setLayout('redesign')
    await mock.queueReply(
      chatReply(
        'Added the notes.',
        [
          createdFile('redesign.txt', 'works'),
          updatedFile('README.md', '# Demo project', '# Demo project (redesign)')
        ],
        'done'
      )
    )

    await start('Create redesign.txt and touch the README')

    assert.equal(run().outcome, 'done', JSON.stringify(run()))
    assert.equal(read('redesign.txt'), 'works\n')
    assert.match(read('README.md'), /# Demo project \(redesign\)/)
    const { sent } = await mock.log()
    assert.equal(sent.length, 1)
    assert.ok(sent[0]!.includes('Create redesign.txt'), sent[0])
  })

  it('applies an edit that the page draws in a code viewer with one element per line (a python fence)', async function () {
    this.timeout(120_000)
    await mock.setLayout('redesign')
    fs.writeFileSync(
      path.join(repo.dir, 'greet.py'),
      'def greet():\n    return "hi"\n\n\n# --- end ---\n'
    )
    git(repo.dir, 'add', 'greet.py')
    git(repo.dir, 'commit', '-q', '-m', 'add greet.py')
    await api.send({ type: 'refreshRepo' })
    await mock.queueReply(
      chatReply(
        'Added the parameter.',
        [
          updatedFile(
            'greet.py',
            'def greet():\n    return "hi"\n\n\n# --- end ---',
            'def greet(name):\n    return f"hello {name}"\n\n\n# --- end ---',
            'python'
          )
        ],
        'done'
      )
    )

    await start('Let greet take a name')

    assert.equal(run().outcome, 'done', JSON.stringify(run()))
    assert.equal(
      read('greet.py'),
      'def greet(name):\n    return f"hello {name}"\n\n\n# --- end ---\n'
    )
    const { sent } = await mock.log()
    assert.equal(sent.length, 1, 'no correction turn was needed')
    assert.equal(
      git(repo.dir, 'show', '--name-only', '--format=', 'HEAD').trim(),
      'greet.py'
    )
  })

  it('continues in the same conversation, sending each result back', async function () {
    this.timeout(120_000)
    await mock.queueReply(
      chatReply('First file.', [createdFile('notes.txt', 'one\ntwo')], 'continue')
    )
    await mock.queueReply(
      chatReply('Second line.', [updatedFile('notes.txt', 'two', 'three')], 'continue')
    )
    await mock.queueReply(chatReply('Nothing left.', [], 'done'))

    await start('Write the notes')

    assert.equal(run().outcome, 'done', JSON.stringify(run()))
    assert.equal(read('notes.txt'), 'one\nthree\n')
    const { sent } = await mock.log()
    assert.equal(sent.length, 3)
    assert.match(sent[1]!, /^CodeGent result — step 1/)
    assert.ok(sent[1]!.includes('notes.txt'))
    assert.match(sent[2]!, /^CodeGent result — step 2/)
    assert.equal(git(repo.dir, 'rev-list', '--count', `${repo.base}..HEAD`), '2')
  })

  it("presses ChatGPT's stop button when the run is stopped", async function () {
    this.timeout(120_000)
    await mock.queueReply(chatReply('Never finished.', [], 'done'), { hold: true })
    const finished = start('Create hello.txt')
    await waitForSent(1)

    await api.send({ type: 'stop' })
    await finished

    assert.equal(run().outcome, 'stopped')
    assert.ok((await mock.log()).stopClicks >= 1, 'the page was told to stop generating')
  })

  it('survives a hub restart while ChatGPT is still answering', async function () {
    this.timeout(180_000)
    await mock.queueReply(
      chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'),
      { hold: true }
    )
    const finished = start('Create hello.txt')
    await waitForSent(1)

    await vscode.commands.executeCommand('codegent.restartHub')
    await api.waitFor((state) => state.connection.hub === 'connected', 30_000)
    // The browser extension notices the new hub by itself and reconnects.
    await api.waitFor((state) => state.connection.browsers.length === 1, 60_000)
    await mock.release()
    await finished

    assert.equal(run().outcome, 'done', JSON.stringify(run()))
    assert.equal(read('hello.txt'), 'hi\n')
  })

  it('pauses while ChatGPT is signed out, and carries on after signing in', async function () {
    this.timeout(180_000)
    await mock.setLoggedOut(true)
    await start('Create hello.txt')
    assert.equal(run().state, 'paused', JSON.stringify(run()))
    assert.match(run().message ?? '', /sign|log/i)

    await mock.setLoggedOut(false)
    await mock.queueReply(
      chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done')
    )
    await api.send({ type: 'resume' })

    assert.equal(run().outcome, 'done', JSON.stringify(run()))
    assert.equal(read('hello.txt'), 'hi\n')
  })

  /** Waits until the page has received `count` messages. */
  async function waitForSent(count: number): Promise<void> {
    const deadline = Date.now() + 60_000
    while ((await mock.log()).sent.length < count) {
      if (Date.now() > deadline)
        throw new Error(`the page never received message ${count}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
})
