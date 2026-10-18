# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working on this repository.

## What this project is

CodeGent runs an agent loop on a ChatGPT web account: a VS Code extension sends a task to chatgpt.com
through a browser extension and a local hub, ChatGPT reads the repository through its GitHub
connector and answers with file changes, CodeGent applies, checks, commits and pushes them, then
reports the result back into the same chat. See [README.md](README.md) and
[docs/architecture.md](docs/architecture.md).

## Layout

| Path                | Contents                                                                           |
| ------------------- | ---------------------------------------------------------------------------------- |
| `packages/protocol` | Wire protocol: message types, validators, constants                                |
| `packages/hub`      | Local relay on `127.0.0.1`                                                         |
| `packages/engine`   | Reply parser, SEARCH/REPLACE matcher, planner, prompts, git, the loop (no VS Code) |
| `apps/vscode`       | VS Code extension and the Preact panel                                             |
| `apps/browser`      | MV3 browser extension; `src/content` is the only code that knows chatgpt.com's DOM |

## Commands

```bash
npm ci
npm run build
npm run typecheck
npm test                 # run before every change is considered done
npm run format:check     # `npm run format` to fix
npm run test:e2e         # browser extension in real Chromium against a mock ChatGPT page
npm run test:integration # VS Code extension inside a real VS Code
```

Do not run `npm run test:live` unless asked: it sends real messages to chatgpt.com.

## Rules

- Match the surrounding code: TypeScript, no semicolons, single quotes, Prettier config in the repo.
- A behaviour change needs a test. ChatGPT page handling is tested against the mock page, never the
  real site.
- Keep the safety invariants (README, _Safety_): validate every edit before writing, never touch files
  with uncommitted or unsaved changes, never give ChatGPT a way to run commands, keep the hub
  loopback-only with the origin allow-list.
- No telemetry, no new network destinations, no new browser-extension permissions without a documented
  reason in the README's _Privacy_ section.
- Selectors for chatgpt.com live in `apps/browser/src/content/selectors.ts` with ordered fallbacks;
  fix page breakage there, not by scattering selectors.
- User-visible changes get a line in `CHANGELOG.md` under _Unreleased_.
- Never commit secrets, and never claim a test passed that you did not run.
