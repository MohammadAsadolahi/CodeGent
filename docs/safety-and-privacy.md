# Safety and privacy

[← Back to the README](../README.md)

## Safety

- **Edits are checked before anything is written.** Paths that leave the repository, point into
  `.git`, or are absolute elsewhere are rejected. Binary files are never edited. A `SEARCH` block
  that cannot be found — or is found in more than one place — is an error, never a guess: that file
  stays untouched and ChatGPT is told what was wrong. (Differences in indentation or trailing spaces
  are tolerated, because chat models get those wrong.)
- **Your own work is protected.** Files with uncommitted changes — and files with unsaved changes in
  an editor — are not edited. Commits contain only the files CodeGent changed; whatever else you have
  staged stays staged.
- **Everything is undoable.** Each step is checkpointed; _Undo this step_ restores the files (it will
  not overwrite something you changed since).
- **ChatGPT never runs commands on your machine.** There is no such channel. The only commands that
  run are git operations CodeGent issues itself and the verify command _you_ configured (which can only
  be set in your user settings, so a repository cannot set one).
- **Loopback only, and only your browser extension.** The hub listens on `127.0.0.1` and checks the
  `Host` and `Origin` of every connection. It accepts your editor and the CodeGent Bridge extension —
  recognised by its fixed extension id — so neither a web page nor any other browser extension can
  talk to it or feed it edits. (If you use your own build of the browser extension, add its id to
  `codegent.advanced.extraBrowserExtensionIds`.)
- **Limits.** A run stops after a step cap and after repeated failures. Stop works at any moment.
- CodeGent does not work in untrusted (restricted-mode) workspaces, because it writes files and runs
  git and your verify command.

## Privacy

- CodeGent has **no server and no telemetry**. The browser extension talks only to the local hub and
  to the ChatGPT page you have open.
- What goes to ChatGPT is what the loop needs: your task, the repository name, branch and commit, the
  results of each step (file names, error messages, short code excerpts when a `SEARCH` block did not
  match, verify-command output), under your own ChatGPT account. ChatGPT reads your code through the
  GitHub connector according to OpenAI's and GitHub's terms. Do not put secrets in tasks, and be aware
  that a verify command's output is sent too.
- Credentials in a remote URL are never put into a prompt.
- The browser extension asks for access to `chatgpt.com` (to type and read), `127.0.0.1` (the hub),
  and the `storage`, `alarms` (to keep its connection alive) and `scripting` (to attach to ChatGPT tabs
  that were already open) permissions.

## Responsible use

CodeGent automates a consumer web interface: it types into your ChatGPT tab, presses send and reads the
answer. Such automation may not be permitted by the service's terms of use, and the service may limit
or change how its pages work. Read the terms that apply to your account and use CodeGent at your own
discretion. Turn **Send in ChatGPT** off if you want to press Enter yourself.
