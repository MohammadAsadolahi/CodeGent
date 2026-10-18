# Development

[← Back to the README](../README.md) · Contribution rules: [CONTRIBUTING](../CONTRIBUTING.md)

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
