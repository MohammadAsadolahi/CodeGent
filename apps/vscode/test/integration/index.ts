import fs from 'node:fs'
import path from 'node:path'
import Mocha from 'mocha'

/** Entry point VS Code calls inside the extension host (see scripts/integration.mjs). */
export const run = async (): Promise<void> => {
  const mocha = new Mocha({ ui: 'bdd', color: false, timeout: 90_000, reporter: 'spec' })
  for (const file of fs.readdirSync(__dirname).sort()) {
    if (file.endsWith('.test.js')) mocha.addFile(path.join(__dirname, file))
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve()))
  })
}
