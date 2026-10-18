import * as vscode from 'vscode'
import { sleep } from '../support/fake-browser'
import { write } from '../support/git-fixture'
import { workRepo } from './env'

const waitForDiagnostics = async (uri: vscode.Uri, ms: number): Promise<number | null> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (vscode.languages.getDiagnostics(uri).length > 0) return Date.now() - started
    await sleep(100)
  }
  return null
}

describe('probe', function () {
  this.timeout(240_000)
  it('measures which documents get diagnostics', async () => {
    const repo = workRepo()
    const typescript = vscode.extensions.getExtension('vscode.typescript-language-features')
    console.log('TS extension present:', !!typescript, 'active:', typescript?.isActive)
    await typescript!.activate()

    write(repo.dir, 'a.ts', 'export const a: number = "text"\n')
    const a = vscode.Uri.file(`${repo.dir}/a.ts`)
    const docA = await vscode.workspace.openTextDocument(a)
    console.log('A opened only; diagnostics after ms =', await waitForDiagnostics(a, 15_000))

    await vscode.window.showTextDocument(docA, { preview: true, preserveFocus: true })
    console.log('A shown; diagnostics after ms =', await waitForDiagnostics(a, 90_000))

    write(repo.dir, 'b.ts', 'export const b: number = "text"\n')
    const b = vscode.Uri.file(`${repo.dir}/b.ts`)
    await vscode.workspace.openTextDocument(b)
    console.log('B opened only (A visible); diagnostics after ms =', await waitForDiagnostics(b, 15_000))

    const json = vscode.extensions.getExtension('vscode.json-language-features')
    write(repo.dir, 'c.json', '{ "a": ')
    const c = vscode.Uri.file(`${repo.dir}/c.json`)
    await json!.activate()
    await vscode.workspace.openTextDocument(c)
    console.log('C json opened only; diagnostics after ms =', await waitForDiagnostics(c, 10_000))
  })
})
