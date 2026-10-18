import * as vscode from 'vscode'
import { buildSettings, type Settings } from './settings-model'

export const readSettings = (workspaceRoot?: string): Settings => {
  const config = vscode.workspace.getConfiguration('codegent')
  return buildSettings(<T>(key: string, fallback: T) => config.get<T>(key, fallback), workspaceRoot)
}

/** Writes a setting where the user already has it set, so the change is actually effective. */
export const updateSetting = async (key: string, value: unknown): Promise<void> => {
  const config = vscode.workspace.getConfiguration('codegent')
  const info = config.inspect(key)
  const target =
    info?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : info?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
  await config.update(key, value, target)
}
