# Contributing to CodeGent

Thank you for helping make agentic coding more accessible. You do not need to know how AI coding
tools or VS Code extensions work to contribute — some of the most useful help is non-code.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. Questions are welcome in
[Discussions](https://github.com/MohammadAsadolahi/CodeGent/discussions); see [SUPPORT.md](SUPPORT.md).

## Ways to help

- **Try it and tell us where you got stuck.** Follow the install steps in the [README](../README.md) on a
  clean machine and open an issue for every unclear step. CodeGent is developed and tested on Windows;
  reports from **macOS and Linux** are especially valuable.
- **Report ChatGPT page changes.** The ChatGPT page is not a stable API. When a run stops finding the
  box, the send button or the reply, open the browser extension's popup, press **Test ChatGPT page**,
  then **Copy report**, and paste it into a bug report. That report is exactly what a fix needs.
- **Improve the docs**: README, troubleshooting, FAQ, wording, translations.
- **Fix bugs and add tests.** Look for issues labelled `good first issue` or `help wanted`.
- **Share an honest demo or tutorial** — and link back to this repository.

## Before you start

For anything larger than a small fix, open an issue or a discussion first so we can agree on the
approach before you spend time on it. Keep pull requests focused: one change, one reason.

## Development setup

You need Node.js 20 or newer and git. The integration tests also need VS Code (the newest stable is
downloaded if none is found) and Chromium (`npx playwright-core install chromium`).

```bash
npm ci
npm run build              # every package; the VS Code extension ends up in apps/vscode/out
npm run typecheck
npm test                   # unit tests, no browser or VS Code needed
npm run format:check       # Prettier; `npm run format` fixes
```

Heavier suites, run them when your change touches the area:

```bash
npm run test:e2e           # the browser extension in a real Chromium against a mock ChatGPT page
npm run test:integration   # the VS Code extension inside a real VS Code
npm run package            # builds apps/vscode/codegent-<version>.vsix
```

`npm run test:live` sends real messages to chatgpt.com through your own signed-in browser. It is
opt-in, and you never need it for a pull request.

Press `F5` in VS Code with this repository open to start an Extension Development Host. The
[architecture overview](../docs/architecture.md) explains how the packages fit together.

## Conventions

- TypeScript, no semicolons, single quotes (Prettier decides; `.editorconfig` is respected).
- Every behaviour change comes with a test. The mock ChatGPT page in the browser tests exists so that
  page handling can be tested without a login; extend it rather than testing against the real site.
- Keep the safety rules in [docs/safety-and-privacy.md](../docs/safety-and-privacy.md) intact: edits are validated before anything is written, files
  with uncommitted or unsaved changes are left alone, ChatGPT never gets a channel to run commands, and
  the hub accepts only loopback connections from your editor and the CodeGent Bridge extension.
- No telemetry and no network calls other than the ones documented there.
- Commit messages use a short prefix: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- User-visible changes get a line under _Unreleased_ in [CHANGELOG.md](../CHANGELOG.md).

## Pull requests

1. Fork, branch from `main`, make your change.
2. Run `npm run format:check`, `npm run typecheck` and `npm test`. The pull request template asks what
   you ran — only tick what you actually ran.
3. Describe the problem you are solving and how you checked it. Screenshots help for panel changes.
4. Remove anything private: tokens, private repository names, logs with secrets.

Only submit work that is yours to submit, and say where anything you borrowed came from.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
