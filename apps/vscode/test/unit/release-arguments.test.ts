import { describe, expect, it } from 'vitest'
import { formatSize, parseRepo, ReleaseError } from '../../scripts/release/common.mjs'
import { parseArguments } from '../../scripts/release.mjs'

describe('the GitHub repository of a remote', () => {
  it('is read from https and ssh URLs, with or without .git', () => {
    for (const url of [
      'https://github.com/MohammadAsadolahi/CodeGent.git',
      'https://github.com/MohammadAsadolahi/CodeGent',
      'https://github.com/MohammadAsadolahi/CodeGent/',
      'https://someone@github.com/MohammadAsadolahi/CodeGent.git',
      'git@github.com:MohammadAsadolahi/CodeGent.git',
      'ssh://git@github.com/MohammadAsadolahi/CodeGent.git',
      'https://github.com/MohammadAsadolahi/CodeGent.git\n'
    ]) {
      expect(parseRepo(url), url).toBe('MohammadAsadolahi/CodeGent')
    }
  })

  it('is refused for anything that is not on GitHub', () => {
    expect(() => parseRepo('https://gitlab.com/a/b.git')).toThrow(ReleaseError)
    expect(() => parseRepo('/some/local/path')).toThrow(/not a GitHub repository URL/)
  })
})

describe('file sizes', () => {
  it('are shown in KB below a megabyte and in MB above', () => {
    expect(formatSize(141086)).toBe('137.8 KB')
    expect(formatSize(2 * 1024 * 1024)).toBe('2.00 MB')
  })
})

describe('the command line', () => {
  it('takes one version and the flags', () => {
    expect(parseArguments(['patch'], {})).toEqual({
      request: 'patch',
      dryRun: false,
      yes: false,
      prerelease: false,
      help: false
    })
    expect(parseArguments(['0.2.0', '--dry-run', '-y', '--prerelease'], {})).toEqual({
      request: '0.2.0',
      dryRun: true,
      yes: true,
      prerelease: true,
      help: false
    })
    expect(parseArguments(['--help'], {}).help).toBe(true)
  })

  it('treats a dry run that npm swallowed as a dry run, rather than publishing', () => {
    expect(parseArguments(['patch'], { npm_config_dry_run: 'true' }).dryRun).toBe(true)
    expect(parseArguments(['patch'], { npm_config_dry_run: 'false' }).dryRun).toBe(false)
  })

  it('has no version when none was given, for the caller to ask for', () => {
    expect(parseArguments([], {}).request).toBeUndefined()
  })

  it('refuses a second version and unknown flags', () => {
    expect(() => parseArguments(['patch', 'minor'], {})).toThrow(/expected one version/)
    expect(() => parseArguments(['patch', '--force'], {})).toThrow(/Unknown option/)
  })
})
