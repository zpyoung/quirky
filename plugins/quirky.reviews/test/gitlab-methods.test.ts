import { describe, expect, test } from 'bun:test'
import { validateValue, type Schema } from '@quirky/protocol'
import {
  isRecord,
  type GitHubAuthAccount,
  type GitHubAuthDiagnostics,
  type GitLabAuthDiagnostics,
  parseAuthDiagnostics,
  parseCommentsResult,
  parseRepoIdentity,
  parseReviewLookup,
  repoFromReviewUrl,
  reviewContext,
} from '../src/detail/data'
import {
  createGitLabMethodHarness,
  deferred,
  GITLAB_COMMENTS,
  GITLAB_DIAGNOSTICS,
  GITLAB_BASE_OID,
  GITLAB_HEAD_OID,
  GITLAB_HOST,
  GITLAB_LOOKUP,
  GITLAB_REPOSITORY,
  GITLAB_REVIEW,
  GITLAB_WORKTREE,
  gitlabComments,
  type GitLabMethodHarness,
  type GitLabMethodHarnessOptions,
} from './gitlab-support'
import type { JsonRecord, ReviewData } from '../src/contracts'
import { newChecksEntry } from '../src/env'
import { checksSpecs } from '../src/checks/methods'
import { createSpecs } from '../src/create/methods'
import { detailSpecs, directMergeAllowed, queueMergeAllowed } from '../src/detail/methods'


const GITLAB_URL = GITLAB_REVIEW.url
const GITHUB_URL = 'https://github.com/owner/repo/pull/5'
const GITHUB_REPOSITORY = { host: 'github.com', owner: 'owner', repo: 'repo' }

function lookup(review: unknown) {
  return { kind: 'found', review, fetchedAt: GITLAB_LOOKUP.fetchedAt }
}

describe('GitLab shared review data', () => {
  test('parses provider-specific subgroup identity and matching merge-request URLs', async () => {
    expect(parseRepoIdentity(GITLAB_REPOSITORY, 'gitlab')).toEqual(GITLAB_REPOSITORY)
    expect(parseRepoIdentity(GITLAB_REPOSITORY, 'github')).toBeNull()
    expect(parseRepoIdentity(GITLAB_REPOSITORY, 'unknown' as never)).toBeNull()

    expect(repoFromReviewUrl(GITLAB_URL, 5, 'gitlab')).toEqual(GITLAB_REPOSITORY)
    expect(repoFromReviewUrl(`${GITLAB_URL}/`, 5, 'gitlab')).toEqual(GITLAB_REPOSITORY)
    expect(repoFromReviewUrl(`${GITLAB_URL}?view=all#discussion`, 5, 'gitlab')).toEqual(GITLAB_REPOSITORY)
    expect(repoFromReviewUrl('http://127.0.0.1:8123/group/sub/proj/-/merge_requests/5', 5, 'gitlab'))
      .toEqual({ host: '127.0.0.1:8123', owner: 'group/sub', repo: 'proj' })
    expect(repoFromReviewUrl('http://[::1]:8123/group/sub/proj/-/merge_requests/5', 5, 'gitlab'))
      .toEqual({ host: '[::1]:8123', owner: 'group/sub', repo: 'proj' })
    expect(parseRepoIdentity({ host: '[::1]:8123', owner: 'group/sub', repo: 'proj' }, 'gitlab'))
      .toEqual({ host: '[::1]:8123', owner: 'group/sub', repo: 'proj' })
    expect(parseRepoIdentity({ host: '[::1]:443', owner: 'group/sub', repo: 'proj' }, 'gitlab'))
      .toEqual({ host: '[::1]:443', owner: 'group/sub', repo: 'proj' })
    expect(repoFromReviewUrl('http://[::1]:443/group/sub/proj/-/merge_requests/5', 5, 'gitlab'))
      .toEqual({ host: '[::1]:443', owner: 'group/sub', repo: 'proj' })

    expect(repoFromReviewUrl(GITHUB_URL, 5, 'github')).toEqual(GITHUB_REPOSITORY)
    expect(repoFromReviewUrl(GITHUB_URL, 5)).toEqual(GITHUB_REPOSITORY)
    expect(repoFromReviewUrl(GITLAB_URL, 5)).toEqual(GITLAB_REPOSITORY)
    expect(repoFromReviewUrl(GITLAB_URL, 5, 'github')).toBeNull()
    expect(repoFromReviewUrl(GITHUB_URL, 5, 'gitlab')).toBeNull()
    expect(repoFromReviewUrl(GITLAB_URL.replace('/merge_requests/', '/pull/'), 5, 'gitlab')).toBeNull()
    expect(repoFromReviewUrl(GITHUB_URL.replace('/pull/', '/merge_requests/'), 5, 'github')).toBeNull()

    const invalidUrls = [
      `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/05`,
      `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/0`,
      `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/9007199254740992`,
      `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/6`,
      `https://${GITLAB_HOST}/group/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/5/extra`,
      `https://${GITLAB_HOST}/group//proj/-/merge_requests/5`,
      `https://user:secret@${GITLAB_HOST}/group/sub/proj/-/merge_requests/5`,
      `ftp://${GITLAB_HOST}/group/sub/proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group\\sub\\proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group/../proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group/%2e%2e/proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group%2fsub/proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group%5csub/proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/${'a'.repeat(256)}/proj/-/merge_requests/5`,
      `https://${GITLAB_HOST}/group/${'a'.repeat(256)}/-/merge_requests/5`,
      `https://${GITLAB_HOST}/${'a'.repeat(8200)}/proj/-/merge_requests/5`,
    ]
    for (const url of invalidUrls) expect(repoFromReviewUrl(url, 5, 'gitlab')).toBeNull()
    expect(repoFromReviewUrl(GITLAB_URL, 6, 'gitlab')).toBeNull()

    const found = parseReviewLookup(GITLAB_LOOKUP)
    expect(found).toMatchObject({ kind: 'found', review: { provider: 'gitlab', number: 5, repository: GITLAB_REPOSITORY } })
    expect(found && found.kind === 'found' ? found.review.updatedAt : null).toBe(GITLAB_REVIEW.updatedAt)
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, provider: 'unknown' }))).toBeNull()
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, url: GITHUB_URL }))).toBeNull()
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, repository: { ...GITLAB_REPOSITORY, repo: 'other' } }))).toBeNull()
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, mergeMethods: { default: 'merge', allowed: ['merge'] } }))).toBeNull()
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, autoMergeRequest: { enabledAt: 'now' } }))).toBeNull()
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, stack: { entries: [] } }))).toBeNull()
    expect(parseReviewLookup(lookup({ ...GITLAB_REVIEW, mergeQueueRequired: true }))).toBeNull()

    const harness = createGitLabMethodHarness()
    try {
      const state = harness.env.view(GITLAB_WORKTREE)
      state.detail.target = { worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY }
      state.detail.review = null
      expect(reviewContext(state, 'detail')).toMatchObject({ number: 5, repo: GITLAB_REPOSITORY })
      state.detail.review = GITLAB_REVIEW
      expect(reviewContext(state, 'detail')).toMatchObject({ number: 5, repo: GITLAB_REPOSITORY })
      state.detail.target = { worktree: GITLAB_WORKTREE, number: 5, prRepo: { ...GITLAB_REPOSITORY, repo: 'other' } }
      expect(reviewContext(state, 'detail')).toBeNull()
      state.detail.target = { worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY }
      state.detail.review = { ...GITLAB_REVIEW, provider: 'unknown' }
      expect(reviewContext(state, 'detail')).toBeNull()
    } finally {
      await harness.env.dispose()
    }

  })

  test('parses discriminated GitHub and GitLab authentication envelopes', () => {
    expect(parseAuthDiagnostics(GITLAB_DIAGNOSTICS)).toEqual(GITLAB_DIAGNOSTICS)
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, tokenSource: 'glab', glabAvailable: true }))
      .toMatchObject({ provider: 'gitlab', tokenSource: 'glab', glabAvailable: true, requiredHostAuthenticated: true })

    for (const glabAvailable of [false, true]) {
      const missing = {
        ...GITLAB_DIAGNOSTICS,
        tokenSource: null,
        glabAvailable,
        activeAccount: null,
        accounts: [],
        envTokenInProcess: false,
        requiredHostAuthenticated: false,
      } satisfies GitLabAuthDiagnostics
      expect(parseAuthDiagnostics(missing)).toEqual(missing)
    }

    const rejected = {
      ...GITLAB_DIAGNOSTICS,
      tokenSource: 'env',
      tokenRejected: true,
      activeAccount: null,
      accounts: [],
      requiredHostAuthenticated: false,
    } satisfies GitLabAuthDiagnostics
    expect(parseAuthDiagnostics(rejected)).toEqual(rejected)
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, missingScopes: ['api'], requiredHostAuthenticated: true }))
      .toMatchObject({ missingScopes: ['api'], requiredHostAuthenticated: true })
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, accounts: [{ ...GITLAB_DIAGNOSTICS.accounts[0], scopes: [] }] }))
      .toMatchObject({ accounts: [{ scopes: [] }] })

    const githubAccount = {
      host: 'github.com', user: 'fixture-user', source: 'env', active: true, bindable: false, scopes: ['repo'],
    } satisfies GitHubAuthAccount
    const githubDiagnostics = {
      ghAvailable: true,
      activeAccount: githubAccount,
      accounts: [githubAccount],
      envTokenInProcess: true,
      missingScopes: [],
      requiredScopes: ['repo'],
      hasKeyringFallback: false,
      requiredHost: 'github.com',
      requiredHostAuthenticated: true,
    } satisfies GitHubAuthDiagnostics
    expect(parseAuthDiagnostics(githubDiagnostics)).toEqual(githubDiagnostics)
    expect(parseAuthDiagnostics({ ...githubDiagnostics, provider: 'github' })).toEqual({ ...githubDiagnostics, provider: 'github' })
    expect(parseAuthDiagnostics({ ...githubDiagnostics, ghAvailable: undefined })).toBeNull()
    expect(parseAuthDiagnostics({ ...githubDiagnostics, activeAccount: { host: 'github.com', user: 'fixture-user' } })).toBeNull()
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, provider: 'gitlab-ish' })).toBeNull()
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, tokenSource: 'github' })).toBeNull()
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, glabAvailable: 'yes' })).toBeNull()
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, activeAccount: { host: GITLAB_HOST } })).toBeNull()
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, accounts: [{ ...GITLAB_DIAGNOSTICS.accounts[0], source: 'unknown' }] })).toBeNull()
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, requiredScopes: 'api' })).toBeNull()
  })

  test('validates every GitLab discussion note before bounding displayed comments', () => {
    expect(parseCommentsResult(GITLAB_COMMENTS, 5, 'gitlab')).toMatchObject({
      number: 5,
      partial: false,
      partialFailures: [],
      comments: [
        { id: 101, kind: 'issue_comment', body: 'hello' },
        { id: 201, kind: 'review_comment', body: 'please fix', path: 'src/a.ts', line: 10, threadId: 'a'.repeat(40) },
      ],
    })
    expect(parseCommentsResult(gitlabComments(100), 5, 'gitlab')?.comments).toHaveLength(100)

    const many = parseCommentsResult(gitlabComments(101), 5, 'gitlab')
    expect(many?.comments).toHaveLength(100)
    expect(many?.comments[0]?.id).toBe(1)
    expect(many?.comments[99]?.id).toBe(100)
    expect(many?.partial).toBe(true)
    expect(many?.partialFailures).toContain('reviews_comments_truncated')

    const malformedAfterLimit = gitlabComments(101)
    const malformedNotes = malformedAfterLimit.comments
    if (!Array.isArray(malformedNotes) || !isRecord(malformedNotes[100])) throw new Error('fixture note was unavailable')
    malformedNotes[100] = { ...malformedNotes[100], body: 42 }
    expect(parseCommentsResult(malformedAfterLimit, 5, 'gitlab')).toBeNull()
    expect(parseCommentsResult(gitlabComments(101), 5)).toBeNull()
    expect(parseCommentsResult(gitlabComments(101), 5, 'github')).toBeNull()
    expect(parseCommentsResult(gitlabComments(101), 5, 'unknown' as never)).toBeNull()

    const existingPartial = parseCommentsResult(gitlabComments(101, true, ['provider_page_partial']), 5, 'gitlab')
    expect(existingPartial?.partial).toBe(true)
    expect(existingPartial?.partialFailures).toEqual(['provider_page_partial', 'reviews_comments_truncated'])
  })

})
type GitLabHarness = GitLabMethodHarness

type HarnessOptions = GitLabMethodHarnessOptions

const GITLAB_STATUS: JsonRecord = {
  branch: 'feature',
  head: GITLAB_HEAD_OID,
  detached: false,
  operation: 'none',
  entries: [],
  files: [],
  upstreamStatus: {},
  busy: null,
  capped: false,
}
const GITLAB_CHECKS: JsonRecord = {
  number: 5,
  headSha: GITLAB_HEAD_OID,
  rollup: 'success',
  checks: [],
  partial: false,
  partialFailures: [],
}
const GITLAB_FILES: JsonRecord = {
  number: 5,
  files: [{
    path: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -9 +10 @@',
    isBinary: false,
    patchUnavailable: false,
    viewed: false,
    coordinates: [{ line: 10, side: 'RIGHT' }],
  }],
  truncated: false,
  filesUnavailable: false,
  partialFailures: [],
  totalCount: 1,
}
const CREATE_WORKTREE = {
  id: GITLAB_WORKTREE,
  kind: 'git' as const,
  repoId: 'fixture-repo',
  path: `/worktrees/${GITLAB_WORKTREE}`,
  branch: 'feature',
  head: GITLAB_HEAD_OID,
}
const GITLAB_ELIGIBILITY: JsonRecord = {
  eligible: true,
  defaultBase: 'main',
  head: 'feature',
  title: 'Add x',
  body: 'body',
  blockers: [],
}
const GIT_BRANCHES: JsonRecord = {
  refs: [{ name: 'origin/main', kind: 'remote' }],
  current: 'feature',
}
const GITHUB_REPOSITORY_ID = { host: 'github.com', owner: 'owner', repo: 'repo' }
const GITHUB_DIAGNOSTICS: JsonRecord = {
  ghAvailable: true,
  activeAccount: { host: 'github.com', user: 'fixture-user', source: 'env', active: true, bindable: false, scopes: ['repo'] },
  accounts: [{ host: 'github.com', user: 'fixture-user', source: 'env', active: true, bindable: false, scopes: ['repo'] }],
  envTokenInProcess: true,
  missingScopes: [],
  requiredScopes: ['repo'],
  hasKeyringFallback: false,
  requiredHost: 'github.com',
  requiredHostAuthenticated: true,
}
const GITHUB_SETTINGS_REPLIES: Record<string, JsonRecord> = {
  'quirky.hosting/accounts': {
    requiredHost: 'github.com',
    accounts: [{ host: 'github.com', user: 'fixture-user', source: 'env', active: true, bindable: false, scopes: ['repo'] }],
  },
  'quirky.hosting/configuration': { worktreeId: GITLAB_WORKTREE, issueSourcePreference: 'auto', account: null },
  'quirky.hosting/rateLimit': {
    core: { limit: 5000, remaining: 4999, resetAt: 1 },
    search: { limit: 30, remaining: 29, resetAt: 1 },
    graphql: { limit: 5000, remaining: 4999, resetAt: 1 },
    fetchedAt: 1,
  },
}

function selectedGitLabReview(overrides: Partial<ReviewData> = {}): ReviewData {
  return { ...GITLAB_REVIEW, prRepo: GITLAB_REPOSITORY, ...overrides }
}
const GITHUB_FORK_REPOSITORY = { host: 'github.com', owner: 'contributor', repo: GITHUB_REPOSITORY_ID.repo }
const GITHUB_OTHER_REPOSITORY = { host: 'github.com', owner: 'another-user', repo: GITHUB_REPOSITORY_ID.repo }

function selectedGitHubReview(
  repository = GITHUB_FORK_REPOSITORY,
  overrides: Partial<ReviewData> = {},
): ReviewData {
  return {
    ...GITLAB_REVIEW,
    provider: 'github',
    url: `https://${repository.host}/${repository.owner}/${repository.repo}/pull/5`,
    mergeable: 'MERGEABLE',
    checksStatus: 'success',
    mergeStateStatus: 'CLEAN',
    mergeMethods: { default: 'merge', allowed: ['merge'] },
    repository,
    prRepo: repository,
    ...overrides,
  }
}
function githubReplies(
  review: ReviewData,
  overrides: NonNullable<HarnessOptions['replies']> = {},
): NonNullable<HarnessOptions['replies']> {
  return {
    'quirky.git/status': GITLAB_STATUS,
    'quirky.hosting/repository': {
      provider: 'github',
      repository: GITHUB_REPOSITORY_ID,
      origin: GITHUB_FORK_REPOSITORY,
      head: GITHUB_FORK_REPOSITORY,
      candidates: [GITHUB_FORK_REPOSITORY, GITHUB_REPOSITORY_ID],
      issueRepository: GITHUB_REPOSITORY_ID,
      issueSourcePreference: 'upstream',
      worktreeId: GITLAB_WORKTREE,
    },
    'quirky.hosting/forBranch': lookup(review),
    'quirky.hosting/review': lookup(review),
    'quirky.hosting/checks': GITLAB_CHECKS,
    'quirky.hosting/comments': GITLAB_COMMENTS,
    'quirky.hosting/reviewStack': {
      number: review.number,
      available: false,
      truncated: false,
      reason: 'stack_unavailable',
    },
    ...overrides,
  }
}


function selectDetail(
  harness: GitLabHarness,
  review: ReviewData = selectedGitLabReview(),
  comments: JsonRecord | null = GITLAB_COMMENTS,
  files: JsonRecord | null = null,
): void {
  const provider = review.provider === 'github' || review.provider === 'gitlab' ? review.provider : undefined
  const repository = provider === undefined ? null : parseRepoIdentity(review.prRepo ?? review.repository, provider)
  harness.env.update((state) => {
    state.detail.target = {
      worktree: GITLAB_WORKTREE,
      number: review.number,
      tab: 'conversation',
      prRepo: repository ?? GITLAB_REPOSITORY,
    }
    state.detail.review = review
    state.detail.comments = comments
    state.detail.files = files
  })
}

function selectChecks(harness: GitLabHarness, review: ReviewData = selectedGitLabReview()): void {
  const entry = newChecksEntry(GITLAB_WORKTREE)
  entry.review = review
  entry.comments = GITLAB_COMMENTS
  harness.env.update((state) => { state.checksByWorktree[GITLAB_WORKTREE] = entry })
}

function callsFor(harness: GitLabHarness, method: string) {
  return harness.calls.filter((call) => call.method === method)
}

async function withHarness<T>(options: HarnessOptions, run: (harness: GitLabHarness) => Promise<T>): Promise<T> {
  const harness = createGitLabMethodHarness(options)
  try {
    return await run(harness)
  } finally {
    await harness.env.dispose()
  }
}


describe('GitLab Reviews daemon methods', () => {
  test('Checks retains normalized MR metadata and comments when optional checks are unavailable', async () => {
    const secretReview = selectedGitLabReview({
      accessToken: 'never-store-this',
      providerPayload: { credential: 'private' },
    })
    await withHarness({
      replies: { 'quirky.git/status': GITLAB_STATUS, 'quirky.hosting/forBranch': lookup(secretReview) },
    }, async (harness) => {
      const result = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      const checks = harness.env.view(GITLAB_WORKTREE).checks

      expect(result).toMatchObject({ ok: false, kind: 'found', number: 5 })
      expect(result.error).toContain('Checks are unavailable for GitLab merge requests.')
      expect(checks.loading).toBe(false)
      expect(checks.checks).toBeNull()
      expect(checks.comments).toMatchObject({
        number: 5,
        comments: expect.arrayContaining([
          expect.objectContaining({ id: 101, body: 'hello' }),
          expect.objectContaining({ id: 201, body: 'please fix', threadId: 'a'.repeat(40) }),
        ]),
      })
      expect(checks.review).toMatchObject({
        provider: 'gitlab',
        number: 5,
        title: 'Add x',
        body: 'body',
        updatedAt: GITLAB_REVIEW.updatedAt,
        requestedReviewers: ['reviewer'],
        assignees: [],
        reviews: [],
        repository: GITLAB_REPOSITORY,
        prRepo: GITLAB_REPOSITORY,
        stack: null,
        autoMergeRequest: null,
        mergeMethods: { default: null, allowed: [] },
      })
      expect(checks.review).not.toHaveProperty('accessToken')
      expect(checks.review).not.toHaveProperty('providerPayload')
      expect(callsFor(harness, 'quirky.hosting/reviewStack')).toHaveLength(0)
    })

    await withHarness({
      replies: { 'quirky.git/status': GITLAB_STATUS, 'quirky.hosting/checks': GITLAB_CHECKS },
    }, async (harness) => {
      const result = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(result.ok).toBe(true)
      expect(harness.env.view(GITLAB_WORKTREE).checks.checks).toMatchObject(GITLAB_CHECKS)
    })
  })

  test('Checks by-number links reject wrong IID and same-number repository sources before detail reads', async () => {
    const wrongNumber = {
      kind: 'found',
      review: { ...GITLAB_REVIEW, number: 6, url: GITLAB_URL.replace('/5', '/6') },
      fetchedAt: GITLAB_LOOKUP.fetchedAt,
    }
    await withHarness({ replies: { 'quirky.hosting/review': wrongNumber } }, async (harness) => {
      await expect(harness.invoke('checks', 'checksLink', { worktree: GITLAB_WORKTREE, number: 5 }))
        .rejects.toMatchObject({ data: { reason: 'invalid_hosting_response' } })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toBeUndefined()
      expect(callsFor(harness, 'quirky.hosting/checks')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/comments')).toHaveLength(0)
    })

    await withHarness({ replies: { 'quirky.hosting/review': GITLAB_LOOKUP } }, async (harness) => {
      await expect(harness.invoke('checks', 'checksLink', {
        worktree: GITLAB_WORKTREE,
        number: 5,
        prRepo: { ...GITLAB_REPOSITORY, repo: 'another-project' },
      })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toBeUndefined()
      expect(callsFor(harness, 'quirky.hosting/checks')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/comments')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/reviewStack')).toHaveLength(0)
    })
  })

  test('detail refresh loads GitLab title/body without GitHub-only reads or fabricated details', async () => {
    const secretReview = selectedGitLabReview({ accessToken: 'never-store-this', providerPayload: { credential: 'private' } })
    await withHarness({ replies: { 'quirky.hosting/review': lookup(secretReview) } }, async (harness) => {
      selectDetail(harness, secretReview)
      const result = await harness.invoke('detail', 'detailRefresh', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5,
      }) as JsonRecord

      expect(result).toMatchObject({
        ok: false,
        loaded: { review: true, details: false, checks: false, comments: true, files: false },
      })
      expect((result.errors as string[]).join(' ')).toContain('Checks are unavailable for GitLab merge requests.')
      expect((result.errors as string[]).join(' ')).toContain('Changed files are unavailable for GitLab merge requests.')
      expect(harness.env.read().detail.review).toMatchObject({
        provider: 'gitlab',
        title: 'Add x',
        body: 'body',
        updatedAt: GITLAB_REVIEW.updatedAt,
        requestedReviewers: ['reviewer'],
        assignees: [],
        reviews: [],
        repository: GITLAB_REPOSITORY,
        prRepo: GITLAB_REPOSITORY,
      })
      expect(harness.env.read().detail.review).not.toHaveProperty('accessToken')
      expect(harness.env.read().detail.review).not.toHaveProperty('providerPayload')
      expect(harness.env.read().detail.details).toBeNull()
      for (const method of ['quirky.hosting/workItemDetails', 'quirky.hosting/files', 'quirky.hosting/reviewStack']) {
        expect(callsFor(harness, method)).toHaveLength(0)
      }
    })
  })

  test('detail refresh rejects wrong IID and cross-project sources before dependent reads', async () => {
    const wrongNumber = {
      kind: 'found',
      review: { ...GITLAB_REVIEW, number: 6, url: GITLAB_URL.replace('/5', '/6') },
      fetchedAt: GITLAB_LOOKUP.fetchedAt,
    }
    await withHarness({ replies: { 'quirky.hosting/review': wrongNumber } }, async (harness) => {
      selectDetail(harness)
      await expect(harness.invoke('detail', 'detailRefresh', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5,
      })).rejects.toMatchObject({ data: { reason: 'invalid_upstream' } })
      expect(callsFor(harness, 'quirky.hosting/checks')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/comments')).toHaveLength(0)
    })

    await withHarness({}, async (harness) => {
      harness.env.update((state) => {
        state.detail.target = {
          worktree: GITLAB_WORKTREE,
          number: 5,
          tab: 'conversation',
          prRepo: { ...GITLAB_REPOSITORY, repo: 'another-project' },
        }
      })
      await expect(harness.invoke('detail', 'detailRefresh', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5,
      })).rejects.toMatchObject({ data: { reason: 'source_mismatch' } })
      expect(callsFor(harness, 'quirky.hosting/checks')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/comments')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/files')).toHaveLength(0)
    })
  })

  test('GitLab settings refresh reads repository and diagnostics only', async () => {
    await withHarness({}, async (harness) => {
      const result = await harness.invoke('create', 'hostingSettingsRefresh', {
        worktree: GITLAB_WORKTREE,
        forceBudget: true,
      }) as JsonRecord
      const settings = harness.env.read().settings

      expect(result).toMatchObject({ worktree: GITLAB_WORKTREE, refreshed: true })
      expect(settings).toMatchObject({
        provider: 'gitlab',
        repository: GITLAB_REPOSITORY,
        diagnostics: GITLAB_DIAGNOSTICS,
        accounts: null,
        configuration: null,
        budget: null,
        loading: false,
        error: null,
      })
      expect(callsFor(harness, 'quirky.hosting/repository')).toHaveLength(1)
      expect(callsFor(harness, 'quirky.hosting/diagnoseAuth')).toHaveLength(1)
      for (const method of [
        'quirky.hosting/accounts',
        'quirky.hosting/configuration',
        'quirky.hosting/configure',
        'quirky.hosting/rateLimit',
      ]) expect(callsFor(harness, method)).toHaveLength(0)
    })
  })

  test('GitLab diagnostics pass through hostingDiagnose, settings refresh, and Checks auth', async () => {
    const missingDiagnostics = {
      ...GITLAB_DIAGNOSTICS,
      tokenSource: null,
      glabAvailable: false,
      activeAccount: null,
      accounts: [],
      envTokenInProcess: false,
      requiredHostAuthenticated: false,
    }
    await withHarness({
      replies: { 'quirky.hosting/diagnoseAuth': missingDiagnostics },
    }, async (harness) => {
      const diagnostics = await harness.invoke('create', 'hostingDiagnose', { worktree: GITLAB_WORKTREE })
      expect(diagnostics).toEqual(missingDiagnostics)
      expect(diagnostics).not.toHaveProperty('ghAvailable')
      const refreshed = await harness.invoke('create', 'hostingSettingsRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(refreshed.refreshed).toBe(true)
      expect(harness.env.read().settings).toMatchObject({
        provider: 'gitlab',
        repository: GITLAB_REPOSITORY,
        diagnostics: missingDiagnostics,
        accounts: null,
        configuration: null,
        budget: null,
        error: null,
      })
    })

    await withHarness({
      replies: {
        'quirky.git/status': GITLAB_STATUS,
        'quirky.hosting/creationEligibility': {
          eligible: false,
          defaultBase: 'main',
          head: 'feature',
          title: 'Add x',
          body: 'body',
          blockers: [{ reason: 'auth_required', nextAction: 'authenticate', message: 'Fixture authentication is missing.' }],
        },
        'quirky.hosting/diagnoseAuth': missingDiagnostics,
      },
    }, async (harness) => {
      const refreshed = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE, force: true }) as JsonRecord
      expect(refreshed.ok).toBe(false)
      expect(harness.env.view(GITLAB_WORKTREE).checks.lookup).toMatchObject({ authDiagnostics: missingDiagnostics })
      expect(callsFor(harness, 'quirky.hosting/diagnoseAuth')).toHaveLength(1)
    })
  })

  test('GitHub-only settings methods use live canonical provider and refuse before dispatch', async () => {
    const inputs: Array<[string, JsonRecord]> = [
      ['hostingAccounts', { worktree: GITLAB_WORKTREE }],
      ['hostingConfiguration', { worktree: GITLAB_WORKTREE }],
      ['hostingBudget', { worktree: GITLAB_WORKTREE }],
      ['hostingBindAccount', { worktree: GITLAB_WORKTREE, host: GITLAB_HOST, user: 'fixture-user' }],
      ['hostingUnbindAccount', { worktree: GITLAB_WORKTREE }],
    ]
    for (const [method, params] of inputs) {
      await withHarness({}, async (harness) => {
        harness.env.update((state) => {
          state.settings.worktree = GITLAB_WORKTREE
          state.settings.provider = 'github'
          state.settings.repository = GITHUB_REPOSITORY_ID
        })
        await expect(harness.invoke('create', method, params))
          .rejects.toMatchObject({ data: { reason: 'unsupported_provider' } })
        expect(callsFor(harness, 'quirky.hosting/repository')).toHaveLength(1)
        for (const unsupported of [
          'quirky.hosting/accounts',
          'quirky.hosting/configuration',
          'quirky.hosting/configure',
          'quirky.hosting/rateLimit',
        ]) expect(callsFor(harness, unsupported)).toHaveLength(0)
      })
    }
  })

  test('settings reads are fenced across a same-worktree A→B→A provider replacement', async () => {
    let repository = { provider: 'github', repository: GITHUB_REPOSITORY_ID }
    const heldFirstDiagnostics = deferred<unknown>()
    const firstDiagnosticStarted = deferred<void>()
    let diagnosticReads = 0
    const harness = createGitLabMethodHarness({
      replies: {
        ...GITHUB_SETTINGS_REPLIES,
        'quirky.hosting/repository': () => ({ ...repository, worktreeId: GITLAB_WORKTREE }),
        'quirky.hosting/diagnoseAuth': () => {
          diagnosticReads += 1
          if (diagnosticReads === 1) {
            firstDiagnosticStarted.resolve(undefined)
            return heldFirstDiagnostics.promise
          }
          return repository.provider === 'gitlab' ? GITLAB_DIAGNOSTICS : GITHUB_DIAGNOSTICS
        },
      },
    })
    try {
      const oldA = harness.invoke('create', 'hostingSettingsRefresh', { worktree: GITLAB_WORKTREE })
      await firstDiagnosticStarted.promise
      const firstGeneration = harness.env.read().settings.generation

      repository = { provider: 'gitlab', repository: GITLAB_REPOSITORY }
      const b = await harness.invoke('create', 'hostingSettingsRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(b.refreshed).toBe(true)
      expect(harness.env.read().settings).toMatchObject({ provider: 'gitlab', repository: GITLAB_REPOSITORY })

      repository = { provider: 'github', repository: GITHUB_REPOSITORY_ID }
      const newA = await harness.invoke('create', 'hostingSettingsRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(newA.refreshed).toBe(true)
      const currentGeneration = harness.env.read().settings.generation
      expect(currentGeneration).toBeGreaterThan(firstGeneration)

      heldFirstDiagnostics.resolve(GITHUB_DIAGNOSTICS)
      const oldResult = await oldA as JsonRecord
      expect(oldResult.stale).toBe(true)
      expect(harness.env.read().settings).toMatchObject({
        provider: 'github',
        repository: GITHUB_REPOSITORY_ID,
        diagnostics: GITHUB_DIAGNOSTICS,
        loading: false,
        error: null,
      })
    } finally {
      heldFirstDiagnostics.resolve(GITHUB_DIAGNOSTICS)
      await harness.env.dispose()
    }
  })

  test('creation eligibility carries canonical GitLab provider and never enables stacking', async () => {
    const harness = createGitLabMethodHarness({
      worktree: CREATE_WORKTREE,
      replies: {
        'quirky.hosting/creationEligibility': GITLAB_ELIGIBILITY,
        'quirky.git/branches': GIT_BRANCHES,
      },
    })
    try {
      const opened = await harness.invoke('create', 'createOpen', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(opened.opened).toBe(true)
      expect(harness.env.read().creation.eligibility).toMatchObject({
        provider: 'gitlab',
        stackSupported: false,
        stackEnabled: false,
      })
      expect(callsFor(harness, 'quirky.hosting/forBranch')).toHaveLength(0)
    } finally {
      await harness.env.dispose()
    }
  })

  test('GitLab creation forwards settled fields and validates the returned canonical MR URL', async () => {
    const createReply = { number: 6, url: `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/6`, existing: false }
    const harness = createGitLabMethodHarness({
      worktree: CREATE_WORKTREE,
      replies: {
        'quirky.hosting/creationEligibility': GITLAB_ELIGIBILITY,
        'quirky.git/branches': GIT_BRANCHES,
        'quirky.hosting/create': createReply,
      },
    })
    try {
      await harness.invoke('create', 'createOpen', { worktree: GITLAB_WORKTREE })
      await harness.invoke('create', 'createDraft', {
        worktree: GITLAB_WORKTREE, title: 'Add x', body: 'body', draft: true, useTemplate: false,
      })
      const result = await harness.invoke('create', 'createSubmit', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(result).toMatchObject({ status: 'created', review: { number: 6, url: createReply.url } })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toEqual({ number: 6, url: createReply.url })
      expect(callsFor(harness, 'quirky.hosting/create')).toHaveLength(1)
      expect(callsFor(harness, 'quirky.hosting/create')[0]?.params).toEqual({
        worktree: GITLAB_WORKTREE, base: 'main', head: 'feature', title: 'Add x', body: 'body', draft: true, useTemplate: false,
      })
      expect(callsFor(harness, 'quirky.hosting/createStacked')).toHaveLength(0)
    } finally {
      await harness.env.dispose()
    }

    for (const url of [
      `https://other.example.test/group/sub/proj/-/merge_requests/6`,
      `https://${GITLAB_HOST}/group/other/proj/-/merge_requests/6`,
      `https://${GITLAB_HOST}/group/sub/proj/-/pull/6`,
      `https://${GITLAB_HOST}/group/sub/proj/-/merge_requests/7`,
    ]) {
      const invalidHarness = createGitLabMethodHarness({
        worktree: CREATE_WORKTREE,
        replies: {
          'quirky.hosting/creationEligibility': GITLAB_ELIGIBILITY,
          'quirky.git/branches': GIT_BRANCHES,
          'quirky.hosting/create': { number: 6, url },
        },
      })
      try {
        await invalidHarness.invoke('create', 'createOpen', { worktree: GITLAB_WORKTREE })
        await invalidHarness.invoke('create', 'createDraft', { worktree: GITLAB_WORKTREE, title: 'Add x' })
        await expect(invalidHarness.invoke('create', 'createSubmit', { worktree: GITLAB_WORKTREE }))
          .rejects.toMatchObject({ data: { reason: 'unknown_completion' } })
        expect(invalidHarness.env.read().links[GITLAB_WORKTREE]).toBeUndefined()
      } finally {
        await invalidHarness.env.dispose()
      }
    }
  })

  test('GitLab state changes accept exact idempotent acknowledgements and preserve updated:false', async () => {
    const cases = [
      { method: 'detailMarkReady', initial: 'draft', action: 'ready', expected: 'open' },
      { method: 'detailCloseReview', initial: 'open', action: 'close', expected: 'closed' },
      { method: 'detailReopenReview', initial: 'closed', action: 'reopen', expected: 'open' },
    ] as const
    for (const item of cases) {
      await withHarness({
        replies: {
          'quirky.hosting/updateReview': () => ({ number: 5, state: item.expected, updated: false }),
        },
      }, async (harness) => {
        selectDetail(harness, selectedGitLabReview({ state: item.initial }))
        const result = await harness.invoke('detail', item.method, {
          surface: 'detail', worktree: GITLAB_WORKTREE, number: 5,
        }) as JsonRecord
        expect(result).toEqual({ number: 5, state: item.expected, updated: false })
        expect(harness.env.read().detail.review?.state).toBe(item.expected)
        expect(callsFor(harness, 'quirky.hosting/updateReview')[0]?.params).toMatchObject({
          worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY, action: item.action,
        })
      })
    }
  })

  test('GitLab reopen applies the confirmed draft state', async () => {
    await withHarness({
      replies: { 'quirky.hosting/updateReview': { number: 5, state: 'draft', updated: true } },
    }, async (harness) => {
      selectDetail(harness, selectedGitLabReview({ state: 'closed' }))
      const result = await harness.invoke('detail', 'detailReopenReview', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5,
      })
      expect(result).toEqual({ number: 5, state: 'draft', updated: true })
      const declared = detailSpecs.find((spec) => spec.id === 'detailReopenReview')
      expect(validateValue(declared!.result!, result, 'result')).toBeNull()
      const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json() as {
        contributes: { method: Array<{ id: string; result: Schema }> }
      }
      const published = manifest.contributes.method.find((method) => method.id === 'detailReopenReview')
      expect(validateValue(published!.result, result, 'result')).toBeNull()
      expect(harness.env.read().detail.review?.state).toBe('draft')
    })
  })

  test('state changes reject unconfirmed states and restore the prior review', async () => {
    const cases = [
      { provider: 'gitlab', method: 'detailReopenReview', initial: 'closed', returned: 'closed' },
      { provider: 'github', method: 'detailReopenReview', initial: 'closed', returned: 'draft' },
      { provider: 'gitlab', method: 'detailCloseReview', initial: 'open', returned: 'draft' },
      { provider: 'gitlab', method: 'detailMarkReady', initial: 'draft', returned: 'draft' },
    ] as const
    for (const item of cases) {
      await withHarness({
        replies: { 'quirky.hosting/updateReview': { number: 5, state: item.returned, updated: true } },
      }, async (harness) => {
        selectDetail(harness, item.provider === 'gitlab'
          ? selectedGitLabReview({ state: item.initial })
          : selectedGitHubReview(undefined, { state: item.initial }))
        await expect(harness.invoke('detail', item.method, {
          surface: 'detail', worktree: GITLAB_WORKTREE, number: 5,
        })).rejects.toMatchObject({ data: { reason: 'invalid_upstream' } })
        expect(harness.env.read().detail.review?.state).toBe(item.initial)
      })
    }
  })

  test('GitLab body, comment, numeric reply, and numberless thread writes use exact repository identity', async () => {
    await withHarness({
      replies: {
        'quirky.hosting/updateReview': (params) => ({ number: 5, updated: params?.action === 'edit' }),
        'quirky.hosting/reviewConversation': (params) => {
          if (params?.action === 'add') return {
            number: 5, action: 'add',
            comment: { kind: 'issue_comment', id: 301, body: params.body, author: 'fixture-user', createdAt: '2026-11-16T00:01:00Z', url: `${GITLAB_URL}#note_301` },
          }
          if (params?.action === 'edit') return {
            number: 5, action: 'edit',
            comment: { kind: 'issue_comment', id: params.commentId, body: params.body, author: 'fixture-user', createdAt: '2026-11-16T00:00:00Z', url: `${GITLAB_URL}#note_101` },
          }
          throw new Error(`Unexpected conversation action: ${String(params?.action)}`)
        },
        'quirky.hosting/reviewComment': (params) => ({
          number: 5,
          action: 'reply',
          comment: { id: 302, body: params?.body, path: null, line: null, startLine: null },
        }),
        'quirky.hosting/resolveThread': (params) => ({
          threadId: params?.threadId,
          action: params?.action,
          resolved: params?.action === 'resolve',
        }),
      },
    }, async (harness) => {
      selectDetail(harness)
      const description = await harness.invoke('detail', 'detailUpdateBody', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5, body: 'edited body',
      }) as JsonRecord
      expect(description).toMatchObject({ number: 5, body: 'edited body', updated: true })

      await harness.invoke('detail', 'detailPostComment', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5, body: 'new note',
      })
      await harness.invoke('detail', 'detailEditComment', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5, commentId: 101, body: 'edited note',
      })
      await harness.invoke('detail', 'detailPostComment', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5, replyToId: 101, body: 'numeric reply',
      })
      const threadId = 'a'.repeat(40)
      const resolved = await harness.invoke('detail', 'detailResolveThread', {
        surface: 'detail', worktree: GITLAB_WORKTREE, number: 5, threadId, resolved: true,
      })
      expect(resolved).toEqual({ number: 5, threadId, resolved: true })
      expect(callsFor(harness, 'quirky.hosting/updateReview')[0]?.params)
        .toMatchObject({ worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY, action: 'edit', body: 'edited body' })
      expect(callsFor(harness, 'quirky.hosting/reviewConversation').map((call) => call.params))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY, action: 'add', body: 'new note' }),
          expect.objectContaining({ worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY, action: 'edit', commentId: 101, body: 'edited note' }),
        ]))
      expect(callsFor(harness, 'quirky.hosting/reviewComment')[0]?.params)
        .toMatchObject({ worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY, action: 'reply', replyToId: 101 })
      expect(callsFor(harness, 'quirky.hosting/resolveThread')[0]?.params)
        .toEqual({ worktree: GITLAB_WORKTREE, number: 5, prRepo: GITLAB_REPOSITORY, threadId, action: 'resolve' })
    })
  })

  test('GitLab unsupported writes refuse before optimistic changes or provider dispatch', async () => {
    const permissive = selectedGitLabReview({
      state: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      mergeMethods: { default: 'merge', allowed: ['merge', 'squash', 'rebase'] },
      mergeMetadataKnown: true,
      mergeQueueRequired: true,
      autoMergeAllowed: true,
    })
    expect(directMergeAllowed(permissive)).toBe(false)
    expect(queueMergeAllowed(permissive)).toBe(false)

    const unsupportedActions: Array<[string, JsonRecord]> = [
      ['detailMergeConfirmation', { expectedHead: GITLAB_HEAD_OID, method: 'merge', action: 'direct' }],
      ['detailMerge', { expectedHead: GITLAB_HEAD_OID, method: 'merge', action: 'direct' }],
      ['detailSetAutoMerge', { expectedHead: GITLAB_HEAD_OID, enabled: true, method: 'merge' }],
      ['detailSetAutoMerge', { expectedHead: GITLAB_HEAD_OID, enabled: false }],
      ['detailUpdateReviewers', { action: 'add', logins: ['reviewer-2'] }],
      ['detailUpdateAssignees', { action: 'set', logins: ['assignee-2'] }],
      ['detailReact', { subjectId: 'note-101', content: '+1', add: true }],
      ['detailDeleteComment', { commentId: 101 }],
      ['detailSetFileViewed', { path: 'src/a.ts', viewed: true }],
      ['detailInlineComment', { expectedHead: GITLAB_HEAD_OID, path: 'src/a.ts', line: 10, body: 'inline note' }],
    ]
    for (const [method, extra] of unsupportedActions) {
      await withHarness({}, async (harness) => {
        const comments = {
          ...GITLAB_COMMENTS,
          comments: GITLAB_COMMENTS.comments.map((comment) => comment.id === 101
            ? { ...comment, reactionSubjectId: 'note-101', reactions: [{ content: '+1', count: 1, viewerHasReacted: false }] }
            : comment),
        }
        selectDetail(harness, permissive, comments, GITLAB_FILES)
        const before = structuredClone({
          review: harness.env.read().detail.review,
          comments: harness.env.read().detail.comments,
          files: harness.env.read().detail.files,
          pending: harness.env.read().detail.pending,
        })
        await expect(harness.invoke('detail', method, {
          surface: 'detail', worktree: GITLAB_WORKTREE, number: 5, ...extra,
        })).rejects.toMatchObject({ data: { reason: 'unsupported_provider' } })
        expect({
          review: harness.env.read().detail.review,
          comments: harness.env.read().detail.comments,
          files: harness.env.read().detail.files,
          pending: harness.env.read().detail.pending,
        }).toEqual(before)
        for (const write of [
          'quirky.hosting/merge',
          'quirky.hosting/autoMerge',
          'quirky.hosting/reviewers',
          'quirky.hosting/reviewAssignees',
          'quirky.hosting/reaction',
          'quirky.hosting/reviewConversation',
          'quirky.hosting/fileViewed',
          'quirky.hosting/reviewComment',
        ]) expect(callsFor(harness, write)).toHaveLength(0)
      })
    }

    await withHarness({}, async (harness) => {
      selectChecks(harness, permissive)
      await expect(harness.invoke('checks', 'checksSitterArm', {
        worktree: GITLAB_WORKTREE,
        capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'on' },
        branchUpdateMode: 'merge-base-update',
        mergeMethod: 'merge',
        mergeCheckScope: 'all',
        budgetHours: 1,
      })).rejects.toMatchObject({ data: { reason: 'unsupported_provider' } })
      expect(callsFor(harness, 'quirky.heimdall/enroll')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/repository')).toHaveLength(0)
    })
  })

  test('checks title save cannot claim or mutate a replacement across delayed worktree resolution', async () => {
    await withHarness({}, async (harness) => {
      selectChecks(harness)
      const resolvedWorktree = await harness.env.resolve({ worktree: GITLAB_WORKTREE }, { role: 'plugin' } as never)
      const resolution = deferred<typeof resolvedWorktree>()
      harness.env.resolve = (() => resolution.promise) as typeof harness.env.resolve

      const oldWrite = harness.invoke('checks', 'checksSaveTitle', {
        worktree: GITLAB_WORKTREE, number: 5, expectedHead: GITLAB_HEAD_OID, title: 'old title',
      })
      const oldGeneration = harness.env.read().checksByWorktree[GITLAB_WORKTREE]!.generation
      const replacementRepo = { ...GITLAB_REPOSITORY, repo: 'another-project' }
      const replacementReview = selectedGitLabReview({
        title: 'replacement',
        url: `https://${GITLAB_HOST}/group/sub/another-project/-/merge_requests/5`,
        repository: replacementRepo,
        prRepo: replacementRepo,
      })
      const replacement = newChecksEntry(GITLAB_WORKTREE, oldGeneration + 1)
      replacement.review = replacementReview
      replacement.titleDraft = 'keep'
      replacement.loading = true
      replacement.error = 'replacement owns this state'
      harness.env.update((state) => { state.checksByWorktree[GITLAB_WORKTREE] = replacement })

      resolution.resolve(resolvedWorktree)
      await oldWrite.catch(() => undefined)
      expect(harness.env.read().checksByWorktree[GITLAB_WORKTREE]).toMatchObject({
        review: replacementReview,
        titleDraft: 'keep',
        loading: true,
        error: 'replacement owns this state',
      })
      expect(callsFor(harness, 'quirky.hosting/updateReview')).toHaveLength(0)
    })
  })

  test('Checks accepts every normalized GitLab mergeability and pipeline status without enabling merge', async () => {
    const mergeableValues = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
    const checksStatusValues = ['neutral', 'success', 'failure', 'pending'] as const
    for (const mergeable of mergeableValues) {
      for (const checksStatus of checksStatusValues) {
        const review = { ...GITLAB_REVIEW, mergeable, checksStatus }
        await withHarness({
          replies: {
            'quirky.git/status': GITLAB_STATUS,
            'quirky.git/mergePreview': {
              base: GITLAB_BASE_OID,
              head: GITLAB_HEAD_OID,
              available: true,
              conflicting: true,
              files: [],
            },
            'quirky.hosting/forBranch': lookup(review),
          },
        }, async (harness) => {
          const result = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
          const accepted = harness.env.view(GITLAB_WORKTREE).checks.review
          expect(result).toMatchObject({ kind: 'found', number: 5 })
          expect(result.error).toContain('Checks are unavailable for GitLab merge requests.')
          expect(accepted).toMatchObject({ provider: 'gitlab', mergeable, checksStatus })
          if (accepted === null) throw new Error('GitLab review was not retained')
          expect(accepted.mergeMethods).toEqual({ default: null, allowed: [] })
          expect(accepted.autoMergeRequest).toBeNull()
          expect(accepted.autoMergeAllowed).toBeNull()
          expect(accepted.mergeQueueRequired).toBe(false)
          expect(accepted.mergeMetadataKnown).toBe(false)
          expect(directMergeAllowed(accepted)).toBe(false)
          expect(queueMergeAllowed(accepted)).toBe(false)
        })
      }
    }
  })

  test('GitHub Checks still accepts fork candidates and preserves explicit repository pins', async () => {
    const forkReview = selectedGitHubReview()
    await withHarness({ replies: githubReplies(forkReview) }, async (harness) => {
      const refreshed = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(refreshed).toMatchObject({ ok: true, kind: 'found', number: 5 })
      expect(harness.env.view(GITLAB_WORKTREE).checks.review?.prRepo).toEqual(GITHUB_FORK_REPOSITORY)

      const linked = await harness.invoke('checks', 'checksLink', {
        worktree: GITLAB_WORKTREE,
        number: 5,
        prRepo: GITHUB_FORK_REPOSITORY,
      }) as JsonRecord
      expect(linked).toMatchObject({ linked: true, number: 5, url: forkReview.url })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toEqual({ number: 5, url: forkReview.url })

      harness.env.update((state) => { state.checksByWorktree[GITLAB_WORKTREE]!.review = null })
      const opened = await harness.invoke('checks', 'checksOpenReview', {
        worktree: GITLAB_WORKTREE,
        number: 5,
      }) as JsonRecord
      expect(opened).toMatchObject({ opened: true, prRepo: GITHUB_FORK_REPOSITORY })
    })

    await withHarness({ replies: githubReplies(selectedGitHubReview(GITHUB_OTHER_REPOSITORY)) }, async (harness) => {
      await expect(harness.invoke('checks', 'checksLink', {
        worktree: GITLAB_WORKTREE,
        number: 5,
        prRepo: GITHUB_FORK_REPOSITORY,
      })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toBeUndefined()
    })
  })

  test('GitHub number-only linking and opening let Hosting search origin and upstream candidates', async () => {
    const review = selectedGitHubReview()
    await withHarness({
      replies: githubReplies(review, {
        'quirky.hosting/review': (params?: JsonRecord) => {
          const repository = params?.prRepo === undefined ? GITHUB_FORK_REPOSITORY : parseRepoIdentity(params.prRepo, 'github')
          return repository?.owner === GITHUB_FORK_REPOSITORY.owner && repository.repo === GITHUB_FORK_REPOSITORY.repo
            ? lookup(review) : { kind: 'no-review', fetchedAt: 1 }
        },
      }),
    }, async (harness) => {
      expect(await harness.invoke('checks', 'checksLink', { worktree: GITLAB_WORKTREE, number: 5 })).toMatchObject({ linked: true })
      harness.env.update((state) => {
        delete state.links[GITLAB_WORKTREE]
        state.checksByWorktree[GITLAB_WORKTREE]!.review = null
      })
      expect(await harness.invoke('checks', 'checksOpenReview', { worktree: GITLAB_WORKTREE, number: 5 })).toMatchObject({
        opened: true, prRepo: GITHUB_FORK_REPOSITORY,
      })
    })
  })

  test('GitHub fork title saves and Sitter enrollment preserve the selected review source', async () => {
    const review = selectedGitHubReview()
    await withHarness({
      replies: githubReplies(review, {
        'quirky.hosting/updateReview': (params?: JsonRecord) => {
          if (typeof params?.title !== 'string') throw new Error('The title write must supply its selected title.')
          review.title = params.title
          return { number: 5, title: review.title, updated: true }
        },
        'quirky.heimdall/enroll': { kind: 'enrolled', enrollment: { watcherId: 'fork-watcher', kind: 'hosted-review' } },
      }),
    }, async (harness) => {
      selectChecks(harness, review)
      const updated = await harness.invoke('checks', 'checksSaveTitle', {
        worktree: GITLAB_WORKTREE, number: 5, expectedHead: GITLAB_HEAD_OID, title: 'Updated fork title',
      })
      expect(updated).toMatchObject({ updated: true, title: 'Updated fork title' })
      expect(callsFor(harness, 'quirky.hosting/updateReview')[0]?.params).toMatchObject({ prRepo: GITHUB_FORK_REPOSITORY })
      const repositoryReads = callsFor(harness, 'quirky.hosting/repository').length
      const armed = await harness.invoke('checks', 'checksSitterArm', {
        worktree: GITLAB_WORKTREE,
        capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
        mergeMethod: 'merge', budgetHours: 1,
      })
      expect(armed).toMatchObject({ ok: true, kind: 'enrolled', enrollment: { watcherId: 'fork-watcher' } })
      expect(callsFor(harness, 'quirky.hosting/repository')).toHaveLength(repositoryReads)
      expect(callsFor(harness, 'quirky.heimdall/enroll')).toHaveLength(1)
    })
  })

  test('GitHub Checks bounds oversized comments while keeping the shared default parser unchanged', async () => {
    expect(parseCommentsResult(gitlabComments(101), 5)).toBeNull()
    const review = selectedGitHubReview()
    await withHarness({
      replies: githubReplies(review, { 'quirky.hosting/comments': gitlabComments(101) }),
    }, async (harness) => {
      const result = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      const comments = harness.env.view(GITLAB_WORKTREE).checks.comments
      expect(result.ok).toBe(true)
      expect(comments).toMatchObject({
        truncated: true,
        partial: false,
        partialFailures: [],
      })
      if (!isRecord(comments) || !Array.isArray(comments.comments)) throw new Error('Checks comments were not retained')
      expect(comments.comments).toHaveLength(100)
      expect(comments.comments[0]).toMatchObject({ id: 1 })
      expect(comments.comments[99]).toMatchObject({ id: 100 })
    })
  })

  test('GitHub creation accepts a valid review returned from a fork repository', async () => {
    const forkUrl = `https://github.com/${GITHUB_FORK_REPOSITORY.owner}/${GITHUB_FORK_REPOSITORY.repo}/pull/5`
    const replies: NonNullable<HarnessOptions['replies']> = {
      'quirky.hosting/repository': {
        provider: 'github',
        repository: GITHUB_REPOSITORY_ID,
        worktreeId: GITLAB_WORKTREE,
      },
      'quirky.hosting/creationEligibility': GITLAB_ELIGIBILITY,
      'quirky.git/branches': GIT_BRANCHES,
      'quirky.hosting/forBranch': { kind: 'no-review', fetchedAt: GITLAB_LOOKUP.fetchedAt },
      'quirky.hosting/create': { number: 5, url: forkUrl, existing: false },
    }
    await withHarness({ worktree: CREATE_WORKTREE, replies }, async (harness) => {
      await harness.invoke('create', 'createOpen', { worktree: GITLAB_WORKTREE })
      await harness.invoke('create', 'createDraft', {
        worktree: GITLAB_WORKTREE,
        title: 'Add x',
        body: 'body',
        draft: true,
        useTemplate: false,
      })
      const result = await harness.invoke('create', 'createSubmit', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(result).toMatchObject({ status: 'created', review: { number: 5, url: forkUrl } })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toEqual({ number: 5, url: forkUrl })
    })
  })

  test('GitLab Checks rejects review identities from another host or project', async () => {
    for (const repository of [
      { ...GITLAB_REPOSITORY, host: 'other.example.test' },
      { ...GITLAB_REPOSITORY, repo: 'another-project' },
    ]) {
      const review = {
        ...GITLAB_REVIEW,
        url: `https://${repository.host}/${repository.owner}/${repository.repo}/-/merge_requests/5`,
        repository,
        prRepo: repository,
      }
      await withHarness({
        replies: { 'quirky.git/status': GITLAB_STATUS, 'quirky.hosting/forBranch': lookup(review) },
      }, async (harness) => {
        const result = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
        expect(result.ok).toBe(false)
        expect(result.error).toContain('different repository identity')
        expect(harness.env.view(GITLAB_WORKTREE).checks.review).toBeNull()
        expect(callsFor(harness, 'quirky.hosting/checks')).toHaveLength(0)
        expect(callsFor(harness, 'quirky.hosting/comments')).toHaveLength(0)
      })
      await withHarness({}, async (harness) => {
        await expect(harness.invoke('checks', 'checksLink', {
          worktree: GITLAB_WORKTREE,
          number: 5,
          prRepo: repository,
        })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
        expect(callsFor(harness, 'quirky.hosting/review')).toHaveLength(0)
      })
    }
  })

  test('GitLab Checks unlink suppresses and relink restores the same review', async () => {
    await withHarness({ replies: { 'quirky.git/status': GITLAB_STATUS } }, async (harness) => {
      await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE })
      expect(harness.env.view(GITLAB_WORKTREE).checks.review?.number).toBe(5)
      expect(harness.env.view(GITLAB_WORKTREE).checks.comments?.comments).toHaveLength(2)

      const unlinked = await harness.invoke('checks', 'checksUnlink', { worktree: GITLAB_WORKTREE })
      expect(unlinked).toMatchObject({ unlinked: true, number: 5 })
      expect(harness.env.read().links[GITLAB_WORKTREE]).toBeUndefined()
      expect(harness.env.read().suppressed[GITLAB_WORKTREE]).toEqual({ number: 5, url: GITLAB_URL })
      expect(harness.env.view(GITLAB_WORKTREE).checks.review).toBeNull()

      const reviewReads = callsFor(harness, 'quirky.hosting/review').length
      const suppressed = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(suppressed).toMatchObject({ ok: true, kind: 'suppressed', number: 5 })
      expect(callsFor(harness, 'quirky.hosting/review')).toHaveLength(reviewReads)

      const restored = await harness.invoke('checks', 'checksRelink', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(restored).toMatchObject({ linked: true, number: 5, url: GITLAB_URL })
      expect(harness.env.read().suppressed[GITLAB_WORKTREE]).toBeUndefined()
      expect(harness.env.read().links[GITLAB_WORKTREE]).toEqual({ number: 5, url: GITLAB_URL })
      expect(harness.env.view(GITLAB_WORKTREE).checks.review).toMatchObject({ provider: 'gitlab', number: 5 })
      expect(harness.env.view(GITLAB_WORKTREE).checks.comments?.comments).toHaveLength(2)
    })
  })

  test('a stale Checks lookup cannot overwrite a newer same-worktree identity', async () => {
    const heldLookup = deferred<unknown>()
    const lookupStarted = deferred<void>()
    await withHarness({
      replies: {
        'quirky.git/status': GITLAB_STATUS,
        'quirky.hosting/forBranch': () => {
          lookupStarted.resolve()
          return heldLookup.promise
        },
      },
    }, async (harness) => {
      const oldRead = harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE })
      await lookupStarted.promise
      const replacementGeneration = harness.env.nextGeneration()
      const replacement = newChecksEntry(GITLAB_WORKTREE, replacementGeneration)
      replacement.review = selectedGitLabReview({ title: 'replacement' })
      replacement.error = 'replacement owns this state'
      harness.env.update((state) => { state.checksByWorktree[GITLAB_WORKTREE] = replacement })

      heldLookup.resolve(GITLAB_LOOKUP)
      const result = await oldRead as JsonRecord
      expect(result.stale).toBe(true)
      expect(harness.env.read().checksByWorktree[GITLAB_WORKTREE]).toMatchObject({
        generation: replacementGeneration,
        review: { title: 'replacement' },
        error: 'replacement owns this state',
      })
      expect(callsFor(harness, 'quirky.hosting/checks')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/comments')).toHaveLength(0)
    })
  })

  test('a same-number GitHub repository replacement clears old Checks and comments', async () => {
    const firstReview = selectedGitHubReview(GITHUB_FORK_REPOSITORY)
    const replacementReview = selectedGitHubReview(GITHUB_OTHER_REPOSITORY)
    let branchReads = 0
    let checkReads = 0
    let commentReads = 0
    await withHarness({
      replies: githubReplies(firstReview, {
        'quirky.hosting/forBranch': () => lookup(branchReads++ === 0 ? firstReview : replacementReview),
        'quirky.hosting/checks': () => {
          checkReads += 1
          if (checkReads === 1) return GITLAB_CHECKS
          throw new Error('replacement checks are unavailable')
        },
        'quirky.hosting/comments': () => {
          commentReads += 1
          if (commentReads === 1) return GITLAB_COMMENTS
          throw new Error('replacement comments are unavailable')
        },
      }),
    }, async (harness) => {
      const initial = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(initial.ok).toBe(true)
      expect(harness.env.view(GITLAB_WORKTREE).checks.checks).not.toBeNull()
      expect(harness.env.view(GITLAB_WORKTREE).checks.comments).not.toBeNull()

      const refreshed = await harness.invoke('checks', 'checksRefresh', { worktree: GITLAB_WORKTREE }) as JsonRecord
      expect(refreshed.ok).toBe(false)
      expect(harness.env.view(GITLAB_WORKTREE).checks.review?.number).toBe(5)
      expect(harness.env.view(GITLAB_WORKTREE).checks.review?.prRepo).toEqual(GITHUB_OTHER_REPOSITORY)
      expect(harness.env.view(GITLAB_WORKTREE).checks.checks).toBeNull()
      expect(harness.env.view(GITLAB_WORKTREE).checks.comments).toBeNull()
      expect(harness.env.view(GITLAB_WORKTREE).checks.loading).toBe(false)
    })
  })

  test('settings authentication read failures settle with an error and no GitHub capabilities', async () => {
    await withHarness({
      replies: {
        'quirky.hosting/diagnoseAuth': { ...GITLAB_DIAGNOSTICS, requiredHostAuthenticated: 'yes' },
      },
    }, async (harness) => {
      const result = await harness.invoke('create', 'hostingSettingsRefresh', {
        worktree: GITLAB_WORKTREE,
        forceBudget: true,
      }) as JsonRecord
      expect(result.refreshed).toBe(false)
      expect(result.error).toContain('GitLab diagnostics')
      expect(harness.env.read().settings).toMatchObject({
        provider: 'gitlab',
        repository: GITLAB_REPOSITORY,
        loading: false,
        error: expect.stringContaining('GitLab diagnostics'),
      })
      expect(callsFor(harness, 'quirky.hosting/accounts')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/configuration')).toHaveLength(0)
      expect(callsFor(harness, 'quirky.hosting/rateLimit')).toHaveLength(0)
    })
  })

  test('detail refresh discards a held read after the selected review identity changes', async () => {
    const heldComments = deferred<unknown>()
    const commentsStarted = deferred<void>()
    const replacementRepository = { ...GITLAB_REPOSITORY, repo: 'another-project' }
    const replacementReview = selectedGitLabReview({
      number: 6,
      url: `https://${GITLAB_HOST}/group/sub/another-project/-/merge_requests/6`,
      repository: replacementRepository,
      prRepo: replacementRepository,
    })
    await withHarness({
      replies: {
        'quirky.hosting/comments': () => {
          commentsStarted.resolve()
          return heldComments.promise
        },
      },
    }, async (harness) => {
      selectDetail(harness)
      const oldRead = harness.invoke('detail', 'detailRefresh', {
        surface: 'detail',
        worktree: GITLAB_WORKTREE,
        number: 5,
      })
      await commentsStarted.promise
      const replacementComments = GITLAB_COMMENTS
      harness.env.update((state) => {
        state.detail.target = {
          worktree: GITLAB_WORKTREE,
          number: 6,
          tab: 'conversation',
          prRepo: replacementRepository,
        }
        state.detail.review = replacementReview
        state.detail.comments = replacementComments
        state.detail.error = 'replacement owns this state'
        state.detail.loading = false
      })

      heldComments.resolve(GITLAB_COMMENTS)
      await oldRead
      expect(harness.env.read().detail).toMatchObject({
        target: { number: 6, prRepo: replacementRepository },
        review: replacementReview,
        comments: replacementComments,
        error: 'replacement owns this state',
        loading: false,
      })
    })
  })

  test('GitLab rejects malformed state and thread acknowledgements without leaving optimistic state', async () => {
    for (const acknowledgement of [
      { number: 6, state: 'closed', updated: true },
      { number: 5, state: 'open', updated: false },
      { number: 5, state: 'closed', updated: 'yes' },
      { number: 5, state: 'closed' },
    ]) {
      await withHarness({
        replies: { 'quirky.hosting/updateReview': acknowledgement },
      }, async (harness) => {
        selectDetail(harness, selectedGitLabReview({ state: 'open' }))
        await expect(harness.invoke('detail', 'detailCloseReview', {
          surface: 'detail',
          worktree: GITLAB_WORKTREE,
          number: 5,
        })).rejects.toMatchObject({ data: { reason: 'invalid_upstream' } })
        expect(harness.env.read().detail.review?.state).toBe('open')
      })
    }

    await withHarness({
      replies: {
        'quirky.hosting/resolveThread': {
          threadId: 'another-thread',
          action: 'resolve',
          resolved: true,
        },
      },
    }, async (harness) => {
      selectDetail(harness)
      await expect(harness.invoke('detail', 'detailResolveThread', {
        surface: 'detail',
        worktree: GITLAB_WORKTREE,
        number: 5,
        threadId: 'a'.repeat(40),
        resolved: true,
      })).rejects.toMatchObject({ data: { reason: 'invalid_upstream' } })
      const comments = harness.env.read().detail.comments
      if (!isRecord(comments) || !Array.isArray(comments.comments) || !isRecord(comments.comments[1])) {
        throw new Error('The GitLab discussion fixture was unavailable')
      }
      expect(comments.comments[1].isResolved).toBe(false)
    })
  })

  test('GitHub still requires a changed-state acknowledgement to report success', async () => {
    await withHarness({
      replies: {
        'quirky.hosting/updateReview': { number: 5, state: 'open', updated: false },
      },
    }, async (harness) => {
      selectDetail(harness, selectedGitHubReview(GITHUB_FORK_REPOSITORY, { state: 'draft' }))
      await expect(harness.invoke('detail', 'detailMarkReady', {
        surface: 'detail',
        worktree: GITLAB_WORKTREE,
        number: 5,
      })).rejects.toMatchObject({ data: { reason: 'invalid_upstream' } })
      expect(harness.env.read().detail.review?.state).toBe('draft')
    })
  })

  function canonicalSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalSchema)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
      .filter(([key, entry]) => key !== 'description' && !(key === 'properties' && isRecord(entry) && Object.keys(entry).length === 0))
      .map(([key, entry]) => [key, canonicalSchema(entry)]))
  }

  test('method specs, manifest schemas, and required CLI IDs stay aligned', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json() as {
      contributes: {
        method: Array<{ id: string; params: unknown; result: unknown }>
        'cli-command': Array<{ id: string; method: string }>
      }
    }
    const sourceSpecs = [...checksSpecs, ...detailSpecs, ...createSpecs]
    for (const spec of sourceSpecs) {
      const declarations = manifest.contributes.method.filter((method) => method.id === spec.id)
      expect(declarations).toHaveLength(1)
      expect(canonicalSchema(declarations[0]?.params)).toEqual(canonicalSchema(spec.params))
      expect(canonicalSchema(declarations[0]?.result)).toEqual(canonicalSchema(spec.result))
    }
    const cli = new Map(manifest.contributes['cli-command'].map((entry) => [entry.id, entry.method]))
    for (const [id, method] of [
      ['create-submit', 'createSubmit'],
      ['hosting-diagnose', 'hostingDiagnose'],
      ['hosting-settings-refresh', 'hostingSettingsRefresh'],
      ['detail-refresh', 'detailRefresh'],
      ['detail-resolve-thread', 'detailResolveThread'],
    ]) expect(cli.get(id)).toBe(method)
  })

})
