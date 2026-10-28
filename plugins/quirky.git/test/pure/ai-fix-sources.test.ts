import { describe, expect, test } from 'bun:test'
import type { PluginCaller, Worktree } from '@quirky/protocol'
import { aiFix, aiFixPreview } from '../../src/daemon/ai-fix'
import type { DaemonEnv } from '../../src/daemon/env'
import type { EffectiveRecipe, RecipeAction } from '../../src/daemon/ai-recipes'

const worktree = { id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt-1' } as Worktree
const review = {
  provider: 'github',
  number: 42,
  url: 'https://github.com/octo/quirky/pull/42',
  title: 'Keep launch settings canonical',
  body: 'Preserve one resolver for every launch.',
  state: 'open',
  headRefName: 'zoe/feat',
  baseRefName: 'main',
  headRefOid: 'a'.repeat(40),
  baseRefOid: 'b'.repeat(40),
  reviewDecision: 'REVIEW_REQUIRED',
  checksStatus: 'failure',
  repository: { host: 'github.com', owner: 'octo', repo: 'quirky' }
}

function sourceEnv(action: RecipeAction) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const recipe: EffectiveRecipe = {
    action,
    agent: 'codex',
    args: '--model gpt-5.5',
    template: '{basePrompt}\nKeep the user in control.',
    launchOptions: { model: 'gpt-5.6-sol', optionValues: { effort: 'high' } },
    sources: { agent: 'repo', args: 'repo', template: 'repo', launchOptions: 'repo' }
  }
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.agents/list') return { agents: [{ id: 'codex', installed: true, enabled: true }] }
      if (method === 'quirky.hosting/forBranch') return { kind: 'found', review, fetchedAt: 1 }
      if (method === 'quirky.hosting/files') return { number: 42, files: [{ path: 'src/launch.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }], truncated: false }
      if (method === 'quirky.hosting/comments') return { number: 42, comments: [{ kind: 'review_comment', author: 'reviewer', body: 'Keep the exact launch owner.', path: 'src/launch.ts', line: 1, threadId: 'thread-1' }], partial: false, partialFailures: [] }
      if (method === 'quirky.terminal/newTab') {
        return { workspace: { root: { kind: 'group', id: 'group-1', tabs: [{ root: { kind: 'pane', session: 'session-1' } }] }, activeGroup: 'group-1' } }
      }
      throw new Error(`unexpected public call ${method}`)
    }
  }
  const env = {
    context,
    resolve: async () => worktree,
    readStatus: async () => ({ branch: 'zoe/feat', head: 'a'.repeat(40) }),
    recipes: { effective: () => recipe }
  } as unknown as DaemonEnv
  return { env, calls, context }
}

describe('public hosting-backed recipe source flows', () => {
  test('PR details, code review, and conversation drafts fetch named public sources and launch through terminal/newTab', async () => {
    const caller = { role: 'plugin' } as unknown as PluginCaller
    const expectations = {
      pullRequestDetails: ['Keep launch settings canonical', 'REVIEW_REQUIRED'],
      pullRequestReview: ['src/launch.ts', 'Keep the exact launch owner.', 'failure'],
      reviewConversation: ['Keep the exact launch owner.', 'Draft a concise reply for the user to review.']
    } as const
    for (const action of Object.keys(expectations) as (keyof typeof expectations)[]) {
      const { env, calls } = sourceEnv(action)
      const params = { action, worktree: worktree.id }
      const preview = await aiFixPreview(env)(params, caller) as { prompt: string; recipe: EffectiveRecipe }
      for (const source of expectations[action]!) expect(preview.prompt).toContain(source)
      expect(preview.recipe.action).toBe(action)
      expect(calls.some((call) => call.method === 'quirky.terminal/newTab')).toBe(false)

      const started = await aiFix(env)(params, caller) as { session: string; agent: string; prompt: string }
      expect(started).toMatchObject({ session: 'session-1', agent: 'codex', prompt: preview.prompt })
      const expectedLookups = action === 'pullRequestDetails' ? 2 : 4
      const lookups = calls.filter((call) => call.method === 'quirky.hosting/forBranch')
      expect(lookups).toHaveLength(expectedLookups)
      expect(lookups.every((call) => call.params.fresh === true)).toBe(true)
      expect(calls.filter((call) => call.method === 'quirky.agents/resolveLaunch')).toEqual([])
      const launches = calls.filter((call) => call.method === 'quirky.terminal/newTab')
      expect(launches).toHaveLength(1)
      expect(launches[0]!.params).toMatchObject({
        worktree: worktree.id,
        agent: 'codex',
        prompt: preview.prompt,
        extraArgs: '--model gpt-5.5',
        model: 'gpt-5.6-sol',
        options: { effort: 'high' }
      })
      if (action === 'pullRequestDetails') expect(calls.some((call) => call.method === 'quirky.hosting/files')).toBe(false)
      if (action === 'pullRequestReview') expect(calls.some((call) => call.method === 'quirky.hosting/files')).toBe(true)
      if (action === 'reviewConversation') expect(calls.some((call) => call.method === 'quirky.hosting/comments')).toBe(true)
      if (action === 'pullRequestReview' || action === 'reviewConversation') {
        expect(calls.some((call) => call.method === 'quirky.hosting/comments')).toBe(true)
      }
    }
  })
})
