import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import type { OutboxRow } from '../src/contracts'
import { register } from '../src/shipping/index'
import { createOutbox, outboxKey, type Outbox } from '../src/shipping/outbox'
import { forBranchFake, handOff, lsRemote, manifestChecked, readyPushTarget } from './shipping-support'
import { type FakeCalls, makeTestApp, sampleMandate } from './support'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

const check = (stdout: string, pass = true) => ({ ran: true, pass, exitCode: pass ? 0 : 1, timedOut: false, aborted: false, stdoutTail: stdout, stderrTail: '' })

const manifestViolations: string[][] = []

afterEach(() => {
  const observed = manifestViolations.flat()
  manifestViolations.length = 0
  expect(observed).toEqual([])
})

function setup(fakeCalls: FakeCalls = {}) {
  const checked = manifestChecked({
    'quirky.git/pushTarget': () => readyPushTarget(),
    'quirky.checks/run': (params) => {
      const command = String(params.command ?? '')
      if (command.includes('ls-remote')) {
        return check(command.includes('--symref')
          ? lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER })
          : `${OTHER}\trefs/heads/feature\n`)
      }
      return check('')
    },
    'quirky.hosting/forBranch': forBranchFake({ branch: 'feature', review: { number: 7, state: 'open' } }),
    ...fakeCalls
  })
  manifestViolations.push(checked.violations)
  const t = makeTestApp({ fakeCalls: checked.fakes })
  handOff(t.app)
  t.app.store.mandates.put(sampleMandate({ level: 'full' }))
  return { ...t, outbox: createOutbox(t.app) }
}

const mergeRow = (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
  t.outbox.enqueue('merge', 'wt-1', { headSha: SHA, target: '7', number: 7, reviewedSha: SHA, checkedSha: SHA, method: 'squash', action: 'direct', ...extra })

const methods = (calls: { method: string }[]) => calls.map((call) => call.method)

describe('outbox enqueue', () => {
  test('records the row before any call and keys it by kind, worktree, head and target', () => {
    const { outbox, calls, app } = setup()
    const row = outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    expect(calls).toEqual([])
    expect(row.state).toBe('recorded')
    expect(row.idempotencyKey).toBe(createHash('sha256').update(JSON.stringify(['push', 'wt-1', SHA, 'feature'])).digest('hex'))
    expect(outboxKey('push', 'wt-1', SHA, 'feature')).toBe(row.idempotencyKey)
    expect(app.store.outbox.get(row.id)).toEqual(row)
  })

  test('the same action on the same head and target is one row', () => {
    const { outbox, app } = setup()
    const first = outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature' })
    const second = outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature' })
    expect(second.id).toBe(first.id)
    expect(app.store.outbox.list()).toHaveLength(1)
    expect(outbox.enqueue('push', 'wt-1', { headSha: OTHER, target: 'feature' }).id).not.toBe(first.id)
  })

  test('a failed or cancelled row is recorded again, a done row is returned as it is', () => {
    const { outbox, app } = setup()
    const row = outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'f' })
    app.store.outbox.put({ ...row, state: 'failed', result: { error: 'x' } })
    expect(outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'f' })).toMatchObject({ id: row.id, state: 'recorded', result: null })
    app.store.outbox.put({ ...row, state: 'done', result: { ok: true } })
    expect(outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'f' })).toMatchObject({ id: row.id, state: 'done' })
  })
})

describe('outbox run', () => {
  test('marks the row running during the call and done with the result after', async () => {
    let seen: OutboxRow['state'] | null = null
    const t = setup({
      'quirky.checks/run': () => check(lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER })),
      'quirky.git/push': () => {
        seen = t.app.store.outbox.list()[0]?.state ?? null
        return { remote: 'origin', branch: 'feature', upstream: 'origin/feature' }
      }
    })
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    const done = await t.outbox.run(row.id)
    expect(seen as unknown).toBe('running')
    expect(done).toMatchObject({ state: 'done', result: { remote: 'origin', branch: 'feature' } })
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'outbox').length).toBeGreaterThanOrEqual(2)
  })

  test('never repeats a row that is done, running or failed', async () => {
    const t = setup({
      'quirky.git/push': () => ({ remote: 'origin', branch: 'feature', upstream: 'origin/feature' }),
      'quirky.checks/run': () => check(lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER }))
    })
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    await t.outbox.run(row.id)
    await t.outbox.run(row.id)
    expect(methods(t.calls).filter((method) => method === 'quirky.git/push')).toHaveLength(1)
    t.app.store.outbox.put({ ...row, state: 'running' })
    await t.outbox.run(row.id)
    expect(methods(t.calls).filter((method) => method === 'quirky.git/push')).toHaveLength(1)
  })

  test('two concurrent runs of one row push once', async () => {
    let pushes = 0
    const t = setup({
      'quirky.checks/run': () => check(lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER })),
      'quirky.git/push': async () => {
        pushes++
        await Promise.resolve()
        return { remote: 'origin', branch: 'feature', upstream: 'origin/feature' }
      }
    })
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    const [first, second] = await Promise.all([t.outbox.run(row.id), t.outbox.run(row.id)])
    expect(pushes).toBe(1)
    expect([first?.state, second?.state].sort()).toEqual(['done', 'running'])
    expect(t.app.store.outbox.get(row.id)?.state).toBe('done')
  })

  test('a throwing call leaves the row failed with the error', async () => {
    const t = setup({
      'quirky.checks/run': () => check(lsRemote({ defaultBranch: 'main', branch: 'feature', sha: OTHER })),
      'quirky.git/push': () => { throw new Error('rejected') }
    })
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'failed', result: { error: 'rejected' } })
  })

  test('checks the remote before pushing and skips a push that already landed', async () => {
    const t = setup({
      'quirky.checks/run': (params) => {
        const command = String(params.command ?? '')
        return check(command.includes('--symref')
          ? lsRemote({ defaultBranch: 'main', branch: 'feature', sha: SHA })
          : `${SHA}\trefs/heads/feature\n`)
      }
    })
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'done' })
    expect(methods(t.calls)).not.toContain('quirky.git/push')
  })

  test('does not act when it cannot tell what happened remotely', async () => {
    const t = setup({ 'quirky.hosting/review': () => ({ kind: 'unavailable', reason: 'offline' }), 'quirky.hosting/merge': () => ({ state: 'merged' }) })
    const row = t.outbox.enqueue('merge', 'wt-1', { headSha: SHA, target: '7', number: 7, reviewedSha: SHA, checkedSha: SHA })
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'recorded' })
    expect(methods(t.calls)).not.toContain('quirky.hosting/merge')
  })

  test('creates a draft PR and marks it ready through hosting', async () => {
    const t = setup({
      'quirky.hosting/forBranch': () => ({ kind: 'no-review' }),
      'quirky.hosting/create': () => ({ number: 7, url: 'u', existing: false }),
      'quirky.hosting/review': () => ({ kind: 'found', review: { state: 'draft' } }),
      'quirky.hosting/updateReview': () => ({ number: 7, updated: true, state: 'open' })
    })
    const pr = t.outbox.enqueue('pr', 'wt-1', { headSha: SHA, target: 'f', branch: 'f', title: 'T', body: 'B', draft: true })
    expect(await t.outbox.run(pr.id)).toMatchObject({ state: 'done', result: { number: 7 } })
    expect(t.calls.find((call) => call.method === 'quirky.hosting/create')?.params).toMatchObject({ title: 'T', draft: true })
    const ready = t.outbox.enqueue('pr-ready', 'wt-1', { headSha: SHA, target: '7', number: 7 })
    await t.outbox.run(ready.id)
    expect(t.calls.find((call) => call.method === 'quirky.hosting/updateReview')?.params).toMatchObject({ number: 7, action: 'ready' })
  })
})

describe('outbox merge', () => {
  test('pins the merge to the reviewed commit through expectedHead', async () => {
    const t = setup({
      'quirky.hosting/review': () => ({ kind: 'found', review: { state: 'open', headRefOid: SHA } }),
      'quirky.hosting/merge': () => ({ state: 'merged', number: 7, head: SHA })
    })
    const row = mergeRow(t)
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'done', result: { state: 'merged' } })
    expect(t.calls.find((call) => call.method === 'quirky.hosting/merge')?.params).toMatchObject({ number: 7, expectedHead: SHA, method: 'squash', action: 'direct' })
  })

  test('refuses a merge whose reviewed and checked commits differ', async () => {
    const t = setup({ 'quirky.hosting/review': () => ({ kind: 'found', review: { state: 'open' } }), 'quirky.hosting/merge': () => ({ state: 'merged' }) })
    const row = mergeRow(t, { checkedSha: OTHER })
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'failed' })
    expect(methods(t.calls)).not.toContain('quirky.hosting/merge')
  })
})

describe('outbox reconcile on activation', () => {
  test('a running merge that GitHub shows as merged becomes done without merging again', async () => {
    const t = setup({ 'quirky.hosting/review': () => ({ kind: 'found', review: { state: 'merged', headRefOid: SHA } }), 'quirky.hosting/merge': () => ({ state: 'merged' }) })
    const row = mergeRow(t)
    t.app.store.outbox.put({ ...row, state: 'running' })
    await t.outbox.reconcile()
    expect(t.app.store.outbox.get(row.id)).toMatchObject({ state: 'done', result: { state: 'merged' } })
    expect(methods(t.calls)).toEqual(['quirky.hosting/review'])
  })

  test('a running merge that did not happen goes back to recorded and is not repeated', async () => {
    const t = setup({ 'quirky.hosting/review': () => ({ kind: 'found', review: { state: 'open' } }), 'quirky.hosting/merge': () => ({ state: 'merged' }) })
    const row = mergeRow(t)
    t.app.store.outbox.put({ ...row, state: 'running' })
    await t.outbox.reconcile()
    expect(t.app.store.outbox.get(row.id)?.state).toBe('recorded')
    expect(methods(t.calls)).not.toContain('quirky.hosting/merge')
  })

  describe('a merge-main-in row left running by a crash', () => {
    const crashed = (command: (command: string) => ReturnType<typeof check>) => {
      const commands: string[] = []
      const t = setup({
        'quirky.checks/run': (params) => {
          commands.push(String(params.command))
          return command(String(params.command))
        }
      })
      const row = t.outbox.enqueue('merge-main-in', 'wt-1', { headSha: SHA, target: 'main@1', defaultBranch: 'main' })
      t.app.store.outbox.put({ ...row, state: 'running' })
      return { t, row, commands }
    }
    const merges = (commands: string[]) => commands.filter((command) => command.startsWith('git merge '))

    test('a merge that already completed is done and never re-run', async () => {
      const { t, row, commands } = crashed((command) => (command.includes('MERGE_HEAD') ? check('', false) : check('')))
      await t.outbox.reconcile()
      expect(t.app.store.outbox.get(row.id)).toMatchObject({ state: 'done', result: { conflict: false } })
      expect(commands.some((command) => command.includes('merge-base --is-ancestor') && command.includes('origin/main'))).toBe(true)
      expect(merges(commands)).toEqual([])
      await t.outbox.run(row.id)
      expect(merges(commands)).toEqual([])
    })

    test('a merge left half-done is failed with a reason and never re-run', async () => {
      const { t, row, commands } = crashed((command) => (command.includes('MERGE_HEAD') ? check('') : check('', false)))
      await t.outbox.reconcile()
      const stored = t.app.store.outbox.get(row.id)
      expect(stored?.state).toBe('failed')
      expect(String((stored?.result as { error?: string }).error)).toContain('in progress')
      expect(merges(commands)).toEqual([])
    })

    test('a merge that clearly did not apply goes back to recorded, and running it then merges once', async () => {
      const { t, row, commands } = crashed((command) => {
        if (command.includes('MERGE_HEAD')) return check('', false)
        if (command.includes('--is-ancestor')) return check('', false)
        return check('Merge made')
      })
      await t.outbox.reconcile()
      expect(t.app.store.outbox.get(row.id)?.state).toBe('recorded')
      expect(merges(commands)).toEqual([])
      expect(await t.outbox.run(row.id)).toMatchObject({ state: 'done' })
      expect(merges(commands)).toHaveLength(1)
    })

    test('when git cannot say, the row stays running and nothing is re-run', async () => {
      const { t, row, commands } = crashed((command) => (command.includes('--is-ancestor') ? { ...check('', false), exitCode: 128 } : check('', false)))
      await t.outbox.reconcile()
      expect(t.app.store.outbox.get(row.id)?.state).toBe('running')
      expect(merges(commands)).toEqual([])
    })
  })

  test('a push is compared with the remote branch SHA and a pr with a fresh branch lookup', async () => {
    const t = setup({
      'quirky.checks/run': (params) => check(String(params.command).includes('ls-remote') ? `${SHA}\trefs/heads/f` : ''),
      'quirky.hosting/forBranch': () => ({ kind: 'found', review: { number: 9, url: 'u', state: 'draft' } })
    })
    const push = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'f', branch: 'f' })
    const pr = t.outbox.enqueue('pr', 'wt-1', { headSha: SHA, target: 'f', branch: 'f', title: 'T' })
    handOff(t.app, 'wt-2')
    t.app.store.mandates.put(sampleMandate({ worktreeId: 'wt-2', level: 'full' }))
    const stale = t.outbox.enqueue('push', 'wt-2', { headSha: OTHER, target: 'g', branch: 'g' })
    for (const row of [push, pr, stale]) t.app.store.outbox.put({ ...row, state: 'running' })
    await t.outbox.reconcile()
    expect(t.app.store.outbox.get(push.id)?.state).toBe('done')
    expect(t.app.store.outbox.get(pr.id)).toMatchObject({ state: 'done', result: { number: 9 } })
    expect(t.app.store.outbox.get(stale.id)?.state).toBe('recorded')
    expect(t.calls.find((call) => call.method === 'quirky.hosting/forBranch')?.params).toMatchObject({ fresh: true })
    expect(methods(t.calls)).not.toContain('quirky.git/push')
    expect(methods(t.calls)).not.toContain('quirky.hosting/create')
  })

  test('leaves done, failed and cancelled rows alone', async () => {
    const t = setup()
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'f' })
    t.app.store.outbox.put({ ...row, state: 'done', result: { ok: true } })
    await t.outbox.reconcile()
    expect(t.calls).toEqual([])
  })
})

describe('outbox merge-main-in', () => {
  const rowFor = (t: ReturnType<typeof setup>) => t.outbox.enqueue('merge-main-in', 'wt-1', { headSha: SHA, target: 'main@1', defaultBranch: 'main' })

  test('merges origin/<default> into the worktree', async () => {
    const t = setup({ 'quirky.checks/run': () => check('Already up to date.') })
    expect(await t.outbox.run(rowFor(t).id)).toMatchObject({ state: 'done', result: { conflict: false } })
    const command = String(t.calls[0]?.params.command)
    expect(command).toContain('git merge')
    expect(command).toContain('origin/main')
    expect(t.calls[0]?.params).toMatchObject({ worktree: 'wt-1' })
  })

  test('reports the conflicted files and leaves the worktree clean', async () => {
    const commands: string[] = []
    const t = setup({
      'quirky.checks/run': (params) => {
        const command = String(params.command)
        commands.push(command)
        if (command.includes('git merge --abort')) return check('')
        if (command.includes('--diff-filter=U')) return check('src/a.ts\nsrc/b.ts\n')
        return check('CONFLICT', false)
      }
    })
    expect(await t.outbox.run(rowFor(t).id)).toMatchObject({ state: 'done', result: { conflict: true, files: ['src/a.ts', 'src/b.ts'] } })
    expect(commands.some((command) => command.includes('git merge --abort'))).toBe(true)
  })

  test('a merge failure with no conflicted files is a failed row', async () => {
    const t = setup({ 'quirky.checks/run': (params) => (String(params.command).includes('--diff-filter=U') ? check('') : check('fatal: not a repo', false)) })
    expect(await t.outbox.run(rowFor(t).id)).toMatchObject({ state: 'failed' })
  })
})

describe('outbox cancel', () => {
  test('cancels recorded rows of one worktree only', () => {
    const t = setup()
    const recorded = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'a' })
    const running = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'b' })
    const done = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'c' })
    handOff(t.app, 'wt-2')
    t.app.store.mandates.put(sampleMandate({ worktreeId: 'wt-2', level: 'full' }))
    const other = t.outbox.enqueue('push', 'wt-2', { headSha: SHA, target: 'a' })
    t.app.store.outbox.put({ ...running, state: 'running' })
    t.app.store.outbox.put({ ...done, state: 'done', result: {} })
    expect(t.outbox.cancel('wt-1')).toBe(1)
    expect(t.app.store.outbox.get(recorded.id)?.state).toBe('cancelled')
    expect(t.app.store.outbox.get(running.id)?.state).toBe('running')
    expect(t.app.store.outbox.get(done.id)?.state).toBe('done')
    expect(t.app.store.outbox.get(other.id)?.state).toBe('recorded')
  })
})

describe('shipping registration (SC-23)', () => {
  const merging = (t: ReturnType<typeof setup>) => {
    const row = mergeRow(t)
    t.app.store.outbox.put({ ...row, state: 'running' })
    return row
  }

  test('reconciles the outbox before anything else and never repeats a merge GitHub already did', async () => {
    const t = setup({
      'quirky.hosting/review': () => ({ kind: 'found', review: { state: 'merged', headRefOid: SHA } }),
      'quirky.hosting/merge': () => ({ state: 'merged' }),
      'quirky.git/status': () => ({ head: SHA, branch: 'f' })
    })
    const row = merging(t)
    register(t.app)
    const pending = t.app.services.shipping.runDoneWhen('wt-1')
    await t.app.services.shipping.reconcileOutbox()
    await pending
    expect(methods(t.calls)[0]).toBe('quirky.hosting/review')
    expect(t.app.store.outbox.get(row.id)?.state).toBe('done')
    expect(methods(t.calls)).not.toContain('quirky.hosting/merge')
  })

  test('another call waits for the first reconcile to finish', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const t = setup({
      'quirky.hosting/review': async () => {
        await gate
        return { kind: 'found', review: { state: 'open' } }
      },
      'quirky.checks/run': () => check('')
    })
    merging(t)
    register(t.app)
    t.app.store.mandates.put({ worktreeId: 'wt-1', goal: 'g', doneWhen: 'true', doneWhenKind: 'command', guidelines: [], level: 'full', switches: { messaging: false, historyRewrite: false, deploys: false }, agent: null, sharedGoalId: null, notes: '', allowSplit: false, updatedAt: 1 })
    const done = t.app.services.shipping.runDoneWhen('wt-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(methods(t.calls)).toEqual(['quirky.hosting/review'])
    release()
    await done
    expect(methods(t.calls)).toContain('quirky.checks/run')
  })

  test('GitHub being unreachable leaves the row recorded, unrepeated, and does not block later calls', async () => {
    const t = setup({ 'quirky.hosting/review': () => { throw new Error('offline') }, 'quirky.hosting/merge': () => ({ state: 'merged' }) })
    const row = merging(t)
    register(t.app)
    await t.app.services.shipping.reconcileOutbox()
    expect(t.app.store.outbox.get(row.id)?.state).toBe('recorded')
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'recorded' })
    expect(methods(t.calls)).not.toContain('quirky.hosting/merge')
    expect(t.app.services.shipping.cancelOutbox('wt-1')).toBe(1)
  })

  test('take-back cancels only the actions that had not started', () => {
    const t = setup()
    register(t.app)
    const queued = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'f' })
    const running = t.outbox.enqueue('pr', 'wt-1', { headSha: SHA, target: 'f' })
    t.app.store.outbox.put({ ...running, state: 'running' })
    expect(t.app.services.shipping.cancelOutbox('wt-1')).toBe(1)
    expect(t.app.store.outbox.get(queued.id)?.state).toBe('cancelled')
    expect(t.app.store.outbox.get(running.id)?.state).toBe('running')
  })

  test('the disposer stops listening for reviewer events', () => {
    const t = setup()
    const dispose = register(t.app)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})

describe('creation push safety', () => {
  const push = (t: { outbox: Outbox }, payload: Record<string, unknown> = {}) =>
    t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature', ...payload })

  test('checks the creation target and remote default before pushing under its own name', async () => {
    const reply = { remote: 'origin', branch: 'feature', upstream: 'origin/feature' }
    const t = setup({ 'quirky.git/push': () => reply })
    expect(await t.outbox.run(push(t).id)).toMatchObject({ state: 'done', result: reply })
    expect(t.calls).toEqual([
      { method: 'quirky.git/pushTarget', params: { worktree: 'wt-1', purpose: 'creation' } },
      { method: 'quirky.checks/run', params: { worktree: 'wt-1', command: "git ls-remote --symref 'origin' HEAD 'refs/heads/feature'", timeoutSeconds: 60 } },
      { method: 'quirky.git/push', params: { worktree: 'wt-1', purpose: 'creation', expectedHead: SHA, expectedBranch: 'feature' } }
    ])
  })

  test('fails a stale-target push without treating it as an unknown outcome', async () => {
    const message = 'The local branch or HEAD changed since push-target validation.'
    const t = setup({
      'quirky.git/push': () => { throw Object.assign(new Error(message), { data: { reason: 'stale-target' } }) }
    })
    const row = push(t)
    expect(await t.outbox.run(row.id)).toMatchObject({
      state: 'failed', result: { error: `push refused (stale-target): ${message}` }
    })
    expect(t.app.store.outbox.get(row.id)?.state).toBe('failed')
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' }).find((entry) => entry.kind === 'outbox')?.data.note).toBe('failed')
  })

  test.each([
    ['branch_mismatch', 'The configured creation push ref is not the current branch.'],
    ['unavailable', 'The remote is unavailable.']
  ])('refuses an unready target (%s)', async (reason, message) => {
    const t = setup({ 'quirky.git/pushTarget': () => ({ ready: false, reason, message }) })
    expect(await t.outbox.run(push(t).id)).toMatchObject({ state: 'failed', result: { error: `push refused (${reason}): ${message}` } })
    expect(methods(t.calls)).toEqual(['quirky.git/pushTarget'])
  })

  test('refuses the default branch of the selected remote', async () => {
    const t = setup({ 'quirky.git/pushTarget': () => readyPushTarget({ branch: 'main', localBranch: 'main' }) })
    expect(await t.outbox.run(push(t, { branch: 'main', target: 'main' }).id)).toMatchObject({
      state: 'failed', result: { error: 'push refused: main is the default branch of origin' }
    })
    expect(methods(t.calls)).toEqual(['quirky.git/pushTarget', 'quirky.checks/run'])
  })

  test('refuses the compare base without making any call', async () => {
    const t = setup()
    expect(await t.outbox.run(push(t, { branch: 'develop', target: 'develop', base: 'develop' }).id)).toMatchObject({
      state: 'failed', result: { error: 'push refused: develop is the branch this worktree is compared against' }
    })
    expect(t.calls).toEqual([])
  })

  test.each([
    [{ localHead: OTHER }, `push refused: HEAD is ${OTHER}, not the recorded ${SHA}`],
    [{ localBranch: 'other' }, 'push refused: the worktree is on other, not feature'],
    [{ branch: 'main' }, 'push refused: the push would go to origin/main, not origin/feature']
  ])('refuses a changed target %j', async (overrides, error) => {
    const t = setup({ 'quirky.git/pushTarget': () => readyPushTarget(overrides) })
    expect(await t.outbox.run(push(t).id)).toMatchObject({ state: 'failed', result: { error } })
    expect(methods(t.calls)).toEqual(['quirky.git/pushTarget'])
  })

  test('keeps the row recorded when the remote default cannot be read', async () => {
    const t = setup({ 'quirky.checks/run': () => check(lsRemote({ defaultBranch: null, branch: 'feature', sha: OTHER })) })
    const row = push(t)
    expect(await t.outbox.run(row.id)).toMatchObject({ state: 'recorded' })
    expect(t.app.store.journalPage({ worktreeId: 'wt-1' })[0]?.data).toMatchObject({
      note: 'not run: could not check what happened', error: 'could not read the default branch of origin'
    })
    expect(methods(t.calls)).not.toContain('quirky.git/push')
  })

  test.each(['not-run', 'nonzero', 'target-error'])('does not push after an unknown lookup (%s)', async (failure) => {
    const t = setup({
      'quirky.git/pushTarget': () => {
        if (failure === 'target-error') throw new Error('offline')
        return readyPushTarget()
      },
      'quirky.checks/run': () => ({ ...check('', false), ran: failure !== 'not-run' })
    })
    expect(await t.outbox.run(push(t).id)).toMatchObject({ state: 'recorded' })
    expect(methods(t.calls)).not.toContain('quirky.git/push')
  })

  test('reads the destination ref rather than the remote HEAD when checking a prior push', async () => {
    const t = setup({ 'quirky.checks/run': () => check(lsRemote({ branch: 'feature', sha: SHA })) })
    expect(await t.outbox.run(push(t).id)).toMatchObject({
      state: 'done', result: { remote: 'origin', branch: 'feature', remoteSha: SHA }
    })
    expect(methods(t.calls)).toEqual(['quirky.git/pushTarget', 'quirky.checks/run'])
  })

  test.each([{ branch: undefined }, { headSha: undefined }])('refuses a push without its recorded identity %j', async (payload) => {
    const t = setup()
    expect(await t.outbox.run(push(t, payload).id)).toMatchObject({
      state: 'failed', result: { error: 'push needs a branch and a commit' }
    })
    expect(t.calls).toEqual([])
  })
})

describe('outbox send authorization', () => {
  test('does not re-record a refused action while the worktree is not handed off', async () => {
    const t = setup()
    const handoff = t.app.store.handoffs.get('wt-1')!
    t.app.store.handoffs.put({ ...handoff, active: false })
    const payload = { headSha: SHA, target: 'feature', branch: 'feature' }
    const row = t.outbox.enqueue('push', 'wt-1', payload)
    expect(row).toMatchObject({ state: 'cancelled', result: { error: 'this worktree is not handed off' } })
    expect(t.outbox.enqueue('push', 'wt-1', payload)).toEqual(row)
    const failed = { ...row, state: 'failed' as const, result: { error: 'previous failure' } }
    t.app.store.outbox.put(failed)
    expect(t.outbox.enqueue('push', 'wt-1', payload)).toEqual(failed)
    await t.outbox.run(row.id)
    expect(t.calls).toEqual([])
  })

  test('a new hand-off records the same cancelled action under its new epoch', async () => {
    const t = setup({ 'quirky.git/push': () => ({ remote: 'origin', branch: 'feature' }) })
    const payload = { headSha: SHA, target: 'feature', branch: 'feature' }
    const row = t.outbox.enqueue('push', 'wt-1', payload)
    t.outbox.cancel('wt-1')
    handOff(t.app, 'wt-1', 2)
    const next = t.outbox.enqueue('push', 'wt-1', payload)
    expect(next).toMatchObject({ id: row.id, state: 'recorded', payload: { handedOffAt: 2 } })
    expect(await t.outbox.run(next.id)).toMatchObject({ state: 'done' })
  })

  test.each([
    ['merge', 'own-branch'],
    ['thread-reply', 'local'],
    ['push', 'shadow']
  ] as const)('refuses a directly run %s at %s', async (kind, level) => {
    const t = setup()
    const row = t.outbox.enqueue(kind, 'wt-1', { headSha: SHA, target: '7', number: 7 })
    t.app.store.mandates.put(sampleMandate({ level }))
    expect(await t.outbox.run(row.id)).toMatchObject({
      state: 'cancelled', result: { error: `level ${level} does not allow ${kind}` }
    })
    expect(t.calls).toEqual([])
  })

  test.each(['recorded', 'running'] as const)('reconcile cancels an absent %s action from a replaced hand-off', async (state) => {
    const t = setup()
    const row = t.outbox.enqueue('push', 'wt-1', { headSha: SHA, target: 'feature', branch: 'feature' })
    t.app.store.outbox.put({ ...row, state })
    handOff(t.app, 'wt-1', 2)
    await t.outbox.reconcile()
    expect(t.app.store.outbox.get(row.id)).toMatchObject({
      state: 'cancelled', result: { error: 'this worktree was taken back and handed off again' }
    })
    expect(methods(t.calls)).not.toContain('quirky.git/push')
  })
})
