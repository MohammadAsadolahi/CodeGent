// The CHANGELOG and the release notes. Plain text in, plain text out.
import { escapeRegExp, ReleaseError } from './common.mjs'

const isHeading = (line) => line.startsWith('## ')

/** Index of the line that ends the section whose heading is at `start`. */
const sectionEnd = (lines, start) => {
  const next = lines.findIndex((line, index) => index > start && isHeading(line))
  return next === -1 ? lines.length : next
}

const trimBlankEdges = (lines) => {
  let from = 0
  let to = lines.length
  while (from < to && lines[from].trim() === '') from++
  while (to > from && lines[to - 1].trim() === '') to--
  return lines.slice(from, to)
}

/** The entries under `## <version>`, or null when there is no such section. */
export const sectionFor = (text, version) => {
  const lines = text.split('\n')
  const heading = new RegExp(`^## v?${escapeRegExp(version)}(\\s.*)?$`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  return trimBlankEdges(lines.slice(start + 1, sectionEnd(lines, start))).join('\n')
}

/**
 * Turns the entries under `## Unreleased` into the section of `version`, leaving a fresh, empty
 * `## Unreleased` above it for the next round of changes.
 */
export const promoteUnreleased = (text, version) => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^## Unreleased\s*$/i.test(line))
  if (start === -1) throw new ReleaseError('CHANGELOG.md has no "## Unreleased" section')
  const end = sectionEnd(lines, start)
  const entries = trimBlankEdges(lines.slice(start + 1, end))
  if (entries.length === 0) {
    throw new ReleaseError(
      'the "Unreleased" section of CHANGELOG.md is empty, so there is nothing to release'
    )
  }
  if (sectionFor(text, version) !== null) {
    throw new ReleaseError(`CHANGELOG.md already has a section for ${version}`)
  }
  return [
    ...lines.slice(0, start),
    '## Unreleased',
    '',
    `## ${version}`,
    '',
    ...entries,
    '',
    ...lines.slice(end)
  ].join('\n')
}

/** The text of the GitHub release: what changed, where to get it, how to install it. */
export const releaseNotes = ({ version, previous, repo, section, vsix, zip }) =>
  [
    `## What changed in ${version}`,
    '',
    section.trim(),
    '',
    '## Downloads',
    '',
    '| File | What it is |',
    '| --- | --- |',
    `| \`${vsix}\` | The VS Code extension (it also contains the browser extension) |`,
    `| \`${zip}\` | The browser extension ("CodeGent Bridge") on its own, for Chrome, Edge or Brave |`,
    '',
    '## Install',
    '',
    `1. **VS Code:** \`code --install-extension ${vsix}\``,
    `2. **Browser:** unzip \`${zip}\`, open \`chrome://extensions\` (or \`edge://extensions\`), turn on **Developer mode**, choose **Load unpacked** and select the unzipped folder. (The CodeGent panel in VS Code also shows the same folder.)`,
    '3. **ChatGPT:** sign in at chatgpt.com in that browser and connect the GitHub connector to your repository.',
    '',
    '**Updating?** Start VS Code once with the new extension, then press reload (⟳) on the CodeGent Bridge card in `chrome://extensions`.',
    '',
    previous
      ? `**Full diff:** https://github.com/${repo}/compare/v${previous}...v${version} · [CHANGELOG](https://github.com/${repo}/blob/main/CHANGELOG.md)`
      : `[CHANGELOG](https://github.com/${repo}/blob/main/CHANGELOG.md)`,
    ''
  ].join('\n')
