import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorld, waitUntil, type World } from './harness'

let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world?.close()
})

describe('popup', () => {
  it('shows the connection, the ChatGPT tab count and the profile name', async () => {
    const chat = await world.context.newPage()
    await chat.goto('https://chatgpt.com/')
    const popup = await world.context.newPage()
    await popup.goto(`chrome-extension://${world.extensionId}/popup.html`)

    await waitUntil(
      async () => (await popup.textContent('#state')) === 'Connected to VS Code',
      'the popup to show a connection'
    )
    await waitUntil(
      async () => (await popup.textContent('#tabs')) === '1',
      'the popup to count the ChatGPT tab'
    )
    expect(await popup.textContent('#hub')).toBe('127.0.0.1:47695')
    expect(await popup.textContent('#hint')).toMatch(/Ready/)

    await popup.fill('#profile', 'Work laptop')
    await popup.dispatchEvent('#profile', 'change')
    await waitUntil(
      () => world.editor.peers[0]?.profile === 'Work laptop',
      'the profile to reach the hub'
    )
    await chat.close()
    await popup.close()
  })

  it('self-test passes on a healthy page and proves typing works without sending anything', async () => {
    const chat = await world.context.newPage()
    await chat.goto('https://chatgpt.com/')
    const popup = await world.context.newPage()
    await popup.goto(`chrome-extension://${world.extensionId}/popup.html`)
    await waitUntil(
      async () => (await popup.textContent('#tabs')) === '1',
      'the ChatGPT tab to be counted'
    )
    const sentBefore = world.mock.sent.length

    await popup.click('#selftest')
    await popup.waitForSelector('#report li', { timeout: 15_000 })

    const rows = await popup.$$eval('#report li', (items) =>
      items.map((li) => ({
        ok: li.querySelector('span')!.className === 'pass',
        name: li.querySelector('.name')!.textContent,
        detail: li.querySelector('.detail')?.textContent ?? ''
      }))
    )
    expect(
      rows.filter((r) => !r.ok),
      JSON.stringify(rows, null, 1)
    ).toEqual([])
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'ChatGPT page',
        'Signed in',
        'Message box',
        'Entering text works',
        'Send button'
      ])
    )
    expect(world.mock.sent.length).toBe(sentBefore) // nothing was sent
    expect(
      await chat.evaluate(() =>
        (window as never as { __mock: { composerText(): string } }).__mock.composerText()
      )
    ).toBe('') // and the marker was cleaned up
    await chat.close()
    await popup.close()
  })

  it('self-test says what is wrong when there is no ChatGPT tab', async () => {
    const popup = await world.context.newPage()
    await popup.goto(`chrome-extension://${world.extensionId}/popup.html`)
    await popup.click('#selftest')
    await popup.waitForSelector('#report li', { timeout: 10_000 })
    expect(await popup.textContent('#report')).toMatch(/Open chatgpt\.com/)
    await popup.close()
  })

  it('explains itself when VS Code is not running', async () => {
    await world.hub.stop()
    const popup = await world.context.newPage()
    await popup.goto(`chrome-extension://${world.extensionId}/popup.html`)
    await waitUntil(
      async () => (await popup.textContent('#state')) === 'Not connected',
      'the popup to show it is disconnected',
      30_000
    )
    expect(await popup.textContent('#hint')).toMatch(/VS Code/)
    await popup.close()
  })
})
