import { describe, expect, it } from 'vitest'
import { AgentRun, DEFAULT_SETTINGS, type RunSettings } from '../src'
import {
  ChatError,
  createReply,
  deleteReply,
  GitError,
  harness,
  reply,
  ScriptedApproval,
  updateReply
} from './fakes'

const settings = (over: Partial<RunSettings> = {}): RunSettings => ({ ...DEFAULT_SETTINGS, ...over })

const run = (h: ReturnType<typeof harness>, over: Partial<RunSettings> = {}, task = 'Add a greeting module') =>
  new AgentRun(h.deps, settings(over), task)

const finalState = (snapshot: { state: { kind: string } }) => snapshot.state

describe('a complete task', () => {
  it('works step by step: apply, check, commit, push, report back, and finish when ChatGPT says done', async () => {
    const h = harness(
      [
        reply('Add the module.', [createReply('src/greeting.ts', 'export const greet = () => "hi"')], 'continue'),
        reply('Wire it into main.', [updateReply('src/main.ts', 'main()', 'main(greet())')], 'continue'),
        reply('All wired up.', [], 'done')
      ],
      { 'src/main.ts': 'main()\n' }
    )
    const states: string[] = []
    const agent = run(h)
    agent.onChange((s) => {
      const key = s.state.kind === 'running' ? `running:${s.state.phase}` : s.state.kind
      if (states.at(-1) !== key) states.push(key)
    })

    const snapshot = await agent.start()

    expect(finalState(snapshot)).toMatchObject({ kind: 'finished', outcome: 'done', message: 'All wired up.' })
    expect(h.workspace.files.get('src/greeting.ts')).toBe('export const greet = () => "hi"\n')
    expect(h.workspace.files.get('src/main.ts')).toBe('main(greet())\n')
    expect(h.git.commits.map((c) => c.paths)).toEqual([['src/greeting.ts'], ['src/main.ts']])
    expect(h.git.commits[0]!.message).toMatch(/^codegent: Add the module\n\nCodeGent step 1\.$/)
    expect(h.git.pushes).toBe(2)

    // The conversation: initial prompt, then two follow-ups.
    expect(h.chat.sent.map((r) => r.newChat)).toEqual([true, false, false])
    expect(new Set(h.chat.sent.map((r) => r.sessionId)).size).toBe(1)
    expect(h.chat.texts[0]).toContain('octo/project')
    expect(h.chat.texts[0]).toContain('Add a greeting module')
    expect(h.chat.texts[1]).toMatch(/^CodeGent result — step 1\n\nThe change was applied\./)
    expect(h.chat.texts[1]).toContain('`src/greeting.ts` — created')
    expect(h.chat.texts[1]).toMatch(/pushed it to origin\/main/)
    expect(h.chat.texts[2]).toContain('step 2')

    expect(snapshot.steps.map((s) => s.messageKind)).toEqual(['initial', 'follow-up', 'follow-up'])
    expect(snapshot.steps.map((s) => s.outcomes.length)).toEqual([1, 1, 0])
    expect(snapshot.steps[0]!.publish).toMatchObject({ state: 'pushed', branch: 'main' })
    expect(snapshot.conversationUrl).toBe('https://chatgpt.com/c/test-conversation')
    expect(states[0]).toBe('running:preparing')
    expect(states).toContain('running:applying')
    expect(states).toContain('running:publishing')
    expect(states.at(-1)).toBe('finished')
  })

  it('finishes straight away when the first reply is already done with changes applied', async () => {
    const h = harness([reply('Done in one go.', [createReply('a.ts', 'x')], 'done')])
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ kind: 'finished', outcome: 'done' })
    expect(h.chat.sent).toHaveLength(1)
    expect(h.git.pushes).toBe(1) // the final changes are still committed and pushed
  })

  it('lets the checks take a baseline of the files about to change, before anything is written', async () => {
    const h = harness(
      [reply('x', [createReply('new.ts', 'x'), updateReply('a.ts', 'a', 'b'), deleteReply('gone.ts')], 'done')],
      { 'a.ts': 'a\n', 'gone.ts': 'g\n' }
    )
    let writtenAtPrepare = -1
    h.checks.prepare = async (paths) => {
      writtenAtPrepare = h.workspace.applied.length
      h.checks.prepareCalls.push([...paths])
    }
    await run(h).start()
    expect(h.checks.prepareCalls[0]!.sort()).toEqual(['a.ts', 'gone.ts']) // existing files only, not new.ts
    expect(writtenAtPrepare).toBe(0)
  })

  it('passes the diagnostics paths of changed files (not deleted ones) to the checks', async () => {
    const h = harness(
      [reply('x', [createReply('new.ts', 'x'), updateReply('a.ts', 'a', 'b'), deleteReply('gone.ts')], 'done')],
      { 'a.ts': 'a\n', 'gone.ts': 'g\n' }
    )
    await run(h).start()
    expect(h.checks.diagnosticsCalls[0]!.sort()).toEqual(['a.ts', 'new.ts'])
    expect(h.git.commits[0]!.paths.sort()).toEqual(['a.ts', 'gone.ts', 'new.ts'])
  })
})

describe('recovering from problems', () => {
  it('feeds failures back, lets ChatGPT fix them, and finishes', async () => {
    const h = harness(
      [
        reply('First try.', [updateReply('src/a.ts', 'const a = 0', 'const a = 1')], 'continue'), // wrong SEARCH
        reply('Fixed.', [updateReply('src/a.ts', 'const a = 1 // old', 'const a = 2')], 'done')
      ],
      { 'src/a.ts': 'const a = 1 // old\n' }
    )
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(h.chat.texts[1]).toContain('Nothing could be applied.')
    expect(h.chat.texts[1]).toContain('SEARCH text of hunk 1 was not found')
    expect(h.chat.texts[1]).toMatch(/Fix the files that were not applied first/)
    expect(h.workspace.files.get('src/a.ts')).toBe('const a = 2\n')
    expect(h.git.commits).toHaveLength(1) // nothing to commit after the failed first step
    expect(snapshot.steps[0]!.publish).toMatchObject({ state: 'skipped' })
  })

  it('keeps applying the good files when one file fails, and says which', async () => {
    const h = harness(
      [
        reply('Two files.', [updateReply('good.ts', 'x', 'y'), updateReply('bad.ts', 'nope', 'z')], 'continue'),
        reply('Done.', [], 'done')
      ],
      { 'good.ts': 'x\n', 'bad.ts': 'b\n' }
    )
    const snapshot = await run(h).start()
    expect(h.workspace.files.get('good.ts')).toBe('y\n')
    expect(h.workspace.files.get('bad.ts')).toBe('b\n')
    expect(h.chat.texts[1]).toContain('1 change applied, 1 could not be.')
    expect(snapshot.steps[0]!.outcomes.map((o) => o.status)).toEqual(['applied', 'failed'])
  })

  it('does not accept "done" while the editor reports errors in the changed files', async () => {
    const h = harness(
      [
        reply('Looks complete.', [createReply('a.ts', 'broken')], 'done'),
        reply('Fixed the type error.', [updateReply('a.ts', 'broken', 'fixed')], 'done')
      ]
    )
    h.checks.diagnosticsQueue = [
      { items: [{ path: 'a.ts', line: 1, column: 1, severity: 'error', message: 'Cannot find name broken', code: 'TS2304', source: 'ts' }], errors: 1, warnings: 0 },
      { items: [], errors: 0, warnings: 0 }
    ]
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(h.chat.sent).toHaveLength(2)
    expect(h.chat.texts[1]).toContain('Editor diagnostics for the changed files: 1 error, 0 warnings.')
    expect(h.chat.texts[1]).toMatch(/Fix the problems found by the checks/)
  })

  it('treats a failing verify command like failing diagnostics', async () => {
    const h = harness([reply('x', [createReply('a.ts', 'x')], 'done'), reply('fixed', [updateReply('a.ts', 'x', 'y')], 'done')])
    h.checks.verifyQueue = [
      { command: 'npm test', exitCode: 1, outputTail: 'AssertionError: expected 1' },
      { command: 'npm test', exitCode: 0, outputTail: '' }
    ]
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(h.chat.texts[1]).toContain('Check `npm test` failed (exit code 1)')
    expect(h.chat.texts[1]).toContain('AssertionError: expected 1')
  })

  it('gives up with "stuck" after repeated steps in which nothing could be applied', async () => {
    const bad = () => reply('Try.', [updateReply('a.ts', 'missing', 'x')], 'continue')
    const h = harness([bad(), bad(), bad(), bad()], { 'a.ts': 'a\n' })
    const snapshot = await run(h, { maxFailedSteps: 3 }).start()
    expect(finalState(snapshot)).toMatchObject({ kind: 'finished', outcome: 'stuck' })
    expect(h.chat.sent).toHaveLength(3)
  })

  it('resets the failure streak after a successful step', async () => {
    const bad = reply('Try.', [updateReply('a.ts', 'missing', 'x')], 'continue')
    const good = reply('Ok.', [updateReply('a.ts', 'a', 'b')], 'continue')
    const h = harness([bad, bad, good, bad, bad, reply('Done.', [], 'done')], { 'a.ts': 'a\n' })
    const snapshot = await run(h, { maxFailedSteps: 3 }).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
  })

  it('stops at the step limit', async () => {
    const step = (n: number) => reply(`Step ${n}.`, [createReply(`f${n}.ts`, 'x')], 'continue')
    const h = harness([step(1), step(2), step(3), step(4)])
    const snapshot = await run(h, { maxSteps: 3 }).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'step-limit' })
    expect(h.chat.sent).toHaveLength(3)
  })

  it('honours "blocked", with ChatGPT’s explanation', async () => {
    const h = harness([reply('I cannot see the repository.', [], 'blocked')])
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'blocked', message: 'I cannot see the repository.' })
  })
})

describe('replies without usable changes', () => {
  it('reminds ChatGPT of the format once, then continues normally', async () => {
    const h = harness([
      'Sure! I think we should add a greeting. Let me know if you want it.',
      reply('Here it is.', [createReply('a.ts', 'x')], 'done')
    ])
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(snapshot.steps.map((s) => s.messageKind)).toEqual(['initial', 'format-reminder'])
    expect(h.chat.texts[1]).toContain('did not contain any file changes')
    expect(h.workspace.files.get('a.ts')).toBe('x\n')
  })

  it('gives up with "no-changes" after the retry budget', async () => {
    const h = harness(['just chatting', 'still chatting'])
    const snapshot = await run(h, { formatRetries: 1 }).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'no-changes' })
    expect(h.chat.sent).toHaveLength(2)
  })

  it('accepts "done" without changes immediately (no reminder)', async () => {
    const h = harness([reply('Nothing to change; it already works.', [], 'done')])
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(h.chat.sent).toHaveLength(1)
  })

  it('applies the complete edits from a cut-off reply and asks only for the rest', async () => {
    const cutOff = `${reply('Part one.', [createReply('a.ts', 'ok')])}\n\n### Created file: \`b.ts\`\n\n\`\`\`ts\nconst half =`
    const h = harness([cutOff, reply('Rest.', [createReply('b.ts', 'full')], 'done')])
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(snapshot.steps[0]!.reply!.truncated).toBe(true)
    expect(h.chat.texts[1]).toContain('your reply was cut off')
    expect(h.chat.texts[1]).toContain('`a.ts`')
    expect(h.workspace.files.get('a.ts')).toBe('ok\n')
    expect(h.workspace.files.get('b.ts')).toBe('full\n')
    expect(snapshot.steps[0]!.messageKind).toBe('initial')
    expect(snapshot.steps[1]!.messageKind).toBe('cut-off-reminder')
  })

  it('reports reply-format problems back instead of silently dropping them', async () => {
    const broken = '### Updated file: `a.ts`\n\n```ts\n<<<<<<< SEARCH\nx\n=======\ny\n```'
    const h = harness([`Edit.\n\n${broken}\n\nCODEGENT_STATUS: continue`, reply('Ok.', [updateReply('a.ts', 'x', 'y')], 'done')], { 'a.ts': 'x\n' })
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(h.chat.texts[1]).toContain('never closed')
  })
})

describe('review mode (auto-apply off)', () => {
  const twoSteps = () => [reply('Add.', [createReply('a.ts', 'x')], 'continue'), reply('Done.', [], 'done')]

  it('asks before applying and applies when approved', async () => {
    const approval = new ScriptedApproval(['apply'])
    const h = harness(twoSteps(), {}, approval)
    const snapshot = await run(h, { autoApply: false }).start()
    expect(approval.reviews).toEqual([{ step: 1, paths: ['a.ts'] }])
    expect(h.workspace.files.get('a.ts')).toBe('x\n')
    expect(snapshot.steps[0]!.decision).toBe('apply')
  })

  it('does not apply what the user declines — and tells ChatGPT', async () => {
    const approval = new ScriptedApproval(['skip'])
    const h = harness([reply('Add.', [createReply('a.ts', 'x')], 'continue'), reply('Ok, skipping.', [], 'done')], {}, approval)
    const snapshot = await run(h, { autoApply: false }).start()
    expect(h.workspace.files.has('a.ts')).toBe(false)
    expect(h.git.commits).toHaveLength(0)
    expect(h.chat.texts[1]).toContain('The user chose not to apply this change.')
    expect(snapshot.steps[0]!.decision).toBe('skip')
  })

  it('stops the whole run when the user says stop', async () => {
    const approval = new ScriptedApproval(['stop'])
    const h = harness(twoSteps(), {}, approval)
    const snapshot = await run(h, { autoApply: false }).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'stopped' })
    expect(h.workspace.files.size).toBe(0)
  })

  it('does not ask when there is nothing to apply', async () => {
    const approval = new ScriptedApproval([])
    const h = harness([reply('Nothing.', [], 'done')], {}, approval)
    await run(h, { autoApply: false }).start()
    expect(approval.reviews).toEqual([])
  })
})

describe('pausing and resuming', () => {
  it('pauses between steps when auto-continue is off, and continues on resume', async () => {
    const h = harness([reply('One.', [createReply('a.ts', 'x')], 'continue'), reply('Two.', [], 'done')])
    const agent = run(h, { autoContinue: false })
    const paused = await agent.start()
    expect(finalState(paused)).toMatchObject({ kind: 'paused', reason: 'awaiting-continue' })
    expect(h.chat.sent).toHaveLength(1)
    const finished = await agent.resume()
    expect(finalState(finished)).toMatchObject({ outcome: 'done' })
    expect(h.chat.sent).toHaveLength(2)
  })

  it.each([
    ['rate-limited', /limiting your messages.*Resume/s],
    ['login-required', /Sign in in the ChatGPT tab.*Resume/s],
    ['no-browser', /No browser is connected.*Resume/s],
    ['composer-not-found', /Resume/],
    ['timeout', /approval prompt/]
  ] as const)('pauses on %s and re-sends the very same message on resume', async (code, message) => {
    const h = harness([new ChatError(code, 'details'), reply('Fine.', [createReply('a.ts', 'x')], 'done')])
    const agent = run(h)
    const paused = await agent.start()
    expect(finalState(paused)).toMatchObject({ kind: 'paused', reason: 'needs-attention' })
    expect((paused.state as { message: string }).message).toMatch(message)
    expect(paused.steps).toHaveLength(0) // the failed attempt is not a step

    const finished = await agent.resume()
    expect(finalState(finished)).toMatchObject({ outcome: 'done' })
    expect(h.chat.sent[1]!.text).toBe(h.chat.sent[0]!.text)
    expect(h.chat.sent[1]!.newChat).toBe(true) // still the first message of the conversation
  })

  it('a follow-up that fails to send keeps its text and stays in the same conversation', async () => {
    const h = harness([
      reply('One.', [createReply('a.ts', 'x')], 'continue'),
      new ChatError('rate-limited', 'free plan limit'),
      reply('Two.', [], 'done')
    ])
    const agent = run(h)
    const paused = await agent.start()
    expect(finalState(paused)).toMatchObject({ reason: 'needs-attention' })
    await agent.resume()
    expect(h.chat.sent[2]!.text).toBe(h.chat.sent[1]!.text)
    expect(h.chat.sent[2]!.newChat).toBe(false)
    expect(h.git.commits).toHaveLength(1) // the first step was not re-applied or re-committed
  })

  it('ends the run when the ChatGPT conversation is lost mid-task', async () => {
    const h = harness([reply('One.', [createReply('a.ts', 'x')], 'continue'), new ChatError('tab-unavailable', 'tab closed')])
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ kind: 'finished', outcome: 'error' })
    expect((snapshot.state as { message: string }).message).toMatch(/conversation is gone/)
  })

  it('treats any other chat failure on the first message as resumable', async () => {
    const h = harness([new ChatError('tab-unavailable', 'could not open ChatGPT'), reply('ok', [], 'done')])
    const agent = run(h)
    expect(finalState(await agent.start())).toMatchObject({ kind: 'paused' })
    expect(finalState(await agent.resume())).toMatchObject({ outcome: 'done' })
  })

  it('cannot be resumed unless paused', async () => {
    const h = harness([reply('ok', [], 'done')])
    const agent = run(h)
    await expect(agent.resume()).rejects.toThrow(/paused/)
    await agent.start()
    await expect(agent.resume()).rejects.toThrow(/paused/)
    await expect(agent.start()).rejects.toThrow(/already been started/)
  })
})

describe('stopping', () => {
  it('stops while waiting for ChatGPT by aborting the request', async () => {
    let aborted = false
    const h = harness([
      (request) =>
        new Promise<string>((_, reject) => {
          request.signal.addEventListener('abort', () => {
            aborted = true
            reject(new ChatError('cancelled', 'cancelled'))
          })
        })
    ])
    const agent = run(h)
    const done = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    agent.stop()
    const snapshot = await done
    expect(aborted).toBe(true)
    expect(finalState(snapshot)).toMatchObject({ kind: 'finished', outcome: 'stopped' })
  })

  it('stops a paused run immediately', async () => {
    const h = harness([new ChatError('rate-limited', 'x')])
    const agent = run(h)
    await agent.start()
    agent.stop()
    expect(finalState(agent.snapshot())).toMatchObject({ outcome: 'stopped' })
  })

  it('does not apply a reply that arrives after stop', async () => {
    const h = harness([
      async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        void request
        return reply('late', [createReply('late.ts', 'x')], 'done')
      }
    ])
    const agent = run(h)
    const done = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    agent.stop()
    await done
    expect(h.workspace.files.has('late.ts')).toBe(false)
  })
})

describe('git: commit and push', () => {
  const oneStep = () => [reply('Add.', [createReply('a.ts', 'x')], 'continue'), reply('Done.', [], 'done')]

  it('pauses when the push fails and resumes at the push (nothing is applied twice)', async () => {
    const h = harness(oneStep())
    h.git.pushFailures = [new GitError('auth', 'fatal: Authentication failed')]
    const agent = run(h)
    const paused = await agent.start()
    expect(finalState(paused)).toMatchObject({ kind: 'paused', reason: 'needs-attention' })
    expect((paused.state as { message: string }).message).toMatch(/not signed in to GitHub/)
    expect(h.workspace.applied).toHaveLength(1)
    expect(h.chat.sent).toHaveLength(1) // ChatGPT is not told the change is on GitHub

    const finished = await agent.resume()
    expect(finalState(finished)).toMatchObject({ outcome: 'done' })
    expect(h.workspace.applied).toHaveLength(1)
    expect(h.git.commits).toHaveLength(1) // not committed again
    expect(h.git.pushes).toBe(1)
    expect(h.chat.texts[1]).toMatch(/pushed it to origin\/main/)
  })

  it.each([
    ['non-fast-forward', /GitHub has commits you do not have locally/],
    ['protected-branch', /protected/],
    ['network', /Fix the problem/]
  ] as const)('explains a %s push failure', async (kind, message) => {
    const h = harness(oneStep())
    h.git.pushFailures = [new GitError(kind, `push failed: ${kind}`)]
    const paused = await run(h).start()
    expect((paused.state as { message: string }).message).toMatch(message)
  })

  it('pauses when the commit itself fails and retries it on resume', async () => {
    const h = harness(oneStep())
    h.git.commitFailures = [new Error('hook failed')]
    const agent = run(h)
    expect(finalState(await agent.start())).toMatchObject({ kind: 'paused' })
    expect(finalState(await agent.resume())).toMatchObject({ outcome: 'done' })
    expect(h.git.commits).toHaveLength(1)
  })

  it('with push off, tells ChatGPT the commit is not on GitHub', async () => {
    const h = harness(oneStep())
    const snapshot = await run(h, { push: false }).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(h.git.pushes).toBe(0)
    expect(h.chat.texts[1]).toContain('NOT on GitHub (pushing is turned off in the settings)')
  })

  it('with commit off, nothing touches git and ChatGPT is told so', async () => {
    const h = harness(oneStep())
    await run(h, { commit: false }).start()
    expect(h.git.commits).toHaveLength(0)
    expect(h.git.pushes).toBe(0)
    expect(h.chat.texts[1]).toContain('Nothing was committed or pushed (committing is turned off in the settings)')
  })

  it('reports "nothing to commit" without failing', async () => {
    const h = harness(oneStep())
    h.git.nothingToCommit = true
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'done' })
    expect(snapshot.steps[0]!.publish).toMatchObject({ state: 'skipped' })
  })

  it('ends with an error when there is no usable GitHub repository', async () => {
    const h = harness([])
    h.git.contextError = new Error('This folder has no GitHub remote.')
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ kind: 'finished', outcome: 'error', message: 'This folder has no GitHub remote.' })
    expect(h.chat.sent).toHaveLength(0)
  })

  it('ends with an error when the files cannot be written', async () => {
    const h = harness([reply('Add.', [createReply('a.ts', 'x')], 'continue')])
    h.workspace.failNextApply = new Error('EACCES: permission denied')
    const snapshot = await run(h).start()
    expect(finalState(snapshot)).toMatchObject({ outcome: 'error' })
    expect((snapshot.state as { message: string }).message).toMatch(/could not be written.*EACCES/)
    expect(h.git.commits).toHaveLength(0)
  })
})

describe('file safety', () => {
  it('leaves files with uncommitted changes alone and reports it', async () => {
    const h = harness(
      [reply('Edit.', [updateReply('a.ts', 'a', 'b')], 'continue'), reply('Done.', [], 'done')],
      { 'a.ts': 'a\n' }
    )
    h.workspace.dirty.add('a.ts')
    const snapshot = await run(h).start()
    expect(h.workspace.files.get('a.ts')).toBe('a\n')
    expect(h.chat.texts[1]).toContain('uncommitted local changes')
    expect(snapshot.steps[0]!.outcomes[0]!.errors[0]!.code).toBe('dirty-file')
  })

  it('edits dirty files when the setting allows it', async () => {
    const h = harness([reply('Edit.', [updateReply('a.ts', 'a', 'b')], 'done')], { 'a.ts': 'a\n' })
    h.workspace.dirty.add('a.ts')
    await run(h, { allowDirty: true }).start()
    expect(h.workspace.files.get('a.ts')).toBe('b\n')
  })

  it('never writes outside the repository, whatever ChatGPT asks', async () => {
    const h = harness([
      reply('Sneaky.', [createReply('../../etc/passwd', 'x'), createReply('.git/config', 'x'), createReply('ok.ts', 'fine')], 'done')
    ])
    await run(h).start()
    expect([...h.workspace.files.keys()]).toEqual(['ok.ts'])
  })
})

describe('snapshots', () => {
  it('records timing, reply details and conversation url, and notifies listeners', async () => {
    const h = harness([reply('Add a thing.', [createReply('a.ts', 'x')], 'done')])
    const agent = run(h)
    const seen: number[] = []
    const off = agent.onChange((s) => seen.push(s.steps.length))
    const snapshot = await agent.start()
    off()
    expect(seen.length).toBeGreaterThan(5)
    const step = snapshot.steps[0]!
    expect(step.reply).toMatchObject({ status: 'done', editCount: 1, summary: 'Add a thing.', truncated: false })
    expect(step.finishedAt).toBeGreaterThan(step.startedAt)
    expect(step.promptChars).toBe(h.chat.texts[0]!.length)
    expect(snapshot.repo?.name).toBe('project')
    expect(snapshot.startedAt).toBeDefined()
  })

  it('a snapshot is a copy: later changes do not alter it', async () => {
    const h = harness([reply('ok', [], 'done')])
    const agent = run(h)
    const before = agent.snapshot()
    await agent.start()
    expect(before.steps).toHaveLength(0)
    expect(before.state.kind).toBe('idle')
  })
})
