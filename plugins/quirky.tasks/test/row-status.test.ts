import { expect, test } from 'bun:test'
import { rowDescription, rowStatus, type AgentActivity } from '../src/list/row-status'
import type { CheckResult, ListItem, MergeMetadata } from '../src/list/model'

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

function item(patch: Partial<ListItem> = {}): ListItem {
  return {
    kind: 'pullRequest', number: 274, title: 'Add thing', body: '', state: 'open', url: 'https://example.test/pull/274',
    createdAt: hoursAgo(100), updatedAt: hoursAgo(48), author: 'alex', labels: [], assignees: [], isDraft: false,
    worktree: '/work/quirky', repoId: 'repo-1', repoName: 'quirky', ...patch
  }
}

function merge(review: Record<string, unknown> = {}): MergeMetadata {
  return {
    review, mergeMetadataKnown: true, mergeQueueRequired: false, autoMergeAllowed: true, mergeEligible: false, queueEligible: false,
    autoMergeEnabled: false, autoMergeEnableEligible: false, directMethods: [], queueMethods: []
  }
}

function failing(count: number): CheckResult {
  return { rollup: 'failure', partial: false, partialFailures: [], checks: Array.from({ length: count }, (_, index) => ({ name: `check-${index}`, status: 'completed', conclusion: 'failure' })) }
}

const passing: CheckResult = { rollup: 'success', partial: false, partialFailures: [], checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }
const attention: AgentActivity = { bucket: 'attention', agent: 'Claude', label: 'Needs a decision' }
const working: AgentActivity = { bucket: 'working', agent: 'Claude', label: 'Running tests' }

test('an agent asking for attention needs you, with the agent name and label', () => {
  expect(rowStatus(item(), { viewer: 'sam', activity: attention })).toEqual({ status: 'needs-you', detail: 'Claude · Needs a decision' })
})

test('a requested review from the viewer needs you', () => {
  expect(rowStatus(item(), { viewer: 'sam', merge: merge({ requestedReviewers: ['kim', 'sam'] }) })).toEqual({ status: 'needs-you', detail: 'review requested' })
})

test('changes requested on the viewer\'s own PR needs you, from the item or the merge review', () => {
  const own = item({ author: 'sam' })
  expect(rowStatus({ ...own, reviewDecision: 'CHANGES_REQUESTED' }, { viewer: 'sam' })).toEqual({ status: 'needs-you', detail: 'changes requested' })
  expect(rowStatus(own, { viewer: 'sam', merge: merge({ reviewDecision: 'CHANGES_REQUESTED' }) })).toEqual({ status: 'needs-you', detail: 'changes requested' })
})

test('changes requested on someone else\'s PR does not need you', () => {
  expect(rowStatus(item({ reviewDecision: 'CHANGES_REQUESTED' }), { viewer: 'sam' }).status).toBe('idle')
})

test('failing checks on the viewer\'s own PR use singular and plural counts', () => {
  const own = item({ author: 'sam' })
  expect(rowStatus(own, { viewer: 'sam', checks: failing(1) })).toEqual({ status: 'failing', detail: '1 check failing' })
  expect(rowStatus(own, { viewer: 'sam', checks: failing(2) })).toEqual({ status: 'failing', detail: '2 checks failing' })
})

test('a failing rollup with no failing check entries counts as one', () => {
  const checks: CheckResult = { rollup: 'failure', partial: false, partialFailures: [], checks: [] }
  expect(rowStatus(item({ author: 'sam' }), { viewer: 'sam', checks })).toEqual({ status: 'failing', detail: '1 check failing' })
})

test('failing checks on someone else\'s PR are not failing', () => {
  expect(rowStatus(item(), { viewer: 'sam', checks: failing(3) }).status).toBe('idle')
})

test('passing checks on the viewer\'s own PR stay idle', () => {
  expect(rowStatus(item({ author: 'sam' }), { viewer: 'sam', checks: passing }).status).toBe('idle')
})

test('an agent working in a linked worktree is working', () => {
  expect(rowStatus(item(), { viewer: 'sam', activity: working })).toEqual({ status: 'working', detail: 'Claude · Running tests' })
})

test('merged and closed items are done with the state word and age', () => {
  expect(rowStatus(item({ state: 'merged' }), { viewer: 'sam' })).toEqual({ status: 'done', detail: 'merged 2d ago' })
  expect(rowStatus(item({ state: 'closed' }), { viewer: 'sam' })).toEqual({ status: 'done', detail: 'closed 2d ago' })
})

test('an open item is idle waiting on the first requested reviewer', () => {
  expect(rowStatus(item(), { viewer: 'sam', merge: merge({ requestedReviewers: ['alex', 'kim'] }) })).toEqual({ status: 'idle', detail: 'waiting on alex' })
})

test('an open item with no known reviewer is idle with its age', () => {
  expect(rowStatus(item(), { viewer: 'sam', merge: merge({ requestedReviewers: [] }) })).toEqual({ status: 'idle', detail: '2d ago' })
  expect(rowStatus(item(), { viewer: 'sam', merge: merge({ requestedReviewers: null }) })).toEqual({ status: 'idle', detail: '2d ago' })
})

test('an item with an unknown update time is idle with unknown age', () => {
  expect(rowStatus(item({ updatedAt: null }), { viewer: 'sam' })).toEqual({ status: 'idle', detail: 'unknown' })
})

test('priority: attention beats review request, failing checks and working', () => {
  const own = item({ author: 'sam', reviewDecision: 'CHANGES_REQUESTED' })
  const inputs = { viewer: 'sam', checks: failing(2), merge: merge({ requestedReviewers: ['sam'] }), activity: attention }
  expect(rowStatus(own, inputs)).toEqual({ status: 'needs-you', detail: 'Claude · Needs a decision' })
})

test('priority: a review request beats changes requested, failing checks and working', () => {
  const own = item({ author: 'sam', reviewDecision: 'CHANGES_REQUESTED' })
  const result = rowStatus(own, { viewer: 'sam', checks: failing(2), merge: merge({ requestedReviewers: ['sam'] }), activity: working })
  expect(result).toEqual({ status: 'needs-you', detail: 'review requested' })
})

test('priority: changes requested beats failing checks', () => {
  const own = item({ author: 'sam', reviewDecision: 'CHANGES_REQUESTED' })
  expect(rowStatus(own, { viewer: 'sam', checks: failing(2) }).status).toBe('needs-you')
})

test('priority: failing checks beat working', () => {
  expect(rowStatus(item({ author: 'sam' }), { viewer: 'sam', checks: failing(2), activity: working })).toEqual({ status: 'failing', detail: '2 checks failing' })
})

test('priority: working beats done and idle', () => {
  expect(rowStatus(item({ state: 'merged' }), { viewer: 'sam', activity: working }).status).toBe('working')
  expect(rowStatus(item(), { viewer: 'sam', merge: merge({ requestedReviewers: ['alex'] }), activity: working }).status).toBe('working')
})

test('priority: done beats waiting on a reviewer', () => {
  expect(rowStatus(item({ state: 'merged' }), { viewer: 'sam', merge: merge({ requestedReviewers: ['alex'] }) }).status).toBe('done')
})

test('a null viewer skips every viewer-based rule', () => {
  const own = item({ author: 'sam', reviewDecision: 'CHANGES_REQUESTED' })
  expect(rowStatus(own, { viewer: null, checks: failing(2), merge: merge({ requestedReviewers: ['sam'] }) })).toEqual({ status: 'idle', detail: 'waiting on sam' })
})

test('a null viewer still reports agent activity and done', () => {
  expect(rowStatus(item(), { viewer: null, activity: attention }).status).toBe('needs-you')
  expect(rowStatus(item(), { viewer: null, activity: working }).status).toBe('working')
  expect(rowStatus(item({ state: 'closed' }), { viewer: null }).status).toBe('done')
})

test('missing checks and merge metadata resolve to idle with the age', () => {
  expect(rowStatus(item({ author: 'sam' }), { viewer: 'sam' })).toEqual({ status: 'idle', detail: '2d ago' })
})

test('rowDescription prefixes the number and the repository for rows that are not agent activity', () => {
  expect(rowDescription(item(), { status: 'needs-you', detail: 'review requested' })).toBe('#274 · quirky · review requested')
  expect(rowDescription(item(), { status: 'failing', detail: '2 checks failing' })).toBe('#274 · quirky · 2 checks failing')
  expect(rowDescription(item({ state: 'merged' }), { status: 'done', detail: 'merged 3d ago' })).toBe('#274 · quirky · merged 3d ago')
  expect(rowDescription(item(), { status: 'idle', detail: 'waiting on alex' })).toBe('#274 · quirky · waiting on alex')
})

test('rowDescription leaves the repository out when the detail is agent activity', () => {
  expect(rowDescription(item(), { status: 'working', detail: 'Claude · Running tests' })).toBe('#274 · Claude · Running tests')
  expect(rowDescription(item(), { status: 'needs-you', detail: 'Claude · Needs a decision' })).toBe('#274 · Claude · Needs a decision')
})
