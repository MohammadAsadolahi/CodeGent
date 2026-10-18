# Changelog

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
