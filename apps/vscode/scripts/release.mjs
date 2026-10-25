// Makes a CodeGent release: checks everything in a clean copy of the repository, builds the files
// people download and publishes them as the latest GitHub release. See "Releasing" in
// docs/development.md.
//
//   npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--yes] [--prerelease]
//
// Nothing in the working tree is touched until every check has passed in the copy; a dry run never
// touches it. Publishing goes through the GitHub CLI (`gh`, signed in), so no token passes through
// this script.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  browserExtensionZip,
  defaultHubPorts,
  sha256,
  verifyRelease
} from './release/assets.mjs'
import { releaseNotes, sectionFor } from './release/changelog.mjs'
import { formatSize, parseRepo, ReleaseError } from './release/common.mjs'
import { createSystem } from './release/system.mjs'
import {
  compareVersions,
  currentVersion,
  isVersion,
  planVersion,
  resolveVersion,
  restorePlan,
  staleDownloadNames,
  writePlan
} from './release/version.mjs'

const REMOTE = 'origin'
const BRANCH = 'main'
const BROWSER_MANIFEST = 'apps/browser/static/manifest.json'

// What CI runs, then the heavy suites against the minified build that ships. The integration
// tests rebuild apps/vscode/out with test ports of their own, so packaging comes after them.
const CHECKS = [
  { id: 'install', title: 'Install dependencies from the lockfile', args: ['ci'] },
  { id: 'format', title: 'Formatting', args: ['run', 'format:check'] },
  { id: 'build', title: 'Build', args: ['run', 'build'] },
  { id: 'typecheck', title: 'Type check', args: ['run', 'typecheck'] },
  { id: 'unit', title: 'Unit tests', args: ['test'] },
  {
    id: 'e2e',
    title: 'Browser extension end to end (minified build)',
    args: ['run', 'test:e2e'],
    env: { CODEGENT_MINIFY: '1' }
  },
  {
    id: 'integration',
    title: 'VS Code integration (minified build)',
    args: ['run', 'test:integration'],
    env: { CODEGENT_MINIFY: '1' }
  },
  { id: 'package', title: 'Package the VS Code extension', args: ['run', 'package'] },
  {
    id: 'package-test',
    title: 'Test the installed package',
    args: ['run', 'test:package']
  }
]

export const USAGE = `Usage: npm run release -- <patch|minor|major|X.Y.Z> [options]

Checks CodeGent in a clean copy of this repository (formatting, types, unit tests, the browser
extension and the VS Code extension in the real thing, the installed package), builds the release
files and publishes them as the latest GitHub release.

Options:
  --dry-run     Do everything except commit, push and publish. The files stay in release/v<version>.
  --yes, -y     Do not ask before pushing and publishing.
  --prerelease  Publish as a pre-release (GitHub never shows those as "Latest").
  --help, -h    Show this text.

Publishing needs the GitHub CLI, signed in: https://cli.github.com, then \`gh auth login\`.`

export const parseArguments = (argv, env = process.env) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      prerelease: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  if (positionals.length > 1) {
    throw new ReleaseError(`expected one version, got: ${positionals.join(' ')}`)
  }
  return {
    request: positionals[0],
    // npm swallows `npm run release --dry-run` for itself; honour it anyway rather than publish.
    dryRun: Boolean(values['dry-run']) || env.npm_config_dry_run === 'true',
    yes: Boolean(values.yes),
    prerelease: Boolean(values.prerelease),
    help: Boolean(values.help)
  }
}

const indent = (lines) => lines.map((line) => `  ${line}`).join('\n')

// ── 1. is a release possible at all? ─────────────────────────────────────────────────────────────
const preflight = async (ctx) => {
  const { options, system, root } = ctx
  const { git, log } = system
  // Without a network a dry run can still check everything else.
  const unreachable = (what, error) => {
    if (!options.dryRun) throw error
    log.warn(`${what}: ${error.message.split('\n')[0]} (carrying on: this is a dry run)`)
  }

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== BRANCH) {
    throw new ReleaseError(`releases are made from ${BRANCH}, but this is ${branch}`)
  }
  const dirty = await git(['status', '--porcelain'])
  if (dirty !== '') {
    throw new ReleaseError(
      `commit or stash your changes first; the working tree is not clean:\n${indent(dirty.split('\n').slice(0, 10))}`
    )
  }
  ctx.repo = parseRepo(await git(['config', '--get', `remote.${REMOTE}.url`]))
  ctx.base = await git(['rev-parse', 'HEAD'])
  ctx.current = currentVersion(root)
  ctx.version = resolveVersion(ctx.current, options.request)
  ctx.tag = `v${ctx.version}`
  log.info(
    `Releasing CodeGent ${ctx.current} → ${ctx.version} from ${BRANCH} (${ctx.base.slice(0, 7)})${options.dryRun ? ' — dry run' : ''}`
  )

  try {
    await git(['fetch', '--quiet', '--tags', REMOTE])
  } catch (error) {
    unreachable(`cannot reach ${REMOTE}`, error)
  }
  const counts = await git([
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...${REMOTE}/${BRANCH}`
  ])
  const [ahead, behind] = counts.split(/\s+/).map(Number)
  if (behind > 0) {
    throw new ReleaseError(
      `${BRANCH} is ${behind} commit(s) behind ${REMOTE}/${BRANCH}; pull first`
    )
  }
  ctx.ahead = ahead

  // The fetch above brought in every tag of origin, so this covers both places.
  if ((await git(['tag', '--list', ctx.tag])) !== '') {
    throw new ReleaseError(`the tag ${ctx.tag} already exists (here or on ${REMOTE})`)
  }

  // The release before this one: for the notes' diff link, and to see which permissions are new.
  const released = (await git(['tag', '--list', 'v*']))
    .split('\n')
    .map((tag) => tag.trim().slice(1))
    .filter((version) => isVersion(version) && compareVersions(version, ctx.version) < 0)
    .sort(compareVersions)
  ctx.previous = released.at(-1) ?? null
  ctx.previousManifest = null
  if (ctx.previous) {
    try {
      ctx.previousManifest = JSON.parse(
        await git(['show', `v${ctx.previous}:${BROWSER_MANIFEST}`])
      )
    } catch {
      log.warn(
        `cannot read the browser manifest of v${ctx.previous}; new permissions go unchecked`
      )
    }
  }

  ctx.gh = system.gh(ctx.repo)
  const status = await ctx.gh.status()
  if (status !== 'ready') {
    const how =
      status === 'missing'
        ? 'install it (Windows: winget install --id GitHub.cli)'
        : 'sign in with: gh auth login (and check that you are online)'
    if (!options.dryRun) {
      throw new ReleaseError(`publishing goes through the GitHub CLI (gh); ${how}`)
    }
    log.warn(`the GitHub CLI is not ready (${how}); a real release would stop here`)
  } else if (await ctx.gh.releaseExists(ctx.tag)) {
    throw new ReleaseError(
      `GitHub already has a release for ${ctx.tag} (a draft left by an earlier run?); delete it first`
    )
  }
}

// ── 2. a clean copy, at the new version ──────────────────────────────────────────────────────────
const prepareCopy = async (ctx) => {
  const { system, root, version, tag, current } = ctx
  const { git, log } = system
  ctx.outDir = path.join(root, 'release', tag)
  ctx.logsDir = path.join(ctx.outDir, 'logs')
  fs.rmSync(ctx.outDir, { recursive: true, force: true })
  fs.mkdirSync(ctx.logsDir, { recursive: true })

  ctx.work = system.tempDir('codegent-release-')
  const work = ctx.work.path
  log.info(`Working in a clean copy of ${ctx.base.slice(0, 7)}: ${work}`)
  // Files exactly as git stores them, whatever the autocrlf setting of whoever runs this.
  await git([
    'clone',
    '--quiet',
    '--no-hardlinks',
    '-c',
    'core.autocrlf=false',
    root,
    work
  ])
  await git(['checkout', '--quiet', '--detach', ctx.base], { cwd: work })

  ctx.plan = version === current ? new Map() : planVersion(work, current, version)
  ctx.changed = [...ctx.plan.keys()].sort()
  if (ctx.changed.length > 0) {
    writePlan(work, ctx.plan)
    await git(['add', '--', ...ctx.changed], { cwd: work })
    await git(
      [
        ...['-c', 'user.name=CodeGent release', '-c', 'user.email=release@localhost'],
        ...[
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--quiet',
          '-m',
          `chore: release ${tag}`
        ]
      ],
      { cwd: work }
    )
  }
  ctx.verifiedTree = await git(['rev-parse', 'HEAD^{tree}'], { cwd: work })

  const stale = staleDownloadNames(
    fs.readFileSync(path.join(work, 'README.md'), 'utf8'),
    version
  )
  if (stale.length > 0) {
    throw new ReleaseError(
      `README.md names files of another version: ${stale.join(', ')}`
    )
  }
  ctx.section = sectionFor(
    fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8'),
    version
  )
  if (!ctx.section) {
    throw new ReleaseError(`CHANGELOG.md has no entries under "## ${version}"`)
  }
}

// ── 3. everything has to pass ────────────────────────────────────────────────────────────────────
const runChecks = async (ctx) => {
  const { system } = ctx
  for (const [index, check] of CHECKS.entries()) {
    const number = `[${index + 1}/${CHECKS.length}]`
    system.log.info(`${number} ${check.title}`)
    const file = path.join(
      ctx.logsDir,
      `${String(index + 1).padStart(2, '0')}-${check.id}.log`
    )
    const result = await system.runCheck({
      args: check.args,
      env: check.env,
      cwd: ctx.work.path,
      logFile: file
    })
    if (!result.ok) {
      system.log.info(`\n${indent(result.tail.split('\n'))}\n`)
      throw new ReleaseError(`"${check.title}" failed. Everything it printed: ${file}`)
    }
    system.log.info(`      ok, ${result.seconds.toFixed(0)} s`)
  }
}

// ── 4. the files ─────────────────────────────────────────────────────────────────────────────────
const assemble = async (ctx) => {
  const { system, version, work, outDir } = ctx
  const vsixName = `codegent-${version}.vsix`
  const zipName = `codegent-bridge-browser-extension-${version}.zip`
  const built = path.join(work.path, 'apps', 'vscode', vsixName)
  if (!fs.existsSync(built)) {
    throw new ReleaseError(`the package step did not leave ${vsixName} in apps/vscode`)
  }
  const vsix = path.join(outDir, vsixName)
  const zip = path.join(outDir, zipName)
  fs.copyFileSync(built, vsix)
  // The commit's own time as the time of every file in the zip: the same commit, the same bytes.
  const committed = new Date(await system.git(['show', '-s', '--format=%cI', ctx.base]))
  fs.writeFileSync(zip, await browserExtensionZip(vsix, committed))

  await verifyRelease({
    vsix,
    zip,
    version,
    hubPorts: defaultHubPorts(work.path),
    previousManifest: ctx.previousManifest,
    docs: fs.readFileSync(path.join(work.path, 'docs', 'safety-and-privacy.md'), 'utf8')
  })

  ctx.notes = path.join(outDir, 'RELEASE_NOTES.md')
  fs.writeFileSync(
    ctx.notes,
    releaseNotes({
      version,
      previous: ctx.previous,
      repo: ctx.repo,
      section: ctx.section,
      vsix: vsixName,
      zip: zipName
    })
  )
  ctx.files = [vsix, zip].map((file) => {
    const data = fs.readFileSync(file)
    return {
      name: path.basename(file),
      path: file,
      size: data.length,
      sha256: sha256(data)
    }
  })
}

const listFiles = (ctx) =>
  ctx.files.map(
    (file) => `${file.name}  ${formatSize(file.size)}\n    sha256 ${file.sha256}`
  )

// ── 5. publish ───────────────────────────────────────────────────────────────────────────────────
/** What is wrong with a release as GitHub reports it, compared with the files made here. */
const assetProblems = (view, files) => {
  const problems = []
  const expected = files.map((file) => file.name).sort()
  const found = view.assets.map((asset) => asset.name).sort()
  if (expected.join('\n') !== found.join('\n')) {
    problems.push(
      `GitHub has the files [${found.join(', ')}] instead of [${expected.join(', ')}]`
    )
  }
  for (const file of files) {
    const asset = view.assets.find((candidate) => candidate.name === file.name)
    if (!asset) continue
    if (asset.size !== file.size) {
      problems.push(`${file.name} is ${asset.size} bytes on GitHub, ${file.size} here`)
    }
    if (asset.state && asset.state !== 'uploaded') {
      problems.push(`${file.name} is "${asset.state}" on GitHub, not uploaded`)
    }
    if (asset.digest && asset.digest !== `sha256:${file.sha256}`) {
      problems.push(`${file.name} has a different checksum on GitHub`)
    }
  }
  return problems
}

const commitRelease = async (ctx) => {
  const { system, root, tag } = ctx
  const { git } = system
  // The very files that passed the checks, or nothing at all.
  const plan = planVersion(root, ctx.current, ctx.version)
  const same =
    [...plan.keys()].sort().join('\n') === ctx.changed.join('\n') &&
    [...plan].every(
      ([file, { after }]) =>
        after === fs.readFileSync(path.join(ctx.work.path, file), 'utf8')
    )
  if (!same) {
    throw new ReleaseError(
      'the version change differs from the one that was checked; nothing was written'
    )
  }
  writePlan(root, plan)
  try {
    await git(['add', '--', ...ctx.changed])
    await git(['commit', '--quiet', '-m', `chore: release ${tag}`, '--', ...ctx.changed])
  } catch (error) {
    await git(['reset', '--quiet', '--', ...ctx.changed]).catch(() => {})
    restorePlan(root, plan)
    throw error
  }
  if ((await git(['rev-parse', 'HEAD^{tree}'])) !== ctx.verifiedTree) {
    throw new ReleaseError(
      'the release commit differs from what was checked, so it was NOT pushed. Undo it with: git reset --soft HEAD~1'
    )
  }
}

const discardDraft = async (ctx) => {
  const { gh, system, tag } = ctx
  try {
    if ((await gh.releaseExists(tag)) && (await gh.view(tag)).isDraft) {
      await gh.deleteDraft(tag)
      system.log.info(`Removed the unfinished draft of ${tag} from GitHub.`)
    }
  } catch (error) {
    system.log.warn(`could not remove the draft of ${tag}: ${error.message}`)
  }
}

const verifyPublished = async (ctx, sha) => {
  const { gh, system, tag, files, options } = ctx
  const view = await gh.view(tag)
  const problems = assetProblems(view, files)
  if (view.isDraft) problems.push('it is still a draft')
  if (view.isPrerelease !== options.prerelease) {
    problems.push(`it is ${view.isPrerelease ? '' : 'not '}marked as a pre-release`)
  }
  if (!options.prerelease) {
    let latest = ''
    for (let attempt = 0; attempt < 5 && latest !== tag; attempt++) {
      if (attempt > 0) await system.sleep(2000)
      latest = await gh.latestTag()
    }
    if (latest !== tag)
      problems.push(`GitHub's latest release is ${latest || 'none'}, not ${tag}`)
  }

  // What people will download, byte for byte.
  const download = system.tempDir('codegent-release-download-')
  try {
    await gh.download(
      tag,
      download.path,
      files.map((file) => file.name)
    )
    for (const file of files) {
      const received = path.join(download.path, file.name)
      if (!fs.existsSync(received) || sha256(fs.readFileSync(received)) !== file.sha256) {
        problems.push(`the downloaded ${file.name} differs from the one that was checked`)
      }
    }
  } catch (error) {
    problems.push(`could not download the files again: ${error.message}`)
  } finally {
    await download.remove()
  }

  try {
    await system.git(['fetch', '--quiet', REMOTE, `refs/tags/${tag}:refs/tags/${tag}`])
    if ((await system.git(['rev-parse', `${tag}^{commit}`])) !== sha) {
      problems.push(`${tag} points to a different commit than the one that was released`)
    }
  } catch (error) {
    problems.push(`cannot fetch the tag ${tag}: ${error.message.split('\n')[0]}`)
  }

  if (problems.length > 0) {
    throw new ReleaseError(
      `${tag} IS published, but it does not look right:\n${indent(problems)}\nLook at ${view.url}`
    )
  }
  return view.url
}

const publish = async (ctx) => {
  const { options, system, tag, version, gh } = ctx
  const { git, log } = system

  log.info(
    `\nReady to publish CodeGent ${version}${options.prerelease ? ' as a pre-release' : ' as the latest release'}:`
  )
  log.info(
    indent([
      `repository  ${ctx.repo}`,
      `commit      ${ctx.changed.length > 0 ? `chore: release ${tag} (new) on top of ${ctx.base.slice(0, 7)}` : ctx.base.slice(0, 7)}${ctx.ahead > 0 ? `; ${ctx.ahead} earlier commit(s) go to ${REMOTE} with it` : ''}`,
      `tag         ${tag} (GitHub creates it when the release is published)`,
      `files       ${listFiles(ctx).join('\n            ')}`,
      `notes       ${path.relative(ctx.root, ctx.notes)}`
    ])
  )
  if (!options.yes && !(await system.confirm(`Push ${BRANCH} and publish ${tag}?`))) {
    throw new ReleaseError(
      'stopped before pushing anything. Run with --yes to publish without being asked.'
    )
  }

  // The repository has to be exactly where the checks started.
  if ((await git(['rev-parse', 'HEAD'])) !== ctx.base) {
    throw new ReleaseError(
      'new commits arrived while the checks ran; run the release again'
    )
  }
  if ((await git(['status', '--porcelain'])) !== '') {
    throw new ReleaseError(
      'the working tree changed while the checks ran; run the release again'
    )
  }
  if (ctx.changed.length > 0) await commitRelease(ctx)

  log.info(`Pushing ${BRANCH} to ${REMOTE} …`)
  await git(['push', '--quiet', REMOTE, BRANCH])
  const sha = await git(['rev-parse', 'HEAD'])

  log.info('Uploading the files to a draft release …')
  let published = false
  try {
    await gh.createDraft({
      tag,
      title: `CodeGent ${version}`,
      notesFile: ctx.notes,
      files: ctx.files.map((file) => file.path),
      target: sha
    })
    const problems = assetProblems(await gh.view(tag), ctx.files)
    if (problems.length > 0) {
      throw new ReleaseError(`the draft on GitHub is not right:\n${indent(problems)}`)
    }
    log.info('Publishing …')
    await gh.publish(tag, { prerelease: options.prerelease })
    published = true
  } catch (error) {
    if (!published) {
      await discardDraft(ctx)
      log.info(
        `${BRANCH} was already pushed (${sha.slice(0, 7)}); only the GitHub release is missing.`
      )
    }
    throw error
  }

  log.info('Checking what GitHub now serves …')
  return verifyPublished(ctx, sha)
}

/**
 * Runs a release. `system` is what createSystem returns (or a stand-in for it in tests).
 * Resolves with what was made; throws a ReleaseError when it had to stop.
 */
export const runRelease = async (given, system) => {
  const options = { dryRun: false, yes: false, prerelease: false, ...given }
  const ctx = { options, system, root: system.root }
  try {
    await preflight(ctx)
    await prepareCopy(ctx)
    await runChecks(ctx)
    await assemble(ctx)
    system.log.info(
      `\nThe release files are ready in ${path.relative(ctx.root, ctx.outDir)}:`
    )
    system.log.info(indent(listFiles(ctx)))
    if (options.dryRun) {
      system.log.info(
        `\nDry run: nothing was committed, pushed or published. To release for real: npm run release -- ${ctx.version}`
      )
      return {
        version: ctx.version,
        tag: ctx.tag,
        outDir: ctx.outDir,
        files: ctx.files,
        url: null
      }
    }
    const url = await publish(ctx)
    system.log.info(`\nPublished ${ctx.tag}: ${url}`)
    system.log.info(
      'Users of an unpacked browser extension press reload (⟳) on its card in chrome://extensions once.'
    )
    return {
      version: ctx.version,
      tag: ctx.tag,
      outDir: ctx.outDir,
      files: ctx.files,
      url
    }
  } finally {
    await ctx.work?.remove()
  }
}

const main = async () => {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.help) return console.log(USAGE)
  if (!options.request) {
    console.error(
      `Which version? patch, minor, major or an exact one like 0.2.0.\n\n${USAGE}`
    )
    process.exitCode = 2
    return
  }

  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..'
  )
  const system = createSystem(root)
  process.once('SIGINT', () => {
    system.dispose()
    process.exit(130)
  })
  try {
    await runRelease(options, system)
  } catch (error) {
    console.error(
      `\nRelease stopped: ${error instanceof ReleaseError ? error.message : error.stack}`
    )
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
