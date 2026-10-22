/**
 * Builders that reproduce the structure of a rendered ChatGPT conversation closely enough for the
 * content-script logic: message wrappers with author roles and ids, a `.markdown` body, and code
 * blocks with a header (language label + Copy button) and syntax-highlight spans.
 */

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A highlighted code block as ChatGPT renders it. */
export const codeBlock = (
  language: string,
  code: string,
  options: { label?: string; classLanguage?: boolean } = {}
): string => {
  const highlighted = escapeHtml(code)
    .split('\n')
    .map((line) =>
      line.replace(
        /\b(export|const|function|return|import)\b/g,
        '<span class="hljs-keyword">$1</span>'
      )
    )
    .join('\n')
  const className =
    options.classLanguage === false
      ? 'whitespace-pre!'
      : `whitespace-pre! language-${language}`
  return (
    `<pre class="overflow-visible!"><div class="contain-inline-size rounded-2xl relative">` +
    `<div class="flex items-center text-xs justify-between h-9 select-none">${options.label ?? language}</div>` +
    `<div class="sticky top-9"><div class="absolute end-0 bottom-0 flex h-9"><button class="flex gap-1" aria-label="Copy">Copy</button></div></div>` +
    `<div class="overflow-y-auto p-4" dir="ltr"><code class="${className}">${highlighted}\n</code></div>` +
    `</div></pre>`
  )
}

/**
 * A code block as the redesigned page draws it (captured 2026-10-18): no `<pre>`, a header with
 * the language label and the Copy button, and a bare `<code>` holding the text.
 */
export const redesignCodeBlock = (language: string, code: string): string =>
  `<div class="code-block"><div class="header"><span>${language}</span>` +
  `<button type="button" aria-label="Copy code">Copy code</button></div>` +
  `<div class="body"><code>${escapeHtml(code)}</code></div></div>`

/**
 * A code block drawn by a CodeMirror-based viewer (the way a language such as Python may be shown):
 * a strip with the language label and a Copy button, then one element per line — no `<pre>`, no
 * `<code>`, and no newline characters in the text.
 */
export const editorCodeBlock = (language: string, code: string): string =>
  `<div class="code-block"><div class="header"><span>${language}</span>` +
  `<button type="button" aria-label="Copy code">Copy code</button></div>` +
  `<div class="cm-editor"><div class="cm-scroller"><div class="cm-content" role="textbox" contenteditable="false">` +
  code
    .split('\n')
    .map((line) => `<div class="cm-line">${line === '' ? '<br>' : escapeHtml(line)}</div>`)
    .join('') +
  `</div></div></div></div>`

export const markdownBody = (html: string): string =>
  `<div class="markdown prose dark:prose-invert w-full break-words">${html}</div>`

export const assistantMessage = (
  html: string,
  options: { id?: string; turnState?: string } = {}
): string => {
  const id = options.id ?? 'msg-' + Math.random().toString(36).slice(2, 10)
  const state = options.turnState ? ` data-talvt-turn-state="${options.turnState}"` : ''
  return (
    `<section data-testid="conversation-turn" data-turn="assistant"${state}>` +
    `<div data-message-author-role="assistant" data-message-id="${id}">` +
    `<div class="flex w-full flex-col gap-1">${markdownBody(html)}</div></div></section>`
  )
}

export const userMessage = (
  text: string,
  id = 'user-' + Math.random().toString(36).slice(2, 8)
): string =>
  `<section data-testid="conversation-turn" data-turn="user"><div data-message-author-role="user" data-message-id="${id}">` +
  `<div class="whitespace-pre-wrap">${escapeHtml(text)}</div></div></section>`

export const composerHtml = (): string =>
  `<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p data-placeholder="Ask anything"><br></p></div>` +
  `<button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form>`

export const stopButtonHtml = (): string =>
  `<button data-testid="stop-button" aria-label="Stop streaming">Stop</button>`

export const setBody = (html: string): void => {
  document.body.innerHTML = html
}

// ── layouts since October 2026 ─────────────────────────────────────────────────────────────────

const COPY_ICON = '<svg viewBox="0 0 20 20"><path d="M7 3h9v11H7z"/></svg>'
export const STOP_ICON_PATH =
  'M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z'
export const SEND_ICON =
  '<svg viewBox="0 0 20 20"><path d="M10 4l5 6h-4v6H9v-6H5z"/></svg>'
export const STOP_ICON = `<svg viewBox="0 0 20 20"><path d="${STOP_ICON_PATH}"/></svg>`

/**
 * "bare": a layout invented to test the generic fallback — turns marked only by
 * `data-talvt-turn-state`, user and assistant in separate turns, no ids, no author attributes.
 */
export const bareUserTurn = (text: string): string =>
  `<div data-talvt-turn-state="complete"><div><h6 class="sr-only">You said:</h6>` +
  `<div class="whitespace-pre-wrap">${escapeHtml(text)}</div></div>` +
  `<div><div><button aria-label="Copy message">${COPY_ICON}</button></div></div></div>`

export const bareAssistantTurn = (html: string, state?: string): string =>
  `<div${state ? ` data-talvt-turn-state="${state}"` : ''}><div><h6 class="sr-only">ChatGPT said:</h6>` +
  `<div data-body>${html}</div></div>` +
  `<div><div><button aria-label="Copy response">${COPY_ICON}</button></div></div></div>`

/**
 * "redesign": the page as captured on chatgpt.com on 2026-10-18. One container per exchange
 * (`data-talvt-turn-state`) holds the user's message bubble, a row for the agent's activity, the
 * assistant's message — a "search unit" whose key ends in `:assistant`, with the body the page
 * copies from marked `data-markdown-copy="contents"` — and a footer of action buttons.
 */
const exchangeUser = (n: number, text: string): string =>
  `<div><div><h4 class="sr-only">You said:</h4>` +
  `<div data-chatgpt-search-unit-key="fallback-turn-${n}:0:user" data-chatgpt-search-message-ids="user-${n}">` +
  `<div data-content-search-unit-key="fallback-turn-${n}:0:user"><div><div data-user-message-bubble="true"><div>` +
  `<div class="whitespace-pre-wrap">${escapeHtml(text)}</div>` +
  `<button type="button" aria-expanded="false" data-thread-find-skip="true" data-markdown-copy="exclude">Show more</button>` +
  `</div></div></div></div></div></div></div>`

/** The agent-activity row and the assistant's message, as they are appended to an exchange. */
export const exchangeAssistantParts = (n: number, id: string, html: string): string =>
  `<div><span data-chatgpt-agent-turn-start=""></span><div><div>` +
  `<button type="button" aria-expanded="false" aria-labelledby="activity-${n}">` +
  `<span id="activity-${n}">Thought for 4s</span></button></div></div></div>` +
  `<div><div data-content-search-unit-key="fallback-turn-${n}:2:assistant" data-chatgpt-search-unit-key="fallback-turn-${n}:2:assistant" ` +
  `data-chatgpt-search-message-ids="${id} thinking-${n}"><h4 data-conversation-role="assistant" class="sr-only">ChatGPT said:</h4>` +
  `<div><div data-chatgpt-selection-conversation-id="conversation-1" data-chatgpt-selection-message-id="${id}">` +
  `<div data-markdown-text-style="assistant-message"><div data-dil-source-message-id="${id}" data-chatgpt-copy-reference="2" data-markdown-copy="contents">` +
  `${html}</div></div></div></div></div></div>`

export const exchangeFooter = (): string =>
  `<div><div><span data-state="closed"><button type="button" aria-label="Copy">${COPY_ICON}</button></span>` +
  `<span data-state="closed"><button type="button" aria-label="Share"><svg aria-hidden="true"></svg></button></span>` +
  `<button type="button" aria-label="Regenerate response" aria-haspopup="menu"><svg aria-hidden="true"></svg></button>` +
  `<button type="button" aria-label="More actions" aria-haspopup="menu"><svg aria-hidden="true"></svg></button></div></div>`

/** An exchange container; `user` and `assistant` may each be left out (a turn still being written). */
export const exchangeHtml = (options: {
  n: number
  state: string
  user?: string
  assistant?: { id: string; html: string }
}): string =>
  `<div data-talvt-turn-state="${options.state}">` +
  (options.user !== undefined ? exchangeUser(options.n, options.user) : '') +
  (options.assistant
    ? exchangeAssistantParts(options.n, options.assistant.id, options.assistant.html) +
      exchangeFooter()
    : '') +
  '</div>'

/** The element that receives the reply text inside an exchange. */
export const EXCHANGE_BODY = '[data-markdown-copy="contents"]'
