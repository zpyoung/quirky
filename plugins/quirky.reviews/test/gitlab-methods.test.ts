import { describe, expect, test } from 'bun:test'
import * as detailData from '../src/detail/data'
import {
  parseCommentsResult,
  parseRepoIdentity,
  parseReviewLookup,
  repoFromReviewUrl,
  reviewContext,
} from '../src/detail/data'
import {
  createGitLabMethodHarness,
  GITLAB_COMMENTS,
  GITLAB_DIAGNOSTICS,
  GITLAB_HOST,
  GITLAB_LOOKUP,
  GITLAB_REPOSITORY,
  GITLAB_REVIEW,
  GITLAB_WORKTREE,
  gitlabComments,
} from './gitlab-support'

const GITLAB_URL = GITLAB_REVIEW.url
const GITHUB_URL = 'https://github.com/owner/repo/pull/5'
const GITHUB_REPOSITORY = { host: 'github.com', owner: 'owner', repo: 'repo' }

function lookup(review: unknown) {
  return { kind: 'found', review, fetchedAt: GITLAB_LOOKUP.fetchedAt }
}
const parseAuthDiagnostics = (value: unknown): unknown => {
  const parser = (detailData as unknown as Record<string, unknown>).parseAuthDiagnostics
  return typeof parser === 'function' ? parser(value) : null
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
      }
      expect(parseAuthDiagnostics(missing)).toEqual(missing)
    }

    const rejected = {
      ...GITLAB_DIAGNOSTICS,
      tokenSource: 'env',
      tokenRejected: true,
      activeAccount: null,
      accounts: [],
      requiredHostAuthenticated: false,
    }
    expect(parseAuthDiagnostics(rejected)).toEqual(rejected)
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, missingScopes: ['api'], requiredHostAuthenticated: true }))
      .toMatchObject({ missingScopes: ['api'], requiredHostAuthenticated: true })
    expect(parseAuthDiagnostics({ ...GITLAB_DIAGNOSTICS, accounts: [{ ...GITLAB_DIAGNOSTICS.accounts[0], scopes: [] }] }))
      .toMatchObject({ accounts: [{ scopes: [] }] })

    const githubAccount = {
      host: 'github.com', user: 'fixture-user', source: 'env', active: true, bindable: false, scopes: ['repo'],
    }
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
    }
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
    malformedAfterLimit.comments[100] = { ...malformedAfterLimit.comments[100] as object, body: 42 }
    expect(parseCommentsResult(malformedAfterLimit, 5, 'gitlab')).toBeNull()
    expect(parseCommentsResult(gitlabComments(101), 5)).toBeNull()
    expect(parseCommentsResult(gitlabComments(101), 5, 'github')).toBeNull()
    expect(parseCommentsResult(gitlabComments(101), 5, 'unknown' as never)).toBeNull()

    const existingPartial = parseCommentsResult(gitlabComments(101, true, ['provider_page_partial']), 5, 'gitlab')
    expect(existingPartial?.partial).toBe(true)
    expect(existingPartial?.partialFailures).toEqual(['provider_page_partial', 'reviews_comments_truncated'])
  })

})
