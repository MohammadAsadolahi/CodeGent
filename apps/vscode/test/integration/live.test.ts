// LIVE: the whole product against the REAL chatgpt.com, through the browser of whoever runs it.
//
// This is not part of `npm run test:integration`. It sends real messages from the signed-in
// ChatGPT account and needs the CodeGent browser extension loaded in a browser that is open
// (the extension finds the hub by itself). Run it with `npm run test:live`; set
// CODEGENT_LIVE_TASK to try another task. The repository is a clone of this one made for the run:
// ChatGPT reads the real code through its GitHub connector. Nothing is pushed (the connector
// could not see a commit that only exists here, and ChatGPT would rightly answer "blocked"): the
// run commits locally and the follow-up messages carry the result, and the clone's push address
// is a local bare repository as a second guard.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import type { CodeGentApi } from '../../src/app'
import type { UiRun } from '../../src/ui/protocol'
import { git } from '../support/git-fixture'
import { getApi, sandbox, setSetting } from './env'

const DEFAULT_TASK = [
  'Make exactly two small changes and nothing else.',
  '1. In packages/protocol/src/constants.ts add a one-line comment directly above `export const MAX_ID_CHARS = 100` that says what it limits.',
  '2. Create docs/e2e-note.md containing exactly this one line: CodeGent live end-to-end check passed.'
].join('\n')

describe('LIVE: the whole agent loop on the real chatgpt.com', function () {
  let api: CodeGentApi
  const dir = path.join(sandbox(), 'work')
  const bare = path.join(sandbox(), 'work.git')
  const started = Date.now()
  const log = (line: string) =>
    console.log(
      `      [${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${line}`
    )
  const read = (relative: string) =>
    fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8')

  before(async function () {
    this.timeout(180_000)
    api = await getApi()
    await api.waitFor((state) => state.connection.hub === 'connected', 30_000)
    log(`hub on port ${api.hub().port}; waiting for the browser extension…`)
    const state = await api.waitFor((s) => s.connection.browsers.length >= 1, 120_000)
    log(`browser connected: ${state.connection.browsers.map((b) => b.label).join(', ')}`)
    await vscode.commands.executeCommand('workbench.view.extension.codegent')
  })

  after(async () => {
    await api.send({ type: 'stop' })
    for (const key of ['replyTimeoutSeconds', 'maxSteps', 'git.push'])
      await setSetting(key, undefined)
  })

  it('takes a task, waits for ChatGPT, applies its edits, commits, reports back and finishes', async function () {
    this.timeout(25 * 60_000)
    await setSetting('replyTimeoutSeconds', 900)
    await setSetting('maxSteps', 6)
    await setSetting('git.push', false)

    const upstream = git(dir, 'remote', 'get-url', 'origin')
    const repoName = /github\.com[/:]([^/]+\/[^/.]+)/.exec(upstream)?.[1]
    assert.ok(repoName, `the clone has no GitHub address: ${upstream}`)
    await api.setPublishingConsent(repoName, 'allow')
    await api.send({ type: 'refreshRepo' })
    const base = git(dir, 'rev-parse', 'HEAD')
    log(
      `repository ${repoName} @ ${base.slice(0, 7)} (committing locally; pushing is off, and the push address is ${bare})`
    )

    const task = process.env.CODEGENT_LIVE_TASK || DEFAULT_TASK
    log(`task: ${task.replace(/\n/g, ' ⏎ ')}`)

    let last = ''
    const watcher = setInterval(() => {
      const run: UiRun | null = api.state().run
      if (!run) return
      const line = `${run.state}${run.phase ? ` · ${run.phase}` : ''}${run.detail ? ` — ${run.detail}` : ''} · steps ${run.steps.length}`
      if (line !== last) {
        last = line
        log(line)
      }
    }, 400)
    try {
      await api.send({ type: 'start', task })
    } finally {
      clearInterval(watcher)
    }

    const run = api.state().run
    assert.ok(run, 'no run was recorded')
    log(`finished: ${run.outcome} — ${run.message ?? ''}`)
    for (const step of run.steps) {
      log(
        `step ${step.n} (${step.kind}) status=${step.replyStatus} ${step.durationSeconds ?? '?'}s · ` +
          `${step.edits.map((e) => `${e.kind} ${e.path}: ${e.status}`).join('; ') || 'no edits'} · ` +
          `${step.publish ? step.publish.label : 'not published'}`
      )
      if (step.summary)
        log(`  ChatGPT: ${step.summary.replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const edit of step.edits)
        for (const error of edit.errors) log(`  ${edit.path}: ${error}`)
      for (const problem of step.problems) log(`  problem: ${problem}`)
    }
    log(`conversation: ${run.conversationUrl}`)

    assert.equal(run.outcome, 'done', JSON.stringify(run.message))
    assert.ok(
      run.steps.some((s) => s.edits.some((e) => e.status === 'applied')),
      'no edit was applied'
    )
    assert.ok(
      run.conversationUrl?.startsWith('https://chatgpt.com/'),
      `no ChatGPT conversation: ${run.conversationUrl}`
    )

    // What the task asked for, on disk.
    assert.equal(
      read('docs/e2e-note.md').trim(),
      'CodeGent live end-to-end check passed.'
    )
    assert.match(
      read('packages/protocol/src/constants.ts'),
      /(\/\/[^\n]*|\/\*[^\n]*\*\/)\n(export const MAX_ID_CHARS = 100)/
    )

    // And committed locally; nothing was pushed.
    assert.match(git(dir, 'log', '-1', '--format=%s'), /^codegent: /)
    assert.notEqual(git(dir, 'rev-parse', 'HEAD'), base)
    assert.equal(git(bare, 'rev-parse', 'main'), base, 'nothing may be pushed')
  })
})
