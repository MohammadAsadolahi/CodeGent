import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRelease } from '../../scripts/release.mjs'
import { sha256 } from '../../scripts/release/assets.mjs'
import { ReleaseError } from '../../scripts/release/common.mjs'
import { createSystem } from '../../scripts/release/system.mjs'
import {
  browserManifest,
  CHANGELOG,
  createProject,
  DOCS,
  makeVsix,
  type Project
} from '../support/release-fixture'

// The release script against real git (a working repository and a bare "origin" in a temp folder)
// with GitHub and the npm checks played by fakes. What is pushed, committed, tagged and left behind
// is the real thing; only the outside world is pretend.

interface Release {
  draft: boolean
  prerelease: boolean
  target: string
  title: string
  notes: string
  assets: Map<string, Buffer>
}

/** Just enough of GitHub: drafts that need a pushed commit, publishing that creates the tag. */
class FakeGitHub {
  state: 'ready' | 'missing' | 'signed-out' = 'ready'
  releases = new Map<string, Release>()
  latest = ''
  calls: string[] = []
  repos: string[] = []
  /** The upload fails after the draft exists, as an interrupted upload would. */
  failUpload = false
  /** What GitHub serves differs from what was uploaded. */
  corruptDownload = false
  /** GitHub names another release the latest. */
  latestIs: string | null = null

  constructor(private readonly origin: (args: string[]) => string) {}

  async status() {
    return this.state
  }

  async releaseExists(tag: string) {
    return this.releases.has(tag)
  }

  async createDraft(input: {
    tag: string
    title: string
    notesFile: string
    files: string[]
    target: string
  }) {
    this.calls.push(`createDraft ${input.tag}`)
    // GitHub refuses a target commit it has never been sent.
    this.origin(['cat-file', '-e', `${input.target}^{commit}`])
    this.releases.set(input.tag, {
      draft: true,
      prerelease: false,
      target: input.target,
      title: input.title,
      notes: fs.readFileSync(input.notesFile, 'utf8'),
      assets: new Map(
        input.files.map((file) => [path.basename(file), fs.readFileSync(file)])
      )
    })
    if (this.failUpload)
      throw new ReleaseError('gh release create failed: upload interrupted')
    return `https://github.com/example/codegent/releases/tag/untagged-${input.tag}`
  }

  private release(tag: string): Release {
    const release = this.releases.get(tag)
    if (!release) throw new ReleaseError(`gh: release ${tag} not found`)
    return release
  }

  async view(tag: string) {
    const release = this.release(tag)
    return {
      url: `https://github.com/example/codegent/releases/tag/${tag}`,
      isDraft: release.draft,
      isPrerelease: release.prerelease,
      assets: [...release.assets].map(([name, data]) => ({
        name,
        size: data.length,
        state: 'uploaded',
        digest: `sha256:${sha256(data)}`
      }))
    }
  }

  async publish(tag: string, options: { prerelease: boolean }) {
    this.calls.push(`publish ${tag}`)
    const release = this.release(tag)
    release.draft = false
    release.prerelease = options.prerelease
    this.origin(['tag', tag, release.target]) // GitHub creates the tag when a draft is published
    if (!options.prerelease) this.latest = this.latestIs ?? tag
  }

  async latestTag() {
    return this.latest
  }

  async download(tag: string, dir: string, names: string[]) {
    for (const name of names) {
      const data = this.release(tag).assets.get(name)!
      fs.writeFileSync(
        path.join(dir, name),
        this.corruptDownload ? Buffer.concat([data, Buffer.from('!')]) : data
      )
    }
  }

  async deleteDraft(tag: string) {
    this.calls.push(`deleteDraft ${tag}`)
    this.releases.delete(tag)
  }
}

const projects: Project[] = []
const newProject = (options?: Parameters<typeof createProject>[0]): Project => {
  const project = createProject(options)
  projects.push(project)
  return project
}
afterEach(() => {
  for (const project of projects.splice(0)) project.remove()
})

const CHECK_IDS = [
  'install',
  'format',
  'build',
  'typecheck',
  'unit',
  'e2e',
  'integration',
  'package',
  'package-test'
]

/** What `npm run package` leaves behind in the copy, made from the copy's own files. */
const writePackage = async (cwd: string) => {
  const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8')
  const { version } = JSON.parse(read('apps/vscode/package.json')) as { version: string }
  const manifest = JSON.parse(read('apps/browser/static/manifest.json')) as object
  const vsix = await makeVsix({
    version,
    changelog: read('CHANGELOG.md'),
    browser: { 'manifest.json': JSON.stringify({ ...manifest, version }, null, 2) + '\n' }
  })
  fs.writeFileSync(path.join(cwd, 'apps', 'vscode', `codegent-${version}.vsix`), vsix)
}

interface HarnessOptions {
  github?: FakeGitHub
  /** The answer to "push and publish?" */
  answer?: boolean
  /** The id of a check that fails. */
  failCheck?: string
  /** Runs when a check starts: the world changing under the release. */
  onCheck?: (id: string, cwd: string) => void
}

const harness = (project: Project, options: HarnessOptions = {}) => {
  const real = createSystem(project.dir)
  const github = options.github ?? new FakeGitHub(project.originGit)
  const lines: string[] = []
  const warnings: string[] = []
  const checks: {
    id: string
    args: string[]
    env?: Record<string, string>
    cwd: string
  }[] = []
  const tempDirs: string[] = []
  const system = {
    ...real,
    gh: (repo: string) => {
      github.repos.push(repo)
      return github
    },
    tempDir: (prefix: string) => {
      const dir = real.tempDir(prefix)
      tempDirs.push(dir.path)
      return dir
    },
    sleep: async () => {},
    confirm: async () => options.answer ?? true,
    log: {
      info: (text = '') => void lines.push(text),
      warn: (text: string) => void warnings.push(text)
    },
    runCheck: async (input: {
      args: string[]
      env?: Record<string, string>
      cwd: string
      logFile: string
    }) => {
      const id = /^\d+-(.+)\.log$/.exec(path.basename(input.logFile))![1]!
      checks.push({ id, args: input.args, env: input.env, cwd: input.cwd })
      options.onCheck?.(id, input.cwd)
      if (options.failCheck === id) {
        fs.writeFileSync(input.logFile, `compiling\nFAILED ${id}\n`)
        return { ok: false, seconds: 0, tail: `compiling\nFAILED ${id}` }
      }
      fs.writeFileSync(input.logFile, `${id} output\n`)
      if (id === 'package') await writePackage(input.cwd)
      return { ok: true, seconds: 1, tail: '' }
    }
  }
  return { system, github, lines, warnings, checks, tempDirs }
}

const out = (project: Project, tag = 'v0.1.1') => path.join(project.dir, 'release', tag)

describe('a dry run', () => {
  it('checks everything in a clean copy and leaves the repository exactly as it was', async () => {
    const project = newProject()
    const head = project.git(['rev-parse', 'HEAD'])
    const { system, github, lines, checks, tempDirs } = harness(project)

    const result = await runRelease({ request: 'patch', dryRun: true }, system)

    expect(result).toMatchObject({ version: '0.1.1', tag: 'v0.1.1', url: null })
    expect(checks.map((check) => check.id)).toEqual(CHECK_IDS)
    for (const check of checks) {
      expect(check.cwd, check.id).not.toBe(project.dir)
      expect(path.basename(check.cwd)).toMatch(/^codegent-release-/)
    }
    expect(checks.map((check) => check.args)).toEqual([
      ['ci'],
      ['run', 'format:check'],
      ['run', 'build'],
      ['run', 'typecheck'],
      ['test'],
      ['run', 'test:e2e'],
      ['run', 'test:integration'],
      ['run', 'package'],
      ['run', 'test:package']
    ])
    // the suites that exercise the real thing run against the minified build that ships
    expect(
      checks.filter((check) => check.env).map((check) => [check.id, check.env])
    ).toEqual([
      ['e2e', { CODEGENT_MINIFY: '1' }],
      ['integration', { CODEGENT_MINIFY: '1' }]
    ])

    expect(project.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(project.git(['status', '--porcelain'])).toBe('')
    expect(project.read('package.json')).toContain('"version": "0.1.0"')
    expect(project.read('CHANGELOG.md')).toContain('## Unreleased\n\n- Reading')
    expect(project.originGit(['rev-parse', 'main'])).toBe(head)
    expect(project.originGit(['tag', '--list'])).toBe('v0.1.0')
    expect(github.calls).toEqual([])
    for (const dir of tempDirs) expect(fs.existsSync(dir), dir).toBe(false)
    expect(lines.join('\n')).toContain(
      'Dry run: nothing was committed, pushed or published'
    )
    expect(lines.join('\n')).toContain('npm run release -- 0.1.1')
  })

  it('leaves the release files, the notes and a log per check', async () => {
    const project = newProject()
    const { system, lines } = harness(project)
    const result = await runRelease({ request: 'patch', dryRun: true }, system)

    expect(fs.readdirSync(out(project)).sort()).toEqual([
      'RELEASE_NOTES.md',
      'codegent-0.1.1.vsix',
      'codegent-bridge-browser-extension-0.1.1.zip',
      'logs'
    ])
    expect(fs.readdirSync(path.join(out(project), 'logs')).sort()).toEqual(
      CHECK_IDS.map((id, index) => `${String(index + 1).padStart(2, '0')}-${id}.log`)
    )
    const notes = fs.readFileSync(path.join(out(project), 'RELEASE_NOTES.md'), 'utf8')
    expect(notes).toContain('## What changed in 0.1.1')
    expect(notes).toContain('- Reading the reply is more robust.')
    expect(notes).toContain('https://github.com/example/codegent/compare/v0.1.0...v0.1.1')
    for (const file of result.files) {
      expect(sha256(fs.readFileSync(file.path))).toBe(file.sha256)
      expect(lines.join('\n')).toContain(file.sha256)
    }
    // the copy was made at the new version, so that is what the files carry
    const vsix = fs.readFileSync(path.join(out(project), 'codegent-0.1.1.vsix'))
    expect(vsix.length).toBeGreaterThan(0)
  })

  it('says what a real release would have stopped at when gh is not ready, and goes on', async () => {
    const project = newProject()
    const { system, github, warnings } = harness(project)
    github.state = 'missing'
    await runRelease({ request: 'patch', dryRun: true }, system)
    expect(warnings.join('\n')).toMatch(/GitHub CLI is not ready \(install it/)
  })

  it('replaces the files of an earlier dry run instead of mixing with them', async () => {
    const project = newProject()
    fs.mkdirSync(out(project), { recursive: true })
    fs.writeFileSync(path.join(out(project), 'stale.txt'), 'old')
    await runRelease({ request: 'patch', dryRun: true }, harness(project).system)
    expect(fs.existsSync(path.join(out(project), 'stale.txt'))).toBe(false)
  })
})

describe('a release', () => {
  it('commits the new version, pushes it, publishes the files and checks what GitHub serves', async () => {
    const project = newProject()
    const base = project.git(['rev-parse', 'HEAD'])
    const { system, github, lines, tempDirs } = harness(project)

    const result = await runRelease({ request: 'patch', yes: true }, system)

    expect(result.url).toBe('https://github.com/example/codegent/releases/tag/v0.1.1')
    expect(github.repos).toEqual(['example/codegent'])
    // the repository: one new commit on top, pushed, tagged by GitHub at that commit
    expect(project.git(['rev-list', '--count', `${base}..HEAD`])).toBe('1')
    expect(project.git(['log', '-1', '--format=%s'])).toBe('chore: release v0.1.1')
    const head = project.git(['rev-parse', 'HEAD'])
    expect(project.originGit(['rev-parse', 'main'])).toBe(head)
    expect(project.originGit(['rev-parse', 'v0.1.1^{commit}'])).toBe(head)
    expect(project.git(['rev-parse', 'v0.1.1^{commit}'])).toBe(head) // fetched back
    expect(project.git(['status', '--porcelain'])).toBe('')
    expect(
      project.git(['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()
    ).toEqual([
      'CHANGELOG.md',
      'CITATION.cff',
      'README.md',
      'apps/browser/package.json',
      'apps/vscode/package.json',
      'package-lock.json',
      'package.json',
      'packages/engine/package.json',
      'packages/hub/package.json',
      'packages/protocol/package.json'
    ])
    expect(project.read('package.json')).toContain('"version": "0.1.1"')
    expect(project.read('CHANGELOG.md')).toContain(
      '## Unreleased\n\n## 0.1.1\n\n- Reading'
    )

    // GitHub: a published (no longer a draft) release, the latest, with the checked files
    const release = github.releases.get('v0.1.1')!
    expect(release).toMatchObject({
      draft: false,
      prerelease: false,
      title: 'CodeGent 0.1.1',
      target: head
    })
    expect(github.latest).toBe('v0.1.1')
    expect(github.calls).toEqual(['createDraft v0.1.1', 'publish v0.1.1'])
    expect([...release.assets.keys()].sort()).toEqual([
      'codegent-0.1.1.vsix',
      'codegent-bridge-browser-extension-0.1.1.zip'
    ])
    for (const [name, data] of release.assets) {
      expect(data.equals(fs.readFileSync(path.join(out(project), name)))).toBe(true)
    }
    expect(release.notes).toContain('## What changed in 0.1.1')
    for (const dir of tempDirs) expect(fs.existsSync(dir), dir).toBe(false)
    expect(lines.join('\n')).toContain('Published v0.1.1')
  })

  it('commits exactly what was checked in the copy', async () => {
    const project = newProject()
    let verifiedTree = ''
    const { system } = harness(project, {
      onCheck: (id, cwd) => {
        if (id === 'unit') verifiedTree = project.git(['rev-parse', 'HEAD^{tree}'], cwd)
      }
    })
    await runRelease({ request: 'patch', yes: true }, system)
    expect(verifiedTree).toMatch(/^[0-9a-f]{40}$/)
    expect(project.git(['rev-parse', 'HEAD^{tree}'])).toBe(verifiedTree)
  })

  it('can publish as a pre-release, which GitHub never shows as the latest', async () => {
    const project = newProject()
    const { system, github } = harness(project)
    await runRelease({ request: 'patch', yes: true, prerelease: true }, system)
    expect(github.releases.get('v0.1.1')).toMatchObject({
      draft: false,
      prerelease: true
    })
    expect(github.latest).toBe('')
  })

  it('takes a minor version bump as far as the ranges workspaces use for each other', async () => {
    const project = newProject()
    const { system } = harness(project)
    await runRelease({ request: 'minor', yes: true }, system)
    expect(project.git(['log', '-1', '--format=%s'])).toBe('chore: release v0.2.0')
    expect(project.read('apps/browser/package.json')).toContain(
      '"@codegent/hub": "^0.2.0"'
    )
    expect(
      JSON.parse(project.read('package-lock.json')).packages['apps/browser']
        .devDependencies['@codegent/hub']
    ).toBe('^0.2.0')
  })

  it('pushes the commits that were not pushed yet along with the release', async () => {
    const project = newProject()
    project.write('docs/notes.md', 'not pushed yet\n')
    project.commit('local work')
    const { system, lines } = harness(project)
    await runRelease({ request: 'patch', yes: true }, system)
    expect(project.originGit(['rev-parse', 'main'])).toBe(
      project.git(['rev-parse', 'HEAD'])
    )
    expect(
      project.originGit(['log', '--format=%s', 'main']).split('\n').slice(0, 2)
    ).toEqual(['chore: release v0.1.1', 'local work'])
    expect(lines.join('\n')).toMatch(/1 earlier commit\(s\) go to origin with it/)
  })

  it('releases a version someone already put in the files, without making a commit of its own', async () => {
    const project = newProject({
      version: '0.1.1',
      files: {
        'CHANGELOG.md':
          '# Changelog\n\n## Unreleased\n\n## 0.1.1\n\n- Prepared by hand.\n\n## 0.1.0\n\nFirst version.\n'
      }
    })
    const head = project.git(['rev-parse', 'HEAD'])
    const { system, github } = harness(project)
    await runRelease({ request: '0.1.1', yes: true }, system)
    expect(project.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(project.originGit(['rev-parse', 'v0.1.1^{commit}'])).toBe(head)
    expect(github.releases.get('v0.1.1')!.notes).toContain('- Prepared by hand.')
    expect(github.latest).toBe('v0.1.1')
  })

  it('asks before it pushes anything, and stops cleanly when the answer is no', async () => {
    const project = newProject()
    const head = project.git(['rev-parse', 'HEAD'])
    const { system, github, tempDirs } = harness(project, { answer: false })
    await expect(runRelease({ request: 'patch' }, system)).rejects.toThrow(
      /stopped before pushing anything/
    )
    expect(project.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(project.git(['status', '--porcelain'])).toBe('')
    expect(project.originGit(['rev-parse', 'main'])).toBe(head)
    expect(project.read('package.json')).toContain('"version": "0.1.0"')
    expect(github.calls).toEqual([])
    for (const dir of tempDirs) expect(fs.existsSync(dir)).toBe(false)
  })
})

describe('a check that fails', () => {
  it('stops the release there, shows the end of its output and changes nothing', async () => {
    const project = newProject()
    const head = project.git(['rev-parse', 'HEAD'])
    const { system, github, checks, lines, tempDirs } = harness(project, {
      failCheck: 'unit'
    })

    const failure = runRelease({ request: 'patch', yes: true }, system)
    await expect(failure).rejects.toThrow(
      /"Unit tests" failed\. Everything it printed: .*05-unit\.log/
    )

    expect(checks.map((check) => check.id)).toEqual([
      'install',
      'format',
      'build',
      'typecheck',
      'unit'
    ])
    expect(lines.join('\n')).toContain('FAILED unit')
    expect(project.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(project.git(['status', '--porcelain'])).toBe('')
    expect(project.originGit(['rev-parse', 'main'])).toBe(head)
    expect(github.calls).toEqual([])
    for (const dir of tempDirs) expect(fs.existsSync(dir), dir).toBe(false)
    expect(fs.existsSync(path.join(out(project), 'logs', '05-unit.log'))).toBe(true)
  })
})

describe('refusing to start', () => {
  interface Case {
    name: string
    message: RegExp
    request?: string
    options?: { dryRun?: boolean }
    project?: Parameters<typeof createProject>[0]
    arrange?: (project: Project, github: FakeGitHub) => void
  }
  const cases: Case[] = [
    {
      name: 'uncommitted changes',
      message: /working tree is not clean:\n {2} ?M README\.md/,
      arrange: (project) => project.write('README.md', 'edited\n')
    },
    {
      name: 'a file git does not know',
      message: /working tree is not clean:\n {2}\?\? notes\.txt/,
      arrange: (project) => project.write('notes.txt', 'new\n')
    },
    {
      name: 'a branch other than main',
      message: /releases are made from main, but this is feature/,
      arrange: (project) => void project.git(['checkout', '--quiet', '-b', 'feature'])
    },
    {
      name: 'a main that is behind origin',
      message: /main is 1 commit\(s\) behind origin\/main; pull first/,
      arrange: (project) => project.pushFromElsewhere('elsewhere.txt', 'x\n')
    },
    {
      name: 'a tag that exists here',
      message: /the tag v0\.1\.1 already exists/,
      arrange: (project) => void project.git(['tag', 'v0.1.1'])
    },
    {
      name: 'a tag that exists on origin',
      message: /the tag v0\.1\.1 already exists on origin/,
      arrange: (project) => void project.originGit(['tag', 'v0.1.1', 'main'])
    },
    {
      name: 'a GitHub release for the tag already (a leftover draft, say)',
      message: /GitHub already has a release for v0\.1\.1/,
      arrange: (project, github) =>
        void github.releases.set('v0.1.1', {
          draft: true,
          prerelease: false,
          target: '',
          title: '',
          notes: '',
          assets: new Map()
        })
    },
    {
      name: 'a GitHub CLI that is not installed',
      message:
        /publishing goes through the GitHub CLI \(gh\); install it \(Windows: winget install --id GitHub\.cli\)/,
      arrange: (_, github) => void (github.state = 'missing')
    },
    {
      name: 'a GitHub CLI that is not signed in',
      message:
        /publishing goes through the GitHub CLI \(gh\); sign in with: gh auth login/,
      arrange: (_, github) => void (github.state = 'signed-out')
    },
    {
      name: 'a request that is not a version',
      message: /neither patch, minor, major nor a version/,
      request: 'banana'
    },
    {
      name: 'a version older than the current one',
      message: /0\.0\.5 is older than the current version 0\.1\.0/,
      request: '0.0.5'
    },
    {
      name: 'a CHANGELOG with nothing under Unreleased',
      message: /"Unreleased" section of CHANGELOG\.md is empty/,
      project: {
        files: {
          'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 0.1.0\n\nFirst version.\n'
        }
      }
    },
    {
      name: 'package.json files that disagree about the version',
      message: /do not agree on the version/,
      project: {
        files: {
          'packages/hub/package.json':
            '{\n  "name": "@codegent/hub",\n  "version": "0.0.3"\n}\n'
        }
      }
    }
  ]

  for (const spec of cases) {
    it(`${spec.name}, before any check runs`, async () => {
      const project = newProject(spec.project)
      const github = new FakeGitHub(project.originGit)
      const { system, checks, tempDirs } = harness(project, { github })
      spec.arrange?.(project, github)
      const originHead = project.originGit(['rev-parse', 'main'])

      await expect(
        runRelease(
          { request: spec.request ?? 'patch', yes: true, ...spec.options },
          system
        )
      ).rejects.toThrow(spec.message)

      expect(checks).toEqual([])
      expect(github.calls).toEqual([])
      expect(project.originGit(['rev-parse', 'main'])).toBe(originHead)
      for (const dir of tempDirs) expect(fs.existsSync(dir), dir).toBe(false)
    })
  }
})

describe('the world changing while the checks run', () => {
  it('stops before pushing when a commit arrives in the repository', async () => {
    const project = newProject()
    const originHead = project.originGit(['rev-parse', 'main'])
    const { system, github } = harness(project, {
      onCheck: (id) => {
        if (id === 'unit') {
          project.write('late.txt', 'x\n')
          project.commit('late work')
        }
      }
    })
    await expect(runRelease({ request: 'patch', yes: true }, system)).rejects.toThrow(
      /new commits arrived while the checks ran/
    )
    expect(project.originGit(['rev-parse', 'main'])).toBe(originHead)
    expect(github.calls).toEqual([])
  })

  it('stops before pushing when a file in the repository is edited', async () => {
    const project = newProject()
    const { system, github } = harness(project, {
      onCheck: (id) => {
        if (id === 'unit') project.write('README.md', 'edited meanwhile\n')
      }
    })
    await expect(runRelease({ request: 'patch', yes: true }, system)).rejects.toThrow(
      /working tree changed while the checks ran/
    )
    expect(project.read('README.md')).toBe('edited meanwhile\n') // the edit is left alone
    expect(github.calls).toEqual([])
  })
})

describe('what the files must be before they go out', () => {
  it('refuses a browser extension that asks for a permission nobody documented', async () => {
    const project = newProject()
    const wider = browserManifest()
    wider.permissions.push('tabs')
    project.write(
      'apps/browser/static/manifest.json',
      JSON.stringify(wider, null, 2) + '\n'
    )
    project.commit('ask for tabs')
    const { system, github } = harness(project)
    await expect(runRelease({ request: 'patch', yes: true }, system)).rejects.toThrow(
      /newly asks for permission tabs; document why in docs\/safety-and-privacy\.md first/
    )
    expect(github.calls).toEqual([])
  })

  it('accepts it once the safety document explains it', async () => {
    const project = newProject()
    const wider = browserManifest()
    wider.permissions.push('tabs')
    project.write(
      'apps/browser/static/manifest.json',
      JSON.stringify(wider, null, 2) + '\n'
    )
    project.write(
      'docs/safety-and-privacy.md',
      `${DOCS}\nThe tabs permission lets it find the ChatGPT tab.\n`
    )
    project.commit('ask for tabs, documented')
    const { system } = harness(project)
    await expect(
      runRelease({ request: 'patch', dryRun: true }, system)
    ).resolves.toBeDefined()
  })

  it('refuses a README that still names the files of another version', async () => {
    const project = newProject()
    project.write(
      'README.md',
      `${project.read('README.md')}\nOld link: codegent-0.0.9.vsix\n`
    )
    project.commit('old link')
    const { system } = harness(project)
    await expect(runRelease({ request: 'patch', dryRun: true }, system)).rejects.toThrow(
      /README\.md names files of another version: codegent-0\.0\.9\.vsix/
    )
  })

  it('refuses to go on when the package step left no .vsix', async () => {
    const project = newProject()
    const { system } = harness(project)
    const runCheck = system.runCheck
    system.runCheck = async (input) => {
      const result = await runCheck(input)
      for (const file of fs.readdirSync(path.join(input.cwd, 'apps', 'vscode'))) {
        if (file.endsWith('.vsix'))
          fs.rmSync(path.join(input.cwd, 'apps', 'vscode', file))
      }
      return result
    }
    await expect(runRelease({ request: 'patch', dryRun: true }, system)).rejects.toThrow(
      /the package step did not leave codegent-0\.1\.1\.vsix in apps\/vscode/
    )
  })

  it('refuses a package whose CHANGELOG was copied before the version was moved', async () => {
    const project = newProject()
    const { system } = harness(project)
    const runCheck = system.runCheck
    system.runCheck = async (input) => {
      const result = await runCheck(input)
      if (input.args.join(' ') === 'run package') {
        const vsix = await makeVsix({ version: '0.1.1', changelog: CHANGELOG })
        fs.writeFileSync(
          path.join(input.cwd, 'apps', 'vscode', 'codegent-0.1.1.vsix'),
          vsix
        )
      }
      return result
    }
    await expect(runRelease({ request: 'patch', dryRun: true }, system)).rejects.toThrow(
      /CHANGELOG inside the \.vsix has no entries for 0\.1\.1/
    )
  })
})

describe('when GitHub goes wrong', () => {
  it('removes the draft it created if the upload fails, and says the push already happened', async () => {
    const project = newProject()
    const github = new FakeGitHub(project.originGit)
    github.failUpload = true
    const { system, lines } = harness(project, { github })

    await expect(runRelease({ request: 'patch', yes: true }, system)).rejects.toThrow(
      /upload interrupted/
    )

    expect(github.releases.size).toBe(0)
    expect(github.calls).toEqual(['createDraft v0.1.1', 'deleteDraft v0.1.1'])
    expect(project.originGit(['log', '-1', '--format=%s', 'main'])).toBe(
      'chore: release v0.1.1'
    )
    expect(project.originGit(['tag', '--list'])).toBe('v0.1.0') // nothing was published, no tag
    expect(lines.join('\n')).toMatch(
      /main was already pushed .*only the GitHub release is missing/
    )
  })

  it('reports a published release whose downloads differ from the checked files', async () => {
    const project = newProject()
    const github = new FakeGitHub(project.originGit)
    github.corruptDownload = true
    const { system } = harness(project, { github })
    const failure = runRelease({ request: 'patch', yes: true }, system)
    await expect(failure).rejects.toThrow(
      /v0\.1\.1 IS published, but it does not look right/
    )
    await expect(failure).rejects.toThrow(/downloaded codegent-0\.1\.1\.vsix differs/)
    expect(github.releases.get('v0.1.1')!.draft).toBe(false) // never silently taken back
  })

  it('reports it when GitHub names another release the latest', async () => {
    const project = newProject()
    const github = new FakeGitHub(project.originGit)
    github.latestIs = 'v9.9.9'
    const { system } = harness(project, { github })
    await expect(runRelease({ request: 'patch', yes: true }, system)).rejects.toThrow(
      /GitHub's latest release is v9\.9\.9, not v0\.1\.1/
    )
  })
})
