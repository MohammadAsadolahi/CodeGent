import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import type { JobRequest } from '@codegent/protocol'
import { FakeBrowser, until } from '../support/fake-browser'
import { git, write } from '../support/git-fixture'
import { chatReply, createdFile, updatedFile } from '../support/replies'
import { sandbox, workRepo } from './env'
import { CONVERSATION, installRunHooks } from './fixture'

describe('when things go wrong', () => {
  const ctx = installRunHooks()
  const repo = workRepo()
  const run = () => ctx.api.state().run!
  const start = (task: string) => ctx.api.send({ type: 'start', task })
  const exists = (relative: string) => fs.existsSync(path.join(repo.dir, ...relative.split('/')))

  /** Answers the first message with `first` and every later one with the next entry of `later`. */
  const script = (...replies: string[]) => ctx.browser.answerWith((_job, index) => replies[Math.min(index, replies.length - 1)]!)

  it('keeps waiting through a hub restart and takes the reply the browser delivers afterwards', async () => {
    const asked: JobRequest[] = []
    ctx.browser.onJob = (job) => void asked.push(job) // ChatGPT is still writing its answer
    const finished = start('Create hello.txt')
    await until(() => asked.length === 1, 'the message to reach the browser')

    await vscode.commands.executeCommand('codegent.restartHub')
    await ctx.api.waitFor((state) => state.connection.hub === 'connected', 30_000)

    // The browser extension reconnects by itself and hands over the reply it was holding.
    const reconnected = await new FakeBrowser(ctx.api.hub().port!, ctx.browser.id).connect()
    try {
      await ctx.api.waitFor((state) => state.connection.browsers.length === 1)
      reconnected.reply(asked[0]!, {
        kind: 'completed',
        markdown: chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'),
        conversationUrl: CONVERSATION,
        durationMs: 1
      })
      await finished
    } finally {
      reconnected.close()
    }
    assert.equal(run().outcome, 'done')
    assert.ok(exists('hello.txt'))
  })

  describe('a reply that is not in the required format', () => {
    it('is answered with one reminder, and the corrected reply is applied', async () => {
      script(
        chatReply('You could add a file called hello.txt that says hi.', [], undefined),
        chatReply('Here it is.', [createdFile('hello.txt', 'hi')], 'done')
      )
      await start('Create hello.txt')

      assert.deepEqual(
        run().steps.map((step) => step.kind),
        ['initial', 'format-reminder']
      )
      assert.equal(run().outcome, 'done')
      assert.ok(exists('hello.txt'))
    })

    it('ends the run with the raw situation explained when the reminder does not help', async () => {
      script(chatReply('I would add a file.', [], undefined))
      await start('Create hello.txt')

      assert.equal(ctx.browser.jobs.length, 2)
      assert.equal(run().outcome, 'no-changes')
      assert.equal(exists('hello.txt'), false)
    })
  })

  it('is told exactly what was wrong when its SEARCH text is not quite in the file, and the file stays as it was', async () => {
    script(
      chatReply('Changing the greeting.', [updatedFile('src/greeting.txt', 'hello\nwurld', 'hello\nearth')], 'continue'),
      chatReply('Now with the right text.', [updatedFile('src/greeting.txt', 'hello\nworld', 'hello\nearth')], 'done')
    )
    await start('Change the greeting')

    assert.equal(run().steps[0]!.edits[0]!.status, 'failed')
    const report = ctx.browser.jobs[1]!.text
    assert.ok(report.includes('src/greeting.txt'), report)
    assert.match(report, /was not found/)
    assert.ok(report.includes('The closest text in the file') && report.includes('world'), `the real lines are shown: ${report}`)
    assert.equal(fs.readFileSync(path.join(repo.dir, 'src/greeting.txt'), 'utf8'), 'hello\nearth\n', 'only the corrected edit was applied')
    assert.equal(run().outcome, 'done')
  })

  it('asks for the rest when the reply is cut off, keeping what arrived complete', async () => {
    script(
      chatReply('Adding two files.', [createdFile('a.txt', 'alpha'), '### Created file: `b.txt`\n\n```txt\nbeta'], undefined),
      chatReply('The second file.', [createdFile('b.txt', 'beta')], 'done')
    )
    await start('Create a.txt and b.txt')

    assert.equal(run().steps[0]!.edits.filter((edit) => edit.status === 'applied').length, 1)
    assert.equal(run().steps[1]!.kind, 'cut-off-reminder')
    assert.ok(exists('a.txt') && exists('b.txt'))
    assert.equal(run().outcome, 'done')
  })

  it('writes nothing outside the repository or into .git, whatever path ChatGPT names', async () => {
    script(
      chatReply('Trying odd places.', [
        createdFile('../evil.txt', 'x'),
        createdFile('..\\evil2.txt', 'x'),
        createdFile('.git/hooks/pre-commit', 'echo owned'),
        createdFile('C:/Windows/codegent-evil.txt', 'x')
      ]),
      chatReply('Sorry, I cannot.', [], 'blocked')
    )
    await start('Create files')

    assert.deepEqual(
      run().steps[0]!.edits.map((edit) => edit.status),
      ['failed', 'failed', 'failed', 'failed']
    )
    assert.equal(fs.existsSync(path.join(sandbox(), 'evil.txt')), false)
    assert.equal(fs.existsSync(path.join(sandbox(), 'evil2.txt')), false)
    assert.equal(fs.existsSync(path.join(repo.dir, '.git', 'hooks', 'pre-commit')), false)
    assert.equal(fs.existsSync('C:/Windows/codegent-evil.txt'), false)
    assert.equal(git(repo.dir, 'rev-parse', 'HEAD'), repo.base, 'nothing was committed')
    assert.equal(run().outcome, 'blocked')
  })

  it('pauses when GitHub rejects the push, never claims it was pushed, and finishes the push after Resume', async () => {
    // Someone else pushed to GitHub in the meantime (a commit made straight in the remote).
    const tree = git(repo.bare, 'rev-parse', 'main^{tree}')
    const theirs = git(repo.bare, '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit-tree', tree, '-p', 'main', '-m', 'other work')
    git(repo.bare, 'update-ref', 'refs/heads/main', theirs)

    script(chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done'))
    await start('Create hello.txt')

    assert.equal(run().state, 'paused')
    assert.match(run().message ?? '', /push to GitHub failed/i)
    assert.match(run().message ?? '', /Pull/)
    assert.equal(ctx.browser.jobs.length, 1, 'ChatGPT has not been told anything about a push')
    assert.equal(git(repo.dir, 'log', '-1', '--format=%s').startsWith('codegent: '), true, 'the commit exists locally')

    // The user pulls what GitHub has (the "fix" the message asks for) and resumes.
    git(repo.dir, 'pull', '-q', '--no-edit', '--no-rebase', repo.bare, 'main')
    await ctx.api.send({ type: 'resume' })

    assert.equal(run().outcome, 'done')
    assert.equal(run().steps[0]!.publish?.state, 'pushed')
    assert.equal(git(repo.bare, 'rev-parse', 'main'), git(repo.dir, 'rev-parse', 'HEAD'))
    assert.ok(exists('hello.txt') && exists('other.txt'))
  })
})
