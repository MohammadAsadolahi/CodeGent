import { describe, expect, it } from 'vitest'
import {
  ChatError,
  type AgentDeps,
  type ChatPort,
  type ChatRequest,
  type FileChange,
  type RepoContext
} from '@codegent/engine'
import { buildSettings, type Settings } from '../../src/settings-model'
import { RunManager, type ActiveRunMarker, type RunHost } from '../../src/run/run-manager'
import type { UiHistoryItem, UiNotice } from '../../src/ui/protocol'
import type { RepoOk, RepoStatus } from '../../src/workspace/repo-service'

const REPO: RepoOk = {
  ok: true,
  root: '/work/project',
  host: 'github.com',
  owner: 'octo',
  name: 'project',
  webUrl: 'https://github.com/octo/project',
  remoteName: 'origin',
  branch: 'main',
  sha: '1'.repeat(40),
  shortSha: '1111111',
  subject: 'Initial commit',
  upstream: { ref: 'origin/main', ahead: 0, behind: 0 },
  dirtyFiles: [],
  dirtyCount: 0,
  warnings: []
}
const CONTEXT: RepoContext = {
  owner: 'octo',
  name: 'project',
  host: 'github.com',
  webUrl: REPO.webUrl,
  branch: 'main',
  sha: REPO.sha,
  shortSha: REPO.shortSha,
  subject: REPO.subject
}

const fence = (body: string) => '```ts\n' + body + '\n```'
const create = (path: string, content: string) =>
  `### Created file: \`${path}\`\n\n${fence(content)}`
const reply = (summary: string, parts: string[], status: string) =>
  [summary, '', ...parts, '', `CODEGENT_STATUS: ${status}`].join('\n')

type Scripted = string | Error | ((request: ChatRequest) => Promise<string>)

const setup = (
  script: Scripted[],
  over: {
    repo?: RepoStatus
    consent?: 'allow' | 'commit-only' | 'cancel'
    settings?: Partial<Settings['run']>
    /** A run that the previous window left behind. */
    lost?: ActiveRunMarker
    history?: UiHistoryItem[]
  } = {}
) => {
  const notices: UiNotice[] = []
  let savedHistory: UiHistoryItem[] = []
  const markers: Array<ActiveRunMarker | undefined> = []
  const files = new Map<string, string>()
  const undone = new Set<string>()
  const commits: string[][] = []
  const state = { pushes: 0, consentAsked: 0 }
  const sent: ChatRequest[] = []

  const chat: ChatPort = {
    async send(request) {
      sent.push(request)
      const next = script.shift()
      if (next === undefined) throw new Error('script ran out')
      if (next instanceof Error) throw next
      const markdown = typeof next === 'function' ? await next(request) : next
      return { markdown, conversationUrl: 'https://chatgpt.com/c/x', durationMs: 3000 }
    }
  }
  const host: RunHost = {
    readSettings: () => {
      const settings = buildSettings(<T>(_key: string, fallback: T) => fallback)
      return { ...settings, run: { ...settings.run, ...over.settings } }
    },
    createDeps: (): Omit<AgentDeps, 'approval'> => ({
      chat,
      workspace: {
        view: {
          read: async (path) => files.get(path) ?? null,
          isDirty: async () => false
        },
        apply: async (changes: readonly FileChange[]) => {
          for (const change of changes) {
            if (change.kind === 'create' || change.kind === 'modify')
              files.set(change.path, change.after)
          }
          return {
            id: `receipt-${files.size}-${commits.length}`,
            paths: changes.map((c) => (c.kind === 'rename' ? c.to : c.path))
          }
        }
      },
      git: {
        context: async () => CONTEXT,
        commit: async (paths) => {
          commits.push([...paths])
          return { committed: true, sha: '2'.repeat(40), shortSha: '2222222' }
        },
        push: async () => {
          state.pushes += 1
          return { branch: 'main', remote: 'origin' }
        }
      },
      checks: {
        diagnostics: async () => ({ items: [], errors: 0, warnings: 0 }),
        verify: async () => undefined
      }
    }),
    workspace: {
      undo: async (id) => {
        undone.add(id)
        return { undone: ['a.ts'], skipped: [] }
      },
      isUndone: (id) => undone.has(id),
      receiptChanges: () => [{ kind: 'create', path: 'a.ts', after: 'x\n' }]
    },
    repoStatus: async () => over.repo ?? REPO,
    confirmPublishing: async () => {
      state.consentAsked += 1
      return over.consent ?? 'allow'
    },
    loadHistory: () => over.history ?? [],
    saveHistory: (items) => (savedHistory = items),
    loadActive: () => over.lost,
    saveActive: (marker) => void markers.push(marker),
    notify: (notice) => notices.push(notice)
  }
  const manager = new RunManager(host)
  return {
    manager,
    markers,
    notices,
    state,
    sent,
    commits,
    files,
    get history() {
      return savedHistory
    }
  }
}

describe('a run from start to finish', () => {
  it('runs, exposes UI state, records history and announces the outcome', async () => {
    const t = setup([
      reply('Add it.', [create('a.ts', 'x')], 'continue'),
      reply('All done.', [], 'done')
    ])
    const views: Array<string | undefined> = []
    t.manager.onChange(() => views.push(t.manager.view().run?.state))

    await t.manager.start('  Add a module  ')

    const { run, history } = t.manager.view()
    expect(run).toMatchObject({
      task: 'Add a module',
      state: 'finished',
      outcome: 'done',
      message: 'All done.',
      canStop: false,
      canResume: false
    })
    expect(run!.steps).toHaveLength(2)
    expect(run!.steps[0]).toMatchObject({
      n: 1,
      kind: 'initial',
      summary: 'Add it.',
      replyStatus: 'continue',
      durationSeconds: 3,
      edits: [{ path: 'a.ts', kind: 'created', status: 'applied' }],
      publish: { state: 'pushed' },
      canUndo: true,
      undone: false
    })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      task: 'Add a module',
      outcome: 'done',
      steps: 2,
      repo: 'octo/project'
    })
    expect(t.history).toHaveLength(1)
    expect(t.notices.at(-1)).toMatchObject({
      kind: 'info',
      text: 'Done — the task is complete: All done.'
    })
    expect(views).toContain('running')
    expect(t.manager.active).toBe(false)
    expect(t.state.pushes).toBe(1)
  })

  it('keeps only the newest applied step undoable, and undo goes through the workspace', async () => {
    const t = setup([
      reply('One.', [create('a.ts', 'x')], 'continue'),
      reply('Two.', [create('b.ts', 'y')], 'done')
    ])
    await t.manager.start('task')
    let steps = t.manager.view().run!.steps
    expect(steps.map((s) => s.canUndo)).toEqual([false, true])

    await t.manager.undoStep(2)
    expect(t.notices.at(-1)).toMatchObject({ kind: 'info' })
    expect(t.notices.at(-1)!.text).toMatch(/Step 2 was undone/)
    steps = t.manager.view().run!.steps
    expect(steps.map((s) => ({ canUndo: s.canUndo, undone: s.undone }))).toEqual([
      { canUndo: true, undone: false }, // the previous step becomes the newest applied one
      { canUndo: false, undone: true }
    ])
  })

  it('reports an undo that could only be partial', async () => {
    const t = setup([reply('One.', [create('a.ts', 'x')], 'done')])
    await t.manager.start('task')
    ;(t.manager as unknown as { host: RunHost }).host.workspace.undo = async () => ({
      undone: ['a.ts'],
      skipped: [{ path: 'b.ts', reason: 'it was changed after this step' }]
    })
    await t.manager.undoStep(1)
    expect(t.notices.at(-1)).toMatchObject({ kind: 'warning' })
    expect(t.notices.at(-1)!.text).toMatch(/partly undone.*b\.ts/)
  })

  it('refuses to undo a step that applied nothing', async () => {
    const t = setup([reply('Nothing.', [], 'done')])
    await t.manager.start('task')
    await t.manager.undoStep(1)
    expect(t.notices.at(-1)).toMatchObject({
      kind: 'warning',
      text: 'That step has nothing to undo.'
    })
  })
})

describe('starting', () => {
  it('needs a task', async () => {
    const t = setup([])
    await t.manager.start('   ')
    expect(t.notices[0]).toMatchObject({
      kind: 'warning',
      text: 'Describe the task first.'
    })
    expect(t.manager.view().run).toBeNull()
  })

  it('explains why a repository cannot be used', async () => {
    const t = setup([], {
      repo: {
        ok: false,
        problem: 'no-remote',
        reason: 'The repository has no GitHub remote.'
      }
    })
    await t.manager.start('task')
    expect(t.notices[0]).toMatchObject({
      kind: 'error',
      text: 'The repository has no GitHub remote.'
    })
    expect(t.manager.view().run).toBeNull()
  })

  it('refuses to start while GitHub is ahead of the local branch', async () => {
    const t = setup([], {
      repo: { ...REPO, upstream: { ref: 'origin/main', ahead: 0, behind: 2 } }
    })
    await t.manager.start('task')
    expect(t.notices[0]!.text).toMatch(
      /GitHub has 2 commits that you do not have locally. Pull first/
    )
    expect(t.manager.view().run).toBeNull()
  })

  it('does not start a second run while one is active', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const t = setup([
      async () => {
        await gate
        return reply('ok', [], 'done')
      }
    ])
    const first = t.manager.start('first')
    await new Promise((r) => setTimeout(r, 30))
    expect(t.manager.active).toBe(true)
    await t.manager.start('second')
    expect(t.notices.at(-1)).toMatchObject({
      kind: 'warning',
      text: 'A run is already in progress.'
    })
    release()
    await first
  })

  it.each([
    ['allow', 1],
    ['commit-only', 0]
  ] as const)(
    'first-time consent "%s" decides whether it pushes',
    async (consent, pushes) => {
      const t = setup([reply('Add.', [create('a.ts', 'x')], 'done')], { consent })
      await t.manager.start('task')
      expect(t.state.consentAsked).toBe(1)
      expect(t.state.pushes).toBe(pushes)
      expect(t.commits).toHaveLength(1)
    }
  )

  it('consent "cancel" starts nothing; with committing off the question is not asked', async () => {
    const cancelled = setup([], { consent: 'cancel' })
    await cancelled.manager.start('task')
    expect(cancelled.manager.view().run).toBeNull()
    expect(cancelled.sent).toHaveLength(0)

    const noCommit = setup([reply('Add.', [create('a.ts', 'x')], 'done')], {
      settings: { commit: false }
    })
    await noCommit.manager.start('task')
    expect(noCommit.state.consentAsked).toBe(0)
  })
})

describe('review mode', () => {
  const reviewing = () =>
    setup(
      [
        reply('Add.', [create('a.ts', 'line1\nline2')], 'continue'),
        reply('Done.', [], 'done')
      ],
      { settings: { autoApply: false } }
    )

  it('shows the proposed files and waits for the decision', async () => {
    const t = reviewing()
    const running = t.manager.start('task')
    await waitFor(() => t.manager.view().review !== null)

    const review = t.manager.view().review!
    expect(review).toMatchObject({ step: 1, summary: 'Add.' })
    expect(review.files).toEqual([{ path: 'a.ts', kind: 'create', added: 2, removed: 0 }])
    expect(t.manager.pendingChanges()).toHaveLength(1)
    expect(t.files.size).toBe(0)

    t.manager.decide('apply')
    await running
    expect(t.files.get('a.ts')).toBe('line1\nline2\n')
    expect(t.manager.view().review).toBeNull()
  })

  it('a skipped review applies nothing and a stop ends the run', async () => {
    const skipping = reviewing()
    const run1 = skipping.manager.start('task')
    await waitFor(() => skipping.manager.view().review !== null)
    skipping.manager.decide('skip')
    await run1
    expect(skipping.files.size).toBe(0)

    const stopping = reviewing()
    const run2 = stopping.manager.start('task')
    await waitFor(() => stopping.manager.view().review !== null)
    stopping.manager.stop()
    await run2
    expect(stopping.manager.view().run).toMatchObject({
      state: 'finished',
      outcome: 'stopped'
    })
  })

  it('switching to review mid-run takes effect at the next step', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    const t = setup([
      reply('One.', [create('a.ts', 'x')], 'continue'),
      async () => {
        await gate // ChatGPT is "thinking" about step two while the user flips the switch
        return reply('Two.', [create('b.ts', 'y')], 'continue')
      },
      reply('Done.', [], 'done')
    ])
    const running = t.manager.start('task')
    await waitFor(() => t.files.has('a.ts') && t.sent.length === 2) // step one applied, step two requested

    t.manager.updateActiveSettings({ autoApply: false })
    openGate()
    await waitFor(() => t.manager.view().review !== null)
    expect(t.manager.view().review).toMatchObject({ step: 2 })
    expect(t.files.has('b.ts')).toBe(false) // waiting for the user

    t.manager.decide('apply')
    await running
    expect(t.files.get('b.ts')).toBe('y\n')
    expect(t.manager.view().run).toMatchObject({ state: 'finished', outcome: 'done' })
  })
})

describe('pausing', () => {
  it('pauses on a ChatGPT problem and resumes with the matching label', async () => {
    const t = setup([
      new ChatError('rate-limited', 'free plan limit'),
      reply('Fine.', [create('a.ts', 'x')], 'done')
    ])
    await t.manager.start('task')
    let run = t.manager.view().run!
    expect(run).toMatchObject({
      state: 'paused',
      pauseReason: 'needs-attention',
      canResume: true,
      resumeLabel: 'Resume',
      canStop: true
    })
    expect(run.message).toMatch(/limiting your messages/)
    expect(t.notices.at(-1)!.text).toMatch(/limiting your messages/)

    await t.manager.resume()
    run = t.manager.view().run!
    expect(run).toMatchObject({ state: 'finished', outcome: 'done' })
  })

  it('"awaiting continue" labels the button Continue', async () => {
    const t = setup(
      [reply('One.', [create('a.ts', 'x')], 'continue'), reply('Two.', [], 'done')],
      { settings: { autoContinue: false } }
    )
    await t.manager.start('task')
    expect(t.manager.view().run).toMatchObject({
      state: 'paused',
      pauseReason: 'awaiting-continue',
      resumeLabel: 'Continue'
    })
    await t.manager.resume()
    expect(t.manager.view().run).toMatchObject({ state: 'finished', outcome: 'done' })
  })

  it('stop works on a paused run; dismissing clears a finished one', async () => {
    const t = setup([new ChatError('no-browser', 'none')])
    await t.manager.start('task')
    t.manager.stop()
    expect(t.manager.view().run).toMatchObject({ state: 'finished', outcome: 'stopped' })
    t.manager.dismiss()
    expect(t.manager.view().run).toBeNull()
    expect(t.manager.active).toBe(false)
  })

  it('only a finished run can be dismissed', async () => {
    const t = setup([new ChatError('no-browser', 'none')])
    await t.manager.start('task')
    t.manager.dismiss()
    expect(t.manager.view().run).not.toBeNull()
  })
})

describe('history', () => {
  it('keeps the newest 30 runs, newest first, and can be cleared', async () => {
    const many = setup(Array.from({ length: 32 }, () => reply('x', [], 'done')))
    for (let i = 0; i < 32; i++) {
      await many.manager.start(`task ${i}`)
      many.manager.dismiss()
    }
    const { history } = many.manager.view()
    expect(history).toHaveLength(30)
    expect(history[0]!.task).toBe('task 31')
    expect(history.at(-1)!.task).toBe('task 2')
    many.manager.clearHistory()
    expect(many.manager.view().history).toEqual([])
    expect(many.history).toEqual([])
  })
})

describe('a run that a closed window left behind', () => {
  const lost = (steps: number): ActiveRunMarker => ({
    id: 'run-lost',
    task: 'Add dark mode',
    startedAt: 1_000,
    repo: 'octo/project',
    steps
  })

  it('shows up in the history as interrupted, once, and the marker is cleared', () => {
    const t = setup([], { lost: lost(2) })
    const { history } = t.manager.view()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      id: 'run-lost',
      task: 'Add dark mode',
      outcome: 'interrupted',
      steps: 2,
      repo: 'octo/project'
    })
    expect(history[0]!.message).toMatch(/working tree and in git/)
    expect(t.history).toHaveLength(1) // saved
    expect(t.markers).toEqual([undefined]) // cleared
    expect(t.manager.active).toBe(false)
    expect(t.manager.view().run).toBeNull()
  })

  it('says that nothing changed when the window closed before ChatGPT had answered', () => {
    const t = setup([], { lost: lost(0) })
    expect(t.manager.view().history[0]!.message).toMatch(/Nothing was changed/)
  })

  it('does not replace a run that did get recorded as finished', () => {
    const finished: UiHistoryItem = {
      id: 'run-lost',
      task: 'Add dark mode',
      startedAt: 1_000,
      outcome: 'done',
      message: 'All done.',
      steps: 2,
      repo: 'octo/project'
    }
    const t = setup([], { lost: lost(2), history: [finished] })
    expect(t.manager.view().history).toEqual([finished])
    expect(t.markers).toEqual([undefined])
  })
})

describe('remembering the run in progress', () => {
  it('writes a marker when the run starts and when steps are added, and clears it at the end', async () => {
    const t = setup([
      reply('Add it.', [create('a.ts', 'x')], 'continue'),
      reply('All done.', [], 'done')
    ])
    await t.manager.start('Add a module')

    const written = t.markers.filter(
      (marker): marker is ActiveRunMarker => marker !== undefined
    )
    expect(written[0]).toMatchObject({
      task: 'Add a module',
      repo: 'octo/project',
      steps: 0
    })
    expect(Math.max(...written.map((marker) => marker.steps))).toBe(2)
    expect(new Set(written.map((marker) => JSON.stringify(marker))).size).toBe(
      written.length
    ) // never rewritten unchanged
    expect(t.markers.at(-1)).toBeUndefined()
  })

  it('keeps the marker while a run waits for the user', async () => {
    const t = setup([new ChatError('rate-limited', 'slow down')])
    await t.manager.start('task')
    expect(t.manager.view().run!.state).toBe('paused')
    expect(t.markers.at(-1)).toMatchObject({ task: 'task' })
  })
})

async function waitFor(probe: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
