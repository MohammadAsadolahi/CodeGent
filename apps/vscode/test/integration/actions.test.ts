import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import { FakeBrowser, until } from '../support/fake-browser'
import { git } from '../support/git-fixture'
import { chatReply, createdFile } from '../support/replies'
import {
  describeFromSources,
  itFromSources,
  replaceWindowFunction,
  workRepo
} from './env'
import { CONVERSATION, installRunHooks, REPO } from './fixture'

describe('what the user can do', () => {
  const ctx = installRunHooks()
  const repo = workRepo()
  const run = () => ctx.api.state().run!
  const start = (task: string) => ctx.api.send({ type: 'start', task })
  const greeting = () =>
    ctx.browser.answerWith(() =>
      chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done')
    )
  const openEditors = () => vscode.window.visibleTextEditors.length

  /** Starts over with the repository at its first commit (the answer to the consent question stays). */
  const startOver = async () => {
    await ctx.api.send({ type: 'dismissRun' })
    repo.reset()
    await ctx.api.send({ type: 'refreshRepo' })
  }

  describe('opening a file from the panel', () => {
    it('opens a file of the repository', async () => {
      await ctx.api.send({ type: 'openFile', path: 'src/greeting.txt' })
      assert.match(
        vscode.window.activeTextEditor?.document.uri.fsPath ?? '',
        /src[\\/]greeting\.txt$/
      )
    })

    it('refuses paths that lead out of the repository, even into a sibling folder that starts with its name', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      for (const unsafe of [
        '../work.git/HEAD',
        '..\\work.git\\HEAD',
        '.git/config',
        'C:/Windows/win.ini'
      ]) {
        await ctx.api.send({ type: 'openFile', path: unsafe })
        assert.equal(openEditors(), 0, `${unsafe} must not be opened`)
      }
    })
  })

  describe('commands', () => {
    it('"Start Task" runs the task it is given', async () => {
      greeting()
      await vscode.commands.executeCommand('codegent.startRun', 'Create hello.txt')
      assert.equal(run().outcome, 'done')
      assert.ok(fs.existsSync(path.join(repo.dir, 'hello.txt')))
    })

    itFromSources('"Start Task" asks for the task when it is not given one', async () => {
      greeting()
      const prompts: unknown[] = []
      const restore = replaceWindowFunction('showInputBox', async (options: unknown) => {
        prompts.push(options)
        return 'Create hello.txt'
      })
      try {
        await vscode.commands.executeCommand('codegent.startRun')
      } finally {
        restore()
      }
      assert.equal(prompts.length, 1)
      assert.equal(run().outcome, 'done')
    })

    it('"Stop" ends the run that is waiting for ChatGPT', async () => {
      ctx.browser.onJob = () => {}
      const finished = start('Create hello.txt')
      await until(() => ctx.browser.jobs.length === 1, 'the message to reach the browser')
      await vscode.commands.executeCommand('codegent.stopRun')
      await finished
      assert.equal(run().outcome, 'stopped')
    })

    it('"Resume" continues a run that stopped for a problem', async () => {
      let attempts = 0
      ctx.browser.onJob = (_job, send) => {
        if (attempts++ === 0)
          return send({
            kind: 'failed',
            code: 'login-required',
            message: 'Sign in to ChatGPT first.'
          })
        send({
          kind: 'completed',
          markdown: chatReply('Added.', [createdFile('hello.txt', 'hi')], 'done'),
          conversationUrl: CONVERSATION,
          durationMs: 1
        })
      }
      await start('Create hello.txt')
      assert.equal(run().state, 'paused')
      await vscode.commands.executeCommand('codegent.resumeRun')
      assert.equal(run().outcome, 'done')
    })

    it('"Undo Last Step" takes the latest step back out of the working tree, and says so when there is nothing to undo', async () => {
      await vscode.commands.executeCommand('codegent.undoStep')
      assert.match(ctx.api.state().notice?.text ?? '', /no step to undo/i)

      greeting()
      await start('Create hello.txt')
      assert.ok(fs.existsSync(path.join(repo.dir, 'hello.txt')))
      await vscode.commands.executeCommand('codegent.undoStep')
      assert.equal(fs.existsSync(path.join(repo.dir, 'hello.txt')), false)
    })

    it('"Show Log" opens the output channel', async () => {
      await vscode.commands.executeCommand('codegent.showLog')
    })
  })

  describeFromSources('the question before the first commit and push', () => {
    /** Answers the modal question with `answer` (undefined = the dialog is closed) and records it. */
    const answerQuestion = (answer: string | undefined) => {
      const asked: Array<{ message: string; detail?: string; items: string[] }> = []
      const restore = replaceWindowFunction(
        'showInformationMessage',
        async (
          message: string,
          options?: { modal?: boolean; detail?: string },
          ...items: string[]
        ) => {
          if (typeof options !== 'object' || !options?.modal) return undefined // ordinary toasts
          asked.push({ message, detail: options.detail, items })
          return answer
        }
      )
      return { asked, restore }
    }

    beforeEach(async () => {
      await ctx.api.setPublishingConsent(REPO, undefined)
      greeting()
    })

    it('"Commit only" keeps the commit local, and the answer is remembered for the repository', async () => {
      const { asked, restore } = answerQuestion('Commit only')
      try {
        await start('Create hello.txt')
        assert.equal(asked.length, 1)
        assert.ok(
          asked[0]!.message.includes(REPO) && asked[0]!.message.includes('main'),
          asked[0]!.message
        )
        assert.deepEqual(asked[0]!.items, ['Commit and push', 'Commit only'])
        assert.equal(run().steps[0]!.publish?.state, 'committed')
        assert.equal(
          git(repo.bare, 'rev-parse', 'main'),
          repo.base,
          'nothing reached GitHub'
        )

        await startOver()
        await start('Create hello.txt again')
        assert.equal(asked.length, 1, 'it does not ask twice')
        assert.equal(run().steps[0]!.publish?.state, 'committed')
      } finally {
        restore()
      }
    })

    it('"Commit and push" publishes, and the answer is remembered too', async () => {
      const { asked, restore } = answerQuestion('Commit and push')
      try {
        await start('Create hello.txt')
        assert.equal(run().steps[0]!.publish?.state, 'pushed')
        assert.equal(
          git(repo.bare, 'rev-parse', 'main'),
          git(repo.dir, 'rev-parse', 'HEAD')
        )

        await startOver()
        await start('Create hello.txt again')
        assert.equal(asked.length, 1)
        assert.equal(run().steps[0]!.publish?.state, 'pushed')
      } finally {
        restore()
      }
    })

    it('starts nothing when the question is dismissed, and asks again next time', async () => {
      const { asked, restore } = answerQuestion(undefined)
      try {
        await start('Create hello.txt')
        assert.equal(ctx.api.state().run, null)
        assert.equal(ctx.browser.jobs.length, 0)
        await start('Create hello.txt')
        assert.equal(asked.length, 2)
      } finally {
        restore()
      }
    })

    it('can be made to ask again with "Ask Again Before Committing and Pushing"', async () => {
      await ctx.api.setPublishingConsent(REPO, 'allow')
      await vscode.commands.executeCommand('codegent.resetPublishingConsent')
      const { asked, restore } = answerQuestion('Commit only')
      try {
        await start('Create hello.txt')
        assert.equal(asked.length, 1)
      } finally {
        restore()
      }
    })
  })

  describeFromSources('with several browsers connected', () => {
    it('asks which one to use, sends the message there, and remembers the choice', async () => {
      const second = await new FakeBrowser(ctx.api.hub().port!).connect()
      try {
        await ctx.api.waitFor((state) => state.connection.browsers.length === 2)
        for (const browser of [ctx.browser, second])
          browser.answerWith(() =>
            chatReply('Added the greeting.', [createdFile('hello.txt', 'hi')], 'done')
          )
        const asked: Array<Array<{ label: string; description: string; id: string }>> = []
        const restore = replaceWindowFunction(
          'showQuickPick',
          async (items: Array<{ label: string; description: string; id: string }>) => {
            asked.push(items)
            return items.find((item) => item.id === second.id)
          }
        )
        try {
          await start('Create hello.txt')
          assert.equal(asked.length, 1)
          assert.equal(asked[0]!.length, 2)
          assert.equal(second.jobs.length, 1)
          assert.equal(ctx.browser.jobs.length, 0)

          await startOver()
          await start('Create hello.txt again')
          assert.equal(asked.length, 1, 'it does not ask again')
          assert.equal(second.jobs.length, 2)
        } finally {
          restore()
        }
      } finally {
        second.close()
      }
    })

    it('lets the user pick the browser from the panel', async () => {
      const second = await new FakeBrowser(ctx.api.hub().port!).connect()
      try {
        await ctx.api.waitFor((state) => state.connection.browsers.length === 2)
        assert.equal(ctx.api.state().connection.selectedBrowserId, undefined)
        const restore = replaceWindowFunction(
          'showQuickPick',
          async (items: Array<{ id: string }>) =>
            items.find((item) => item.id === second.id)
        )
        try {
          await ctx.api.send({ type: 'chooseBrowser' })
        } finally {
          restore()
        }
        assert.equal(ctx.api.state().connection.selectedBrowserId, second.id)
      } finally {
        second.close()
      }
    })
  })
})
