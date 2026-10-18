import {
  BinaryFileError,
  ChatError,
  GitError,
  type AgentDeps,
  type ApplyReceipt,
  type ApprovalDecision,
  type ApprovalPort,
  type ChatPort,
  type ChatReply,
  type ChatRequest,
  type ChecksPort,
  type DiagnosticsSummary,
  type FileChange,
  type GitPort,
  type RepoContext,
  type VerifyResult,
  type WorkspacePort,
  type WorkspaceView
} from '../src'

export const REPO: RepoContext = {
  owner: 'octo',
  name: 'project',
  host: 'github.com',
  webUrl: 'https://github.com/octo/project',
  branch: 'main',
  sha: '1'.repeat(40),
  shortSha: '1111111',
  subject: 'Initial commit'
}

// ── reply builders (what ChatGPT would write) ─────────────────────────────────────────────────
export const fence = (body: string, lang = 'ts') => `\`\`\`${lang}\n${body}\n\`\`\``
export const updateReply = (path: string, search: string, replace: string) =>
  `### Updated file: \`${path}\`\n\n${fence(`<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`)}`
export const createReply = (path: string, content: string) => `### Created file: \`${path}\`\n\n${fence(content)}`
export const deleteReply = (path: string) => `### Deleted file: \`${path}\``
export const reply = (summary: string, parts: string[], status?: 'continue' | 'done' | 'blocked') =>
  [summary, '', ...parts, ...(status ? ['', `CODEGENT_STATUS: ${status}`] : [])].join('\n')

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────
type Scripted = string | Error | ((request: ChatRequest) => string | Promise<string>)

export class ScriptedChat implements ChatPort {
  readonly sent: ChatRequest[] = []
  constructor(private readonly script: Scripted[]) {}

  async send(request: ChatRequest): Promise<ChatReply> {
    this.sent.push(request)
    request.onProgress?.('tab-ready')
    const next = this.script.shift()
    if (next === undefined) throw new Error('the script ran out of replies')
    if (next instanceof Error) throw next
    const markdown = typeof next === 'function' ? await next(request) : next
    return { markdown, conversationUrl: 'https://chatgpt.com/c/test-conversation', durationMs: 5 }
  }

  get texts(): string[] {
    return this.sent.map((request) => request.text)
  }
}

export class MemoryWorkspace implements WorkspacePort {
  readonly files = new Map<string, string>()
  readonly dirty = new Set<string>()
  readonly binary = new Set<string>()
  readonly applied: FileChange[][] = []
  failNextApply: Error | null = null

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.files.set(path, content)
  }

  readonly view: WorkspaceView = {
    read: async (path) => {
      if (this.binary.has(path)) throw new BinaryFileError()
      return this.files.get(path) ?? null
    },
    isDirty: async (path) => this.dirty.has(path)
  }

  async apply(changes: readonly FileChange[]): Promise<ApplyReceipt> {
    if (this.failNextApply) {
      const error = this.failNextApply
      this.failNextApply = null
      throw error
    }
    this.applied.push([...changes])
    for (const change of changes) {
      if (change.kind === 'create' || change.kind === 'modify') this.files.set(change.path, change.after)
      else if (change.kind === 'delete') this.files.delete(change.path)
      else {
        this.files.delete(change.from)
        this.files.set(change.to, change.after)
      }
    }
    return { id: `receipt-${this.applied.length}`, paths: changes.map((c) => (c.kind === 'rename' ? c.to : c.path)) }
  }
}

export class FakeGit implements GitPort {
  readonly commits: Array<{ paths: string[]; message: string }> = []
  pushes = 0
  /** Errors thrown by successive push() calls; empty means pushes succeed. */
  pushFailures: Error[] = []
  commitFailures: Error[] = []
  contextError: Error | null = null
  nothingToCommit = false
  private counter = 1

  async context(): Promise<RepoContext> {
    if (this.contextError) throw this.contextError
    return REPO
  }
  async commit(paths: readonly string[], message: string) {
    const failure = this.commitFailures.shift()
    if (failure) throw failure
    if (this.nothingToCommit) return { committed: false }
    this.commits.push({ paths: [...paths], message })
    this.counter += 1
    const sha = String(this.counter).repeat(40).slice(0, 40)
    return { committed: true, sha, shortSha: sha.slice(0, 7) }
  }
  async push() {
    const failure = this.pushFailures.shift()
    if (failure) throw failure
    this.pushes += 1
    return { branch: 'main', remote: 'origin' }
  }
}

export class FakeChecks implements ChecksPort {
  readonly prepareCalls: string[][] = []
  readonly diagnosticsCalls: string[][] = []

  async prepare(existingPaths: readonly string[]): Promise<void> {
    this.prepareCalls.push([...existingPaths])
  }
  diagnosticsQueue: DiagnosticsSummary[] = []
  verifyQueue: Array<VerifyResult | undefined> = []
  verifyCalls = 0

  async diagnostics(paths: readonly string[]): Promise<DiagnosticsSummary> {
    this.diagnosticsCalls.push([...paths])
    return this.diagnosticsQueue.shift() ?? { items: [], errors: 0, warnings: 0 }
  }
  async verify(): Promise<VerifyResult | undefined> {
    this.verifyCalls += 1
    return this.verifyQueue.shift()
  }
}

export class ScriptedApproval implements ApprovalPort {
  readonly reviews: Array<{ step: number; paths: string[] }> = []
  constructor(private readonly decisions: ApprovalDecision[]) {}
  async review(input: { step: number; changeSet: { changes: FileChange[] } }) {
    this.reviews.push({
      step: input.step,
      paths: input.changeSet.changes.map((c) => (c.kind === 'rename' ? c.to : c.path))
    })
    return this.decisions.shift() ?? 'apply'
  }
}

export interface Harness {
  chat: ScriptedChat
  workspace: MemoryWorkspace
  git: FakeGit
  checks: FakeChecks
  deps: AgentDeps
}

export const harness = (script: Scripted[], files: Record<string, string> = {}, approval?: ApprovalPort): Harness => {
  const chat = new ScriptedChat(script)
  const workspace = new MemoryWorkspace(files)
  const git = new FakeGit()
  const checks = new FakeChecks()
  let tick = 1_000
  let ids = 0
  return {
    chat,
    workspace,
    git,
    checks,
    deps: { chat, workspace, git, checks, approval, now: () => (tick += 10), newId: () => `id-${++ids}` }
  }
}

export { ChatError, GitError }
