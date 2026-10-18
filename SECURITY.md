# Security policy

CodeGent writes files, runs git, and talks to a browser extension, so security reports are taken
seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/MohammadAsadolahi/CodeGent/security/advisories/new).

Include what you found, how to reproduce it, and which version you used. Expect an acknowledgement
within a few days; this is a volunteer project, so fixes follow as soon as they can be made safely.

## Supported versions

Only the latest release receives fixes.

## What is in scope

- Anything that lets a web page, another browser extension or another local program send edits to the
  hub or read from it (the hub is meant to accept only your editor and the CodeGent Bridge extension on
  `127.0.0.1`).
- Edits that escape the repository, write into `.git`, or overwrite files the user changed.
- Any way for a repository or ChatGPT reply to cause a command to run other than git operations the
  extension issues itself and the verify command configured in the user's own settings.
- Credentials or secrets ending up in prompts, logs or the browser extension.

## Out of scope

- The behaviour of chatgpt.com, OpenAI's GitHub connector or GitHub itself.
- Problems that need an attacker who already controls your machine or your browser profile.

The design and safety rules are described in the [README](README.md#safety) and in
[docs/architecture.md](docs/architecture.md).
