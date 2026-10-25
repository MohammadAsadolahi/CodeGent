// The real-world side of the release script: programs, git, the GitHub CLI, the terminal. The
// release itself (../release.mjs) only talks to the object `createSystem` returns, so its
// decisions can be tested without any of this.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { ReleaseError } from './common.mjs'

const environment = (extra = {}) => {
  const env = { ...process.env, ...extra }
  // `npm run release --dry-run` would otherwise turn every npm command of the checks into one.
  delete env.npm_config_dry_run
  return env
}

const firstLines = (text, count = 6) => text.trim().split('\n').slice(0, count).join('\n')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs a program to its end. Never throws: the exit code is null when it could not start. */
export const exec = (command, args = [], { cwd, env, input = '' } = {}) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, { cwd, env: environment(env), windowsHide: true })
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) =>
      resolve({ code: null, stdout, stderr: stderr || error.message })
    )
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {}) // the program may exit without reading its input
    child.stdin.end(input)
  })

/** Runs git in `defaultCwd` (or the `cwd` given) and returns its output; a failure throws. */
export const createGit =
  (defaultCwd, run = exec) =>
  async (args, { cwd = defaultCwd } = {}) => {
    const result = await run('git', args, {
      cwd,
      env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    })
    if (result.code !== 0) {
      const why = firstLines(result.stderr || result.stdout) || 'could not start git'
      throw new ReleaseError(`git ${args.join(' ')} failed:\n${why}`)
    }
    return result.stdout.trimEnd()
  }

/**
 * The GitHub CLI as the few things a release asks of it. `run` is injectable so the exact
 * command lines can be tested.
 */
export const createGh = (repo, run = exec) => {
  const gh = (args) =>
    run('gh', args, { env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } })
  const must = async (args, what) => {
    const result = await gh(args)
    if (result.code !== 0) {
      throw new ReleaseError(
        `${what} failed:\n${firstLines(result.stderr || result.stdout)}`
      )
    }
    return result.stdout.trim()
  }

  return {
    /** 'ready', 'missing' (not installed) or 'signed-out'. */
    async status() {
      if ((await gh(['--version'])).code !== 0) return 'missing'
      const auth = await gh(['auth', 'status', '--hostname', 'github.com'])
      return auth.code === 0 ? 'ready' : 'signed-out'
    },

    async releaseExists(tag) {
      const result = await gh([
        'release',
        'view',
        tag,
        '--repo',
        repo,
        '--json',
        'tagName'
      ])
      if (result.code === 0) return true
      if (/not found/i.test(result.stderr)) return false
      throw new ReleaseError(
        `gh release view ${tag} failed:\n${firstLines(result.stderr)}`
      )
    },

    /** A draft stays invisible; its tag is only created when it is published. */
    async createDraft({ tag, title, notesFile, files, target }) {
      return must(
        [
          'release',
          'create',
          tag,
          ...files,
          ...['--repo', repo, '--title', title, '--notes-file', notesFile],
          ...['--target', target, '--draft']
        ],
        `gh release create ${tag}`
      )
    },

    async view(tag) {
      const json = await must(
        [
          ...['release', 'view', tag, '--repo', repo],
          ...['--json', 'url,isDraft,isPrerelease,assets']
        ],
        `gh release view ${tag}`
      )
      const release = JSON.parse(json)
      return {
        url: release.url,
        isDraft: release.isDraft,
        isPrerelease: release.isPrerelease,
        assets: (release.assets ?? []).map(({ name, size, state, digest }) => ({
          name,
          size,
          state,
          digest
        }))
      }
    },

    async publish(tag, { prerelease }) {
      await must(
        [
          ...['release', 'edit', tag, '--repo', repo, '--draft=false'],
          prerelease ? '--prerelease' : '--latest'
        ],
        `gh release edit ${tag}`
      )
    },

    /** The tag GitHub shows as "Latest", or '' when there is none. */
    async latestTag() {
      const result = await gh([
        'api',
        `repos/${repo}/releases/latest`,
        '--jq',
        '.tag_name'
      ])
      return result.code === 0 ? result.stdout.trim() : ''
    },

    async download(tag, dir, names) {
      await must(
        [
          ...['release', 'download', tag, '--repo', repo, '--dir', dir],
          ...names.flatMap((name) => ['--pattern', name])
        ],
        `gh release download ${tag}`
      )
    },

    async deleteDraft(tag) {
      await must(
        ['release', 'delete', tag, '--repo', repo, '--yes'],
        `gh release delete ${tag}`
      )
    }
  }
}

// Under `npm run`, npm tells us where it lives, which avoids the shell that a `.cmd` needs.
const npmCommand = (args) => {
  const script = process.env.npm_execpath
  return script && /npm-cli\.c?js$/.test(script)
    ? { command: process.execPath, args: [script, ...args], shell: false }
    : { command: 'npm', args, shell: process.platform === 'win32' }
}

const tailOf = (file, count = 40) =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trimEnd()
    .split('\n')
    .slice(-count)
    .join('\n')

/** Runs `npm <args>` with all of its output in `logFile`. */
export const runCheck = ({ args, cwd, env, logFile }) =>
  new Promise((resolve) => {
    const started = Date.now()
    const output = fs.openSync(logFile, 'w')
    const { command, args: commandArgs, shell } = npmCommand(args)
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      fs.closeSync(output)
      const ok = code === 0
      resolve({
        ok,
        seconds: (Date.now() - started) / 1000,
        tail: ok ? '' : tailOf(logFile)
      })
    }
    const child = spawn(command, commandArgs, {
      cwd,
      env: environment(env),
      stdio: ['ignore', output, output],
      windowsHide: true,
      shell
    })
    child.on('error', (error) => {
      fs.writeSync(output, `${error.message}\n`)
      finish(null)
    })
    child.on('close', finish)
  })

// VS Code's helper processes can still be shutting down; give them a moment.
const removeDir = async (dir) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(500)
    }
  }
  console.warn(`could not remove ${dir}; delete it by hand`)
}

const confirm = async (question) => {
  if (!process.stdin.isTTY) return false
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  const answer = await new Promise((resolve) =>
    terminal.question(`${question} [y/N] `, resolve)
  )
  terminal.close()
  return /^y(es)?$/i.test(answer.trim())
}

export const createSystem = (root) => {
  const tempDirs = new Set()
  return {
    root,
    git: createGit(root),
    gh: (repo) => createGh(repo),
    runCheck,
    sleep,
    confirm,
    log: {
      info: (text = '') => console.log(text),
      warn: (text) => console.warn(`warning: ${text}`)
    },
    tempDir(prefix) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
      tempDirs.add(dir)
      return {
        path: dir,
        remove: async () => {
          await removeDir(dir)
          tempDirs.delete(dir)
        }
      }
    },
    /** For an interrupted run: remove what is still lying around, without waiting. */
    dispose() {
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // best effort: the folder lives in the system's temp folder
        }
      }
    }
  }
}
