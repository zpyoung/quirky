import { afterEach, describe, expect, test } from 'bun:test'
import { createOutbox } from '../src/shipping/outbox'
import { register } from '../src/shipping/index'
import { forBranchFake, handOff, lsRemote, manifestChecked, readyPushTarget } from './shipping-support'
import { type FakeCalls, makeTestApp, sampleMandate } from './support'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const check = (stdout = '', pass = true) => ({ ran: true, pass, exitCode: pass ? 0 : 1, timedOut: false, aborted: false, stdoutTail: stdout, stderrTail: '' })
const checkedSets: string[][] = []

afterEach(() => {
  const observed = checkedSets.flat()
  checkedSets.length = 0
  expect(observed).toEqual([])
})

function checked(fakes: FakeCalls) {
  const result = manifestChecked(fakes)
  checkedSets.push(result.violations)
  return result
}

type SetupOptions = { calls?: FakeCalls; status?: Record<string, unknown>; review?: Record<string, unknown> }

function setup(options: SetupOptions = {}) {
  const targetReview = options.review ?? {
    number: 7,
    state: 'open',
    headRefOid: HEAD,
    mergeQueueRequired: false
  }
  const fake = checked({
    'quirky.git/status': () => options.status ?? ({ head: HEAD, branch: 'feature' }),
    'quirky.git/compare': () => ({ status: 'ready', base: 'origin/main', entries: [{ path: 'src/a.ts' }] }),
    'quirky.git/pushTarget': () => readyPushTarget({ localHead: HEAD }),
    'quirky.checks/run': (params) => String(params.command ?? '').includes('ls-remote')
      ? check(lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER }))
      : check(''),
    'quirky.hosting/forBranch': forBranchFake({ branch: 'feature', review: targetReview }),
    'quirky.hosting/review': () => ({ kind: 'found', review: targetReview }),
    'quirky.hosting/checks': () => ({ number: 7, headSha: HEAD, rollup: 'success', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 1 }], partial: false, partialFailures: [] }),
    'quirky.hosting/comments': () => ({ number: 7, comments: [], partial: false, partialFailures: [] }),
    'quirky.hosting/merge': () => ({ state: 'merged', number: 7, head: HEAD }),
    'quirky.hosting/updateReview': () => ({ number: 7, updated: true, state: 'open' }),
    'quirky.hosting/create': () => ({ number: 7, url: 'https://example.test/7', existing: false }),
    'quirky.hosting/rerunChecks': () => ({ started: 1, targetCount: 1, completedSteps: [] }),
    ...options.calls
  })
  const t = makeTestApp({ fakeCalls: fake.fakes })
  handOff(t.app)
  t.app.store.mandates.put(sampleMandate({ level: 'full' }))
  t.app.journal('wt-1', 'finding', { reviewed: true, headSha: HEAD })
  const outbox = createOutbox(t.app)
  register(t.app)
  return { ...t, outbox, shipping: t.app.services.shipping }
}

describe('manifest-checked shipping fakes', () => {
  test('rejects an unknown method before running its fake', () => {
    let ran = false
    const result = checked({ 'quirky.hosting/notInManifest': () => { ran = true } })
    expect(() => result.fakes['quirky.hosting/notInManifest']!({})).toThrow('quirky.hosting/notInManifest: not in the manifest')
    expect(ran).toBe(false)
    expect(result.violations).toEqual(['quirky.hosting/notInManifest: not in the manifest'])
    result.violations.length = 0
  })

  test('rejects params that do not match the method schema before running its fake', () => {
    let ran = false
    const result = checked({ 'quirky.hosting/create': () => { ran = true } })
    expect(() => result.fakes['quirky.hosting/create']!({ title: 7 })).toThrow('quirky.hosting/create: params.title must be a string')
    expect(ran).toBe(false)
    expect(result.violations).toEqual(['quirky.hosting/create: params.title must be a string'])
    result.violations.length = 0
  })

  test('requires yes true for destructive calls and removes dispatch-only params before schema validation', () => {
    const seen: Record<string, unknown>[] = []
    const result = checked({ 'quirky.hosting/merge': (params) => { seen.push(params); return { state: 'merged' } } })
    const base = { number: 7, expectedHead: HEAD, method: 'squash', action: 'direct' }
    expect(() => result.fakes['quirky.hosting/merge']!(base)).toThrow('quirky.hosting/merge: destructive without yes: true')
    expect(result.violations).toEqual(['quirky.hosting/merge: destructive without yes: true'])
    result.violations.length = 0
    expect(result.fakes['quirky.hosting/merge']!({ ...base, yes: true, confirmation: 'approved' })).toEqual({ state: 'merged' })
    expect(seen).toEqual([{ ...base, yes: true, confirmation: 'approved' }])
    expect(result.violations).toEqual([])
  })

  test('passes through other plugins without manifest validation', () => {
    const seen: Record<string, unknown>[] = []
    const params = { deliberatelyUnknown: true }
    const result = checked({ 'quirky.structured/create': (value) => { seen.push(value); return { id: 's1' } } })
    expect(result.fakes['quirky.structured/create']!(params)).toEqual({ id: 's1' })
    expect(seen).toEqual([params])
    expect(result.violations).toEqual([])
  })

  test('the branch lookup fake requires its branch unless the PR number matches', () => {
    const review = { number: 7, state: 'open' }
    const fake = forBranchFake({ branch: 'feature', review })
    expect(fake({ branch: 'feature' })).toEqual({ kind: 'found', review, fetchedAt: 0 })
    expect(fake({})).toEqual({ kind: 'no-review', fetchedAt: 0 })
    expect(fake({ number: 7 })).toEqual({ kind: 'found', review, fetchedAt: 0 })
  })
})

describe('shipping branch lookup contract', () => {
  test('merge, comment intake, and a PR row look up the worktree branch and head', async () => {
    const t = setup()
    await t.shipping.merge('wt-1')
    const expected = { worktree: 'wt-1', branch: 'feature', headOid: HEAD, fresh: true }
    expect(t.calls.filter((call) => call.method === 'quirky.hosting/forBranch').slice(0, 2).map((call) => call.params)).toEqual([expected, expected])

    t.calls.length = 0
    const row = t.outbox.enqueue('pr', 'wt-1', { headSha: HEAD, target: 'feature', branch: 'feature', title: 'Update' })
    await t.outbox.run(row.id)
    expect(t.calls.find((call) => call.method === 'quirky.hosting/forBranch')?.params).toEqual(expected)
  })

  test('merge passes the reviewed head and destructive confirmation to hosting', async () => {
    const t = setup()
    expect(await t.shipping.merge('wt-1')).toEqual({ ok: true })
    expect(t.calls.find((call) => call.method === 'quirky.hosting/merge')?.params).toEqual({
      worktree: 'wt-1', number: 7, expectedHead: HEAD, method: 'squash', action: 'direct', yes: true
    })
  })

  test('a missing branch prevents both merge and comment lookup', async () => {
    const t = setup({ status: { head: HEAD, branch: null } })
    expect(await t.shipping.merge('wt-1')).toEqual({ ok: false, reason: 'the worktree has no branch' })
    expect(t.calls.filter((call) => call.method === 'quirky.hosting/forBranch')).toEqual([])
  })

  test('an unavailable pull request lookup preserves its hosting reason', async () => {
    const t = setup({ calls: { 'quirky.hosting/forBranch': () => ({ kind: 'unavailable', reason: 'ambiguous_head', message: 'More than one pull request is linked to this branch.' }) } })
    expect(await t.shipping.merge('wt-1')).toEqual({ ok: false, reason: 'could not look up the pull request (ambiguous_head): More than one pull request is linked to this branch.' })
  })

  test('a no-review lookup keeps the ordinary no-pull-request reason', async () => {
    const t = setup({ calls: { 'quirky.hosting/forBranch': () => ({ kind: 'no-review', fetchedAt: 0 }) } })
    expect(await t.shipping.merge('wt-1')).toEqual({ ok: false, reason: 'there is no pull request for this worktree' })
  })

  test('a PR row without a branch fails rather than creating a pull request', async () => {
    const t = setup()
    const row = t.outbox.enqueue('pr', 'wt-1', { headSha: HEAD, target: 'feature', title: 'Update' })
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'failed', result: { error: 'pr needs a branch' } })
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/create')
  })
})
