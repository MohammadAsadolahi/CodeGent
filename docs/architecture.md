# Architecture

CodeGent turns a ChatGPT conversation into an agent loop without any API: the VS Code extension
drives, a browser extension is its hands on chatgpt.com, and a small local hub connects the two.

```
┌──────────────── VS Code ─────────────────┐        ┌────────── Chromium ───────────┐
│ panel (webview) ◀──▶ App                 │        │ CodeGent Bridge (MV3)         │
│                      │                   │        │  service worker ◀▶ content    │
│  RunManager ─ AgentRun (engine)          │   WS   │  script on chatgpt.com        │
│     │            │   │                   │ ◀────▶ │   fill · submit · wait ·      │
│  FsWorkspace  RepoService  BridgeChat    │  hub   │   read the reply as markdown  │
│  VsCodeChecks      │          │          │        └───────────────────────────────┘
└───────────────────┼──────────┼───────────┘
                    ▼          ▼
                  git ◀──▶ GitHub ◀── ChatGPT's GitHub connector
```

## Packages

| Package             | Role                                                                                                                                                      | Runs in                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/protocol` | Message types, runtime validators, constants (ports, limits), id helpers, hub discovery. Pure TypeScript                                                  | everywhere                                                   |
| `packages/hub`      | The relay (`Hub`), its entry point, and `ensureHub` which finds or starts it                                                                              | a detached Node process (VS Code's own Electron run as Node) |
| `packages/engine`   | The reply parser, SEARCH/REPLACE matcher, change planner, prompt builders, git client, and `AgentRun` — the loop as a state machine whose I/O is injected | the VS Code extension host (and plain Node in tests)         |
| `apps/vscode`       | Adapters that give the engine VS Code-flavoured ports (workspace, checks, chat), the panel, commands, settings                                            | the extension host + a webview                               |
| `apps/browser`      | The MV3 extension: a service worker that owns the hub connection and the job router, and a content script that drives ChatGPT                             | the browser                                                  |

## The loop (`packages/engine/src/loop`)

`AgentRun` takes ports — `chat`, `workspace`, `git`, `checks`, `approval` — and moves through
_preparing → sending → waiting → reading → (approval) → applying → checking → publishing → feeding
back_. Everything it needs from the outside world is behind those ports, so the whole loop is tested
with fakes (every transition and failure), and the same loop runs against real adapters in VS Code.

- **Policies.** A step cap, a repeated-failure cap ("stuck"), one automatic format reminder, `done` is
  not accepted while diagnostics or the verify command report errors, Stop works at any point (a reply
  that arrives after Stop is dropped), and a declined review is reported back to ChatGPT.
- **Pauses are resumable.** If a push fails after files were applied and committed, _Resume_ continues
  at the push — nothing is applied or committed twice. Chat errors (rate limit, sign-in, no browser,
  timeout) resume by sending the identical message again.
- **Publishing is truthful.** ChatGPT reads GitHub, so each step is committed (only the touched paths)
  and pushed, and the follow-up names the commit to look for — or says it is _not_ on GitHub.

## Reply format (`packages/engine/src/edits`)

Replies use headings plus fenced blocks, with no line numbers (chat models are unreliable at them):

````
### Updated file: `src/greeting.ts`
```ts
<<<<<<< SEARCH
old lines
=======
new lines
>>>>>>> REPLACE
```
### Created file: `src/new.ts`
```ts
whole new file
```
CODEGENT_STATUS: continue
````

The parser is tolerant of harmless variations (bold or backticked headings, any fence length, CRLF) and
strict where it matters: only a heading's first block defines content, loose code samples are never
edits, and unterminated or cut-off blocks are reported as problems, not guessed. The matcher tries
exact → trailing-space-insensitive → indentation-insensitive (re-indenting the replacement) → collapsed
spaces → blank-line-insensitive; **ambiguity is an error**. Changes are _planned_ in memory on an
overlay (create, update, replace, delete, rename in order), then written together:

- each file is all-or-nothing, files are independent, failures are reported per file;
- paths are sandboxed (no `..`, no `.git`, no absolute paths elsewhere, no forbidden characters);
- binary, git-ignored and dirty files (uncommitted changes or unsaved editor buffers) are not edited;
- a whole-file replacement that shrinks a large file drastically is refused.

The prompt's own format example is parsed in a test, so the prompt and the parser cannot drift apart.

## The hub (`packages/hub`)

- Binds `127.0.0.1` only; `GET /health` answers `{service: "codegent-hub", protocol}`. Candidate ports
  are 47615–47619, probed in parallel by both sides, so a foreign program on a port is harmless.
- The WebSocket handshake checks `Host`, the protocol version and `Origin`. An _editor_ peer must send
  no `Origin`. A _browser_ peer must come from an extension origin, and when the editor started the hub
  it passed the allow-list: the bundled browser extension's origin — its id follows from the `key`
  pinned in its manifest, so it is known before the extension ever runs — plus any ids the user
  added. Web pages cannot connect (their origin is not an extension's), other extensions cannot
  either, and there are no CORS headers.
- Roles: editors send jobs and cancels; browsers send events. Peers use random UUIDs that survive
  reconnects. A job's `editorId` must be its sender's (no spoofing); events reach only the originating
  editor.
- A bounded mailbox per editor replays events produced while its window reloads. Application-level
  ping/pong (10 s) also keeps MV3 service workers alive; silent peers are dropped after 35 s.
- It exits 60 s after the last editor leaves, runs in the temp folder (so it never locks a project), and
  `shutdown` from an editor stops it (the _Restart Hub_ command).

## The browser extension (`apps/browser`)

- The **service worker** owns the hub WebSocket (discovery, backoff, watchdog, an ordered outbox
  persisted in `storage.session`), a **job router** (session → tab map and active jobs, persisted), and
  opens or reuses ChatGPT tabs (falling back to a new window when the browser has none).
- The **content script** is the only code that knows ChatGPT's page. It announces _ready_; the worker
  answers with the pending job (no URL-hash hand-off, so redirects and logins cannot lose a job). It
  fills the composer with three verified strategies, submits (button, then Enter), detects completion
  (stop button gone, turn complete, text stable), converts the answer DOM to markdown with correctly
  sized code fences, and detects sign-in walls, challenges, rate limits and banners. All selectors live
  in one module with ordered fallbacks, and the popup's **Test ChatGPT page** reports which match.
  The page draws one container per exchange (your message, the agent's activity, the assistant's message,
  a row of buttons); the reply is the assistant's message in it, found by the markers the page puts on
  messages (the author attribute it used to carry, or the `…:assistant` search-unit key it carries now)
  and read from the body the page itself copies from (`data-markdown-copy`). When no marker is left, the
  reply is whatever follows the prompt's own text inside the first new container, so a future redesign
  degrades instead of breaking. Code blocks are recognised without `<pre>`: a `<code>` that spans lines or
  stands alone outside a sentence is a block, and the language strip with the Copy button is page chrome.
  The stop button is the only signal that _proves_ a reply is still streaming; other hints (a streaming class, a turn that is not in a final
  state) can go stale and only delay acceptance by a few seconds. A run never waits silently for a reply
  it cannot see: once generation has visibly ended and nothing readable is on the page, it fails within
  seconds, and every timeout carries `[Page: …]`, a structure-only description of the page (counts,
  attribute names, text lengths — never conversation text).
- A killed service worker is woken by the page: open ChatGPT tabs ping it every 10 s.
- Tests never touch the real site: Chromium resolves `chatgpt.com` to a local HTTPS mock with a real
  ProseMirror composer.

## The VS Code extension (`apps/vscode`)

- `App` wires everything: `HubConnection` (find or start the hub, reconnect, same identity after a
  hub restart) → `BridgeChat` (a `ChatPort`: submit a job, wait for its events, cancel, choose a
  browser) → the engine; `RepoService` and `FsWorkspace` (read, all-or-nothing writes with rollback,
  symlink-escape check, checkpoints and undo); `VsCodeChecks` (diagnostics, verify command);
  `RunManager` (the panel's view of a run, review decisions, history, an _in-progress_ marker so a
  closed window leaves an "interrupted" history entry).
- **Diagnostics need a visible editor.** Language servers (TypeScript, JSON, …) only analyse files that
  are shown, so the changed files are briefly revealed in a side editor group without taking focus and
  closed again; errors are reported as a delta against a baseline taken just before the step.
- The panel is a Preact webview with a CSP and nonce. It is **not trusted**: it displays text that
  originates from ChatGPT, so rendering is escaped and every message it sends is validated in the
  extension (paths go through the same sandbox as edits, only `https:` links open, diffs are looked up by
  name among the current changes).
- `verifyCommand` is machine-scoped, so a repository cannot set a command that CodeGent would run.

## Testing

| Layer                 | How                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protocol, hub, engine | Vitest: table-driven and property-based tests (random files, line endings, indentation), real sockets and child processes, real `git` repositories with a bare remote                                                                           |
| browser extension     | jsdom unit tests; end-to-end in a real Chromium with the extension loaded against the mock ChatGPT page (job round trip, follow-ups, reopening a closed conversation, cancel, signed-out, hub restart, service-worker kill)                     |
| webview               | jsdom, with a fake of VS Code's webview API; hostile strings must render as text                                                                                                                                                                |
| VS Code extension     | Inside a real VS Code (`@vscode/test-electron`, isolated profile): first against a scripted browser speaking the real protocol, then against the real browser extension in Chromium and the mock page — the whole product except ChatGPT itself |

The mock ChatGPT page exists in three generations — the one with test ids and per-message author
attributes, the page as captured on 2026-10-18 (one container per exchange, one send/stop button,
no `<pre>` around code), and an invented minimal one that exercises the generic fallback — and the
browser tests run against all of them. What cannot be tested offline is
ChatGPT's real page and GitHub connector; `npm run test:live` is the opt-in test for that (it sends real
messages from the signed-in account), next to the popup's self-test.
