import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReleaseError } from '../../scripts/release/common.mjs'
import { createGh, createGit, exec, runCheck } from '../../scripts/release/system.mjs'

interface Call {
  command: string
  args: string[]
  env?: Record<string, string>
}
type Reply = { code: number | null; stdout?: string; stderr?: string }

/** A stand-in for `exec` that answers from a queue and remembers how it was called. */
const script = (...replies: Reply[]) => {
  const calls: Call[] = []
  const run = async (
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string> } = {}
  ) => {
    calls.push({ command, args, env: options.env })
    const reply = replies.shift() ?? { code: 0 }
    return { code: reply.code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { run, calls }
}

describe('running programs', () => {
  const node = process.execPath

  it('captures output and the exit code, and never throws', async () => {
    const result = await exec(node, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'
    ])
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' })
  })

  it('hands the program its input', async () => {
    const result = await exec(node, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'hello'
    })
    expect(result.stdout).toBe('hello')
  })

  it('reports a program that cannot start with a null exit code', async () => {
    const result = await exec('codegent-no-such-program-anywhere')
    expect(result.code).toBeNull()
    expect(result.stderr).toMatch(/ENOENT|not found/i)
  })

  it('adds the environment it was given', async () => {
    const result = await exec(
      node,
      ['-e', 'process.stdout.write(process.env.CODEGENT_TEST ?? "")'],
      {
        env: { CODEGENT_TEST: 'yes' }
      }
    )
    expect(result.stdout).toBe('yes')
  })

  it('does not pass on npm’s own dry-run setting, which would turn every npm command into one', async () => {
    const saved = process.env.npm_config_dry_run
    process.env.npm_config_dry_run = 'true'
    try {
      const result = await exec(node, [
        '-e',
        'process.stdout.write(process.env.npm_config_dry_run ?? "unset")'
      ])
      expect(result.stdout).toBe('unset')
    } finally {
      if (saved === undefined) delete process.env.npm_config_dry_run
      else process.env.npm_config_dry_run = saved
    }
  })
})

describe('git', () => {
  it('returns what git printed, without the trailing newline', async () => {
    const { run, calls } = script({ code: 0, stdout: 'abc123\n' })
    const git = createGit('/repo', run)
    expect(await git(['rev-parse', 'HEAD'])).toBe('abc123')
    expect(calls[0]).toMatchObject({ command: 'git', args: ['rev-parse', 'HEAD'] })
  })

  it('keeps the leading space of the first line, which porcelain output needs', async () => {
    const { run } = script({ code: 0, stdout: ' M README.md\n?? new.txt\n' })
    expect(await createGit('/repo', run)(['status', '--porcelain'])).toBe(
      ' M README.md\n?? new.txt'
    )
  })

  it('never lets git ask a question nobody could answer', async () => {
    const { run, calls } = script({ code: 0 })
    await createGit('/repo', run)(['fetch'])
    expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' })
  })

  it('turns a failure into a ReleaseError that says what failed and why', async () => {
    const { run } = script({ code: 128, stderr: 'fatal: not a git repository\n' })
    const failure = createGit('/repo', run)(['status'])
    await expect(failure).rejects.toBeInstanceOf(ReleaseError)
    await expect(failure).rejects.toThrow(
      /git status failed:\nfatal: not a git repository/
    )
  })

  it('says so when git itself is missing', async () => {
    const { run } = script({ code: null, stderr: 'spawn git ENOENT' })
    await expect(createGit('/repo', run)(['status'])).rejects.toThrow(/spawn git ENOENT/)
  })
})

describe('the GitHub CLI', () => {
  const REPO = 'someone/codegent'

  it('is ready when it is installed and signed in', async () => {
    const { run, calls } = script({ code: 0 }, { code: 0 })
    expect(await createGh(REPO, run).status()).toBe('ready')
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['api', 'user', '--jq', '.login']
    ])
  })

  it('is missing when it cannot be started, and signed out when auth fails', async () => {
    expect(await createGh(REPO, script({ code: null }).run).status()).toBe('missing')
    expect(await createGh(REPO, script({ code: 0 }, { code: 1 }).run).status()).toBe(
      'signed-out'
    )
  })

  it('never prompts and never checks for updates', async () => {
    const { run, calls } = script({ code: 0 })
    await createGh(REPO, run).status()
    expect(calls[0]!.env).toMatchObject({
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1'
    })
  })

  it('knows whether a release exists, and raises on any other failure', async () => {
    const found = script({ code: 0, stdout: '{"tagName":"v1.0.0"}' })
    expect(await createGh(REPO, found.run).releaseExists('v1.0.0')).toBe(true)
    expect(found.calls[0]!.args).toEqual([
      'release',
      'view',
      'v1.0.0',
      '--repo',
      REPO,
      '--json',
      'tagName'
    ])
    const absent = script({ code: 1, stderr: 'release not found' })
    expect(await createGh(REPO, absent.run).releaseExists('v1.0.0')).toBe(false)
    const broken = script({ code: 1, stderr: 'HTTP 502: bad gateway' })
    await expect(createGh(REPO, broken.run).releaseExists('v1.0.0')).rejects.toThrow(
      /502/
    )
  })

  it('creates a draft, with the files, the notes and the exact commit', async () => {
    const { run, calls } = script({
      code: 0,
      stdout: 'https://github.com/someone/codegent/releases/tag/untagged-1\n'
    })
    const url = await createGh(REPO, run).createDraft({
      tag: 'v1.0.0',
      title: 'CodeGent 1.0.0',
      notesFile: '/out/notes.md',
      files: ['/out/a.vsix', '/out/b.zip'],
      target: 'abc123'
    })
    expect(url).toContain('releases/tag/')
    expect(calls[0]!.args).toEqual([
      'release',
      'create',
      'v1.0.0',
      '/out/a.vsix',
      '/out/b.zip',
      '--repo',
      REPO,
      '--title',
      'CodeGent 1.0.0',
      '--notes-file',
      '/out/notes.md',
      '--target',
      'abc123',
      '--draft'
    ])
  })

  it('reads a release, keeping only what the script compares', async () => {
    const json = JSON.stringify({
      url: 'https://github.com/someone/codegent/releases/tag/v1.0.0',
      isDraft: true,
      isPrerelease: false,
      tagName: 'ignored',
      assets: [
        {
          name: 'a.vsix',
          size: 10,
          state: 'uploaded',
          digest: 'sha256:aa',
          id: 1,
          url: 'x'
        }
      ]
    })
    const { run, calls } = script({ code: 0, stdout: json })
    expect(await createGh(REPO, run).view('v1.0.0')).toEqual({
      url: 'https://github.com/someone/codegent/releases/tag/v1.0.0',
      isDraft: true,
      isPrerelease: false,
      assets: [{ name: 'a.vsix', size: 10, state: 'uploaded', digest: 'sha256:aa' }]
    })
    expect(calls[0]!.args).toEqual([
      'release',
      'view',
      'v1.0.0',
      '--repo',
      REPO,
      '--json',
      'url,isDraft,isPrerelease,assets'
    ])
  })

  it('publishes a draft as the latest release, or as a pre-release', async () => {
    const latest = script({ code: 0 })
    await createGh(REPO, latest.run).publish('v1.0.0', { prerelease: false })
    expect(latest.calls[0]!.args).toEqual([
      'release',
      'edit',
      'v1.0.0',
      '--repo',
      REPO,
      '--draft=false',
      '--latest'
    ])
    const pre = script({ code: 0 })
    await createGh(REPO, pre.run).publish('v1.0.0', { prerelease: true })
    expect(pre.calls[0]!.args).toEqual([
      'release',
      'edit',
      'v1.0.0',
      '--repo',
      REPO,
      '--draft=false',
      '--prerelease'
    ])
  })

  it('asks GitHub which release is the latest, and gets nothing when there is none', async () => {
    const some = script({ code: 0, stdout: 'v1.0.0\n' })
    expect(await createGh(REPO, some.run).latestTag()).toBe('v1.0.0')
    expect(some.calls[0]!.args).toEqual([
      'api',
      `repos/${REPO}/releases/latest`,
      '--jq',
      '.tag_name'
    ])
    expect(
      await createGh(REPO, script({ code: 1, stderr: 'HTTP 404' }).run).latestTag()
    ).toBe('')
  })

  it('downloads exactly the files it names', async () => {
    const { run, calls } = script({ code: 0 })
    await createGh(REPO, run).download('v1.0.0', '/tmp/d', ['a.vsix', 'b.zip'])
    expect(calls[0]!.args).toEqual([
      'release',
      'download',
      'v1.0.0',
      '--repo',
      REPO,
      '--dir',
      '/tmp/d',
      '--pattern',
      'a.vsix',
      '--pattern',
      'b.zip'
    ])
  })

  it('deletes a draft without touching tags', async () => {
    const { run, calls } = script({ code: 0 })
    await createGh(REPO, run).deleteDraft('v1.0.0')
    expect(calls[0]!.args).toEqual([
      'release',
      'delete',
      'v1.0.0',
      '--repo',
      REPO,
      '--yes'
    ])
  })

  it('says which gh command failed and what it printed', async () => {
    const { run } = script({ code: 1, stderr: 'HTTP 403: Resource not accessible\nmore' })
    await expect(
      createGh(REPO, run).publish('v1.0.0', { prerelease: false })
    ).rejects.toThrow(
      /gh release edit v1\.0\.0 failed:\nHTTP 403: Resource not accessible/
    )
  })
})

describe('running a check with npm', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegent-check-test-'))
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        version: '1.0.0',
        scripts: {
          fine: 'node -e "console.log(\'all good\')"',
          broken:
            "node -e \"console.log('first'); console.error('it broke'); process.exit(2)\"",
          env: 'node -e "console.log(\'flag=\' + process.env.CODEGENT_FLAG)"'
        }
      })
    )
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes everything the check printed to its log, and says it went well', async () => {
    const logFile = path.join(dir, 'fine.log')
    const result = await runCheck({ args: ['run', 'fine'], cwd: dir, logFile })
    expect(result.ok).toBe(true)
    expect(result.tail).toBe('')
    expect(result.seconds).toBeGreaterThan(0)
    expect(fs.readFileSync(logFile, 'utf8')).toContain('all good')
  }, 60_000)

  it('keeps the end of the output for a check that failed', async () => {
    const logFile = path.join(dir, 'broken.log')
    const result = await runCheck({ args: ['run', 'broken'], cwd: dir, logFile })
    expect(result.ok).toBe(false)
    expect(result.tail).toContain('it broke')
    expect(fs.readFileSync(logFile, 'utf8')).toContain('first')
  }, 60_000)

  it('runs the check with the environment it was given', async () => {
    const logFile = path.join(dir, 'env.log')
    const result = await runCheck({
      args: ['run', 'env'],
      cwd: dir,
      env: { CODEGENT_FLAG: '1' },
      logFile
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(logFile, 'utf8')).toContain('flag=1')
  }, 60_000)
})
