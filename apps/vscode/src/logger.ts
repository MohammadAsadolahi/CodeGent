import * as vscode from 'vscode'

/** The "CodeGent" output channel. Never logs prompt or reply contents, only what happened. */
export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('CodeGent')

  private write(level: string, message: string): void {
    this.channel.appendLine(`${new Date().toISOString().slice(11, 23)} ${level} ${message}`)
  }

  info = (message: string): void => this.write('INFO ', message)
  warn = (message: string): void => this.write('WARN ', message)
  error = (message: string): void => this.write('ERROR', message)
  show = (): void => this.channel.show(true)
  dispose = (): void => this.channel.dispose()
}
