import path from 'node:path'
import * as vscode from 'vscode'
import type {
  ChecksPort,
  DiagnosticItem,
  DiagnosticsSummary,
  VerifyResult
} from '@codegent/engine'
import { newProblems, summarize } from './diagnostics-delta'
import { runVerifyCommand } from './verify-runner'

export interface ChecksOptions {
  root: string
  diagnosticsWaitMs: () => number
  verify: () => { command: string; timeoutMs: number }
  log?: (line: string) => void
}

const MIN_WAIT_MS = 700
const QUIET_MS = 1_200
const BASELINE_WAIT_CAP_MS = 3_000
/** More files than this are not shown for analysis (each one is briefly an editor tab). */
const MAX_REVEALED_FILES = 12

/** URIs of the text files that are open in some editor tab. */
const openTabUris = (): string[] =>
  vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.flatMap((tab) =>
      tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []
    )
  )

const codeOf = (code: vscode.Diagnostic['code']): string | undefined => {
  if (code === undefined) return undefined
  return String(typeof code === 'object' ? code.value : code)
}

/**
 * What the editor knows about the files a step changed: the errors and warnings its language
 * servers report (only problems *introduced* by the step, measured against a baseline taken just
 * before) and the optional verify command.
 */
export class VsCodeChecks implements ChecksPort {
  private baseline = new Map<string, DiagnosticItem[]>()

  constructor(private readonly options: ChecksOptions) {}

  private uri(relative: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.options.root, ...relative.split('/')))
  }

  async prepare(existingPaths: readonly string[], signal: AbortSignal): Promise<void> {
    this.baseline.clear()
    if (existingPaths.length === 0) return
    const items = await this.collect(
      existingPaths,
      Math.min(this.options.diagnosticsWaitMs(), BASELINE_WAIT_CAP_MS),
      signal
    )
    for (const item of items) {
      const list = this.baseline.get(item.path) ?? []
      list.push(item)
      this.baseline.set(item.path, list)
    }
  }

  async diagnostics(
    paths: readonly string[],
    signal: AbortSignal
  ): Promise<DiagnosticsSummary> {
    if (paths.length === 0) return summarize([])
    const current = await this.collect(paths, this.options.diagnosticsWaitMs(), signal)
    const before = paths.flatMap((p) => this.baseline.get(p) ?? [])
    return summarize(newProblems(before, current))
  }

  async verify(signal: AbortSignal): Promise<VerifyResult | undefined> {
    const { command, timeoutMs } = this.options.verify()
    if (!command) return undefined
    return runVerifyCommand({ command, cwd: this.options.root, timeoutMs, signal })
  }

  /**
   * Language servers only analyse files that are shown in an editor, so the files are briefly
   * revealed in a side group (without taking focus) while we wait for things to calm down, and
   * closed again afterwards. With a wait of 0 nothing is opened and only what is already known
   * is read.
   */
  private async collect(
    paths: readonly string[],
    waitMs: number,
    signal: AbortSignal
  ): Promise<DiagnosticItem[]> {
    const uris = paths.map((p) => this.uri(p))
    const revealed = waitMs > 0 ? await this.reveal(uris) : []
    try {
      if (waitMs > 0) await this.settle(uris, waitMs, signal)
    } finally {
      await this.release(revealed)
    }

    const items: DiagnosticItem[] = []
    paths.forEach((relative, index) => {
      for (const diagnostic of vscode.languages.getDiagnostics(uris[index]!)) {
        if (
          diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
          diagnostic.severity !== vscode.DiagnosticSeverity.Warning
        )
          continue
        items.push({
          path: relative,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity:
            diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
          message: diagnostic.message,
          code: codeOf(diagnostic.code),
          source: diagnostic.source
        })
      }
    })
    return items
  }

  /** Shows the files that are not on screen yet; returns the ones this call opened. */
  private async reveal(uris: readonly vscode.Uri[]): Promise<string[]> {
    const onScreen = new Set(openTabUris())
    const opened: string[] = []
    for (const uri of uris) {
      if (opened.length >= MAX_REVEALED_FILES) break
      const key = uri.toString()
      if (onScreen.has(key)) continue
      try {
        const document = await vscode.workspace.openTextDocument(uri)
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: true,
          preview: false
        })
        opened.push(key)
      } catch (error) {
        this.options.log?.(
          `could not open ${uri.fsPath} for analysis: ${(error as Error).message}`
        )
      }
    }
    return opened
  }

  /** Closes the tabs `reveal` opened (and only those). */
  private async release(opened: readonly string[]): Promise<void> {
    if (opened.length === 0) return
    const ours = new Set(opened)
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText && ours.has(tab.input.uri.toString())
      )
    try {
      await vscode.window.tabGroups.close(tabs, true)
    } catch (error) {
      this.options.log?.(`could not close the analysis tabs: ${(error as Error).message}`)
    }
  }

  private settle(
    uris: readonly vscode.Uri[],
    maxMs: number,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolve) => {
      const watched = new Set(uris.map((uri) => uri.toString()))
      const started = Date.now()
      let lastChange = started
      const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
        if (event.uris.some((uri) => watched.has(uri.toString()))) lastChange = Date.now()
      })
      const finish = () => {
        clearInterval(timer)
        subscription.dispose()
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setInterval(() => {
        const now = Date.now()
        if (
          now - started >= maxMs ||
          (now - started >= MIN_WAIT_MS && now - lastChange >= QUIET_MS)
        )
          finish()
      }, 100)
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}
