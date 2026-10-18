import * as vscode from 'vscode'
import { App, type CodeGentApi } from './app'

let app: App | undefined

export async function activate(
  context: vscode.ExtensionContext
): Promise<CodeGentApi | undefined> {
  app = new App(context)
  context.subscriptions.push(app)
  await app.start()
  // A way to drive the extension without its panel exists only for its own integration tests;
  // other extensions get nothing.
  return process.env.CODEGENT_TEST_API === '1' ? app.api : undefined
}

export function deactivate(): void {
  app?.dispose()
  app = undefined
}
