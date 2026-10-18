import { describe, expect, it } from 'vitest'
import { normalizeRepoPath } from '../src'

const ok = (raw: string, root?: string) => {
  const result = normalizeRepoPath(raw, { workspaceRoot: root })
  if (!result.ok) throw new Error(`expected ok for ${JSON.stringify(raw)}, got: ${result.reason}`)
  return result.path
}
const rejected = (raw: string, root?: string) => {
  const result = normalizeRepoPath(raw, { workspaceRoot: root })
  if (result.ok) throw new Error(`expected rejection for ${JSON.stringify(raw)}, got: ${result.path}`)
  return result.reason
}

describe('normalizeRepoPath — accepted forms', () => {
  it.each([
    ['src/app.ts', 'src/app.ts'],
    ['./src/app.ts', 'src/app.ts'],
    ['src//nested///file.ts', 'src/nested/file.ts'],
    ['src\\windows\\style.ts', 'src/windows/style.ts'],
    ['  `src/quoted.ts`  ', 'src/quoted.ts'],
    ['"src/double.ts"', 'src/double.ts'],
    ["'src/single.ts'", 'src/single.ts'],
    ['README.md', 'README.md'],
    ['Dockerfile', 'Dockerfile'],
    ['.gitignore', '.gitignore'],
    ['.github/workflows/ci.yml', '.github/workflows/ci.yml'],
    ['packages/@scope/pkg/index.ts', 'packages/@scope/pkg/index.ts'],
    ['app/(group)/[id]/page.tsx', 'app/(group)/[id]/page.tsx'],
    ['dir with spaces/file name.txt', 'dir with spaces/file name.txt'],
    ['src/ünïcode/日本語.ts', 'src/ünïcode/日本語.ts']
  ])('%s → %s', (raw, expected) => {
    expect(ok(raw)).toBe(expected)
  })

  it('treats a leading slash as "from the repository root"', () => {
    expect(ok('/src/app.ts')).toBe('src/app.ts')
  })

  it('converts absolute paths inside the workspace into relative ones', () => {
    expect(ok('/home/me/project/src/a.ts', '/home/me/project')).toBe('src/a.ts')
    expect(ok('C:\\Users\\me\\project\\src\\a.ts', 'C:\\Users\\me\\project')).toBe('src/a.ts')
    expect(ok('c:/users/me/project/src/a.ts', 'C:\\Users\\Me\\Project\\')).toBe('src/a.ts')
  })
})

describe('normalizeRepoPath — rejected forms', () => {
  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['`  `', /empty/],
    ['../escape.ts', /leaves the repository/],
    ['src/../../escape.ts', /leaves the repository/],
    ['..\\escape.ts', /leaves the repository/],
    ['src/ok/../../../../etc/passwd', /leaves the repository/],
    ['.git/config', /\.git/],
    ['src/.git/hooks/pre-commit', /\.git/],
    ['.GIT/config', /\.git/],
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', /outside the repository/],
    ['D:/data/file.txt', /outside the repository/],
    ['src/bad\u0000name.ts', /not allowed/],
    ['src/new\nline.ts', /not allowed/],
    ['src/what?.ts', /not allowed/],
    ['src/star*.ts', /not allowed/],
    ['src/pipe|name.ts', /not allowed/],
    ['src/dir/', /directory/],
    ['.', /empty/],
    ['./', /empty/]
  ])('%j is rejected', (raw, reason) => {
    expect(rejected(raw)).toMatch(reason)
  })

  it('rejects absolute paths outside the workspace root on Windows drives', () => {
    expect(rejected('D:\\other\\a.ts', 'C:\\project')).toMatch(/outside the repository/)
  })

  it('rejects over-long paths', () => {
    expect(rejected('a/'.repeat(600) + 'x.ts')).toMatch(/too long/)
  })

  it('does not treat names that merely contain "git" as git data', () => {
    expect(ok('src/gitHelper.ts')).toBe('src/gitHelper.ts')
    expect(ok('.gitattributes')).toBe('.gitattributes')
    expect(ok('docs/.github/readme.md')).toBe('docs/.github/readme.md')
  })
})
