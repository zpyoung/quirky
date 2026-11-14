import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { ReviewData, ReviewsState } from '../src/contracts'
import { createReviewsEnv, newChecksEntry } from '../src/env'
import { detailMethods } from '../src/detail/methods'
import { ReviewActions } from '../src/detail/Actions'
import { SitterRow, SitterSafetyStrip } from '../src/checks/SitterRow'
import { listReviewsUiControls, requestOpenSitter, requestReviewsUiControl, runReviewsUiControl, type ChecksSitterState, type SitterFleetRow, type ReviewsUiControlDescriptor } from '../src/checks/data'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates } from '../../../scripts/ui-scoreboard/audit-discovery'
import { resolve } from 'node:path'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})
afterAll(() => GlobalRegistrator.unregister())
const WORKTREE = '/fixture/tree'
const PANEL = 'panel:quirky.reviews/checks'
const VIEW = 'view:quirky.reviews/review'
const REPO = { host: 'github.com', owner: 'fixture', repo: 'reviews' }
const review: ReviewData = {
  provider: 'github', number: 12, url: 'https://github.com/fixture/reviews/pull/12', title: 'Review 12', body: '',
  state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE', checksStatus: 'success', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, stack: null, mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
  mergeMetadataKnown: true, mergeQueueRequired: false, autoMergeAllowed: true, prRepo: REPO,
}

function model(current: ReviewData | null = review): ReviewsState {
  return {
    checks: { worktree: WORKTREE, generation: 1, review: current, conflicts: null },
    detail: { target: { worktree: WORKTREE, number: current?.number ?? 12, prRepo: REPO }, generation: 1, review: current, details: null, pending: [] },
  } as unknown as ReviewsState
}

test('loading check details preserves prior run keys and the public stored shape', async () => {
  const details = { check: { id: 31, name: 'build' }, annotations: [], jobs: [], logTails: [], partialFailures: [], truncated: false }
  const env = createReviewsEnv({
    openStore: () => ({ get: () => undefined, run: () => {} }), emit() {},
    error: (_kind: string, message: string) => new Error(message),
    call: async (method: string) => {
      if (method === 'quirky.worktree/resolve') return { id: WORKTREE, kind: 'git', repoId: 'fixture', path: WORKTREE }
      if (method === 'quirky.hosting/checkDetails') return details
      throw new Error(`Unexpected method ${method}`)
    },
  } as never)
  env.update((state) => {
    const entry = newChecksEntry(WORKTREE, 1)
    entry.review = review
    entry.checks = { number: 12, headSha: review.headRefOid, rollup: 'success', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 31, workflowRunId: null, suiteId: null, url: null }], partial: false, partialFailures: [], detailsById: { '19': { prior: true } } }
    state.checksByWorktree[WORKTREE] = entry
  })
  const methods = detailMethods(env)
  await methods.detailLoadCheckDetails!({ surface: 'checks', worktree: WORKTREE, number: 12, expectedHead: review.headRefOid, checkRunId: 31 } as never, {} as never)
  expect(env.read().checksByWorktree[WORKTREE]?.checks?.detailsById).toEqual({ '19': { prior: true }, '31': details })
})

test('detail methods expose no UI action candidates', () => {
  const inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')!
  expect(discoverCandidates(plugin, ['plugins/quirky.reviews/src/detail/methods.ts'])).toEqual([])
})
