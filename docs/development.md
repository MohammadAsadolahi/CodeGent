# Development

[← Back to the README](../README.md) · Contribution rules: [CONTRIBUTING](../.github/CONTRIBUTING.md)

```bash
npm ci
npm run build              # every package; the VS Code extension ends up in apps/vscode/out
npm run typecheck
npm test                   # unit tests (protocol, hub, engine, browser extension, VS Code extension, webview)
npm run test:e2e           # the browser extension in a real Chromium against a mock ChatGPT page
npm run test:integration   # the VS Code extension inside a real VS Code, against a scripted browser,
                           # then against the real browser extension in Chromium and the mock page
npm run test:live          # opt-in, sends REAL messages: the whole loop against the real chatgpt.com,
                           # through the browser that is open and signed in (needs the extension loaded);
                           # works on a clone of this repository: commits locally, pushes nothing
npm run package            # builds apps/vscode/codegent-<version>.vsix
npm run test:package       # installs that .vsix like a user would and runs the integration tests on it
npm run release -- patch --dry-run   # the whole release check in a clean copy; publishes nothing (see Releasing)
npm run format
```

Press `F5` in VS Code with this repository open to start an Extension Development Host. The
integration tests need an installed VS Code (the newest stable is downloaded if none is found) and
the Chromium that `npx playwright-core install chromium` provides.

| Folder              | Contents                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/protocol` | Wire protocol: message types, validators, constants shared by every process                       |
| `packages/hub`      | The local relay and the code that starts it                                                       |
| `packages/engine`   | Everything testable without VS Code: reply parser, matcher, planner, prompts, git, the agent loop |
| `apps/vscode`       | The VS Code extension: adapters around the engine, the panel (Preact webview)                     |
| `apps/browser`      | The MV3 browser extension: service worker + the content script that drives chatgpt.com            |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit and why.

## Releasing

One command checks everything and publishes the result as the latest GitHub release. It needs Node.js
20+, git, and the [GitHub CLI](https://cli.github.com) signed in once (`gh auth login`; on Windows
`winget install --id GitHub.cli`). Publishing goes through `gh`, so no token ever passes through the
script, and the script is not part of anything that ships.

```bash
npm run release -- patch --dry-run   # a rehearsal: everything except commit, push and publish
npm run release -- patch             # 0.1.0 → 0.1.1; also `minor`, `major` or an exact version like 0.2.0
```

Add `--yes` to skip the question before pushing, `--prerelease` to publish a pre-release instead (GitHub
never shows those as "Latest"). In order, it:

1. **Looks before it leaps.** You are on `main` with a clean working tree and not behind `origin`; the
   version's tag and GitHub release do not exist yet; `gh` is installed and signed in.
2. **Works in a clean copy** of the repository in a temporary folder, so nothing in your working tree
   is touched until everything has passed (a dry run only ever writes the git-ignored `release/`
   folder). The version moves there: every `package.json`, the lockfile, `CITATION.cff`, the download
   names in the README, and `## Unreleased` in the CHANGELOG becomes the new version's section.
3. **Checks everything in that copy**: `npm ci`, formatting, build, type check, unit tests, the browser
   extension end to end in Chromium and the VS Code extension inside a real VS Code (both against the
   minified build that ships), then `npm run package` and the installed-package test. What each step
   printed is kept in `release/v<version>/logs`.
4. **Builds and inspects the files** in `release/v<version>/`: `codegent-<version>.vsix`, the browser
   extension zip (made from the copy inside the `.vsix`, so both hold the same bytes) and the release
   notes taken from the CHANGELOG. It checks versions, that every file the manifest names is there,
   that the browser extension uses the default hub ports and not the ones the tests use, that no
   sources or source maps ship, and that no browser permission is new since the last release without
   being explained in [safety-and-privacy](safety-and-privacy.md).
5. **Publishes**, after you confirm: commits the version change on `main` (byte for byte what was
   checked in the copy), pushes, uploads the files to a draft release, publishes it as the latest
   release, and finally downloads the files from GitHub and compares their checksums.

Do not commit to the repository while it runs: it notices and stops before pushing. If a check fails,
nothing was pushed or published; fix the cause and run it again. If publishing fails after the push, the
script removes the draft it made and says so; the release commit stays on `main`, and running
`npm run release -- <that version>` again publishes it without making another commit.
