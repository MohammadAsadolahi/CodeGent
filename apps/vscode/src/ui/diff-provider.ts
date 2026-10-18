import * as vscode from 'vscode'
import type { FileChange } from '@codegent/engine'

export const DIFF_SCHEME = 'codegent-diff'

/**
 * Serves the "before" and "after" text of a change to VS Code's diff editor. The URI carries the
 * text's key; the content itself lives in memory only for as long as the change is on screen.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>()
  private counter = 0
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.changed.event

  private uriFor(text: string, label: string): vscode.Uri {
    const key = String(++this.counter)
    this.texts.set(key, text)
    if (this.texts.size > 400) this.texts.delete(this.texts.keys().next().value as string)
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${label}`, query: key })
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.query) ?? ''
  }

  /** Opens VS Code's diff editor for one change. */
  async open(change: FileChange, title: string): Promise<void> {
    const path = change.kind === 'rename' ? change.to : change.path
    const before = change.kind === 'create' ? '' : change.before
    const after = change.kind === 'delete' ? '' : change.after
    const left = this.uriFor(before, `${path} (before)`)
    const right = this.uriFor(after, `${path} (after)`)
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true })
  }
}
