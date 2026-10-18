// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToExtension, UiState, UiStep } from '../../src/ui/protocol'

// ── a fake of the API VS Code hands to a webview ───────────────────────────────────────────────
let posted: ToExtension[] = []
let saved: unknown

const state = (over: Partial<UiState> = {}): UiState => ({
  version: '0.1.0',
  connection: {
    hub: 'connected',
    browsers: [{ id: 'b1', label: 'Chrome', chatgptTabs: 1 }],
    chatgptTabs: 1
  },
  repo: {
    ok: true,
    fullName: 'octo/project',
    webUrl: 'https://github.com/octo/project',
    branch: 'main',
    shortSha: 'abc1234',
    subject: 'initial commit',
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    dirtyCount: 0,
    dirtyFiles: [],
    warnings: []
  },
  toggles: {
    autoApply: true,
    autoContinue: true,
    commit: true,
    push: true,
    autoSubmit: true
  },
  run: null,
  review: null,
  history: [],
  busy: false,
  notice: null,
  setup: { browserExtensionPath: 'C:\\extensions\\browser-extension' },
  ...over
})

const step = (over: Partial<UiStep> = {}): UiStep => ({
  n: 1,
  kind: 'initial',
  summary: 'Added the greeting module.',
  replyStatus: 'done',
  durationSeconds: 12,
  working: false,
  edits: [
    {
      path: 'src/greeting.ts',
      kind: 'created',
      status: 'applied',
      detail: '12 lines',
      notes: [],
      errors: []
    }
  ],
  problems: [],
  warnings: [],
  publish: {
    state: 'pushed',
    label: 'Committed abc1234 and pushed it to origin/main.',
    shortSha: 'abc1234'
  },
  canUndo: true,
  undone: false,
  ...over
})

const run = (
  over: Partial<NonNullable<UiState['run']>> = {}
): NonNullable<UiState['run']> => ({
  id: 'r1',
  task: 'Add a greeting',
  startedAt: Date.now() - 5_000,
  state: 'finished',
  outcome: 'done',
  message: 'All done.',
  steps: [step()],
  conversationUrl: 'https://chatgpt.com/c/abc',
  canStop: false,
  canResume: false,
  resumeLabel: 'Resume',
  ...over
})

// ── driving the page ───────────────────────────────────────────────────────────────────────────
let act: (callback: () => void | Promise<void>) => Promise<void>

const boot = async (): Promise<void> => {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  ;(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: ToExtension) => void posted.push(message),
    getState: () => saved,
    setState: (value: unknown) => void (saved = value)
  })
  ;({ act } = await import('preact/test-utils'))
  await act(async () => {
    await import('../../webview/main')
  })
}

const show = (next: UiState) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'state', state: next } })
    )
  })

const page = () => document.getElementById('root')!
const text = () => page().textContent ?? ''
const buttons = () => [...page().querySelectorAll('button')]
const button = (label: string | RegExp): HTMLButtonElement => {
  const found = buttons().find((candidate) => {
    const name =
      `${candidate.getAttribute('aria-label') ?? ''} ${candidate.textContent ?? ''}`.trim()
    return typeof label === 'string' ? name.includes(label) : label.test(name)
  })
  if (!found)
    throw new Error(
      `no button "${label}" on the page; buttons: ${buttons()
        .map((b) => b.textContent?.trim())
        .join(' | ')}`
    )
  return found
}
const click = (element: Element) => act(() => (element as HTMLElement).click())

const type = (value: string) => {
  const box = page().querySelector('textarea')!
  return act(() => {
    box.value = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  posted = []
  saved = undefined
})

afterEach(async () => {
  const { render } = await import('preact')
  render(null, document.getElementById('root')!)
})

describe('the panel', () => {
  it('says hello to the extension and shows a loading message until the first state arrives', async () => {
    await boot()
    expect(posted).toEqual([{ type: 'ready' }])
    expect(text()).toContain('Loading')

    await show(state())
    expect(text()).not.toContain('Loading')
    expect(text()).toContain('CodeGent')
    expect(text()).toContain('v0.1.0')
  })

  it('guides through the setup and collapses it when everything is ready', async () => {
    await boot()
    await show(
      state({
        connection: {
          hub: 'connected',
          browsers: [],
          chatgptTabs: 0,
          hint: 'No browser is connected.'
        },
        repo: {
          ok: false,
          problem: 'no-remote',
          reason: 'The repository has no GitHub remote.'
        }
      })
    )
    expect(text()).toContain('Setup — finish these steps')
    expect(text()).toContain('C:\\extensions\\browser-extension')
    expect(text()).toContain('The repository has no GitHub remote.')
    expect(page().querySelector('details.card')!.hasAttribute('open')).toBe(true)

    await click(button('Show folder'))
    await click(button('Copy path'))
    expect(posted.slice(1)).toEqual([
      { type: 'openBrowserExtensionFolder' },
      { type: 'copyBrowserExtensionPath' }
    ])

    await show(state())
    expect(text()).toContain('Setup (all good)')
    expect(page().querySelector('details.card')!.hasAttribute('open')).toBe(false)
    expect(text()).toContain('GitHub repository: octo/project')
  })

  it('offers to restart a hub that is not running', async () => {
    await boot()
    await show(
      state({
        connection: {
          hub: 'offline',
          browsers: [],
          chatgptTabs: 0,
          hint: 'The local hub is not running.'
        }
      })
    )
    expect(text()).toContain('The local hub is not running.')
    await click(page().querySelector('.chips button')!)
    expect(posted.at(-1)).toEqual({ type: 'restartHub' })
  })

  it('lets the user pick a browser when several are connected', async () => {
    await boot()
    await show(
      state({
        connection: {
          hub: 'connected',
          browsers: [
            { id: 'b1', label: 'Chrome', chatgptTabs: 1 },
            { id: 'b2', label: 'Edge', chatgptTabs: 0 }
          ],
          chatgptTabs: 1
        }
      })
    )
    await click(button('Browser (2)'))
    expect(posted.at(-1)).toEqual({ type: 'chooseBrowser' })
  })

  it('shows the repository and offers to push when the branch is ahead of GitHub', async () => {
    await boot()
    await show(state())
    expect(button('octo/project')).toBeTruthy()
    expect(text()).toContain('initial commit')
    expect(buttons().some((b) => b.textContent?.includes('Push now'))).toBe(false)

    const ok = state().repo as Extract<UiState['repo'], { ok: true }>
    await show(
      state({
        repo: {
          ...ok,
          ahead: 2,
          dirtyCount: 1,
          dirtyFiles: ['notes.txt'],
          warnings: ['The remote is on example.org.']
        }
      })
    )
    expect(text()).toContain('1 uncommitted file')
    expect(text()).toContain('The remote is on example.org.')
    await click(button('Push now'))
    await click(button('octo/project'))
    await click(button('Refresh'))
    expect(posted.slice(1)).toEqual([
      { type: 'pushNow' },
      { type: 'openUrl', url: 'https://github.com/octo/project' },
      { type: 'refreshRepo' }
    ])
  })
})

describe('starting a task', () => {
  it('starts with the button or Ctrl+Enter, but not with an empty description', async () => {
    await boot()
    await show(state())
    const start = button('Start')
    expect(start.disabled).toBe(true)

    await type('   ')
    expect(button('Start').disabled).toBe(true)

    await type('Add dark mode')
    expect(button('Start').disabled).toBe(false)
    await click(button('Start'))
    expect(posted.at(-1)).toEqual({ type: 'start', task: 'Add dark mode' })

    await act(() => {
      page()
        .querySelector('textarea')!
        .dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
          })
        )
    })
    expect(posted.filter((m) => m.type === 'start')).toHaveLength(2)
  })

  it('keeps the draft when the panel is reloaded', async () => {
    await boot()
    await show(state())
    await type('Refactor the parser')
    expect(saved).toMatchObject({ draft: 'Refactor the parser' })

    await boot() // VS Code recreates the webview and hands back what it saved
    await show(state())
    expect(page().querySelector('textarea')!.value).toBe('Refactor the parser')
  })

  it('locks the task box while a run is in progress and while one is starting', async () => {
    await boot()
    await show(state({ busy: true }))
    await type('Something')
    expect(button('Starting').disabled).toBe(true)

    await show(
      state({
        run: run({
          state: 'running',
          outcome: undefined,
          phase: 'Waiting for ChatGPT',
          message: undefined,
          canStop: true,
          steps: []
        })
      })
    )
    expect(page().querySelector('textarea')!.disabled).toBe(true)
    expect(text()).toContain('Waiting for ChatGPT')
    await click(button('Stop'))
    expect(posted.at(-1)).toEqual({ type: 'stop' })
  })

  it('reports toggle changes to the extension', async () => {
    await boot()
    await show(state())
    const boxes = [...page().querySelectorAll<HTMLInputElement>('.toggle input')]
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true, true, true])
    await click(boxes[0]!) // Apply automatically
    await click(boxes[3]!) // Push each step
    expect(posted.slice(1)).toEqual([
      { type: 'setToggle', key: 'autoApply', value: false },
      { type: 'setToggle', key: 'push', value: false }
    ])
  })
})

describe('a run', () => {
  it('lists what each step changed, with the checks and the outcome', async () => {
    await boot()
    await show(
      state({
        run: run({
          steps: [
            step({
              diagnostics: {
                errors: 1,
                warnings: 0,
                items: [
                  {
                    path: 'src/greeting.ts',
                    line: 3,
                    column: 1,
                    severity: 'error',
                    message: "Type 'string' is not assignable to type 'number'."
                  }
                ]
              },
              verify: { command: 'npm test', outcome: 'failed', exitCode: 2 }
            }),
            step({
              n: 2,
              kind: 'follow-up',
              summary: 'Fixed it.',
              edits: [],
              publish: undefined,
              canUndo: false
            })
          ]
        })
      })
    )
    expect(text()).toContain('Add a greeting')
    expect(text()).toContain('Done — the task is complete')
    expect(text()).toContain('All done.')
    expect(text()).toContain('Step 1')
    expect(text()).toContain('Added the greeting module.')
    expect(text()).toContain('src/greeting.ts')
    expect(text()).toContain('1 new error, 0 warnings in the changed files')
    expect(text()).toContain("Type 'string' is not assignable to type 'number'.")
    expect(text()).toContain('npm test')
    expect(text()).toContain('failed (exit code 2)')
    expect(text()).toContain('Committed abc1234 and pushed it to origin/main.')
    expect(text()).toContain('Step 2')

    await click(button('Show diff of src/greeting.ts'))
    await click(button('src/greeting.ts'))
    await click(button('Undo this step'))
    await click(button('Open conversation'))
    await click(button('Close'))
    expect(posted.slice(1)).toEqual([
      { type: 'openDiff', path: 'src/greeting.ts', step: 1 },
      { type: 'openFile', path: 'src/greeting.ts' },
      { type: 'undo', step: 1 },
      { type: 'openUrl', url: 'https://chatgpt.com/c/abc' },
      { type: 'dismissRun' }
    ])
  })

  it('says so when the checks found nothing, and marks undone steps', async () => {
    await boot()
    await show(
      state({
        run: run({
          steps: [
            step({
              diagnostics: { errors: 0, warnings: 0, items: [] },
              canUndo: false,
              undone: true
            })
          ]
        })
      })
    )
    expect(text()).toContain('No new errors or warnings in the changed files.')
    expect(text()).toContain('undone')
    expect(buttons().some((b) => b.textContent?.includes('Undo this step'))).toBe(false)
  })

  it('shows a failed edit with its reason', async () => {
    await boot()
    await show(
      state({
        run: run({
          steps: [
            step({
              edits: [
                {
                  path: 'a.ts',
                  kind: 'updated',
                  status: 'failed',
                  detail: '',
                  notes: [],
                  errors: ['The SEARCH text was not found.']
                }
              ],
              canUndo: false
            })
          ]
        })
      })
    )
    expect(text()).toContain('Could not change')
    expect(text()).toContain('The SEARCH text was not found.')
    expect(
      buttons().some((b) => b.getAttribute('aria-label')?.startsWith('Show diff'))
    ).toBe(false)
  })

  it('offers Resume and Stop when a run needs attention', async () => {
    await boot()
    await show(
      state({
        run: run({
          state: 'paused',
          outcome: undefined,
          pauseReason: 'needs-attention',
          message: 'The push to GitHub failed.',
          canResume: true,
          resumeLabel: 'Resume',
          steps: []
        })
      })
    )
    expect(text()).toContain('Needs your attention')
    expect(text()).toContain('The push to GitHub failed.')
    await click(button('Resume'))
    await click(button('Stop'))
    expect(posted.slice(1)).toEqual([{ type: 'resume' }, { type: 'stop' }])
  })

  it('asks for a decision when a step is waiting for review', async () => {
    await boot()
    await show(
      state({
        review: {
          step: 2,
          summary: 'Rename the helper.',
          files: [
            { path: 'src/util.ts', kind: 'modify', added: 3, removed: 1 },
            { path: 'src/old.ts', kind: 'delete', added: 0, removed: 9 }
          ]
        }
      })
    )
    expect(text()).toContain('Review step 2')
    expect(text()).toContain('Rename the helper.')
    expect(text()).toContain('+3 −1')
    await click(button('Show diff of src/util.ts'))
    await click(button('Apply'))
    await click(button('Skip this step'))
    await click(button('Stop run'))
    expect(posted.slice(1)).toEqual([
      { type: 'openDiff', path: 'src/util.ts' },
      { type: 'decide', decision: 'apply' },
      { type: 'decide', decision: 'skip' },
      { type: 'decide', decision: 'stop' }
    ])
  })
})

describe('messages and history', () => {
  it('shows a notice and lets the user dismiss it', async () => {
    await boot()
    await show(
      state({
        notice: {
          kind: 'error',
          text: 'GitHub has 2 commits that you do not have locally.'
        }
      })
    )
    expect(page().querySelector('[role="alert"].notice.error')!.textContent).toContain(
      'GitHub has 2 commits'
    )
    await click(button('Dismiss'))
    expect(posted.at(-1)).toEqual({ type: 'dismissNotice' })
  })

  it('lists earlier runs and can clear them', async () => {
    await boot()
    await show(
      state({
        history: [
          {
            id: 'h1',
            task: 'Add a greeting',
            startedAt: Date.now() - 3_600_000,
            outcome: 'done',
            message: 'All done.',
            steps: 2,
            repo: 'octo/project'
          },
          {
            id: 'h2',
            task: 'Fix the build',
            startedAt: Date.now() - 60_000,
            outcome: 'interrupted',
            message: 'VS Code was closed.',
            steps: 1,
            repo: 'octo/project'
          }
        ]
      })
    )
    expect(text()).toContain('History (2)')
    expect(text()).toContain('Fix the build')
    expect(text()).toContain('2 steps')
    expect(text()).toContain('1 step ·')
    await click(button('Clear history'))
    expect(posted.at(-1)).toEqual({ type: 'clearHistory' })
  })

  it('shows text that comes from ChatGPT as text, never as markup', async () => {
    await boot()
    const hostile =
      '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>'
    await show(
      state({
        notice: { kind: 'warning', text: hostile },
        run: run({
          task: hostile,
          message: hostile,
          steps: [
            step({
              summary: hostile,
              problems: [hostile],
              warnings: [hostile],
              edits: [
                {
                  path: hostile,
                  kind: 'created',
                  status: 'applied',
                  detail: hostile,
                  notes: [hostile],
                  errors: [hostile]
                }
              ]
            })
          ]
        }),
        history: [
          {
            id: 'h',
            task: hostile,
            startedAt: Date.now(),
            outcome: 'done',
            message: hostile,
            steps: 1,
            repo: hostile
          }
        ]
      })
    )
    expect(page().querySelector('img')).toBeNull()
    expect(page().querySelector('script')).toBeNull()
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined()
    expect(text()).toContain('<img src=x')
  })
})
