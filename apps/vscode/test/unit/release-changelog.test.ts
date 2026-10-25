import { describe, expect, it } from 'vitest'
import {
  promoteUnreleased,
  releaseNotes,
  sectionFor
} from '../../scripts/release/changelog.mjs'
import { CHANGELOG } from '../support/release-fixture'

describe('promoting the Unreleased section', () => {
  it('makes the entries the section of the version and leaves a fresh Unreleased', () => {
    expect(promoteUnreleased(CHANGELOG, '0.2.0')).toBe(`# Changelog

## Unreleased

## 0.2.0

- Reading the reply is more robust.
- A change that needs a second line
  to be explained.

## 0.1.0

First version.
`)
  })

  it('keeps blank lines and paragraphs inside the entries', () => {
    const text =
      '# Changelog\n\n## Unreleased\n\n- One.\n\n  More about one.\n\n- Two.\n\n## 0.1.0\n'
    expect(promoteUnreleased(text, '0.1.1')).toContain(
      '## 0.1.1\n\n- One.\n\n  More about one.\n\n- Two.\n\n## 0.1.0'
    )
  })

  it('works when Unreleased is the last section, and ends with one newline', () => {
    const result = promoteUnreleased(
      '# Changelog\n\n## Unreleased\n\n- Only entry.\n',
      '0.1.1'
    )
    expect(result).toBe('# Changelog\n\n## Unreleased\n\n## 0.1.1\n\n- Only entry.\n')
  })

  it('refuses an empty Unreleased section: there is nothing to release', () => {
    expect(() =>
      promoteUnreleased('# Changelog\n\n## Unreleased\n\n\n## 0.1.0\n\nx\n', '0.1.1')
    ).toThrow(/is empty/)
  })

  it('refuses a CHANGELOG without Unreleased', () => {
    expect(() => promoteUnreleased('# Changelog\n\n## 0.1.0\n\nx\n', '0.1.1')).toThrow(
      /no "## Unreleased" section/
    )
  })

  it('refuses a version that already has a section', () => {
    expect(() => promoteUnreleased(CHANGELOG, '0.1.0')).toThrow(
      /already has a section for 0.1.0/
    )
  })
})

describe('finding the entries of a version', () => {
  it('returns the entries without the blank lines around them', () => {
    expect(sectionFor(CHANGELOG, '0.1.0')).toBe('First version.')
    expect(sectionFor(CHANGELOG, '0.1.0')).not.toMatch(/^\n|\n$/)
  })

  it('is null for a version that is not there', () => {
    expect(sectionFor(CHANGELOG, '0.9.9')).toBeNull()
  })

  it('does not take 0.1.1 for the beginning of 0.1.10', () => {
    const text = '## 0.1.10\n\n- ten\n\n## 0.1.1\n\n- one\n'
    expect(sectionFor(text, '0.1.1')).toBe('- one')
    expect(sectionFor(text, '0.1.10')).toBe('- ten')
  })

  it('also reads headings with a date or a v', () => {
    expect(sectionFor('## 0.2.0 — 2026-11-02\n\n- dated\n', '0.2.0')).toBe('- dated')
    expect(sectionFor('## v0.2.0\n\n- prefixed\n', '0.2.0')).toBe('- prefixed')
  })

  it('is an empty string for a heading with nothing under it', () => {
    expect(sectionFor('## 0.2.0\n\n## 0.1.0\n\n- x\n', '0.2.0')).toBe('')
  })
})

describe('the release notes', () => {
  const input = {
    version: '0.2.0',
    previous: '0.1.0',
    repo: 'someone/codegent',
    section: '- First change.\n- Second change.',
    vsix: 'codegent-0.2.0.vsix',
    zip: 'codegent-bridge-browser-extension-0.2.0.zip'
  }

  it('lead with what changed, then say what to download and how to install it', () => {
    const notes = releaseNotes(input)
    expect(notes.indexOf('## What changed in 0.2.0')).toBe(0)
    expect(notes).toContain('- First change.\n- Second change.')
    expect(notes.indexOf('## Downloads')).toBeGreaterThan(notes.indexOf('Second change'))
    expect(notes).toContain('| `codegent-0.2.0.vsix` |')
    expect(notes).toContain('| `codegent-bridge-browser-extension-0.2.0.zip` |')
    expect(notes).toContain('`code --install-extension codegent-0.2.0.vsix`')
    expect(notes).toContain('unzip `codegent-bridge-browser-extension-0.2.0.zip`')
    expect(notes).toContain('press reload (⟳)')
    expect(notes.endsWith('\n')).toBe(true)
  })

  it('link to the diff with the release before', () => {
    expect(releaseNotes(input)).toContain(
      'https://github.com/someone/codegent/compare/v0.1.0...v0.2.0'
    )
  })

  it('have no diff link for a first release', () => {
    const notes = releaseNotes({ ...input, previous: null })
    expect(notes).not.toContain('compare/')
    expect(notes).toContain('https://github.com/someone/codegent/blob/main/CHANGELOG.md')
  })

  it('never print "undefined"', () => {
    expect(releaseNotes(input)).not.toMatch(/undefined|null/)
  })
})
