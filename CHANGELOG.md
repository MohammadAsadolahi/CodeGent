# Changelog

## Unreleased

- Fixed: with ChatGPT's page as redesigned in October 2026 a run typed and sent the prompt but never
  recognised the finished reply, so it ended with _did not finish replying in time_ after the full
  timeout. The page no longer has test ids or an author attribute on messages, draws one container for
  your message and the reply together, and draws code blocks without `<pre>` (which would have hidden
  every edit). The reply is now read from the assistant's message in that container (with a fallback:
  whatever follows your prompt), code blocks are recognised in both forms, the send button is found
  without a test id, and sign-in is recognised by the page's buttons.
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
