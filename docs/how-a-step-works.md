# What a step looks like

[← Back to the README](../README.md) · How the pieces fit together: [architecture](architecture.md)

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
