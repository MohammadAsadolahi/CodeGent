import {
  FORMAT_RULES,
  REPLY_FORMAT_EXAMPLE,
  STATUS_RULES,
  STATUS_LINES
} from './instructions'

export interface RepoContext {
  owner: string
  name: string
  host: string
  webUrl: string
  branch: string
  sha: string
  shortSha: string
  /** Subject line of the latest commit. */
  subject: string
}

export interface InitialPromptInput {
  repo: RepoContext
  task: string
  /** Standing project guidance from the user's settings (build tool, style, constraints …). */
  conventions?: string
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** The first message of a run: who the repository is, what to do and exactly how to answer. */
export const buildInitialPrompt = ({
  repo,
  task,
  conventions
}: InitialPromptInput): string => {
  const sections = [
    `You are a coding agent. You work on a GitHub repository through ChatGPT's GitHub connector, and a program on my computer called CodeGent applies the file changes you write and sends you the result, so you can continue step by step until the task is done.`,

    [
      '## Repository',
      `- Repository: ${repo.owner}/${repo.name} (${repo.webUrl})`,
      `- Branch: ${repo.branch}`,
      `- Latest commit: ${repo.shortSha} “${oneLine(repo.subject, 100)}” (${repo.sha})`,
      '',
      `Before you answer, use the GitHub connector to read the CURRENT contents of every file you intend to change or depend on, from branch "${repo.branch}". Never write a change from memory: files change between steps, and a SEARCH block that does not match the real file is rejected. If the connector cannot show you this repository or branch, do not guess — explain what you see and finish with ${STATUS_LINES.blocked}.`
    ].join('\n'),

    ['## Task', task.trim()].join('\n'),
    ...(conventions?.trim()
      ? [['## Project conventions', conventions.trim()].join('\n')]
      : []),

    [
      '## Complete the task in one pass',
      'Inspect all relevant files, tests and instructions before editing. Identify the full set of changes needed, check for conflicting guidance, and include related changes together in your reply. Do not send a plan, partial implementation, recap or request for another turn when you can complete the work now. Use the continue status only when real work remains or you need to act on CodeGent verification feedback; otherwise use done.',
      '',
      '## How to reply',
      '1. Start with one to three sentences saying what this reply accomplishes.',
      '2. Give every file change in the format below.',
      `3. Finish with the status line.`,
      '',
      'Example of a complete reply:',
      '',
      '````markdown',
      REPLY_FORMAT_EXAMPLE,
      '````',
      '',
      FORMAT_RULES,
      '',
      STATUS_RULES
    ].join('\n')
  ]
  return sections.join('\n\n')
}
