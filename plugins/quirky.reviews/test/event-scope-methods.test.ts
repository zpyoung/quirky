import { describe, expect, test } from 'bun:test'
import type { JsonRecord, ReviewData, ReviewsEnv, ReviewsStore } from '../src/contracts'
import { newChecksEntry, createReviewsEnv } from '../src/env'
import { detailMethods } from '../src/detail/methods'
import { checksMethods } from '../src/checks/methods'

type EmittedChange = { type: string; data: unknown }
type CallStub = (method: string, params?: JsonRecord) => Promise<unknown>
type ProviderCall = { method: string; params: JsonRecord }

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const CHECKS_TARGET = { surface: 'checks', worktree: 'w1', number: 12 }
const CHECKS_ENTRY_METHODS = [
  'detailRefresh',
  'detailSetCommentDraft',
  'detailQueueComment',
  'detailExpandCheck',
  'detailRefreshChecks',
  'detailLoadCheckDetails',
  'detailRerunChecks',
  'detailPostComment',
  'detailEditComment',
  'detailDeleteComment',
  'detailResolveThread',
  'detailReact',
  'detailUpdateBody',
  'detailUpdateReviewers',
  'detailUpdateAssignees',
  'detailMarkReady',
  'detailCloseReview',
  'detailReopenReview',
  'detailMerge',
  'detailSetAutoMerge',
]
const SHARED_CHECKS_METHODS = ['detailSetAudience', 'detailSetGrouping', 'detailSetChecksCollapsed']
const NO_CHECKS_ENTRY_METHODS = [
  'open',
  'detailSetTab',
  'detailSetBodyDraft',
  'detailSetFilesView',
  'detailSetBotOverride',
  'detailSetFileViewed',
  'detailInlineComment',
  'detailMergeConfirmation',
]

function normalizedReview(number: number, state: ReviewData['state'] = 'open'): ReviewData {
  return {
    provider: 'github',
    number,
    url: `https://github.com/test-owner/test-repo/pull/${number}`,
    title: `Review ${number}`,
    body: 'Review body',
    state,
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: HEAD,
    baseRefOid: BASE,
    mergeable: 'MERGEABLE',
    checksStatus: 'failure',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    stack: null,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
    mergeMetadataKnown: true,
    mergeQueueRequired: false,
    autoMergeAllowed: true,
    requestedReviewers: [],
    assignees: [],
  }
}

function issueComment(id = 91, body = 'Original comment'): JsonRecord {
  return {
    kind: 'issue_comment', id, author: 'fixture-user', body, createdAt: '2026-11-12T00:00:00Z', state: null,
    path: null, line: null, startLine: null, threadId: null, isResolved: null, isOutdated: null,
    reactionSubjectId: 'IC_91', reactions: [{ content: '+1', count: 0, viewerHasReacted: false }],
    url: `https://github.com/test-owner/test-repo/pull/12#issuecomment-${id}`,
  }
}

function threadComment(): JsonRecord {
  return {
    kind: 'review_comment', id: 'RC_92', author: 'reviewer', body: 'Thread comment', createdAt: null, state: null,
    path: 'src/main.ts', line: 8, startLine: null, threadId: 'T1', isResolved: false, isOutdated: false,
    reactionSubjectId: 'PRRC_92', reactions: [],
  }
}

function commentsResult(comments: JsonRecord[] = [issueComment(), threadComment()]): JsonRecord {
  return { number: 12, comments, partial: false, partialFailures: [] }
}

function checksResult(number = 12): JsonRecord {
  return {
    number,
    headSha: HEAD,
    rollup: 'failure',
    checks: [{
      kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure',
      url: 'https://github.com/test-owner/test-repo/actions/runs/41', checkRunId: 31, workflowRunId: 41, suiteId: null,
    }],
    partial: false,
    partialFailures: [],
  }
}

function filesResult(): JsonRecord {
  return {
    number: 12,
    files: [{
      path: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@',
      isBinary: false, patchUnavailable: false, viewed: false, coordinates: [{ line: 8, side: 'RIGHT' }],
    }],
    truncated: false,
    filesUnavailable: false,
    partialFailures: [],
    totalCount: 1,
  }
}

function checkDetails(): JsonRecord {
  return { check: { id: 31, name: 'build' }, annotations: [], jobs: [], logTails: [], partialFailures: [], truncated: false }
}

function acceptedRemoteResponse(method: string, params: JsonRecord): unknown {
  switch (method) {
    case 'quirky.hosting/review':
      return { kind: 'found', review: normalizedReview(12), fetchedAt: 1 }
    case 'quirky.hosting/workItemDetails':
      return { item: { number: 12, title: 'Hydrated review', body: 'Hydrated body' } }
    case 'quirky.hosting/checks':
      return checksResult()
    case 'quirky.hosting/comments':
      return commentsResult()
    case 'quirky.hosting/files':
      return filesResult()
    case 'quirky.hosting/checkDetails':
      return checkDetails()
    case 'quirky.hosting/rerunChecks':
      return { started: 1, targetCount: 1, completedSteps: ['queued'] }
    case 'quirky.hosting/reviewConversation':
      if (params.action === 'add') {
        return {
          number: 12, action: 'add',
          comment: {
            kind: 'issue_comment', id: 93, body: params.body, author: 'fixture-user',
            createdAt: '2026-11-12T00:01:00Z', url: 'https://github.com/test-owner/test-repo/pull/12#issuecomment-93',
          },
        }
      }
      if (params.action === 'edit') {
        return {
          number: 12, action: 'edit',
          comment: {
            kind: 'issue_comment', id: params.commentId, body: params.body, author: 'fixture-user',
            createdAt: '2026-11-12T00:00:00Z', url: 'https://github.com/test-owner/test-repo/pull/12#issuecomment-91',
          },
        }
      }
      if (params.action === 'delete') return { number: 12, action: 'delete', commentId: params.commentId, deleted: true }
      break
    case 'quirky.hosting/resolveThread':
      return { number: 12, threadId: params.threadId, action: params.action, resolved: params.action === 'resolve' }
    case 'quirky.hosting/reaction':
      return { subjectId: params.subjectId, action: params.action, content: params.content, changed: true }
    case 'quirky.hosting/updateReview':
      return { number: 12, updated: true, state: params.action === 'close' ? 'closed' : 'open' }
    case 'quirky.hosting/reviewers':
      return { number: 12, reviewers: ['reviewer-2'], updated: true }
    case 'quirky.hosting/reviewAssignees':
      return { number: 12, assignees: ['assignee-2'] }
    case 'quirky.hosting/merge':
      return { number: 12, state: 'merged', head: HEAD, operationId: 'operation-12' }
    case 'quirky.hosting/autoMerge':
      return { number: 12, enabled: params.action === 'enable', state: params.action === 'enable' ? 'enabled' : 'disabled' }
  }
  throw new Error(`Unexpected hosting call: ${method}`)
}

function dialogMayBeScoped(dialog: ReviewsStore['agentDialog'], worktree: string): boolean {
  return dialog === null || dialog.surface !== 'detail' && dialog.target?.worktree === worktree
}

function expectScopedUpdate(before: ReviewsStore, after: ReviewsStore, worktree: string): void {
  const prior = structuredClone(before)
  const next = structuredClone(after)
  prior.revision = 0
  next.revision = 0
  delete prior.checksByWorktree[worktree]
  delete next.checksByWorktree[worktree]
  if (dialogMayBeScoped(before.agentDialog, worktree) && dialogMayBeScoped(after.agentDialog, worktree)) {
    prior.agentDialog = null
    next.agentDialog = null
  }
  expect(next).toEqual(prior)
}

async function defaultContextCall(method: string, params?: JsonRecord): Promise<unknown> {
  if (method === 'quirky.worktree/resolve') {
    const selector = typeof params?.selector === 'string' ? params.selector : 'w1'
    return { id: selector, kind: 'git', repoId: 'fixture-repo', path: `/tmp/${selector}` }
  }
  if (method === 'ui.state') return { layout: { view: { id: 'fixture:other-view' } } }
  return {}
}

function unitEnv(call: CallStub = defaultContextCall) {
  const events: EmittedChange[] = []
  const env = createReviewsEnv({
    openStore: () => ({ get: () => undefined, run: () => {} }),
    emit: (type: string, data: unknown) => events.push({ type, data }),
    error: (_kind: string, message: string) => new Error(message),
    call,
  } as never)
  const update = env.update.bind(env)
  env.update = (change, checksWorktree) => {
    const before = checksWorktree === undefined ? null : structuredClone(env.read())
    const state = update(change, checksWorktree)
    if (before !== null) expectScopedUpdate(before, env.read(), checksWorktree!)
    return state
  }
  env.update((state) => {
    const w1 = newChecksEntry('w1', 1)
    w1.review = normalizedReview(12)
    w1.checks = checksResult()
    w1.comments = commentsResult()
    state.checksByWorktree.w1 = w1

    const w2 = newChecksEntry('w2', 1)
    w2.review = normalizedReview(13)
    state.checksByWorktree.w2 = w2

    state.detail.target = { worktree: 'w1', number: 12, tab: 'conversation' }
    state.detail.generation = 1
    state.detail.review = normalizedReview(12)
  })
  events.length = 0
  return { env, events, methods: detailMethods(env) }
}

function invoke(methods: ReturnType<typeof detailMethods>, method: string, params: Record<string, unknown>): Promise<unknown> {
  return methods[method]!(params as never, {} as never)
}

function expectTagged(events: EmittedChange[], worktree = 'w1'): void {
  expect(events.length).toBeGreaterThan(0)
  expect(events.every((event) => {
    if (event.type !== 'changed' || event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return false
    return (event.data as Record<string, unknown>).worktree === worktree
  })).toBe(true)
}

function expectUntagged(events: EmittedChange[]): void {
  expect(events.every((event) => {
    if (event.type !== 'changed' || event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return false
    return !Object.hasOwn(event.data, 'worktree')
  })).toBe(true)
}

function storedComments(env: ReviewsEnv): Record<string, unknown>[] {
  const value = env.read().checksByWorktree.w1?.comments?.comments
  expect(Array.isArray(value)).toBe(true)
  return value as Record<string, unknown>[]
}

type RemoteScenario = {
  method: string
  hostMethod: string
  params: Record<string, unknown>
  prepare?: (env: ReviewsEnv) => void
  assertSuccess: (result: unknown, env: ReviewsEnv) => void
}

const remoteScenarios: RemoteScenario[] = [
  {
    method: 'detailRefresh', hostMethod: 'quirky.hosting/review', params: { ...CHECKS_TARGET },
    assertSuccess(result, env) {
      expect(result).toMatchObject({
        surface: 'checks', number: 12, ok: true, errors: [],
        loaded: { review: true, details: true, checks: true, comments: true, files: true },
      })
      expect(env.read().checksByWorktree.w1?.checks).toMatchObject({ headSha: HEAD, checks: [{ name: 'build', checkRunId: 31 }] })
      expect(storedComments(env).map((comment) => comment.body)).toContain('Original comment')
    },
  },
  {
    method: 'detailRefreshChecks', hostMethod: 'quirky.hosting/checks', params: { ...CHECKS_TARGET },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ surface: 'checks', number: 12, headSha: HEAD, checks: [{ name: 'build', checkRunId: 31 }] })
      expect(env.read().checksByWorktree.w1?.checks).toMatchObject({ headSha: HEAD, rollup: 'failure' })
    },
  },
  {
    method: 'detailLoadCheckDetails', hostMethod: 'quirky.hosting/checkDetails',
    params: { ...CHECKS_TARGET, expectedHead: HEAD, checkRunId: 31, workflowRunId: 41, jobName: 'build' },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ surface: 'checks', number: 12, checkRunId: 31, details: { check: { id: 31, name: 'build' } } })
      expect(env.read().checksByWorktree.w1?.checks).toMatchObject({ detailsById: { '31': { check: { id: 31 } } } })
    },
  },
  {
    method: 'detailRerunChecks', hostMethod: 'quirky.hosting/rerunChecks',
    params: { ...CHECKS_TARGET, failedOnly: false },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ started: 1, targetCount: 1, completedSteps: ['queued'], refreshed: true })
      expect(env.read().checksByWorktree.w1?.checks).toMatchObject({ headSha: HEAD, checks: [{ name: 'build' }] })
    },
  },
  {
    method: 'detailPostComment', hostMethod: 'quirky.hosting/reviewConversation', params: { ...CHECKS_TARGET, body: 'Posted comment' },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, comment: { id: 93, body: 'Posted comment', kind: 'issue_comment' } })
      expect(storedComments(env).some((comment) => comment.id === 93 && comment.body === 'Posted comment')).toBe(true)
    },
  },
  {
    method: 'detailEditComment', hostMethod: 'quirky.hosting/reviewConversation', params: { ...CHECKS_TARGET, commentId: 91, body: 'Edited comment' },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, commentId: 91, body: 'Edited comment', updated: true })
      expect(storedComments(env).find((comment) => comment.id === 91)?.body).toBe('Edited comment')
    },
  },
  {
    method: 'detailDeleteComment', hostMethod: 'quirky.hosting/reviewConversation', params: { ...CHECKS_TARGET, commentId: 91 },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, commentId: 91, deleted: true })
      expect(storedComments(env).some((comment) => comment.id === 91)).toBe(false)
    },
  },
  {
    method: 'detailResolveThread', hostMethod: 'quirky.hosting/resolveThread',
    params: { ...CHECKS_TARGET, threadId: 'T1', resolved: true },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, threadId: 'T1', resolved: true })
      expect(storedComments(env).find((comment) => comment.threadId === 'T1')?.isResolved).toBe(true)
    },
  },
  {
    method: 'detailReact', hostMethod: 'quirky.hosting/reaction',
    params: { ...CHECKS_TARGET, subjectId: 'IC_91', content: '+1', add: true },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, subjectId: 'IC_91', content: '+1', add: true, changed: true })
      expect(storedComments(env).find((comment) => comment.reactionSubjectId === 'IC_91')?.reactions).toEqual([
        { content: '+1', count: 1, viewerHasReacted: true },
      ])
    },
  },
  {
    method: 'detailUpdateBody', hostMethod: 'quirky.hosting/updateReview', params: { ...CHECKS_TARGET, body: 'Updated review body' },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, body: 'Updated review body', updated: true })
      expect(env.read().checksByWorktree.w1?.review?.body).toBe('Updated review body')
    },
  },
  {
    method: 'detailUpdateReviewers', hostMethod: 'quirky.hosting/reviewers',
    params: { ...CHECKS_TARGET, action: 'add', logins: ['reviewer-2'] },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, reviewers: ['reviewer-2'], updated: true })
      expect(env.read().checksByWorktree.w1?.review?.requestedReviewers).toEqual(['reviewer-2'])
    },
  },
  {
    method: 'detailUpdateAssignees', hostMethod: 'quirky.hosting/reviewAssignees',
    params: { ...CHECKS_TARGET, action: 'set', logins: ['assignee-2'] },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, assignees: ['assignee-2'] })
      expect(env.read().checksByWorktree.w1?.review?.assignees).toEqual(['assignee-2'])
    },
  },
  {
    method: 'detailMarkReady', hostMethod: 'quirky.hosting/updateReview', params: { ...CHECKS_TARGET },
    prepare(env) { env.update((state) => { state.checksByWorktree.w1!.review!.state = 'draft' }) },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, state: 'open', updated: true })
      expect(env.read().checksByWorktree.w1?.review?.state).toBe('open')
    },
  },
  {
    method: 'detailCloseReview', hostMethod: 'quirky.hosting/updateReview', params: { ...CHECKS_TARGET },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, state: 'closed', updated: true })
      expect(env.read().checksByWorktree.w1?.review?.state).toBe('closed')
    },
  },
  {
    method: 'detailReopenReview', hostMethod: 'quirky.hosting/updateReview', params: { ...CHECKS_TARGET },
    prepare(env) { env.update((state) => { state.checksByWorktree.w1!.review!.state = 'closed' }) },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, state: 'open', updated: true })
      expect(env.read().checksByWorktree.w1?.review?.state).toBe('open')
    },
  },
  {
    method: 'detailMerge', hostMethod: 'quirky.hosting/merge',
    params: { ...CHECKS_TARGET, expectedHead: HEAD, method: 'squash', action: 'direct' },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, state: 'merged', head: HEAD, operationId: 'operation-12' })
      expect(env.read().checksByWorktree.w1?.review?.state).toBe('merged')
    },
  },
  {
    method: 'detailSetAutoMerge', hostMethod: 'quirky.hosting/autoMerge',
    params: { ...CHECKS_TARGET, expectedHead: HEAD, enabled: true, method: 'squash' },
    assertSuccess(result, env) {
      expect(result).toMatchObject({ number: 12, enabled: true, state: 'enabled' })
      expect(env.read().checksByWorktree.w1?.review?.autoMergeRequest).toEqual({ state: 'enabled', enabled: true, method: 'squash' })
    },
  },
]

describe('reviews detail-method event scope', () => {
  test('comment drafts on the Checks surface emit one event tagged to the owning worktree', async () => {
    const { env, events, methods } = unitEnv()

    const result = await invoke(methods, 'detailSetCommentDraft', { ...CHECKS_TARGET, body: 'x', draftVersion: 1 })

    expect(result).toMatchObject({ surface: 'checks', body: 'x', draftVersion: 1, applied: true })
    expect(events).toEqual([{ type: 'changed', data: { revision: 2, worktree: 'w1' } }])
    expect(env.read().checksByWorktree.w1?.commentDraft).toBe('x')
  })

  test('expanded checks and queued comments each emit one event tagged to the owning worktree', async () => {
    const { env, events, methods } = unitEnv()

    await invoke(methods, 'detailExpandCheck', { ...CHECKS_TARGET, checkId: 'c', expanded: true })
    await invoke(methods, 'detailQueueComment', { ...CHECKS_TARGET, commentId: 'c1', queued: true })

    expect(events).toEqual([
      { type: 'changed', data: { revision: 2, worktree: 'w1' } },
      { type: 'changed', data: { revision: 3, worktree: 'w1' } },
    ])
    expect(env.read().checksByWorktree.w1?.expandedChecks).toEqual(['c'])
    expect(env.read().checksByWorktree.w1?.queuedComments).toEqual(['c1'])
  })

  test('comment drafts on the detail surface remain untagged', async () => {
    const { env, events, methods } = unitEnv()

    const result = await invoke(methods, 'detailSetCommentDraft', {
      surface: 'detail', worktree: 'w1', number: 12, body: 'x', draftVersion: 1,
    })

    expect(result).toMatchObject({ surface: 'detail', body: 'x', applied: true })
    expect(events).toEqual([{ type: 'changed', data: { revision: 2 } }])
    expect(env.read().detail.commentDraft).toBe('x')
  })

  test('Checks preferences stay global and appear in every worktree projection', async () => {
    const { env, events, methods } = unitEnv()

    await invoke(methods, 'detailSetAudience', { ...CHECKS_TARGET, audience: 'bots' })
    expect(events).toEqual([{ type: 'changed', data: { revision: 2 } }])
    expect(env.view('w2').checks.audience).toBe('bots')

    events.length = 0
    await invoke(methods, 'detailSetGrouping', { ...CHECKS_TARGET, grouping: 'timeline' })
    expect(events).toEqual([{ type: 'changed', data: { revision: 3 } }])
    expect(env.view('w2').checks.grouping).toBe('timeline')

    events.length = 0
    await invoke(methods, 'detailSetChecksCollapsed', { ...CHECKS_TARGET, collapsed: true })
    expect(events).toEqual([{ type: 'changed', data: { revision: 4 } }])
    expect(env.view('w2').checks.checksCollapsed).toBe(true)
  })

  for (const scenario of remoteScenarios) {
    test(`${scenario.method} tags accepted remote changes and applies the response`, async () => {
      const calls: ProviderCall[] = []
      const { env, events, methods } = unitEnv(async (method, params = {}) => {
        calls.push({ method, params })
        return acceptedRemoteResponse(method, params)
      })
      scenario.prepare?.(env)
      events.length = 0

      const result = await invoke(methods, scenario.method, scenario.params)

      expect(calls.some((call) => call.method === scenario.hostMethod)).toBe(true)
      scenario.assertSuccess(result, env)
      expectTagged(events)
    })

    test(`${scenario.method} tags changes when the remote call rejects`, async () => {
      const calls: ProviderCall[] = []
      const { env, events, methods } = unitEnv(async (method, params = {}) => {
        calls.push({ method, params })
        throw new Error('remote failed')
      })
      scenario.prepare?.(env)
      events.length = 0

      if (scenario.method === 'detailRefresh') {
        const result = await invoke(methods, scenario.method, scenario.params)
        expect(result).toMatchObject({ ok: false, errors: ['remote failed'] })
      } else {
        await expect(invoke(methods, scenario.method, scenario.params)).rejects.toThrow('remote failed')
      }

      expect(calls.some((call) => call.method === scenario.hostMethod)).toBe(true)
      expect(env.read().checksByWorktree.w1?.error).toBe('remote failed')
      expectTagged(events)
    })
  }

  test('a stale Checks owner still tags each no-op mutation update at its exact revision', async () => {
    let env: ReviewsEnv
    const boom = new Error('boom')
    const harness = unitEnv(async (method) => {
      if (method !== 'quirky.hosting/reviewConversation') throw new Error(`Unexpected hosting call: ${method}`)
      env.update((state) => { state.checksByWorktree.w1!.generation = 99 }, 'w1')
      throw boom
    })
    env = harness.env
    const { events, methods } = harness

    await expect(invoke(methods, 'detailPostComment', { ...CHECKS_TARGET, body: 'hello' })).rejects.toBe(boom)

    expect(events).toEqual([2, 3, 4, 5].map((revision) => ({
      type: 'changed',
      data: { revision, worktree: 'w1' },
    })))
    expect(env.read().checksByWorktree.w1?.error).toBeNull()
    expect(env.read().checksByWorktree.w1?.generation).toBe(99)
    expect(env.read().revision).toBe(5)
  })

  test('methods that never write a Checks entry emit no tagged event', async () => {
    const { env, events, methods } = unitEnv()

    for (const [method, params] of [
      ['detailSetFileViewed', { ...CHECKS_TARGET, path: 'src/main.ts', viewed: true }],
      ['detailInlineComment', { ...CHECKS_TARGET, expectedHead: HEAD, path: 'src/main.ts', line: 8, body: 'Please update this.' }],
    ] as const) {
      await expect(invoke(methods, method, params)).rejects.toMatchObject({ data: { reason: 'unsupported_surface' } })
      expect(events).toHaveLength(0)
    }

    const confirmation = await invoke(methods, 'detailMergeConfirmation', {
      ...CHECKS_TARGET, expectedHead: HEAD, method: 'squash', action: 'direct',
    })
    expect(confirmation).toContain('Merge PR #12')
    expect(events).toHaveLength(0)

    const untaggedCases: [string, Record<string, unknown>][] = [
      ['open', { worktree: 'w1', number: 12, tab: 'conversation' }],
      ['detailSetTab', { worktree: 'w1', number: 12, tab: 'checks' }],
      ['detailSetBodyDraft', { worktree: 'w1', number: 12, body: 'draft', draftVersion: 1 }],
      ['detailSetFilesView', {
        worktree: 'w1', number: 12, fileFilter: 'main', diffMode: 'inline', selectedFile: null,
        collapsedFiles: [], treeVisible: true,
      }],
      ['detailSetBotOverride', { author: 'fixture-bot', bot: true }],
    ]
    for (const [method, params] of untaggedCases) {
      events.length = 0
      await invoke(methods, method, params)
      expect(events.length).toBeGreaterThan(0)
      expectUntagged(events)
    }
    expect(env.read().botOverrides).toEqual(['fixture-bot'])
  })

  test('the method coverage table lists every method exactly once', () => {
    const { methods } = unitEnv()
    const groups = [CHECKS_ENTRY_METHODS, SHARED_CHECKS_METHODS, NO_CHECKS_ENTRY_METHODS]
    const listed = groups.flat()

    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(Object.keys(methods).sort())
  })

  test('the update tripwire rejects a tagged change outside that worktree Checks entry', () => {
    const { env } = unitEnv()

    expect(() => env.update((state) => { state.audience = 'bots' }, 'w1')).toThrow()
  })
})

function agentEnv(deliver: () => Promise<unknown>) {
  const fixture = unitEnv()
  const { env } = fixture
  env.resolve = async (params) => ({ id: params.worktree, kind: 'git', repoId: 'r', path: '/tmp/reviews-scope' }) as never
  env.call = async (method) => {
    if (method === 'quirky.agents/list') return {
      defaultAgent: 'test-agent',
      agents: [{ id: 'test-agent', enabled: true, installed: true, isDefault: true }]
    }
    if (method === 'quirky.session/create') return { id: 'session-1', agent: 'test-agent' }
    if (method === 'quirky.agents/deliver') return deliver()
    if (method === 'quirky.hosting/resolveThread') return { resolved: true }
    throw new Error(`Unexpected agent call: ${method}`)
  }
  return { ...fixture, checks: checksMethods(env) }
}

const conflictsDialog = { surface: 'checks', worktree: 'w1', number: 12, action: 'conflicts', prompt: 'Resolve conflicts' }

describe('review agent launch event scope', () => {
  test('undelivered Checks prompts record only a worktree-scoped error', async () => {
    const { env, events, checks } = agentEnv(async () => ({ delivery: 'not-delivered' }))
    await checks.checksSetAgentDialog!(conflictsDialog, {} as never)
    events.length = 0

    expect(await checks.checksLaunchAgent!({ worktree: 'w1' }, {} as never)).toMatchObject({ delivered: false })

    expect(env.read().checksByWorktree.w1!.error).toContain('was not delivered')
    expectTagged(events)
  })

  test('delivered queued threads and the final dialog clear stay Checks-owned', async () => {
    const { env, events, checks } = agentEnv(async () => ({ delivery: 'pasted' }))
    env.update((state) => {
      state.checksByWorktree.w1!.queuedComments = ['T1']
    }, 'w1')
    await checks.checksSetAgentDialog!({ ...conflictsDialog, action: 'comments' }, {} as never)
    events.length = 0

    expect(await checks.checksLaunchAgent!({ worktree: 'w1' }, {} as never)).toMatchObject({ delivered: true, resolved: ['T1'] })

    expect(env.read().checksByWorktree.w1!.queuedComments).toEqual([])
    expect(storedComments(env).find((comment) => comment.threadId === 'T1')?.isResolved).toBe(true)
    expect(env.read().agentDialog).toBeNull()
    expect(events).toHaveLength(2)
    expectTagged(events)
  })

  test('detail launch errors remain globally visible', async () => {
    const { env, events, checks } = agentEnv(async () => ({ delivery: 'not-delivered' }))
    await checks.checksSetAgentDialog!({ ...conflictsDialog, surface: 'detail' }, {} as never)
    events.length = 0

    expect(await checks.checksLaunchAgent!({ worktree: 'w1' }, {} as never)).toMatchObject({ delivered: false })

    expect(env.read().detail.error).toContain('was not delivered')
    expectUntagged(events)
  })

  for (const replacement of [
    { ...conflictsDialog, surface: 'detail', prompt: 'Detail replacement' },
    { ...conflictsDialog, worktree: 'w2', number: 13, prompt: 'Other worktree replacement' }
  ]) {
    test(`launch completion leaves the replacement ${replacement.surface}/${replacement.worktree} dialog alone`, async () => {
      const delivery = Promise.withResolvers<unknown>()
      const delivering = Promise.withResolvers<void>()
      const { env, events, checks } = agentEnv(() => {
        delivering.resolve()
        return delivery.promise
      })
      await checks.checksSetAgentDialog!(conflictsDialog, {} as never)
      const launch = checks.checksLaunchAgent!({ worktree: 'w1' }, {} as never)
      await delivering.promise
      await checks.checksSetAgentDialog!(replacement, {} as never)
      const saved = structuredClone(env.read().agentDialog)
      events.length = 0
      delivery.resolve({ delivery: 'pasted' })

      expect(await launch).toMatchObject({ delivered: true })

      expect(events).toHaveLength(1)
      expectTagged(events)
      expect(env.read().agentDialog).toEqual(saved)
    })
  }
})

describe('review agent dialog event scope', () => {
  test('opening and editing a Checks dialog tags its own worktree', async () => {
    const { env, events } = unitEnv()
    const checks = checksMethods(env)

    await checks.checksSetAgentDialog!(conflictsDialog, {} as never)

    expect(events).toHaveLength(1)
    expectTagged(events)
    expect(env.view('w1').checks.agentDialog).toMatchObject({ prompt: 'Resolve conflicts', visible: true })
    expect(env.view('w2').checks.agentDialog).toBeNull()
    events.length = 0

    await checks.checksSetAgentDialog!({ ...conflictsDialog, prompt: 'Updated prompt' }, {} as never)

    expect(events).toHaveLength(1)
    expectTagged(events)
    expect(env.view('w1').checks.agentDialog?.prompt).toBe('Updated prompt')
  })

  for (const [before, after] of [
    [conflictsDialog, { ...conflictsDialog, worktree: 'w2', number: 13 }],
    [{ ...conflictsDialog, surface: 'detail' }, conflictsDialog],
    [conflictsDialog, { ...conflictsDialog, surface: 'detail' }]
  ] as const) {
    test(`replacing ${before.surface}/${before.worktree} with ${after.surface}/${after.worktree} is global`, async () => {
      const { env, events } = unitEnv()
      const checks = checksMethods(env)
      await checks.checksSetAgentDialog!(before, {} as never)
      events.length = 0

      await checks.checksSetAgentDialog!(after, {} as never)

      expect(events).toHaveLength(1)
      expectUntagged(events)
      expect(env.read().agentDialog).toMatchObject({ surface: after.surface, target: { worktree: after.worktree, number: after.number } })
      if (after.surface === 'checks') expect(env.view(after.worktree === 'w1' ? 'w2' : 'w1').checks.agentDialog).toBeNull()
      else expect(env.view('w2').checks.agentDialog).toEqual(env.read().agentDialog)
    })
  }

  for (const initial of ['checks', 'detail', 'none'] as const) {
    for (const action of ['hide', 'clear'] as const) {
      test(`${action} with a ${initial} dialog emits ${initial === 'checks' ? 'the owner tag' : 'globally'}`, async () => {
        const { env, events } = unitEnv()
        const checks = checksMethods(env)
        if (initial !== 'none') await checks.checksSetAgentDialog!({ ...conflictsDialog, surface: initial }, {} as never)
        const previous = structuredClone(env.read().agentDialog)
        events.length = 0

        await checks.checksSetAgentDialog!({ action, ...(action === 'hide' ? { surface: 'checks' } : {}) }, {} as never)

        expect(events).toHaveLength(1)
        if (initial === 'checks') expectTagged(events)
        else expectUntagged(events)
        expect(env.read().agentDialog).toEqual(action === 'clear' ? null : initial === 'checks' ? { ...previous, visible: false } : previous)
      })
    }
  }
})
