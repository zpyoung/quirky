import { supportsHostedReviewCreation } from '../../shared/hosted-review-creation-providers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createGitHubPullRequestMock,
  createGitLabMergeRequestMock,
  getMergeRequestForBranchMock,
  getProjectSlugMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock,
  getGitHubPRLookupRateLimitBlockMock,
  getEnterpriseGitHubRepoSlugMock
} = vi.hoisted(() => ({
  createGitHubPullRequestMock: vi.fn(),
  createGitLabMergeRequestMock: vi.fn(),
  getMergeRequestForBranchMock: vi.fn(),
  getProjectSlugMock: vi.fn(),
  getPRForBranchOutcomeMock: vi.fn(),
  getRepoSlugMock: vi.fn(),
  getGitHubPRLookupRateLimitBlockMock: vi.fn(async () => null),
  getEnterpriseGitHubRepoSlugMock: vi.fn()
}))

vi.mock('../gitlab/client', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  // Why: forge-provider resolves branch reviews via the OrThrow variant so
  // lookup failures surface as unavailable instead of "no MR found".
  getMergeRequestForBranchOrThrow: getMergeRequestForBranchMock,
  getMergeRequest: vi.fn()
}))

vi.mock('../gitlab/merge-request-creation', () => ({
  createGitLabMergeRequest: createGitLabMergeRequestMock
}))

vi.mock('../github/client', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock,
  getRepoSlug: getRepoSlugMock,
  getPRForBranchOutcome: getPRForBranchOutcomeMock,
  getGitHubPRLookupRateLimitBlock: getGitHubPRLookupRateLimitBlockMock
}))

vi.mock('../github/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock
}))

import {
  FORGE_PROVIDERS,
  detectHostedReviewProvider,
  getForgeProviderById,
  getForgeProviderForRepository
} from './forge-provider'

import { _resetOriginGitHubApiRepositoryCache } from '../github/github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('forge provider interface', () => {
  beforeEach(() => {
    createGitHubPullRequestMock.mockReset()
    createGitLabMergeRequestMock.mockReset()
    getMergeRequestForBranchMock.mockReset()
    getProjectSlugMock.mockReset()
    getPRForBranchOutcomeMock.mockReset()
    getRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getGitHubPRLookupRateLimitBlockMock.mockReset()
    getGitHubPRLookupRateLimitBlockMock.mockResolvedValue(null)
  })

  it('preserves the existing hosted provider detection order', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'team/quirky' })
    getRepoSlugMock.mockResolvedValue({ owner: 'team', repo: 'quirky' })

    await expect(
      detectHostedReviewProvider({ executionHostId: 'local', repoPath: '/repo' })
    ).resolves.toBe('gitlab')
    await expect(
      getForgeProviderForRepository({ executionHostId: 'local', repoPath: '/repo' })
    ).resolves.toMatchObject({
      id: 'gitlab'
    })
    expect(getRepoSlugMock).not.toHaveBeenCalled()
  })

  it('detects a GitHub Enterprise Server remote as the GitHub provider', async () => {
    // Regression for #8312: a GHES host is not github.com, so github.com-only
    // slug parsing returns null. Detection must claim it via the enterprise
    // resolver.
    getProjectSlugMock.mockResolvedValue(null)
    // Why: getRepoSlug resolves hosted identities itself now — a GHES remote
    // comes back host-qualified instead of null + separate enterprise fallback.
    getRepoSlugMock.mockResolvedValue({
      owner: 'team',
      repo: 'quirky',
      host: 'github.acme-corp.com'
    })

    await expect(
      detectHostedReviewProvider({ executionHostId: 'local', repoPath: '/repo' })
    ).resolves.toBe('github')
    await expect(
      getForgeProviderForRepository({ executionHostId: 'local', repoPath: '/repo' })
    ).resolves.toMatchObject({
      id: 'github'
    })
  })

  it('keeps review creation capability scoped to providers with creation support', async () => {
    expect(
      FORGE_PROVIDERS.map((provider) => [provider.id, provider.supportsReviewCreation])
    ).toEqual([
      ['gitlab', true],
      ['github', true]
    ])
    // Why: the shared list is what the Create blocker and the renderer read.
    for (const provider of FORGE_PROVIDERS) {
      expect(supportsHostedReviewCreation(provider.id)).toBe(provider.supportsReviewCreation)
    }
    createGitHubPullRequestMock.mockResolvedValue({
      ok: true,
      number: 12,
      url: 'https://github.com/team/quirky/pull/12'
    })

    const provider = getForgeProviderById('github')
    await expect(
      provider.createReview?.(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature/provider-interface',
          title: 'Add provider interface'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/team/quirky/pull/12'
    })
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'github',
        base: 'main',
        head: 'feature/provider-interface',
        title: 'Add provider interface'
      },
      'local'
    )
  })

  it('routes GitLab review creation through the shared provider contract', async () => {
    createGitLabMergeRequestMock.mockResolvedValue({
      ok: true,
      number: 44,
      url: 'https://gitlab.com/team/quirky/-/merge_requests/44'
    })

    const provider = getForgeProviderById('gitlab')
    await expect(
      provider.createReview?.(
        '/repo',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature/provider-interface',
          title: 'Add provider interface'
        },
        'ssh:ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 44,
      url: 'https://gitlab.com/team/quirky/-/merge_requests/44'
    })
    expect(createGitLabMergeRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'gitlab',
        base: 'main',
        head: 'feature/provider-interface',
        title: 'Add provider interface'
      },
      'ssh:ssh-1'
    )
  })

  it('adapts GitHub branch lookup through the shared provider contract', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      fetchedAt: 1,
      pr: {
        number: 7,
        title: 'Provider branch',
        state: 'open',
        url: 'https://github.com/team/quirky/pull/7',
        checksStatus: 'success',
        updatedAt: '2026-05-29T00:00:00.000Z',
        mergeable: 'MERGEABLE'
      }
    })

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        executionHostId: 'ssh:ssh-1',
        branch: '',
        fallbackReviewNumber: 7
      })
    ).resolves.toMatchObject({
      provider: 'github',
      number: 7,
      status: 'success'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', '', null, 'ssh-1', 7, {
      acceptMergedFallbackPR: true,
      currentHeadOid: null
    })
  })

  it('passes the worktree HEAD oid through to the GitHub lookup', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })

    await getForgeProviderById('github').getReviewForBranch({
      repoPath: '/repo',
      executionHostId: 'local',
      branch: 'feature/x',
      githubCurrentHeadOid: 'abc1234'
    })

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', 'feature/x', null, null, null, {
      currentHeadOid: 'abc1234'
    })
  })

  it('returns null for a confirmed GitHub no-pr lookup', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        executionHostId: 'local',
        branch: 'feature/x'
      })
    ).resolves.toBeNull()
  })

  it('throws on a GitHub upstream error instead of reporting no review', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'connection reset',
      fetchedAt: 1
    })

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        executionHostId: 'local',
        branch: 'feature/x'
      })
    ).rejects.toThrow(/network/)
  })

  it('refuses a GitHub branch lookup while the rate-limit budget is exhausted (#11532)', async () => {
    getGitHubPRLookupRateLimitBlockMock.mockResolvedValueOnce({
      resetAt: 1_800_000_000
    } as never)

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        executionHostId: 'local',
        branch: 'feature/x'
      })
      // Throwing (not null) keeps a low budget from reading as "no pull request".
    ).rejects.toThrow(/rate_limited/)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })

  it('refuses a GitHub lookup by number while the rate-limit budget is exhausted (#11532)', async () => {
    getGitHubPRLookupRateLimitBlockMock.mockResolvedValueOnce({
      resetAt: 1_800_000_000
    } as never)

    await expect(
      getForgeProviderById('github').getReviewByNumber({
        repoPath: '/repo',
        executionHostId: 'local',
        number: 42
      })
    ).rejects.toThrow(/rate_limited/)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })

  it('does not gate non-GitHub providers on the GitHub rate limit', async () => {
    getGitHubPRLookupRateLimitBlockMock.mockResolvedValue({ resetAt: 1_800_000_000 } as never)
    getMergeRequestForBranchMock.mockResolvedValue(null)

    await expect(
      getForgeProviderById('gitlab').getReviewForBranch({
        repoPath: '/repo',
        executionHostId: 'local',
        branch: 'feature/x'
      })
    ).resolves.toBeNull()
  })
})
