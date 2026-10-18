# CodeGent

[![CI](https://github.com/MohammadAsadolahi/CodeGent/actions/workflows/ci.yml/badge.svg)](https://github.com/MohammadAsadolahi/CodeGent/actions/workflows/ci.yml)
![VS Code 1.96+](https://img.shields.io/badge/VS%20Code-1.96%2B-007acc)
![Chromium 116+](https://img.shields.io/badge/Chromium-116%2B-4285f4)
![No API keys, no telemetry](https://img.shields.io/badge/API%20keys%20%C2%B7%20telemetry-none-brightgreen)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

**Agentic coding on a free ChatGPT account.** You describe a task in VS Code. ChatGPT reads the
latest code of your repository from GitHub, answers with file changes, CodeGent applies them to your
working tree, checks them, commits and pushes them, and sends the result back into the same chat so
ChatGPT can take the next step — until the task is done. No API keys, no copy and paste.

> **Status: early release (0.1.0).** The whole loop works and is tested, but CodeGent was developed on
> Windows and drives a web page it does not control, so expect rough edges — see
> [Known limitations](#known-limitations). Bug reports and ChatGPT-page reports are the most useful
> thing you can send; see [Contributing](#contributing).

**Why?** A chatbot can suggest code; _agentic_ coding goes further: change the code, check what
happened, and use the result to decide the next step. That loop usually needs a paid coding-agent
subscription or an API key. CodeGent builds it around the ChatGPT account you already have, so
students, hobbyists and anyone on a tight budget can try — and learn — how agentic coding works.

```
 VS Code (CodeGent) ──▶ local hub ──▶ browser extension ──▶ chatgpt.com (your own signed-in tab)
        ▲                                                         │
        └── apply · check · commit · push ◀── reply as markdown ◀─┘
                       │
                       └──▶ GitHub ◀── ChatGPT reads the new code through its GitHub connector
```

CodeGent has three small parts:

- **The VS Code extension** — the panel, the agent loop, applying edits, git.
- **The browser extension ("CodeGent Bridge")** — types into your ChatGPT tab and reads the answer.
- **A tiny local hub** — started by the VS Code extension; relays messages between the two on
  `127.0.0.1` only.

## What you need

|         |                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code | 1.96 or newer, with a folder that is a **git repository whose remote is on GitHub**                                                               |
| Browser | Chrome, Edge, Brave or another Chromium browser (116+). Firefox is not supported yet                                                              |
| ChatGPT | A ChatGPT account (the free plan is the target) that is **signed in** in that browser, with the **GitHub connector** connected to your repository |
| git     | On your `PATH`, with credentials that can push to the repository                                                                                  |

Developed and tested on Windows. Nothing in the code is Windows-specific, but macOS and Linux have
not been tried yet.

## Install

1. **VS Code extension.** Get the `.vsix` (from a release, or build it yourself with
   `npm run package`, see _Development_) and install it: `code --install-extension codegent-0.1.0.vsix`
   or _Extensions → … → Install from VSIX_. Open your project folder; the **CodeGent** icon appears in
   the activity bar.
2. **Browser extension.** The CodeGent panel shows a _Setup_ checklist. Under _Browser extension
   connected_ it shows the folder to load. In the browser open `chrome://extensions` (or
   `edge://extensions`), turn on **Developer mode**, choose **Load unpacked** and select that folder.
   The _Show folder_ and _Copy path_ buttons help. The panel's _Browser_ chip turns green once the
   extension has found the hub.
3. **ChatGPT.** Open <https://chatgpt.com> in the same browser and sign in. In ChatGPT's settings
   connect the **GitHub** connector (it may be called an _app_ in your version) and allow it to read
   your repository. How GitHub access is offered depends on your plan and region; if you use a
   ChatGPT _Project_ that already has the connector enabled, set its URL as the **Chat URL**
   (`codegent.chatUrl`) so runs start inside it.

## Use it

1. Open the CodeGent panel and write what you want — be specific; ChatGPT reads the repository
   itself, so you do not need to paste code.
2. Press **Start** (or `Ctrl+Enter`). The first time, CodeGent asks whether it may **commit and push**
   each step (ChatGPT can only see changes that are on GitHub); the answer is remembered per
   repository.
3. Watch the run: each step shows what ChatGPT changed (click a file to open it, the diff button to
   see exactly what changed), what the language servers and your verify command found, and the
   commit. **Stop** is always available, and **Undo this step** puts a step's files back in your
   working tree.

Useful commands (Command Palette → _CodeGent_): _Start Task…_, _Stop_, _Resume_, _Undo Last Step_,
_Reconnect to the Browser (Restart Hub)_, _Show Log_, _Show Browser Extension Folder_,
_Ask Again Before Committing and Pushing_.

### What a step looks like

1. CodeGent sends ChatGPT a message: the repository (owner/name, branch, commit), the task, and a
   strict reply format. It tells ChatGPT to read the files from GitHub first.
2. ChatGPT answers with `SEARCH`/`REPLACE` edits and whole new files, plus a status line
   (`continue`, `done` or `blocked`).
3. CodeGent parses the reply, plans every change in memory, and refuses what is unsafe (see below).
   With _Apply automatically_ off it shows the proposed changes for review first.
4. It writes the files, collects errors from your language servers, runs your verify command (if any),
   commits **only the files it changed** and pushes.
5. It sends the outcome back into the same conversation — what applied, what failed and why (with the
   closest matching lines), new errors, the commit to look for — and ChatGPT continues. The run ends
   when ChatGPT says `done` or `blocked`, a limit is reached, something needs you, or you press Stop.

## Settings

All settings are under **CodeGent** in the VS Code settings. The first five are also toggles in the
panel.

| Setting                                      | Default                | Meaning                                                                                 |
| -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `codegent.autoSubmit`                        | on                     | Press send in ChatGPT for you. Off: the prompt is typed in and you press Enter          |
| `codegent.autoApply`                         | on                     | Apply changes without asking. Off: review each step first                               |
| `codegent.autoContinue`                      | on                     | Send each result back automatically. Off: pause after every step                        |
| `codegent.git.commit`                        | on                     | Commit the files each step changed (only those)                                         |
| `codegent.git.push`                          | on                     | Push after each commit so ChatGPT can read the new code                                 |
| `codegent.git.commitPrefix`                  | `codegent: `           | Prefix of commit messages                                                               |
| `codegent.maxSteps`                          | 12                     | Stop after this many ChatGPT replies                                                    |
| `codegent.maxFailedSteps`                    | 3                      | Stop after this many steps in a row whose changes could not be applied                  |
| `codegent.allowEditingDirtyFiles`            | off                    | Allow changes to files that have uncommitted changes (off: such files are left alone)   |
| `codegent.chatUrl`                           | `https://chatgpt.com/` | Where new conversations start (only chatgpt.com is accepted)                            |
| `codegent.replyTimeoutSeconds`               | 600                    | How long to wait for ChatGPT to finish a reply                                          |
| `codegent.browserWaitSeconds`                | 40                     | How long to wait for the browser extension to connect                                   |
| `codegent.conventions`                       | empty                  | Standing guidance added to the first message of every run                               |
| `codegent.verifyCommand`                     | empty                  | A command run after each step that changed files, e.g. `npm test`. User settings only   |
| `codegent.verifyTimeoutSeconds`              | 300                    | Time limit for the verify command. User settings only                                   |
| `codegent.diagnosticsWaitSeconds`            | 8                      | How long to let language servers analyse changed files. `0` skips the check             |
| `codegent.advanced.hubPorts`                 | empty                  | Ports the hub uses (default 47615–47619); the browser extension must use the same       |
| `codegent.advanced.extraBrowserExtensionIds` | empty                  | Ids of additional browser extensions that may connect (your own build, a store version) |

Tip: a verify command such as `npx tsc --noEmit` or `npm test` gives ChatGPT the feedback it cannot
get on its own, and a failing command stops it from declaring the task done.

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

## Troubleshooting

| Symptom                                                                                                                       | What to do                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Hub_ chip is red                                                                                                             | Click it, or run **Reconnect to the Browser (Restart Hub)**. _Show Log_ tells why it could not start (a firewall blocking local ports 47615–47619, or another program using all of them)                                                                                           |
| _Browser_ chip is red                                                                                                         | Load the browser extension (see Install). Keep the browser open. In the extension's popup it should say _Connected to VS Code_; if not press **Reconnect**                                                                                                                         |
| _Browser_ chip stays red, the popup says _Not connected_, and the hub log says _browser extension … is not on the allow-list_ | You loaded a build of the browser extension whose id differs from the bundled one. Add its id to `codegent.advanced.extraBrowserExtensionIds`, then run **Reconnect to the Browser (Restart Hub)**                                                                                 |
| _Browser (2)_ is amber                                                                                                        | Several browsers/profiles are connected. Click it and choose one; give each a name in the popup's _Profile name_                                                                                                                                                                   |
| _ChatGPT_ chip is amber                                                                                                       | Open <https://chatgpt.com> in that browser and sign in (a tab is also opened automatically when a run starts)                                                                                                                                                                      |
| Run pauses with a sign-in or _verify you are human_ message                                                                   | Fix it in the ChatGPT tab, then press **Resume** — the same message is sent again                                                                                                                                                                                                  |
| Run pauses with a rate-limit message                                                                                          | Free plans have message limits. Wait, then **Resume**                                                                                                                                                                                                                              |
| _The push to GitHub failed … Pull_                                                                                            | GitHub has commits you do not have. Pull them yourself (CodeGent never merges for you), then **Resume**                                                                                                                                                                            |
| _GitHub has N commits that you do not have locally_ when starting                                                             | Pull first: ChatGPT reads GitHub, so its changes would not match your files                                                                                                                                                                                                        |
| ChatGPT talks about files that do not exist or are old                                                                        | The connector may serve a cached view or may not have access to the repository. Re-connect GitHub in ChatGPT and check the repository is allowed; a push is needed before ChatGPT can see a change                                                                                 |
| _Reply was cut off_ / format reminders                                                                                        | ChatGPT's answer was too long or off-format. CodeGent asks once for the rest; for big changes, ask for smaller steps                                                                                                                                                               |
| Nothing is typed into ChatGPT                                                                                                 | Click the extension's **Test ChatGPT page** in its popup: it reports which parts of the page it can find. ChatGPT's page changes over time; this report is what a bug report needs                                                                                                 |
| _ChatGPT did not finish replying in time_, or _could not find its reply on the page_                                          | ChatGPT's page changed (it did in October 2026). The message ends with `[Page: …]`, a one-line description of what the extension saw — include it in a bug report, together with the popup's **Test ChatGPT page** → **Copy report**. The reply itself is still in the ChatGPT tab |
| A tab opens but nothing else happens                                                                                          | The extension needs to be allowed on `chatgpt.com`; check `chrome://extensions` → CodeGent Bridge → _Site access_                                                                                                                                                                  |
| Errors from language servers never show up                                                                                    | The server may not analyse files that are not on screen; CodeGent shows the changed files briefly in a side editor to ask. A verify command (`tsc`, tests, lint) is the dependable alternative                                                                                     |

Logs: **CodeGent: Show Log** (Output panel). The hub also writes `hub.log` in the extension's global
storage folder.

## Known limitations

- ChatGPT's GitHub connector decides what ChatGPT can see; CodeGent can only push, wait and tell it which
  commit to look for.
- One repository per window (the first workspace folder); Chromium-based browsers only.
- Local windows only. In a remote window (SSH, Dev Containers, Codespaces) the extension runs on the
  remote machine, whose `127.0.0.1` is not your browser's, so the two cannot find each other.
- A run cannot be resumed after VS Code is closed or reloaded; it is recorded as _interrupted_ in the
  history (steps already applied stay in your tree and in git).
- The ChatGPT page is not a stable API. The browser extension keeps all page-specific code in one
  module and has a self-test, but a ChatGPT redesign can break it until it is updated.

## FAQ

**Can I use ChatGPT Free with VS Code for agentic coding?**
That is what CodeGent is for: the loop runs in your own signed-in ChatGPT tab, with no API key.
Whether the GitHub connector and how many messages you get depend on OpenAI's plans and region, and can
change — CodeGent does not lift any limit (a run pauses on a rate limit and you press **Resume**).

**Is there a coding agent that uses ChatGPT in the browser, without an API key?**
Yes, this one: a VS Code extension, a Chromium extension and a local hub, all in this repository.

**How do I get an edit → test → feedback loop with ChatGPT?**
Set a verify command (`codegent.verifyCommand`, for example `npm test`). After each step CodeGent
runs it, together with the language servers' error check, and sends the output back to ChatGPT; a
failing command stops it from declaring the task done.

**Does ChatGPT run commands on my computer or write to my repository?**
No. ChatGPT only answers with text. CodeGent applies validated edits itself and runs only git and
your own verify command. See [Safety](#safety).

**Does anything leave my machine besides the chat with ChatGPT?**
Only what [Privacy](#privacy) lists: the conversation with ChatGPT and the pushes to your own git
remote. There is no CodeGent server and no telemetry.

**Is this affiliated with OpenAI, GitHub or Microsoft?**
No. CodeGent is an independent community project, not endorsed by those companies. Automating a
consumer web page may conflict with its terms — see [Responsible use](#responsible-use).

## Contributing

CodeGent is free to use, and contributions are welcome. You do not need to be an expert to help. Trying the install steps on macOS or Linux, reporting where
you got stuck, improving these docs, or sending a **Test ChatGPT page** report when ChatGPT's page
changes are all valuable. Start with [CONTRIBUTING.md](CONTRIBUTING.md); ask questions in
[Discussions](https://github.com/MohammadAsadolahi/CodeGent/discussions) and report problems as
[issues](https://github.com/MohammadAsadolahi/CodeGent/issues/new/choose). Please read the
[Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in
[SECURITY.md](SECURITY.md).

If CodeGent is useful to you, a star helps other people find it — and a bug report or a pull request
helps even more.

## Development

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
