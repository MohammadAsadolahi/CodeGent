import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import { HUB_PORTS } from '@codegent/protocol'
import type { BrowserInfo } from '@codegent/protocol'
import { normalizeRepoPath } from '@codegent/engine'
import { allowedBrowserOrigins } from './bridge/allowed-origins'
import { BridgeChat } from './bridge/bridge-chat'
import { HubConnection } from './bridge/hub-connection'
import { installBrowserExtension } from './browser-extension-installer'
import { VsCodeChecks } from './checks/vscode-checks'
import { Log } from './logger'
import { RunManager, type ActiveRunMarker, type RunHost } from './run/run-manager'
import { readSettings, updateSetting } from './settings'
import { DIFF_SCHEME, DiffContentProvider } from './ui/diff-provider'
import { PanelProvider } from './ui/panel-provider'
import type { ToExtension, ToggleKey, UiNotice, UiState } from './ui/protocol'
import { toUiConnection, toUiRepo } from './ui/view-model'
import { FsWorkspace } from './workspace/fs-workspace'
import { RepoService, type RepoOk, type RepoStatus } from './workspace/repo-service'
import { TimeTravel, type RestoreMarker, type TimePoint } from './workspace/time-travel'

/** What the integration tests (and only they) use to drive the extension without clicking. */
export interface CodeGentApi {
  state(): UiState
  /** Handles a message exactly as if the panel had posted it (`start`, `setToggle`, `openDiff` …). */
  send(message: ToExtension): Promise<void>
  waitFor(predicate: (state: UiState) => boolean, timeoutMs?: number): Promise<UiState>
  /** Answers the "commit and push?" question in advance (undefined forgets the answer). */
  setPublishingConsent(
    repo: string,
    value: 'allow' | 'commit-only' | undefined
  ): Promise<void>
  hub(): { port: number | null; editorId: string }
  browserExtensionPath(): string | undefined
  webview(): { resolved: boolean; received: readonly string[] }
}

const HISTORY_KEY = 'codegent.history'
const ACTIVE_KEY = 'codegent.activeRun'
const RESTORE_KEY = 'codegent.lastTimeTravelRestore'
const BROWSER_KEY = 'codegent.browserId'
const consentKey = (repo: string) => `codegent.publish.${repo}`

export class App implements vscode.Disposable {
  private readonly log = new Log()
  private readonly hub: HubConnection
  private readonly diffs = new DiffContentProvider()
  private readonly panel: PanelProvider
  private readonly status: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[] = []
  private readonly manager: RunManager

  private repoService: RepoService | undefined
  private workspace: FsWorkspace | undefined
  private repoStatus: RepoStatus | undefined
  private timePoints: TimePoint[] = []
  private repoRevision = 0
  private timeTravelBusy = false
  private notice: UiNotice | null = null
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private pushTimer: ReturnType<typeof setTimeout> | undefined
  private browserExtensionPath: string | undefined
  private refreshing: Promise<void> | undefined
  private disposed = false

  constructor(private readonly context: vscode.ExtensionContext) {
    const version = (context.extension.packageJSON as { version: string }).version
    const storage = context.globalStorageUri.fsPath
    fs.mkdirSync(storage, { recursive: true })

    const configuredPorts = vscode.workspace
      .getConfiguration('codegent')
      .get<number[]>('advanced.hubPorts', [])
    this.hub = new HubConnection({
      hubScriptPath: context.asAbsolutePath(path.join('out', 'hub.cjs')),
      version,
      logFile: path.join(storage, 'hub.log'),
      ports: configuredPorts.length > 0 ? configuredPorts : HUB_PORTS,
      allowedOrigins: () => this.allowedBrowserOrigins(),
      log: (line) => this.log.info(line)
    })

    this.manager = new RunManager(this.runHost())
    this.panel = new PanelProvider(
      context.extensionUri,
      (message) => void this.handle(message),
      () => void this.refreshRepo()
    )
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
    this.status.command = 'codegent.focus'
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    const { context } = this
    this.disposables.push(
      this.log,
      this.status,
      vscode.window.registerWebviewViewProvider(PanelProvider.viewType, this.panel, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this.diffs),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('codegent')) return
        const { run } = readSettings()
        this.manager.updateActiveSettings({
          autoApply: run.autoApply,
          autoContinue: run.autoContinue,
          commit: run.commit,
          push: run.push
        })
        this.pushState()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // Hide the previous repository immediately, including its restore actions.
        // A refresh already in flight must not publish results for the old folder.
        this.repoRevision += 1
        this.repoService = undefined
        this.workspace = undefined
        this.repoStatus = undefined
        this.timePoints = []
        this.pushState()
        void this.refreshRepo()
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refreshRepo()
      }),
      ...this.commands()
    )
    this.hub.onState(() => this.pushState())
    this.hub.onPeers(() => this.pushState())
    this.manager.onChange(() => {
      this.pushState()
      this.scheduleRepoRefreshAfterStep()
    })

    this.browserExtensionPath =
      (await installBrowserExtension({
        source: context.asAbsolutePath(path.join('out', 'browser-extension')),
        target: path.join(context.globalStorageUri.fsPath, 'browser-extension'),
        version: (context.extension.packageJSON as { version: string }).version
      }).catch((error: Error) => {
        this.log.warn(`could not install the browser extension files: ${error.message}`)
        return null
      })) ?? undefined

    this.hub.start()
    await this.refreshRepo()
    const timer = setInterval(() => {
      if (this.panel.visible && !this.manager.active) void this.refreshRepo()
    }, 30_000)
    this.disposables.push({ dispose: () => clearInterval(timer) })
    this.pushState()
    this.log.info('CodeGent started')
  }

  dispose(): void {
    this.disposed = true
    this.hub.stop()
    this.manager.stop()
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }

  /** The browser extensions the hub is told to accept: the bundled one plus the user's own ids. */
  private allowedBrowserOrigins(): string[] {
    let bundledManifestKey: unknown
    try {
      const manifest = path.join(
        this.context.asAbsolutePath('out'),
        'browser-extension',
        'manifest.json'
      )
      bundledManifestKey = (
        JSON.parse(fs.readFileSync(manifest, 'utf8')) as { key?: unknown }
      ).key
    } catch (error) {
      this.log.warn(
        `could not read the bundled browser extension's manifest: ${(error as Error).message}`
      )
    }
    const extraIds = vscode.workspace
      .getConfiguration('codegent')
      .get<string[]>('advanced.extraBrowserExtensionIds', [])
    const { origins, notes } = allowedBrowserOrigins({ bundledManifestKey, extraIds })
    for (const note of notes) this.log.warn(note)
    return origins
  }

  // ── services that depend on the open folder ─────────────────────────────────────────────────
  private folderPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  private repo(): RepoService | undefined {
    const folder = this.folderPath()
    if (!folder) return undefined
    if (!this.repoService || this.repoService.folder !== folder)
      this.repoService = new RepoService(folder)
    return this.repoService
  }

  private workspaceFor(root: string): FsWorkspace {
    const repo = this.repo()!
    if (!this.workspace || this.workspace.root !== root) {
      this.workspace = new FsWorkspace({
        root,
        repo,
        isBufferDirty: (absolute) =>
          vscode.workspace.textDocuments.some(
            (doc) =>
              doc.isDirty &&
              doc.uri.scheme === 'file' &&
              path.normalize(doc.uri.fsPath).toLowerCase() ===
                path.normalize(absolute).toLowerCase()
          ),
        log: (line) => this.log.info(line)
      })
    }
    return this.workspace
  }

  async refreshRepo(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const revision = this.repoRevision
    this.refreshing = (async () => {
      // Even without an open folder, yield before the finally block: otherwise
      // a synchronously settled promise can remain stuck in this.refreshing.
      await Promise.resolve()
      try {
        const repo = this.repo()
        const status: RepoStatus = repo
          ? await repo.status({ fetch: true })
          : {
              ok: false,
              problem: 'no-repo',
              reason: 'Open a folder that is a git repository with a GitHub remote.'
            }
        const points = status.ok
          ? await new TimeTravel(status.root).points().catch((error: Error) => {
              this.log.warn('Could not load Time Travel history: ' + error.message)
              return []
            })
          : []
        if (revision === this.repoRevision) {
          this.repoStatus = status
          this.timePoints = points
        }
      } catch (error) {
        if (revision === this.repoRevision) {
          this.repoStatus = {
            ok: false,
            problem: 'no-repo',
            reason: (error as Error).message
          }
          this.timePoints = []
        }
      } finally {
        this.refreshing = undefined
        if (!this.disposed) {
          this.pushState()
          if (revision !== this.repoRevision) void this.refreshRepo()
        }
      }
    })()
    return this.refreshing
  }

  private scheduleRepoRefreshAfterStep(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      if (!this.manager.active) void this.refreshRepo()
    }, 1_500)
  }

  // ── the run host ─────────────────────────────────────────────────────────────────────────────
  private runHost(): RunHost {
    return {
      readSettings: () =>
        readSettings(this.repoStatus?.ok ? this.repoStatus.root : this.folderPath()),
      createDeps: (settings) => {
        const status = this.repoStatus
        if (!status?.ok) throw new Error('The repository is not ready.')
        const workspace = this.workspaceFor(status.root)
        const repo = this.repo()!
        return {
          chat: new BridgeChat(this.hub, {
            chatUrl: () => readSettings().bridge.chatUrl,
            autoSubmit: () => readSettings().bridge.autoSubmit,
            replyTimeoutMs: () => readSettings().bridge.replyTimeoutMs,
            browserWaitMs: () => readSettings().bridge.browserWaitMs,
            chooseBrowser: (browsers) => this.chooseBrowser(browsers),
            preferredBrowserId: () =>
              this.context.workspaceState.get<string>(BROWSER_KEY),
            rememberBrowser: (id) =>
              void this.context.workspaceState.update(BROWSER_KEY, id),
            log: (line) => this.log.info(line)
          }),
          workspace,
          git: repo.gitPort(),
          checks: new VsCodeChecks({
            root: status.root,
            diagnosticsWaitMs: () => settings.diagnosticsWaitMs,
            verify: () => settings.verify,
            log: (line) => this.log.info(line)
          })
        }
      },
      workspace: {
        undo: async (id) => {
          const result = await this.workspace!.undo(id)
          void this.refreshRepo()
          return result
        },
        isUndone: (id) => this.workspace?.isUndone(id) ?? false,
        receiptChanges: (id) => this.workspace?.receiptChanges(id)
      },
      repoStatus: async (options) => {
        const repo = this.repo()
        if (!repo)
          return {
            ok: false,
            problem: 'no-repo',
            reason: 'Open a folder that is a git repository with a GitHub remote.'
          }
        this.repoStatus = await repo.status(options)
        this.pushState()
        return this.repoStatus
      },
      confirmPublishing: (repo) => this.confirmPublishing(repo),
      loadHistory: () => this.context.globalState.get(HISTORY_KEY, []),
      saveHistory: (items) => void this.context.globalState.update(HISTORY_KEY, items),
      // Per workspace, so another window never mistakes this window's run for a lost one.
      loadActive: () => this.context.workspaceState.get<ActiveRunMarker>(ACTIVE_KEY),
      saveActive: (marker) => void this.context.workspaceState.update(ACTIVE_KEY, marker),
      notify: (notice) => this.notify(notice)
    }
  }

  private async confirmPublishing(
    repo: RepoOk
  ): Promise<'allow' | 'commit-only' | 'cancel'> {
    const key = consentKey(`${repo.owner}/${repo.name}`)
    const saved = this.context.workspaceState.get<'allow' | 'commit-only'>(key)
    if (saved) return saved
    const push = 'Commit and push'
    const commitOnly = 'Commit only'
    const choice = await vscode.window.showInformationMessage(
      `CodeGent will commit each applied step to "${repo.branch}" of ${repo.owner}/${repo.name} and push it to GitHub, so ChatGPT can read the new code through its GitHub connector.`,
      {
        modal: true,
        detail:
          'Only the files CodeGent changed are committed — never your other work. You can change this later in the CodeGent settings. “Commit only” keeps everything local, but then ChatGPT cannot see its own changes on GitHub.'
      },
      push,
      commitOnly
    )
    if (choice === push) {
      await this.context.workspaceState.update(key, 'allow')
      return 'allow'
    }
    if (choice === commitOnly) {
      await this.context.workspaceState.update(key, 'commit-only')
      return 'commit-only'
    }
    return 'cancel'
  }

  private async chooseBrowser(
    browsers: readonly BrowserInfo[]
  ): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      browsers.map((browser) => ({
        label: browser.profile ? `${browser.name} — ${browser.profile}` : browser.name,
        description: `${browser.chatgptTabs} ChatGPT tab${browser.chatgptTabs === 1 ? '' : 's'}`,
        id: browser.id
      })),
      {
        title: 'CodeGent',
        placeHolder: 'Several browsers are connected. Which one should CodeGent use?'
      }
    )
    return picked?.id
  }

  // ── UI state ─────────────────────────────────────────────────────────────────────────────────
  buildState(): UiState {
    const settings = readSettings()
    const selected = this.context.workspaceState.get<string>(BROWSER_KEY)
    const restore = this.context.workspaceState.get<RestoreMarker>(RESTORE_KEY)
    return {
      version: (this.context.extension.packageJSON as { version: string }).version,
      connection: toUiConnection(
        this.hub.state,
        this.hub.browsers,
        this.hub.browsers.some((b) => b.id === selected) ? selected : undefined,
        this.hub.lastError
      ),
      repo: this.repoStatus
        ? toUiRepo(this.repoStatus)
        : { ok: false, problem: 'loading', reason: 'Reading the repository…' },
      toggles: {
        autoApply: settings.run.autoApply,
        autoContinue: settings.run.autoContinue,
        commit: settings.run.commit,
        push: settings.run.push,
        autoSubmit: settings.bridge.autoSubmit
      },
      ...this.manager.view(),
      timeTravel: {
        points: this.timePoints,
        undoAvailable:
          this.repoStatus?.ok === true &&
          restore?.root === this.repoStatus.root &&
          restore.headSha === this.repoStatus.sha
      },
      busy: this.manager.busy || this.timeTravelBusy,
      notice: this.notice,
      setup: { browserExtensionPath: this.browserExtensionPath }
    }
  }

  private pushState(): void {
    if (this.disposed) return
    const state = this.buildState()
    this.panel.post(state)
    this.updateStatusBar(state)
  }

  private updateStatusBar(state: UiState): void {
    const run = state.run
    if (run && run.state === 'running') {
      this.status.text = `$(sync~spin) CodeGent: ${run.phase ?? 'working'}`
      this.status.tooltip = `Working on: ${run.task}`
    } else if (run && run.state === 'paused') {
      this.status.text = '$(warning) CodeGent: needs attention'
      this.status.tooltip = run.message ?? 'Paused'
    } else if (state.connection.browsers.length > 0) {
      this.status.text = `$(check) CodeGent`
      this.status.tooltip = `Connected to ${state.connection.browsers.map((b) => b.label).join(', ')}${state.connection.chatgptTabs === 0 ? ' — open chatgpt.com in that browser' : ''}`
    } else {
      this.status.text = '$(circle-slash) CodeGent'
      this.status.tooltip = 'No browser connected — see the CodeGent panel'
    }
    this.status.show()
  }

  private notify(notice: UiNotice): void {
    this.notice = notice
    this.log[
      notice.kind === 'error' ? 'error' : notice.kind === 'warning' ? 'warn' : 'info'
    ](notice.text)
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    if (notice.kind === 'info') {
      this.noticeTimer = setTimeout(() => {
        this.notice = null
        this.pushState()
      }, 20_000)
    }
    this.pushState()
    if (!this.panel.visible) {
      const show =
        notice.kind === 'error'
          ? vscode.window.showErrorMessage
          : notice.kind === 'warning'
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage
      void show(`CodeGent: ${notice.text}`, 'Open panel').then((choice) => {
        if (choice) void vscode.commands.executeCommand('codegent.focus')
      })
    }
  }

  // ── messages from the panel ──────────────────────────────────────────────────────────────────
  private async handle(message: ToExtension): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.pushState()
          return void this.refreshRepo()
        case 'start':
          if (this.timeTravelBusy)
            return this.notify({ kind: 'warning', text: 'Time Travel is in progress. Start the task after it finishes.' })
          return await this.manager.start(String(message.task ?? ''))
        case 'stop':
          return this.manager.stop()
        case 'resume':
          if (this.timeTravelBusy)
            return this.notify({ kind: 'warning', text: 'Time Travel is in progress. Resume after it finishes.' })
          return await this.manager.resume()
        case 'decide':
          return this.manager.decide(message.decision)
        case 'undo':
          if (this.timeTravelBusy)
            return this.notify({ kind: 'warning', text: 'Time Travel is in progress. Undo the step afterward.' })
          return await this.manager.undoStep(Number(message.step))
        case 'restorePoint':
          return await this.restorePoint(String(message.sha))
        case 'undoTimeTravel':
          return await this.undoTimeTravel()
        case 'dismissRun':
          return this.manager.dismiss()
        case 'clearHistory':
          return this.manager.clearHistory()
        case 'dismissNotice':
          this.notice = null
          return this.pushState()
        case 'setToggle':
          return await this.setToggle(message.key, message.value === true)
        case 'refreshRepo':
          return await this.refreshRepo()
        case 'pushNow':
          return await this.pushNow()
        case 'openDiff':
          return await this.openDiff(
            String(message.path),
            typeof message.step === 'number' ? message.step : undefined
          )
        case 'openFile':
          return await this.openFile(String(message.path))
        case 'openUrl':
          return this.openUrl(String(message.url))
        case 'openBrowserExtensionFolder':
          return await this.revealBrowserExtension()
        case 'copyBrowserExtensionPath':
          if (this.browserExtensionPath) {
            await vscode.env.clipboard.writeText(this.browserExtensionPath)
            this.notify({
              kind: 'info',
              text: 'Folder path copied. In your browser: extensions page → Load unpacked → paste it.'
            })
          }
          return
        case 'restartHub':
          return await this.hub.restartHub()
        case 'chooseBrowser': {
          const id = await this.chooseBrowser(this.hub.browsers)
          if (id) await this.context.workspaceState.update(BROWSER_KEY, id)
          return this.pushState()
        }
        case 'showLog':
          return this.log.show()
      }
    } catch (error) {
      this.log.error(
        `message "${message.type}" failed: ${(error as Error).stack ?? error}`
      )
      this.notify({ kind: 'error', text: (error as Error).message })
    }
  }

  private async setToggle(key: ToggleKey, value: boolean): Promise<void> {
    const setting = {
      autoApply: 'autoApply',
      autoContinue: 'autoContinue',
      commit: 'git.commit',
      push: 'git.push',
      autoSubmit: 'autoSubmit'
    }[key]
    if (!setting) return
    await updateSetting(setting, value)
    if (key === 'push' && value) {
      const repo = this.repoStatus
      if (repo?.ok)
        await this.context.workspaceState.update(
          consentKey(`${repo.owner}/${repo.name}`),
          'allow'
        )
    }
  }

  private async pushNow(): Promise<void> {
    const repo = this.repo()
    if (!repo) return
    try {
      const pushed = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeGent: pushing to GitHub…'
        },
        () => repo.pushNow()
      )
      this.notify({ kind: 'info', text: `Pushed ${pushed.branch} to ${pushed.remote}.` })
    } catch (error) {
      this.notify({
        kind: 'error',
        text: `Push failed: ${(error as Error).message.split('\n')[0]}`
      })
    }
    await this.refreshRepo()
  }

  /** Time Travel never changes HEAD or the staging area; only the working tree is patched. */
  private travel(root: string): TimeTravel {
    return new TimeTravel(root, undefined, () =>
      vscode.workspace.textDocuments.some((doc) => {
        if (!doc.isDirty || doc.uri.scheme !== 'file') return false
        const relative = path.relative(root, doc.uri.fsPath)
        return (
          relative !== '' &&
          relative !== '..' &&
          !relative.startsWith('..' + path.sep) &&
          !path.isAbsolute(relative)
        )
      })
    )
  }

  /** Only one restore or undo may touch a repository at a time in this VS Code window. */
  private async withTimeTravelLock(operation: () => Promise<void>): Promise<void> {
    if (this.timeTravelBusy)
      throw new Error('Another Time Travel operation is already in progress.')
    this.timeTravelBusy = true
    this.pushState()
    try {
      await operation()
    } finally {
      this.timeTravelBusy = false
      this.pushState()
    }
  }

  private async restorePoint(sha: string): Promise<void> {
    return this.withTimeTravelLock(async () => {
    const folder = this.folderPath()
    const status = this.repoStatus
    if (!status?.ok) throw new Error('Open a GitHub repository to use Time Travel.')
    if (this.manager.active || this.manager.busy)
      throw new Error('Stop the current CodeGent run before restoring files.')

    const travel = this.travel(status.root)
    const preview = await travel.preview(sha)
    if (preview.files.length === 0) {
      this.notify({ kind: 'info', text: 'This checkpoint already matches HEAD.' })
      return
    }
    const label =
      this.timePoints.find((point) => point.sha === sha)?.title ?? sha.slice(0, 7)
    const visibleFiles = preview.files.slice(0, 12)
    const detail = [
      preview.summary || 'Changes to tracked files',
      '',
      ...visibleFiles,
      ...(preview.files.length > visibleFiles.length
        ? ['… and ' + (preview.files.length - visibleFiles.length) + ' more files']
        : []),
      '',
      'Your branch, commits, staging area and GitHub remote will not change.',
      'All uncommitted and unsaved work must be cleared before restoring.',
      'Use Undo Time Travel to reverse this restore if the affected files remain unchanged.'
    ].join('\n')
    const choice = await vscode.window.showWarningMessage(
      'Restore ' + preview.files.length + ' file(s) from "' + label + '"?',
      { modal: true, detail },
      'Restore files'
    )
    if (choice !== 'Restore files') return
    if (folder !== this.folderPath())
      throw new Error('The open workspace changed during confirmation. Restore cancelled.')
    if (this.manager.active || this.manager.busy)
      throw new Error('A CodeGent run started during confirmation. Restore cancelled.')
    const marker = await travel.restore(sha, preview.headSha)
    await this.context.workspaceState.update(RESTORE_KEY, marker)
    this.notify({
      kind: 'info',
      text:
        'Restored ' +
        preview.files.length +
        ' files in your working tree. Review the diff before committing; Git history is unchanged.'
    })
    await this.refreshRepo()
    })
  }

  private async undoTimeTravel(): Promise<void> {
    return this.withTimeTravelLock(async () => {
    const folder = this.folderPath()
    if (this.manager.active || this.manager.busy)
      throw new Error('Stop the current CodeGent run before undoing a restore.')
    const status = this.repoStatus
    const marker = this.context.workspaceState.get<RestoreMarker>(RESTORE_KEY)
    if (!status?.ok || !marker || marker.root !== status.root)
      throw new Error('There is no Time Travel restore to undo in this repository.')
    const choice = await vscode.window.showWarningMessage(
      'Undo the last Time Travel restore?',
      {
        modal: true,
        detail:
          'CodeGent will reverse only the restore patch. If those files were edited since the restore, the undo will be refused rather than overwrite your work.'
      },
      'Undo restore'
    )
    if (choice !== 'Undo restore') return
    if (folder !== this.folderPath())
      throw new Error('The open workspace changed during confirmation. Undo cancelled.')
    await this.travel(status.root).undo(marker)
    await this.context.workspaceState.update(RESTORE_KEY, undefined)
    this.notify({
      kind: 'info',
      text: 'Time Travel restore undone; working tree returned to the previous state.'
    })
    await this.refreshRepo()
    })
  }

  private async openDiff(file: string, step: number | undefined): Promise<void> {
    const changes =
      step === undefined ? this.manager.pendingChanges() : this.manager.stepChanges(step)
    const change = changes?.find((c) => (c.kind === 'rename' ? c.to : c.path) === file)
    if (!change)
      return void this.notify({
        kind: 'warning',
        text: 'That diff is no longer available.'
      })
    await this.diffs.open(
      change,
      `${file} — CodeGent${step === undefined ? ' (proposed)' : ` step ${step}`}`
    )
  }

  private async openFile(file: string): Promise<void> {
    const root = this.repoStatus?.ok ? this.repoStatus.root : this.folderPath()
    if (!root) return
    // The path comes from the panel, which shows text that originates from ChatGPT: only plain
    // repository-relative paths are opened.
    const safe = normalizeRepoPath(file)
    if (!safe.ok)
      return void this.notify({
        kind: 'warning',
        text: `Cannot open "${file}": ${safe.reason}.`
      })
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(root, ...safe.path.split('/'))),
      { preview: true }
    )
  }

  private openUrl(url: string): void {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:')
        void vscode.env.openExternal(vscode.Uri.parse(parsed.toString()))
    } catch {
      // not a URL
    }
  }

  private async revealBrowserExtension(): Promise<void> {
    if (!this.browserExtensionPath) {
      return void this.notify({
        kind: 'error',
        text: 'The browser extension files were not found in this installation.'
      })
    }
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(path.join(this.browserExtensionPath, 'manifest.json'))
    )
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────
  private commands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('codegent.focus', () =>
        vscode.commands.executeCommand('workbench.view.extension.codegent')
      ),
      vscode.commands.registerCommand('codegent.startRun', async (task?: unknown) => {
        const text =
          typeof task === 'string' && task.trim()
            ? task
            : await vscode.window.showInputBox({
                title: 'CodeGent',
                prompt: 'What should ChatGPT build or fix?',
                ignoreFocusOut: true
              })
        if (text) {
          if (this.timeTravelBusy)
            this.notify({ kind: 'warning', text: 'Time Travel is in progress. Start the task after it finishes.' })
          else await this.manager.start(text)
        }
      }),
      vscode.commands.registerCommand('codegent.stopRun', () => this.manager.stop()),
      vscode.commands.registerCommand('codegent.resumeRun', () =>
        this.timeTravelBusy
          ? this.notify({ kind: 'warning', text: 'Time Travel is in progress. Resume after it finishes.' })
          : this.manager.resume()
      ),
      vscode.commands.registerCommand('codegent.undoTimeTravel', () =>
        this.undoTimeTravel()
      ),
      vscode.commands.registerCommand('codegent.undoStep', async () => {
        if (this.timeTravelBusy)
          return this.notify({ kind: 'warning', text: 'Time Travel is in progress. Undo the step afterward.' })
        const run = this.manager.view().run
        const step = run?.steps.find((s) => s.canUndo)
        if (step) await this.manager.undoStep(step.n)
        else this.notify({ kind: 'warning', text: 'There is no step to undo.' })
      }),
      vscode.commands.registerCommand('codegent.openBrowserExtensionFolder', () =>
        this.revealBrowserExtension()
      ),
      vscode.commands.registerCommand('codegent.restartHub', () => this.hub.restartHub()),
      vscode.commands.registerCommand('codegent.showLog', () => this.log.show()),
      vscode.commands.registerCommand('codegent.resetPublishingConsent', async () => {
        const repo = this.repoStatus
        if (repo?.ok)
          await this.context.workspaceState.update(
            consentKey(`${repo.owner}/${repo.name}`),
            undefined
          )
        this.notify({
          kind: 'info',
          text: 'CodeGent will ask again before it commits and pushes.'
        })
      })
    ]
  }

  // ── test api ─────────────────────────────────────────────────────────────────────────────────
  get api(): CodeGentApi {
    return {
      state: () => this.buildState(),
      send: (message) => this.handle(message),
      waitFor: async (predicate, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const state = this.buildState()
          if (predicate(state)) return state
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for the extension state; run: ${JSON.stringify(state.run)} notice: ${JSON.stringify(state.notice)}`
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      },
      setPublishingConsent: (repo, value) =>
        Promise.resolve(this.context.workspaceState.update(consentKey(repo), value)),
      hub: () => ({ port: this.hub.port, editorId: this.hub.editorId }),
      browserExtensionPath: () => this.browserExtensionPath,
      webview: () => ({ resolved: this.panel.resolved, received: this.panel.received })
    }
  }
}
