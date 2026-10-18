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
    .map((line) => line.replace(/\b(export|const|function|return|import)\b/g, '<span class="hljs-keyword">$1</span>'))
    .join('\n')
  const className = options.classLanguage === false ? 'whitespace-pre!' : `whitespace-pre! language-${language}`
  return (
    `<pre class="overflow-visible!"><div class="contain-inline-size rounded-2xl relative">` +
    `<div class="flex items-center text-xs justify-between h-9 select-none">${options.label ?? language}</div>` +
    `<div class="sticky top-9"><div class="absolute end-0 bottom-0 flex h-9"><button class="flex gap-1" aria-label="Copy">Copy</button></div></div>` +
    `<div class="overflow-y-auto p-4" dir="ltr"><code class="${className}">${highlighted}\n</code></div>` +
    `</div></pre>`
  )
}

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

export const userMessage = (text: string, id = 'user-' + Math.random().toString(36).slice(2, 8)): string =>
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

// ── the October 2026 redesign ─────────────────────────────────────────────────────────────────
// No test ids, no per-message author attributes, no `.markdown` wrapper: a turn is only a div that
// carries `data-talvt-turn-state`, with the content first and the action buttons in the last child.

const COPY_ICON = '<svg viewBox="0 0 20 20"><path d="M7 3h9v11H7z"/></svg>'
export const STOP_ICON_PATH =
  'M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z'

export const redesignUserTurn = (text: string): string =>
  `<div data-talvt-turn-state="complete"><div><h6 class="sr-only">You said:</h6>` +
  `<div class="whitespace-pre-wrap">${escapeHtml(text)}</div></div>` +
  `<div><div><button aria-label="Copy message">${COPY_ICON}</button></div></div></div>`

export const redesignAssistantTurn = (html: string, state?: string): string =>
  `<div${state ? ` data-talvt-turn-state="${state}"` : ''}><div><h6 class="sr-only">ChatGPT said:</h6>` +
  `<div data-body>${html}</div></div>` +
  `<div><div><button aria-label="Copy response">${COPY_ICON}</button></div></div></div>`

export const redesignComposerHtml = (): string =>
  `<form id="composer-form"><div contenteditable="true" role="textbox" data-composer-input></div>` +
  `<div data-composer-trailing><button type="submit" data-composer-submit aria-disabled="true" ` +
  `aria-label="Send message" data-send-label="Send message" data-stop-label="Stop generating">` +
  `<svg viewBox="0 0 20 20"><path d="M10 4l5 6h-4v6H9v-6H5z"/></svg></button></div></form>`
