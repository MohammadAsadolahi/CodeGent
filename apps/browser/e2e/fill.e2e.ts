import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { startWorld, type World } from './harness'

let world: World
let page: Page

beforeAll(async () => {
  world = await startWorld()
  page = await world.context.newPage()
  await page.goto('https://chatgpt.com/')
})
afterAll(async () => {
  await world?.close()
})

type Strategy = 'inner-text' | 'paste-event' | 'exec-command'
interface FillOutcome {
  result: { ok: boolean; strategy?: string; detail?: string }
  holds: boolean
  text: string
}

const fill = async (text: string, strategy: Strategy): Promise<FillOutcome> => {
  await page.evaluate(() =>
    (window as never as { __mock: { clear(): Promise<boolean> } }).__mock.clear()
  )
  return page.evaluate(
    ([t, s]) =>
      (
        window as never as {
          __mock: { fill(text: string, s: string[]): Promise<unknown> }
        }
      ).__mock.fill(t!, [s!]),
    [text, strategy]
  ) as Promise<FillOutcome>
}

const SAMPLES: Record<string, string> = {
  'a single line': 'Add a greeting to the README.',
  'paragraphs and a code fence': [
    'Task: add logging.',
    '',
    'Rules:',
    '- keep it small',
    '- use `logger.info()`',
    '',
    '```ts',
    'export const x = 1',
    '',
    '',
    'export const y = 2',
    '```',
    '',
    'Reply with edits only.'
  ].join('\n'),
  'unicode and symbols': 'Naïve café — “quotes” ✓ <b>&amp;</b> 日本語 🚀 \\n literally',
  'a large prompt': Array.from(
    { length: 600 },
    (_, i) => `Line ${i}: ${'lorem ipsum '.repeat(8).trim()}`
  ).join('\n')
}

describe.each(Object.entries(SAMPLES))(
  'entering %s into a real ProseMirror composer',
  (_name, text) => {
    it.each<Strategy>(['inner-text', 'paste-event', 'exec-command'])(
      'works with the %s strategy',
      async (strategy) => {
        const outcome = await fill(text, strategy)
        expect(outcome.result.ok, JSON.stringify(outcome.result)).toBe(true)
        expect(outcome.holds).toBe(true)
      }
    )

    it('inner-text (the primary strategy) preserves the text exactly, blank lines included', async () => {
      const outcome = await fill(text, 'inner-text')
      expect(outcome.text).toBe(text)
    })
  }
)

describe('fill hygiene', () => {
  it('never duplicates text when a second attempt replaces the first', async () => {
    const text = 'only once please'
    await fill(text, 'inner-text')
    const second = (await page.evaluate(
      ([t]) =>
        (
          window as never as {
            __mock: { fill(text: string, s: string[]): Promise<unknown> }
          }
        ).__mock.fill(t!, ['paste-event']),
      [text]
    )) as FillOutcome
    expect(second.text).toBe(text)
  })

  it('clearing leaves the editor empty and the send button gone', async () => {
    await fill('something', 'inner-text')
    expect(await page.locator('[data-testid="send-button"]').count()).toBe(1)
    await page.evaluate(() =>
      (window as never as { __mock: { clear(): Promise<boolean> } }).__mock.clear()
    )
    expect(
      await page.evaluate(() =>
        (window as never as { __mock: { composerText(): string } }).__mock.composerText()
      )
    ).toBe('')
    expect(await page.locator('[data-testid="send-button"]').count()).toBe(0)
  })
})
