import type { PluginCaller } from '@quirky/protocol'
import { checksMethods } from '../src/checks/methods'
import { createMethods } from '../src/create/methods'
import { createReviewsEnv } from '../src/env'
import { detailMethods } from '../src/detail/methods'
import type { JsonRecord, ReviewMethodTable, ReviewData } from '../src/contracts'

export const GITLAB_WORKTREE = 'w'
export const GITLAB_HOST = 'gitlab.example.test'
export const GITLAB_HEAD_OID = 'a'.repeat(40)
export const GITLAB_BASE_OID = 'b'.repeat(40)
export const GITLAB_REPOSITORY = { host: GITLAB_HOST, owner: 'group/sub', repo: 'proj' }

export const GITLAB_REVIEW: ReviewData = {
  provider: 'gitlab',
  number: 5,
  url: `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/5`,
  title: 'Add x',
  body: 'body',
  updatedAt: '2026-11-16T00:00:00Z',
  state: 'draft',
  headRefName: 'feature',
  baseRefName: 'main',
  headRefOid: GITLAB_HEAD_OID,
  baseRefOid: GITLAB_BASE_OID,
  mergeable: 'UNKNOWN',
  checksStatus: 'neutral',
  reviewDecision: '',
  mergeStateStatus: 'UNKNOWN',
  requestedReviewers: ['reviewer'],
  assignees: [],
  reviews: [],
  autoMergeRequest: null,
  stack: null,
  mergeMethods: { default: null, allowed: [] },
  mergeQueueRequired: false,
  autoMergeAllowed: null,
  mergeMetadataKnown: false,
  repository: GITLAB_REPOSITORY,
}

export const GITLAB_LOOKUP = { kind: 'found', review: GITLAB_REVIEW, fetchedAt: 1_000_000 }

export const GITLAB_DIAGNOSTICS = {
  provider: 'gitlab',
  tokenSource: 'env',
  glabAvailable: null,
  tokenRejected: false,
  activeAccount: { host: GITLAB_HOST, user: 'fixture-user' },
  accounts: [{ host: GITLAB_HOST, user: 'fixture-user', source: 'env', active: true, scopes: ['api'] }],
  envTokenInProcess: true,
  missingScopes: [],
  requiredScopes: ['api'],
  hasKeyringFallback: false,
  requiredHost: GITLAB_HOST,
  requiredHostAuthenticated: true,
}

export function gitlabComment(id: number, overrides: Partial<JsonRecord> = {}): JsonRecord {
  return {
    kind: 'issue_comment',
    id,
    author: 'fixture-user',
    body: id === 101 ? 'hello' : `note ${id}`,
    createdAt: '2026-11-16T00:00:00Z',
    state: null,
    path: null,
    line: null,
    startLine: null,
    threadId: null,
    isResolved: null,
    isOutdated: null,
    reactionSubjectId: null,
    reactions: [],
    isBot: null,
    url: `${GITLAB_REVIEW.url}#note_${id}`,
    ...overrides,
  }
}

export const GITLAB_THREADED_COMMENT = gitlabComment(201, {
  kind: 'review_comment',
  body: 'please fix',
  path: 'src/a.ts',
  line: 10,
  threadId: 'a'.repeat(40),
  isResolved: false,
  isOutdated: false,
  url: null,
})

export const GITLAB_COMMENTS = {
  number: 5,
  comments: [gitlabComment(101), GITLAB_THREADED_COMMENT],
  partial: false,
  partialFailures: [],
}

export function gitlabComments(count: number, partial = false, partialFailures: string[] = []): JsonRecord {
  return {
    number: 5,
    comments: Array.from({ length: count }, (_, index) => gitlabComment(index + 1)),
    partial,
    partialFailures,
  }
}

export type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

export type RecordedPublicCall = { method: string; params: JsonRecord | undefined }
type StandInReply = unknown | ((params: JsonRecord | undefined) => unknown | Promise<unknown>)
type GitLabMethodHarnessOptions = {
  replies?: Record<string, StandInReply>
  worktree?: { id: string; kind: 'git' | 'folder'; repoId: string; path: string }
}

function unsupported(method: string): Error {
  return Object.assign(new Error(`GitLab hosting does not answer ${method} yet.`), { data: { reason: 'unsupported_provider' } })
}

export function createGitLabMethodHarness(options: GitLabMethodHarnessOptions = {}) {
  const calls: RecordedPublicCall[] = []
  const replies = options.replies ?? {}
  const worktree = options.worktree ?? {
    id: GITLAB_WORKTREE,
    kind: 'git' as const,
    repoId: 'fixture-repo',
    path: `/worktrees/${GITLAB_WORKTREE}`,
  }
  const builtins: Record<string, StandInReply> = {
    'quirky.worktree/resolve': () => worktree,
    'quirky.hosting/repository': () => ({ provider: 'gitlab', repository: GITLAB_REPOSITORY, worktreeId: worktree.id }),
    'quirky.hosting/diagnoseAuth': () => GITLAB_DIAGNOSTICS,
    'quirky.hosting/review': () => GITLAB_LOOKUP,
    'quirky.hosting/forBranch': () => GITLAB_LOOKUP,
    'quirky.hosting/comments': () => GITLAB_COMMENTS,
    'quirky.hosting/checks': () => { throw unsupported('quirky.hosting/checks') },
    'ui.state': () => ({ layout: { view: { id: 'view:fixture' } } }),
    'ui.view.open': () => ({}),
    'ui.view.close': () => ({}),
    'ui.panel.open': () => ({}),
    'ui.command.run': () => ({}),
  }
  const context = {
    openStore: () => ({ get: () => undefined, run: () => {} }),
    emit: () => {},
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind }),
    call: async (method: string, params?: JsonRecord) => {
      calls.push({ method, params: params === undefined ? undefined : structuredClone(params) })
      const reply = Object.hasOwn(replies, method) ? replies[method] : builtins[method]
      if (reply === undefined) throw new Error(`Unexpected Reviews test public call: ${method}`)
      return typeof reply === 'function' ? reply(params) : reply
    },
  }
  const env = createReviewsEnv(context as never)
  const methods: Record<'checks' | 'detail' | 'create', ReviewMethodTable> = {
    checks: checksMethods(env),
    detail: detailMethods(env),
    create: createMethods(env),
  }
  return {
    env,
    methods,
    calls,
    publicCall(method: string, params?: JsonRecord) {
      return env.call(method, params)
    },
    invoke(surface: keyof typeof methods, method: string, params: JsonRecord = {}) {
      const handler = methods[surface][method]
      if (!handler) throw new Error(`Unknown ${surface} Reviews method: ${method}`)
      return handler(params, { role: 'plugin' } as PluginCaller)
    },
  }
}
