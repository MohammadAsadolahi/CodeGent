import * as vscode from 'vscode'
import { App, type CodeGentApi } from './app'

let app: App | undefined

export async function activate(context: vscode.ExtensionContext): Promise<CodeGentApi> {
  app = new App(context)
  context.subscriptions.push(app)
  await app.start()
  return app.api
}

export function deactivate(): void {
  app?.dispose()
  app = undefined
}
