import { describe, expect, it } from 'vitest'
import {
  detectLoggedOut,
  findSendButton,
  findStopButton,
  hasStreamingMarkers,
  isGenerating,
  listTurns,
  turnKey,
  turnRole,
  turnState
} from '../../src/content/selectors'
import { STOP_ICON_PATH } from '../fixtures/chatgpt-dom'

const body = (html: string): void => {
  document.body.innerHTML = html
}

describe('findSendButton', () => {
  it('finds the single send/stop button of the redesigned page', () => {
    body(
      '<main><form><div contenteditable="true"></div>' +
        '<button type="submit" data-composer-submit aria-label="Send message"></button></form></main>'
    )
    expect(findSendButton(document)?.selector).toBe('button[data-composer-submit]')
  })

  it('still finds the old test-id button first', () => {
    body(
      '<form><button data-testid="send-button">Send</button>' +
        '<button type="submit" aria-label="Send message">x</button></form>'
    )
    expect(findSendButton(document)?.selector).toBe('button[data-testid="send-button"]')
  })

  it('never returns the button while it is labelled as the stop button', () => {
    body(
      '<form><div contenteditable="true"></div>' +
        '<button type="submit" data-composer-submit aria-label="Stop generating"></button></form>'
    )
    expect(
      findSendButton(document, document.querySelector('[contenteditable]'))
    ).toBeNull()
  })

  it('asks the composer’s form for its submit button when no known selector matches', () => {
    body(
      '<form><div contenteditable="true"></div><button type="submit" aria-label="Go">→</button></form>'
    )
    const composer = document.querySelector('[contenteditable]')
    expect(findSendButton(document)).toBeNull()
    expect(findSendButton(document, composer)?.selector).toBe(
      'form button[type="submit"]'
    )
  })
})

describe('stop button and streaming signals', () => {
  it('recognises the button that advertises its stop label', () => {
    body(
      '<form><button type="submit" data-composer-submit aria-label="Stop generating" ' +
        'data-send-label="Send message" data-stop-label="Stop generating"></button></form>'
    )
    expect(isGenerating(document)).toBe(true)
  })

  it('recognises a stop button by its square icon when it has no label at all', () => {
    body(`<form><button><svg><path d="${STOP_ICON_PATH}"/></svg></button></form>`)
    expect(findStopButton(document)?.selector).toMatch(/M4\.5 5\.75C4\.5 5\.05964/)
  })

  it('is idle when the button is back in its send state', () => {
    body(
      '<form><button type="submit" data-composer-submit aria-label="Send message" ' +
        'data-send-label="Send message" data-stop-label="Stop generating"></button></form>'
    )
    expect(isGenerating(document)).toBe(false)
  })

  it('treats a turn that is not in a final state as a hint, not as proof', () => {
    body('<main><div data-talvt-turn-state="streaming"><p>partial</p></div></main>')
    expect(hasStreamingMarkers(document)).toBe(true)
    expect(isGenerating(document)).toBe(false)
  })

  it.each(['complete', 'stopped', 'error', 'incomplete'])(
    'does not take the final state “%s” for streaming',
    (state) => {
      body(`<main><div data-talvt-turn-state="${state}"><p>text</p></div></main>`)
      expect(hasStreamingMarkers(document)).toBe(false)
    }
  )

  it('ignores the state of the user’s own turns', () => {
    body('<main><div data-turn="user" data-talvt-turn-state="pending">hi</div></main>')
    expect(hasStreamingMarkers(document)).toBe(false)
  })
})

describe('conversation turns', () => {
  it('lists the outermost match only, in document order', () => {
    body(
      '<main>' +
        '<article data-turn="user"><div data-message-author-role="user">one</div></article>' +
        '<div data-talvt-turn-state="complete"><article><p>two</p></article></div>' +
        '<div data-message-author-role="assistant">three</div>' +
        '</main>'
    )
    expect(listTurns(document).map((t) => t.textContent)).toEqual(['one', 'two', 'three'])
  })

  it('falls back to the whole page when there is no <main>', () => {
    body('<div data-talvt-turn-state="complete">only</div>')
    expect(listTurns(document)).toHaveLength(1)
  })

  it('reads the role from the turn or from the message inside it', () => {
    body(
      '<main><div id="a" data-turn="Assistant"></div>' +
        '<div id="b"><div data-message-author-role="user"></div></div>' +
        '<div id="c" data-talvt-turn-state="complete"></div></main>'
    )
    expect(turnRole(document.getElementById('a')!)).toBe('assistant')
    expect(turnRole(document.getElementById('b')!)).toBe('user')
    expect(turnRole(document.getElementById('c')!)).toBeUndefined()
    expect(turnState(document.getElementById('c')!)).toBe('complete')
  })

  it('only trusts identities that are really unique', () => {
    body(
      '<main><div id="a" data-turn-id="t-1"></div>' +
        '<div id="b" data-testid="conversation-turn-3"></div>' +
        '<div id="c" data-testid="conversation-turn"></div>' +
        '<div id="d"><div data-message-id="m-9"></div></div></main>'
    )
    expect(turnKey(document.getElementById('a')!)).toBe('t-1')
    expect(turnKey(document.getElementById('b')!)).toBe('conversation-turn-3')
    expect(turnKey(document.getElementById('c')!)).toBeUndefined()
    expect(turnKey(document.getElementById('d')!)).toBe('m-9')
  })
})

describe('detectLoggedOut', () => {
  it('recognises the old test-id buttons', () => {
    body('<header><button data-testid="login-button">Log in</button></header>')
    expect(detectLoggedOut(document)).toBe(true)
  })

  it('recognises the sign-in buttons of the redesign by their label', () => {
    body('<header><button>Log in</button><button>Sign up for free</button></header>')
    expect(detectLoggedOut(document)).toBe(true)
  })

  it('does not fire on a signed-in page, nor on a link inside a reply', () => {
    body(
      '<header><button aria-label="Open profile menu">AB</button></header>' +
        '<main><div data-talvt-turn-state="complete"><a href="/x">Sign up</a></div></main>'
    )
    expect(detectLoggedOut(document)).toBe(false)
  })
})
