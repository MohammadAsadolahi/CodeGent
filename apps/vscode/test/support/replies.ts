/** Builders for the replies ChatGPT is asked to write (see the engine's reply format). */
const fence = (body: string, lang = 'txt') => `\`\`\`${lang}\n${body}\n\`\`\``

export const createdFile = (path: string, content: string): string =>
  `### Created file: \`${path}\`\n\n${fence(content)}`

export const updatedFile = (
  path: string,
  search: string,
  replace: string,
  lang?: string
): string =>
  `### Updated file: \`${path}\`\n\n${fence(`<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`, lang)}`

export const deletedFile = (path: string): string => `### Deleted file: \`${path}\``

export const chatReply = (
  summary: string,
  parts: string[],
  status?: 'continue' | 'done' | 'blocked'
): string =>
  [summary, '', ...parts, ...(status ? ['', `CODEGENT_STATUS: ${status}`] : [])].join(
    '\n'
  )
