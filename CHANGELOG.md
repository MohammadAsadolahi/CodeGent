# Changelog

## Unreleased

- A reply that cannot be applied no longer costs a string of identical retries. Every correction now
  names what was wrong in the reply (a heading with no code block under it, SEARCH/REPLACE text that
  was not inside a code fence, a pair that was never closed …) and shows the exact shape to answer
  in, filled in with the file names. A second failure asks for one file at a time; when SEARCH text
  keeps not matching a small file, ChatGPT is asked for the complete file instead; a third failure
  for the same file (or in the same way) stops the run with the last problem, instead of asking again.
- The prompt now asks ChatGPT to open every code block with `text` instead of the file's language,
  and to check each file's shape before sending. Blocks without a language are the form the real
  page was verified to give back exactly; a language-specific block may be drawn by another viewer.
- More reply shapes are read in the original turn, with no correction at all: file headings written
  _inside_ the code block (also when the whole answer is in one block, or in a four-backtick
  `markdown` block like the example in the prompt), and a bare file name on the line above a fenced
  SEARCH/REPLACE block. A bare file name is only used for a block that really has SEARCH/REPLACE
  markers (which still have to match the file exactly), never for an ordinary code sample.
- Replacements that stand in for code (`// ... existing code ...`, `# rest of the file unchanged`)
  are refused, in SEARCH/REPLACE and in whole-file replacements, instead of being written over the
  real code.
- The browser extension now reads a code viewer built on CodeMirror (every line an element of its
  own, no `<pre>` or `<code>`) as a code block. Read as ordinary markup, each line became a paragraph
  with its indentation lost, so an edit in such a viewer arrived without any code block. As a safety
  net for viewers it does not know, SEARCH/REPLACE text that reaches the markdown outside a code
  fence is taken again from the lines the page shows and fenced, exactly as shown.
- A file whose SEARCH/REPLACE pairs are written without a fence is read as one block, as inside a
  fence: when its last pair is broken nothing of that file is applied (before, the complete pairs
  were).
- The copy of the browser extension in VS Code's storage is now replaced whenever the bundle's
  content differs from it, not only when the version number changes. A local build keeps its
  version, so the browser went on running the old page-reading code. After VS Code has started with
  a new build, press reload (⟳) on the extension's card in `chrome://extensions` once.
- _Show Log_ now has one line per reply with its size and shape (characters, file headings, code
  fences, SEARCH/REPLACE pairs) — never its contents — so a reply CodeGent could not use can be told
  from one it could.
- A complete SEARCH/REPLACE pair directly under a file heading is now accepted even when ChatGPT
  omits the surrounding Markdown code fence, avoiding a needless correction turn.
- Fixed: with ChatGPT's page as redesigned in October 2026 a run typed and sent the prompt but never
  recognised the finished reply, so it ended with _did not finish replying in time_ after the full
  timeout. The page no longer has test ids or an author attribute on messages, draws one container for
  your message and the reply together, and draws code blocks without `<pre>` (which would have hidden
  every edit). The reply is now read from the assistant's message in that container (with a fallback:
  whatever follows your prompt), code blocks are recognised in both forms, the send button is found
  without a test id, and sign-in is recognised by the page's buttons.
- A reply that says `done` and only recaps the changed files as headings, with no content under them,
  now ends the run at once (the ignored headings are shown as a note on the step) instead of costing
  another round trip. A finished run is announced as _Done — the task is complete_.
- A run no longer waits silently for a reply it cannot see: when generation has visibly ended and
  nothing readable is on the page it fails within seconds, and every timeout names what the page looked
  like (`[Page: …]`, structure only).
- The popup's _Test ChatGPT page_ report now includes the outline of the message box and the last
  turns, with a **Copy report** button for bug reports.
- Tests: the mock ChatGPT page exists in both page generations; `npm run test:live` (opt-in) runs the
  whole loop against the real chatgpt.com.

## 0.1.0

First version.

- VS Code extension with a panel: setup guide, task box, live run timeline, review of proposed changes
  with the native diff, undo per step, history, quick toggles.
- The agent loop: ChatGPT reads the repository through its GitHub connector, answers with
  `SEARCH`/`REPLACE` edits, CodeGent applies them, checks them (language-server errors, optional verify
  command), commits only the changed files, pushes, and reports the result back in the same
  conversation.
- Browser extension ("CodeGent Bridge", Manifest V3, Chromium) that drives the ChatGPT page, with a
  self-test in its popup.
- Local hub on `127.0.0.1` that relays between the two, started on demand.
- Safety: path sandbox, atomic per-file edits, protection of uncommitted and unsaved work, step and
  failure caps, Stop, first-run consent before committing and pushing.
