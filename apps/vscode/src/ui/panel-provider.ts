import * as vscode from 'vscode'
import type { ToExtension, UiState } from './protocol'

const nonce = (): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/** The sidebar view. All behaviour lives in the webview app and in the App class. */
export class PanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codegent.panel'

  private view: vscode.WebviewView | undefined
  private lastState: UiState | undefined
  /** Types of the messages the webview has sent (newest last); lets tests see that it actually runs. */
  readonly received: string[] = []

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: ToExtension) => void,
    private readonly onVisible: () => void
  ) {}

  get visible(): boolean {
    return this.view?.visible === true
  }

  get resolved(): boolean {
    return this.view !== undefined
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const root = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [root] }
    view.webview.html = this.html(view.webview, root)
    view.webview.onDidReceiveMessage((message: ToExtension) => {
      if (!message || typeof message.type !== 'string') return
      this.received.push(message.type)
      if (this.received.length > 200) this.received.shift()
      this.onMessage(message)
    })
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.onVisible()
        if (this.lastState)
          void view.webview.postMessage({ type: 'state', state: this.lastState })
      }
    })
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined
    })
  }

  post(state: UiState): void {
    this.lastState = state
    void this.view?.webview.postMessage({ type: 'state', state })
  }

  reveal(): void {
    this.view?.show(true)
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.css'))
    const token = nonce()
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${token}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`
    ].join('; ')
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${style}" />
    <title>CodeGent</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${token}" src="${script}"></script>
  </body>
</html>`
  }
}
