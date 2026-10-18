import { describe, expect, it } from 'vitest'
import { buildSettings, sanitizeChatUrl } from '../../src/settings-model'

const from =
  (values: Record<string, unknown>) =>
  <T>(key: string, fallback: T): T =>
    (key in values ? values[key] : fallback) as T

describe('buildSettings', () => {
  it('has seamless defaults: everything automatic, committing and pushing, no verify command', () => {
    const settings = buildSettings(from({}), '/repo')
    expect(settings.run).toMatchObject({
      autoApply: true,
      autoContinue: true,
      commit: true,
      push: true,
      allowDirty: false,
      maxSteps: 12,
      maxFailedSteps: 3,
      commitPrefix: 'codegent: ',
      workspaceRoot: '/repo'
    })
    expect(settings.run.conventions).toBeUndefined()
    expect(settings.bridge).toEqual({
      chatUrl: 'https://chatgpt.com/',
      autoSubmit: true,
      replyTimeoutMs: 600_000,
      browserWaitMs: 40_000
    })
    expect(settings.verify).toEqual({ command: '', timeoutMs: 300_000 })
    expect(settings.diagnosticsWaitMs).toBe(8_000)
  })

  it('reads configured values', () => {
    const settings = buildSettings(
      from({
        autoApply: false,
        autoContinue: false,
        'git.commit': false,
        'git.push': false,
        'git.commitPrefix': 'ai: ',
        maxSteps: 5,
        maxFailedSteps: 2,
        allowEditingDirtyFiles: true,
        autoSubmit: false,
        replyTimeoutSeconds: 120,
        browserWaitSeconds: 5,
        verifyCommand: '  npm test  ',
        verifyTimeoutSeconds: 60,
        diagnosticsWaitSeconds: 2,
        conventions: '  Use pnpm.  '
      })
    )
    expect(settings.run).toMatchObject({
      autoApply: false,
      autoContinue: false,
      commit: false,
      push: false,
      commitPrefix: 'ai: ',
      maxSteps: 5,
      maxFailedSteps: 2,
      allowDirty: true,
      conventions: 'Use pnpm.'
    })
    expect(settings.bridge).toMatchObject({
      autoSubmit: false,
      replyTimeoutMs: 120_000,
      browserWaitMs: 5_000
    })
    expect(settings.verify).toEqual({ command: 'npm test', timeoutMs: 60_000 })
    expect(settings.diagnosticsWaitMs).toBe(2_000)
  })

  it('clamps out-of-range numbers and ignores wrongly-typed values', () => {
    const settings = buildSettings(
      from({
        maxSteps: 100_000,
        maxFailedSteps: 0,
        replyTimeoutSeconds: 1,
        browserWaitSeconds: -5,
        verifyTimeoutSeconds: 999_999,
        diagnosticsWaitSeconds: 'soon',
        autoApply: 'yes',
        'git.push': 1,
        verifyCommand: 42
      })
    )
    expect(settings.run.maxSteps).toBe(100)
    expect(settings.run.maxFailedSteps).toBe(1)
    expect(settings.bridge.replyTimeoutMs).toBe(30_000)
    expect(settings.bridge.browserWaitMs).toBe(0)
    expect(settings.verify.timeoutMs).toBe(3_600_000)
    expect(settings.diagnosticsWaitMs).toBe(8_000)
    expect(settings.run.autoApply).toBe(true) // wrong type → default
    expect(settings.run.push).toBe(true)
    expect(settings.verify.command).toBe('')
  })

  it('keeps the commit prefix on one line and bounded, and the conventions bounded', () => {
    const settings = buildSettings(
      from({ 'git.commitPrefix': 'a\nb\r\nc: ', conventions: 'x'.repeat(10_000) })
    )
    expect(settings.run.commitPrefix).toBe('a b c: ')
    expect(settings.run.conventions).toHaveLength(4_000)
    expect(
      buildSettings(from({ 'git.commitPrefix': 'p'.repeat(100) })).run.commitPrefix
    ).toHaveLength(40)
  })
})

describe('sanitizeChatUrl', () => {
  it.each([
    ['https://chatgpt.com/', 'https://chatgpt.com/'],
    [
      'https://chatgpt.com/g/g-p-123-my-project/project',
      'https://chatgpt.com/g/g-p-123-my-project/project'
    ],
    ['  https://chat.openai.com/  ', 'https://chat.openai.com/'],
    ['https://user:secret@chatgpt.com/path', 'https://chatgpt.com/path']
  ])('accepts %s', (input, expected) => {
    expect(sanitizeChatUrl(input)).toBe(expected)
  })

  it.each([
    ['http://chatgpt.com/'],
    ['https://evil.example/'],
    ['https://chatgpt.com.evil.example/'],
    ['https://evilchatgpt.com/'],
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['not a url'],
    [''],
    [undefined],
    [42]
  ])('falls back to the default for %j', (input) => {
    expect(sanitizeChatUrl(input)).toBe('https://chatgpt.com/')
  })
})
