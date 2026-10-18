import fs from 'node:fs'
import path from 'node:path'
import Mocha from 'mocha'

/**
 * Entry point VS Code calls inside the extension host (see scripts/integration.mjs). The "chain"
 * suite runs the files called `chain.*`; the "protocol" suite runs all the others.
 */
export const run = async (): Promise<void> => {
  const chain = process.env.CODEGENT_IT_SUITE === 'chain'
  const mocha = new Mocha({ ui: 'bdd', color: false, timeout: 90_000, reporter: 'spec' })
  if (process.env.CODEGENT_IT_GREP) mocha.grep(process.env.CODEGENT_IT_GREP)
  for (const file of fs.readdirSync(__dirname).sort()) {
    if (file.endsWith('.test.js') && file.startsWith('chain.') === chain) {
      mocha.addFile(path.join(__dirname, file))
    }
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve()
    )
  })
}
