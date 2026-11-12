import { afterEach, describe, expect, test } from 'bun:test'
import type { WorktreeState } from '../src/contracts'
import { register } from '../src/shipping/index'
import { forBranchFake, handOff, lsRemote, manifestChecked, readyPushTarget, takeBack } from './shipping-support'
import { type FakeCalls, makeTestApp, sampleMandate } from './support'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const check = (stdout = '', pass = true) => ({ ran: true, pass, exitCode: pass ? 0 : 1, timedOut: false, aborted: false, stdoutTail: stdout, stderrTail: '' })
const manifestViolations: string[][] = []

afterEach(() => {
  const observed = manifestViolations.flat()
  manifestViolations.length = 0
  expect(observed).toEqual([])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => (resolve = finish))
  return { promise, resolve }
}

type SetupOptions = { level?: 'shadow' | 'local' | 'own-branch' | 'full'; prState?: string; calls?: FakeCalls }

function setup(options: SetupOptions = {}) {
  const checked = manifestChecked({
    'quirky.git/status': () => ({ head: HEAD, branch: 'feature' }),
    'quirky.git/compare': () => ({ status: 'ready', base: 'origin/main', entries: [{ path: 'src/a.ts' }] }),
    'quirky.git/fetch': () => ({ ok: true }),
    'quirky.git/pushTarget': () => readyPushTarget({ localHead: HEAD }),
    'quirky.git/push': () => ({ remote: 'origin', branch: 'feature', upstream: 'origin/feature' }),
    'quirky.checks/run': (params) => {
      const command = String(params.command ?? '')
      if (command.includes('ls-remote')) return check(lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER }))
      if (command.includes('rev-parse')) return check('c'.repeat(40))
      if (command.includes('--diff-filter=U')) return check('src/a.ts\n')
      if (command.includes('git merge --abort')) return check('')
      if (command.includes('git merge --no-edit')) return check('Already up to date.')
      return check('')
    },
    'quirky.hosting/forBranch': forBranchFake({ branch: 'feature', review: { number: 7, state: options.prState ?? 'open', headRefOid: HEAD, mergeQueueRequired: false } }),
    'quirky.hosting/review': () => ({ kind: 'found', review: { number: 7, state: options.prState ?? 'open', headRefOid: HEAD } }),
    'quirky.hosting/checks': () => ({ number: 7, headSha: HEAD, rollup: 'success', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 1 }], partial: false, partialFailures: [] }),
    'quirky.hosting/checkDetails': () => ({ logTails: [], annotations: [] }),
    'quirky.hosting/comments': () => ({ number: 7, comments: [], partial: false, partialFailures: [] }),
    'quirky.hosting/merge': () => ({ state: 'merged', number: 7, head: HEAD }),
    'quirky.hosting/updateReview': () => ({ number: 7, updated: true, state: 'open' }),
    'quirky.hosting/create': () => ({ number: 7, url: 'https://example.test/7', existing: false }),
    'quirky.hosting/rerunChecks': () => ({ started: 1, targetCount: 1, completedSteps: [] }),
    ...options.calls
  })
  manifestViolations.push(checked.violations)
  const t = makeTestApp({ fakeCalls: checked.fakes })
  handOff(t.app)
  t.app.store.mandates.put(sampleMandate({ level: options.level ?? 'full' }))
  t.app.journal('wt-1', 'finding', { reviewed: true, headSha: HEAD })
  const states: WorktreeState[] = []
  const sent: string[] = []
  t.app.services.handoff.setState = (_worktreeId, state) => void states.push(state)
  t.app.services.supervisor.send = async (_worktreeId, text) => {
    sent.push(text)
    return { sent: true }
  }
  register(t.app)
  return { ...t, states, sent, shipping: t.app.services.shipping }
}

function flakyBuildCalls(checkDetails: FakeCalls[string]): FakeCalls {
  return {
    'quirky.hosting/checks': () => ({
      number: 7,
      headSha: HEAD,
      rollup: 'failure',
      checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', checkRunId: 1 }],
      partial: false,
      partialFailures: []
    }),
    'quirky.hosting/checkDetails': checkDetails
  }
}

describe('shipping hand-off checks', () => {
  test('openPr, merge, and mergeMainIn refuse an absent or inactive hand-off without recording work', async () => {
    for (const inactive of [false, true]) {
      const t = setup()
      if (inactive) t.app.store.handoffs.put({ ...t.app.store.handoffs.get('wt-1')!, active: false })
      else t.app.store.handoffs.delete('wt-1')
      const expected = { ok: false, reason: 'this worktree is not handed off' }
      expect(await t.shipping.openPr('wt-1')).toEqual(expected)
      expect(await t.shipping.merge('wt-1')).toEqual(expected)
      expect(await t.shipping.mergeMainIn('wt-1')).toEqual(expected)
      expect(t.calls).toEqual([])
      expect(t.app.store.outbox.list()).toEqual([])
    }
  })

  test('take-back during the push lets that call finish but does not open a PR or set state', async () => {
    const push = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      level: 'own-branch',
      calls: { 'quirky.git/push': () => { entered.resolve(); return push.promise } }
    })
    const opening = t.shipping.openPr('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(0)
    push.resolve({ remote: 'origin', branch: 'feature', upstream: 'origin/feature' })
    expect(await opening).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.app.store.outbox.list({ kind: 'push' })[0]).toMatchObject({ state: 'done', result: { remote: 'origin', branch: 'feature' } })
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).find((entry) => entry.kind === 'outbox')?.data.note).toBe('done after take-back')
    expect(t.app.store.outbox.list({ kind: 'pr' })).toEqual([])
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/create')
    expect(t.states).toEqual([])
  })

  test('take-back during ls-remote checking cancels the push after failed or clean-absent evidence', async () => {
    const replies = [
      { ran: false, pass: false, exitCode: null, timedOut: false, aborted: false, stdoutTail: '', stderrTail: '', error: 'offline' },
      check(lsRemote({ branch: 'feature', sha: OTHER }))
    ]
    for (const reply of replies) {
      const remote = deferred<unknown>()
      const entered = deferred<void>()
      const t = setup({
        level: 'own-branch',
        calls: { 'quirky.checks/run': () => { entered.resolve(); return remote.promise } }
      })
      const opening = t.shipping.openPr('wt-1')
      await entered.promise
      expect(takeBack(t.app)).toBe(1)
      const row = t.app.store.outbox.list({ kind: 'push' })[0]!
      expect(row.state).toBe('cancelled')
      remote.resolve(reply)
      expect(await opening).toEqual({ ok: false, reason: 'this worktree is not handed off' })
      expect(t.app.store.outbox.get(row.id)?.state).toBe('cancelled')
      expect(t.calls.map((call) => call.method)).not.toContain('quirky.git/push')
      expect(t.app.store.outbox.list({ kind: 'pr' })).toEqual([])
    }
  })

  test('a cancelled push becomes done if the held remote check proves it already landed', async () => {
    const remote = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      level: 'own-branch',
      calls: { 'quirky.checks/run': () => { entered.resolve(); return remote.promise } }
    })
    const opening = t.shipping.openPr('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(1)
    remote.resolve(check(lsRemote({ branch: 'feature', sha: HEAD })))
    expect(await opening).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.app.store.outbox.list({ kind: 'push' })[0]).toMatchObject({ state: 'done', result: { remote: 'origin', branch: 'feature', remoteSha: HEAD } })
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.git/push')
  })

  test('an old push cannot continue after take-back and a new hand-off', async () => {
    const push = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      level: 'own-branch',
      calls: { 'quirky.git/push': () => { entered.resolve(); return push.promise } }
    })
    const opening = t.shipping.openPr('wt-1')
    await entered.promise
    takeBack(t.app)
    handOff(t.app, 'wt-1', 2)
    push.resolve({ remote: 'origin', branch: 'feature', upstream: 'origin/feature' })
    expect(await opening).toEqual({ ok: false, reason: 'this worktree was taken back and handed off again' })
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/create')
  })

  test('lowering the mandate during checks stops the merge at the new level', async () => {
    const checks = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({ calls: { 'quirky.hosting/checks': () => { entered.resolve(); return checks.promise } } })
    const merging = t.shipping.merge('wt-1')
    await entered.promise
    const mandate = t.app.store.mandates.get('wt-1')!
    t.app.store.mandates.put({ ...mandate, level: 'own-branch' })
    checks.resolve({ number: 7, headSha: HEAD, rollup: 'success', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 1 }], partial: false, partialFailures: [] })
    expect(await merging).toEqual({ ok: false, reason: 'level own-branch stops at draft-pr' })
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/updateReview')
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/merge')
  })

  test('take-back while merge reads checks records no next step or state', async () => {
    const checks = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({ calls: { 'quirky.hosting/checks': () => { entered.resolve(); return checks.promise } } })
    const merging = t.shipping.merge('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(0)
    checks.resolve({ number: 7, headSha: HEAD, rollup: 'success', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 1 }], partial: false, partialFailures: [] })
    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.app.store.outbox.list()).toEqual([])
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/updateReview')
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/merge')
    expect(t.states).toEqual([])
  })

  test('take-back after updateReview was issued finishes that row but does not record a merge', async () => {
    const update = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      prState: 'draft',
      calls: { 'quirky.hosting/updateReview': () => { entered.resolve(); return update.promise } }
    })
    const merging = t.shipping.merge('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(0)
    update.resolve({ number: 7, updated: true, state: 'open' })
    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.app.store.outbox.list({ kind: 'pr-ready' })[0]?.state).toBe('done')
    expect(t.app.store.outbox.list({ kind: 'merge' })).toEqual([])
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/merge')
  })

  test('take-back during check details prevents reruns, worker sends, and state changes', async () => {
    const details = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      calls: {
        'quirky.hosting/checks': () => ({ number: 7, headSha: HEAD, rollup: 'failure', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', checkRunId: 1 }], partial: false, partialFailures: [] }),
        'quirky.hosting/checkDetails': () => { entered.resolve(); return details.promise }
      }
    })
    const merging = t.shipping.merge('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(0)
    details.resolve({ logTails: ['src/a.ts:3 type error'], annotations: [] })
    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/rerunChecks')
    expect(t.sent).toEqual([])
    expect(t.states).toEqual([])
  })

  test('take-back during check details prevents rerunning a previously green failed build', async () => {
    const details = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      calls: flakyBuildCalls(() => {
        entered.resolve()
        return details.promise
      })
    })
    t.app.journal('wt-1', 'event', { checksGreen: true, headSha: HEAD, names: ['build'] })
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).some((entry) =>
      entry.kind === 'event' && entry.data.checksGreen === true && entry.data.headSha === HEAD &&
      Array.isArray(entry.data.names) && entry.data.names.includes('build')
    )).toBe(true)

    const merging = t.shipping.merge('wt-1')
    await entered.promise
    expect(t.calls.map((call) => call.method)).toContain('quirky.hosting/checkDetails')
    expect(takeBack(t.app)).toBe(0)
    details.resolve({ logTails: ['src/a.ts:3 type error'], annotations: [] })

    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.calls.map((call) => call.method)).not.toContain('quirky.hosting/rerunChecks')
    expect(t.app.store.journalSince(0).some((entry) =>
      entry.kind === 'event' && entry.data.flakyRerun === true && entry.data.headSha === HEAD
    )).toBe(false)
    expect(t.sent).toEqual([])
    expect(t.states).toEqual([])
  })

  test('a previously green failed build reruns checks without take-back', async () => {
    const t = setup({ calls: flakyBuildCalls(() => ({ logTails: ['src/a.ts:3 type error'], annotations: [] })) })
    t.app.journal('wt-1', 'event', { checksGreen: true, headSha: HEAD, names: ['build'] })

    expect(await t.shipping.merge('wt-1')).toEqual({
      ok: false,
      reason: 'required check build looks flaky, rerunning once'
    })
    expect(t.calls.map((call) => call.method)).toContain('quirky.hosting/rerunChecks')
    expect(t.app.store.journalSince(0)).toContainEqual(expect.objectContaining({
      kind: 'event',
      data: expect.objectContaining({ flakyRerun: true, headSha: HEAD, checks: 'build' })
    }))
    expect(t.sent).toEqual([])
    expect(t.states).toEqual([])
  })

  test('take-back while create is held records the PR row but refuses openPr completion', async () => {
    const create = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      level: 'own-branch',
      calls: {
        'quirky.hosting/forBranch': () => ({ kind: 'no-review', fetchedAt: 0 }),
        'quirky.hosting/create': () => {
          entered.resolve()
          return create.promise
        }
      }
    })
    const opening = t.shipping.openPr('wt-1')
    await entered.promise

    expect(takeBack(t.app)).toBe(0)
    create.resolve({ number: 7, url: 'https://example.test/7', existing: false })

    expect(await opening).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    const pr = t.app.store.outbox.list({ kind: 'pr' })[0]!
    expect(pr.state).toBe('done')
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).find((entry) =>
      entry.kind === 'outbox' && entry.data.id === pr.id
    )).toMatchObject({ data: { state: 'done', note: 'done after take-back' } })
    expect(t.calls.map((call) => call.method)).toContain('quirky.hosting/create')
    expect(t.states).toEqual([])
  })

  test('take-back while merge is held records the merge row without setting merged state', async () => {
    const merge = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      calls: {
        'quirky.hosting/merge': () => {
          entered.resolve()
          return merge.promise
        }
      }
    })
    const merging = t.shipping.merge('wt-1')
    await entered.promise
    expect(t.states).toEqual(['merge-ready'])

    expect(takeBack(t.app)).toBe(0)
    const statesAtTakeBack = [...t.states]
    merge.resolve({ state: 'merged', number: 7, head: HEAD })

    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    const mergeRow = t.app.store.outbox.list({ kind: 'merge' })[0]!
    expect(mergeRow.state).toBe('done')
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).find((entry) =>
      entry.kind === 'outbox' && entry.data.id === mergeRow.id
    )).toMatchObject({ data: { state: 'done', note: 'done after take-back' } })
    expect(t.states).toEqual(statesAtTakeBack)
    expect(t.states).not.toContain('merged')
  })

  test('take-back during fetch prevents merge-main-in from starting', async () => {
    const fetch = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({ calls: { 'quirky.git/fetch': () => { entered.resolve(); return fetch.promise } } })
    const merging = t.shipping.mergeMainIn('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(0)
    fetch.resolve({ ok: true })
    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.calls.some((call) => String(call.params.command ?? '').includes('git merge'))).toBe(false)
    expect(t.app.store.outbox.list({ kind: 'merge-main-in' })).toEqual([])
  })

  test('a merge-main-in conflict returned after take-back is recorded but not sent to the worker', async () => {
    const merge = deferred<unknown>()
    const entered = deferred<void>()
    const t = setup({
      calls: {
        'quirky.checks/run': (params) => {
          const command = String(params.command ?? '')
          if (command.includes('git merge --no-edit')) { entered.resolve(); return merge.promise }
          if (command.includes('--diff-filter=U')) return check('src/a.ts\n')
          if (command.includes('git merge --abort')) return check('')
          if (command.includes('rev-parse')) return check('c'.repeat(40))
          return check('')
        }
      }
    })
    const merging = t.shipping.mergeMainIn('wt-1')
    await entered.promise
    expect(takeBack(t.app)).toBe(0)
    merge.resolve(check('CONFLICT', false))
    expect(await merging).toEqual({ ok: false, reason: 'this worktree is not handed off' })
    expect(t.app.store.outbox.list({ kind: 'merge-main-in' })[0]).toMatchObject({ state: 'done', result: { conflict: true, files: ['src/a.ts'] } })
    expect(t.app.needs.list({ open: true })).toEqual([])
    expect(t.sent).toEqual([])
  })
})
