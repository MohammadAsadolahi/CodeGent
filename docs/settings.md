# Settings

[← Back to the README](../README.md)

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
