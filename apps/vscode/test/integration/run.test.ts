import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import { FakeBrowser, until } from '../support/fake-browser'
import { git, write } from '../support/git-fixture'
import { chatReply, createdFile, updatedFile } from '../support/replies'
import { getApi, setSetting, workRepo } from './env'

const REPO = 'octo/project'
const CONVERSATION = 'https://chatgpt.com/c/test-conversation'

describe('an agent run in VS Code', () => {
  let api: CodeGentApi
  let browser: FakeBrowser
  const repo = workRepo()
  const file = (relative: string) => path.join(repo.dir, ...relative.split('/'))
  const read = (relative: string) => fs.readFileSync(file(relative), 'utf8')

  /** Starts a run; resolves when it has finished or paused (the panel does not wait for this). */
  const start = (task: string) => api.send({ type: 'start', task })
  const run = () => api.state().run!

  before(async () => {
    api = await getApi()
    await api.waitFor((state) => state.connection.hub === 'connected', 30_000)
  })

  beforeEach(async () => {
    repo.reset()
    await api.send({ type: 'dismissRun' })
    await api.send({ type: 'clearHistory' })
    await api.setPublishingConsent(REPO, 'allow')
    await api.send({ type: 'refreshRepo' })
    browser = await new FakeBrowser(api.hub().port!).connect()
    await api.waitFor((state) => state.connection.browsers.length === 1)
  })

  afterEach(async () => {
    await api.send({ type: 'stop' })
    await api.waitFor((state) => !state.run || state.run.state !== 'running', 15_000)
    browser.close()
    await api.waitFor((state) => state.connection.browsers.length === 0)
    for (const key of ['autoApply', 'autoContinue', 'git.push', 'git.commit', 'verifyCommand', 'diagnosticsWaitSeconds']) {
      await setSetting(key, undefined)
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  it("applies ChatGPT's reply, commits only that file and pushes it to GitHub", async () => {
    browser.answerWith(() => chatReply('I added the greeting file.', [createdFile('hello.txt', 'Hello from CodeGent')], 'done'))

    await start('Create hello.txt')

    // What ChatGPT was asked.
    assert.equal(browser.jobs.length, 1)
    const job = browser.jobs[0]!
    assert.equal(job.newChat, true)
    assert.equal(job.autoSubmit, true)
    assert.equal(job.chatUrl, 'https://chatgpt.com/')
    assert.ok(job.text.includes(REPO), 'the prompt names the repository')
    assert.ok(job.text.includes('Create hello.txt'), 'the prompt contains the task')

    // What happened in the working tree and in git.
    assert.equal(read('hello.txt'), 'Hello from CodeGent\n')
    assert.match(git(repo.dir, 'log', '-1', '--format=%s'), /^codegent: /)
    assert.deepEqual(git(repo.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['hello.txt'])
    assert.equal(git(repo.bare, 'rev-parse', 'main'), git(repo.dir, 'rev-parse', 'HEAD'), 'the commit reached GitHub')
    assert.equal(git(repo.dir, 'status', '--porcelain'), '')

    // What the panel shows.
    const state = api.state()
    assert.equal(run().state, 'finished')
    assert.equal(run().outcome, 'done')
    assert.equal(run().conversationUrl, CONVERSATION)
    const step = run().steps[0]!
    assert.deepEqual(
      step.edits.map((edit) => [edit.path, edit.kind, edit.status]),
      [['hello.txt', 'created', 'applied']]
    )
    assert.equal(step.publish?.state, 'pushed')
    assert.equal(step.canUndo, true)
    assert.equal(state.history.length, 1)
    assert.equal(state.history[0]!.outcome, 'done')
  })

  it('continues over several steps in one conversation, reporting each result back', async () => {
    browser.answerWith((_job, index) =>
      [
        chatReply('Start with the notes file.', [createdFile('notes.txt', 'one\ntwo')], 'continue'),
        chatReply('Fix the second line.', [updatedFile('notes.txt', 'two', 'three')], 'continue'),
        chatReply('Nothing left to do.', [], 'done')
      ][index]!
    )

    await start('Write the notes')

    assert.equal(browser.jobs.length, 3)
    assert.deepEqual(
      browser.jobs.map((job) => job.newChat),
      [true, false, false]
    )
    assert.equal(new Set(browser.jobs.map((job) => job.sessionId)).size, 1, 'one conversation')
    assert.match(browser.jobs[1]!.text, /step 1/)
    assert.ok(browser.jobs[1]!.text.includes('notes.txt'), 'the result of step 1 mentions the file')
    assert.match(browser.jobs[2]!.text, /step 2/)

    assert.equal(read('notes.txt'), 'one\nthree\n')
    assert.equal(git(repo.dir, 'rev-list', '--count', `${repo.base}..HEAD`), '2')
    assert.equal(git(repo.bare, 'rev-parse', 'main'), git(repo.dir, 'rev-parse', 'HEAD'))
    assert.equal(run().outcome, 'done')
    assert.equal(run().steps.length, 3)
  })

  it('leaves your own uncommitted work alone', async () => {
    write(repo.dir, 'src/keep.txt', 'untouched\nmy work in progress\n') // a tracked file with local changes
    write(repo.dir, 'mine.txt', 'not committed yet\n') // and a new file
    await api.send({ type: 'refreshRepo' })
    const status = api.state().repo
    assert.equal(status.ok && status.dirtyCount, 2)

    browser.answerWith(() => chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'))
    await start('Create hello.txt')

    assert.equal(run().outcome, 'done')
    assert.deepEqual(git(repo.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['hello.txt'])
    assert.deepEqual(git(repo.dir, 'status', '--porcelain').split('\n').sort(), [' M src/keep.txt', '?? mine.txt'])
    assert.equal(read('src/keep.txt'), 'untouched\nmy work in progress\n')
  })

  it('refuses to overwrite changes that are only in an unsaved editor', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file('src/keep.txt')))
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// unsaved idea\n'))
    assert.equal(document.isDirty, true)

    browser.answerWith((_job, index) =>
      [
        chatReply('Changing the file.', [updatedFile('src/keep.txt', 'untouched', 'changed')], 'done'),
        chatReply('Understood, leaving it.', [], 'done')
      ][index]!
    )
    await start('Change keep.txt')

    const first = run().steps[0]!
    assert.equal(first.edits[0]!.status, 'failed')
    assert.match(first.edits[0]!.errors.join(' '), /uncommitted local changes/)
    assert.equal(fs.readFileSync(file('src/keep.txt'), 'utf8'), 'untouched\n', 'the file on disk is unchanged')
    assert.ok(document.getText().startsWith('// unsaved idea'), 'the unsaved text is still in the editor')
    assert.ok(browser.jobs[1]!.text.includes('left alone'), 'ChatGPT is told why')
    assert.equal(git(repo.dir, 'rev-list', '--count', `${repo.base}..HEAD`), '0', 'nothing was committed')

    await vscode.commands.executeCommand('workbench.action.files.revert')
  })

  it('shows the proposal and waits for approval when auto-apply is off', async () => {
    await setSetting('autoApply', false)
    await api.waitFor((state) => !state.toggles.autoApply)
    browser.answerWith(() => chatReply('Added the greeting.', [createdFile('hello.txt', 'Hello from CodeGent')], 'done'))

    const finished = start('Create hello.txt')
    const state = await api.waitFor((s) => s.review !== null)
    assert.deepEqual(
      state.review!.files.map((entry) => [entry.path, entry.kind, entry.added]),
      [['hello.txt', 'create', 1]]
    )
    assert.equal(fs.existsSync(file('hello.txt')), false, 'nothing is written before approval')

    // The diff opens in VS Code's diff editor, with the proposed text on the right.
    await api.send({ type: 'openDiff', path: 'hello.txt' })
    const diff = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.input)
      .find((input): input is vscode.TabInputTextDiff => input instanceof vscode.TabInputTextDiff)
    assert.ok(diff, 'a diff editor is open')
    assert.equal(diff.modified.scheme, 'codegent-diff')
    assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), 'Hello from CodeGent\n')
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), '')

    await api.send({ type: 'decide', decision: 'apply' })
    await finished
    assert.equal(read('hello.txt'), 'Hello from CodeGent\n')
    assert.equal(run().outcome, 'done')
    assert.equal(run().steps[0]!.decision, 'apply')
  })

  it('applies nothing when the proposal is declined, and tells ChatGPT', async () => {
    await setSetting('autoApply', false)
    await api.waitFor((state) => !state.toggles.autoApply)
    browser.answerWith((_job, index) =>
      [
        chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'continue'),
        chatReply('Alright, I will stop here.', [], 'done')
      ][index]!
    )

    const finished = start('Create hello.txt')
    await api.waitFor((s) => s.review !== null)
    await api.send({ type: 'decide', decision: 'skip' })
    await finished

    assert.equal(fs.existsSync(file('hello.txt')), false)
    assert.equal(git(repo.dir, 'rev-list', '--count', `${repo.base}..HEAD`), '0')
    assert.match(browser.jobs[1]!.text, /not to apply|declined/i)
    assert.equal(run().steps[0]!.decision, 'skip')
  })

  it('undoes a step in the working tree', async () => {
    browser.answerWith(() => chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'))
    await start('Create hello.txt')
    assert.equal(fs.existsSync(file('hello.txt')), true)

    await api.send({ type: 'undo', step: 1 })

    assert.equal(fs.existsSync(file('hello.txt')), false)
    const step = run().steps[0]!
    assert.equal(step.undone, true)
    assert.equal(step.canUndo, false)
    assert.match(api.state().notice?.text ?? '', /undone/)
  })

  it('stops on request and cancels the message in the browser', async () => {
    browser.onJob = () => {} // ChatGPT never answers
    const finished = start('Create hello.txt')
    await until(() => browser.jobs.length === 1, 'the message to reach the browser')

    await api.send({ type: 'stop' })
    await finished

    assert.equal(run().outcome, 'stopped')
    await until(() => browser.cancels.length === 1, 'the cancel to reach the browser')
    assert.equal(browser.cancels[0]!.jobId, browser.jobs[0]!.jobId)
  })

  it('commits locally when pushing is off, and pushes on request', async () => {
    await setSetting('git.push', false)
    await api.waitFor((state) => !state.toggles.push)
    browser.answerWith(() => chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'))

    await start('Create hello.txt')

    assert.equal(run().steps[0]!.publish?.state, 'committed')
    assert.equal(git(repo.bare, 'rev-parse', 'main'), repo.base, 'GitHub has not seen the commit')
    await api.send({ type: 'refreshRepo' })
    const status = api.state().repo
    assert.equal(status.ok && status.ahead, 1)

    await api.send({ type: 'pushNow' })
    assert.equal(git(repo.bare, 'rev-parse', 'main'), git(repo.dir, 'rev-parse', 'HEAD'))
    assert.match(api.state().notice?.text ?? '', /Pushed main/)
    await api.waitFor((state) => state.repo.ok && state.repo.ahead === 0)
  })

  it('does not commit at all when committing is off', async () => {
    await setSetting('git.commit', false)
    await api.waitFor((state) => !state.toggles.commit)
    browser.answerWith(() => chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'))

    await start('Create hello.txt')

    assert.equal(run().outcome, 'done')
    assert.equal(run().steps[0]!.publish?.state, 'skipped')
    assert.equal(git(repo.dir, 'rev-parse', 'HEAD'), repo.base)
    assert.equal(git(repo.dir, 'status', '--porcelain'), '?? hello.txt')
  })

  it('pauses when ChatGPT reports a problem and carries on after Resume', async () => {
    let attempts = 0
    browser.onJob = (_job, send) => {
      if (attempts++ === 0) return send({ kind: 'failed', code: 'rate-limited', message: 'ChatGPT says you are sending too many requests' })
      send({
        kind: 'completed',
        markdown: chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'),
        conversationUrl: CONVERSATION,
        durationMs: 1
      })
    }

    await start('Create hello.txt')
    assert.equal(run().state, 'paused')
    assert.equal(run().canResume, true)
    assert.match(run().message ?? '', /too many requests/)

    await api.send({ type: 'resume' })
    assert.equal(run().outcome, 'done')
    assert.equal(read('hello.txt'), 'hi\n')
    assert.equal(browser.jobs.length, 2)
  })

  it('refuses to start while GitHub has commits that are not in the working tree', async () => {
    write(repo.dir, 'upstream.txt', 'someone else pushed this\n')
    git(repo.dir, 'add', '-A')
    git(repo.dir, 'commit', '-q', '-m', 'someone else')
    git(repo.dir, 'push', '-q', 'origin', 'main')
    git(repo.dir, 'reset', '-q', '--hard', repo.base) // the working tree is now behind GitHub
    browser.answerWith(() => chatReply('Should never be asked.', [], 'done'))

    await start('Create hello.txt')

    assert.equal(api.state().run, null)
    assert.equal(browser.jobs.length, 0)
    assert.match(api.state().notice?.text ?? '', /Pull first/)
  })

  it('runs the verify command and tells ChatGPT when it fails', async () => {
    await setSetting('verifyCommand', `node -e "console.log('VERIFY-MARKER'); process.exit(3)"`)
    browser.answerWith((_job, index) =>
      [
        chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'),
        chatReply('Looking into it.', [], 'blocked')
      ][index]!
    )

    await start('Create hello.txt')

    assert.deepEqual(
      { outcome: run().steps[0]!.verify?.outcome, exitCode: run().steps[0]!.verify?.exitCode },
      { outcome: 'failed', exitCode: 3 }
    )
    assert.equal(browser.jobs.length, 2, 'a failing check keeps the run going instead of finishing')
    assert.ok(browser.jobs[1]!.text.includes('VERIFY-MARKER'), 'the command output is sent back')
  })

  it('reports the errors the language servers find in the changed files', async function () {
    this.timeout(180_000)
    // The built-in TypeScript server has to be up before it can judge a new file.
    const typescript = vscode.extensions.getExtension('vscode.typescript-language-features')
    if (!typescript) return this.skip()
    await typescript.activate()
    write(repo.dir, 'warmup.ts', 'export const warmup: number = "text"\n')
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file('warmup.ts')))
    await until(
      () => vscode.languages.getDiagnostics(document.uri).length > 0,
      `the TypeScript server to start (language ${document.languageId})`,
      120_000
    )

    await setSetting('diagnosticsWaitSeconds', 20)
    browser.answerWith((_job, index) =>
      [
        chatReply('Added the module.', [createdFile('src/count.ts', 'export const count: number = "three"')], 'done'),
        chatReply('I will leave it.', [], 'blocked')
      ][index]!
    )
    await start('Create src/count.ts')

    const diagnostics = run().steps[0]!.diagnostics
    assert.ok(diagnostics && diagnostics.errors >= 1, `expected an error in src/count.ts, got ${JSON.stringify(diagnostics)}`)
    assert.equal(diagnostics.items[0]!.path, 'src/count.ts')
    assert.ok(browser.jobs[1]!.text.includes('src/count.ts'), 'the error is reported back')
  })
})
