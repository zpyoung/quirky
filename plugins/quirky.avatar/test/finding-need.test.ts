import { afterEach, describe, expect, test } from 'bun:test'
import { quoteAsData } from '../src/sanitize'
import { register as registerHandoff } from '../src/handoff'
import { register as registerShipping } from '../src/shipping/index'
import { forBranchFake, handOff, lsRemote, manifestChecked, readyPushTarget } from './shipping-support'
import type { AvatarApp } from '../src/contracts'
import { type FakeCalls, makeTestApp, sampleMandate, type TestApp } from './support'

const HEAD = 'c'.repeat(40)
const REVIEW = { number: 7, state: 'open', headRefOid: HEAD, mergeQueueRequired: false, reviewDecision: 'NONE' }
const ROOT_COMMENT = {
  kind: 'review_comment',
  id: 11,
  author: 'sam',
  isBot: false,
  body: 'Please rename this',
  path: 'src/a.ts',
  line: 3,
  threadId: 'T1'
}
const manifestViolations: string[][] = []
const disposers: (() => void)[] = []

afterEach(() => {
  const observed = manifestViolations.flat()
  for (const dispose of disposers.splice(0)) dispose()
  manifestViolations.length = 0
  expect(observed).toEqual([])
})

type SetupOptions = {
  resolveThread?: (params: Record<string, unknown>) => unknown
  sendResult?: { sent: boolean; reason?: string }
}

async function setup(options: SetupOptions = {}) {
  let threadResolved = false
  const resolveCalls: Record<string, unknown>[] = []
  const reviewCommentCalls: Record<string, unknown>[] = []
  const sent: [string, string][] = []
  let wakes = 0
  const checked = manifestChecked({
    'quirky.git/status': () => ({ head: HEAD, branch: 'feature' }),
    'quirky.git/compare': () => ({ status: 'ready', base: 'origin/main', entries: [{ path: 'src/a.ts' }] }),
    'quirky.git/pushTarget': () => readyPushTarget({ localHead: HEAD }),
    'quirky.checks/run': (params) => String(params.command ?? '').includes('ls-remote')
      ? { ran: true, pass: true, exitCode: 0, timedOut: false, aborted: false, stdoutTail: lsRemote({ defaultBranch: 'main', branch: 'feature', sha: 'b'.repeat(40) }), stderrTail: '' }
      : { ran: true, pass: true, exitCode: 0, timedOut: false, aborted: false, stdoutTail: '', stderrTail: '' },
    'quirky.hosting/forBranch': forBranchFake({ branch: 'feature', review: REVIEW }),
    'quirky.hosting/review': () => ({ kind: 'found', review: REVIEW }),
    'quirky.hosting/checks': () => ({
      number: 7,
      headSha: HEAD,
      rollup: 'success',
      checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 1 }],
      partial: false,
      partialFailures: []
    }),
    'quirky.hosting/comments': () => ({ number: 7, comments: [{ ...ROOT_COMMENT, isResolved: threadResolved }], partial: false, partialFailures: [] }),
    'quirky.hosting/reviewComment': (params) => {
      reviewCommentCalls.push(params)
      return { number: 7, action: 'reply', comment: { id: 99 } }
    },
    'quirky.hosting/resolveThread': (params) => {
      resolveCalls.push(params)
      return Promise.resolve()
        .then(() => options.resolveThread?.(params) ?? { threadId: 'T1', action: 'resolve', resolved: true })
        .then((result) => {
          if (typeof result === 'object' && result !== null && (result as Record<string, unknown>).resolved === true) threadResolved = true
          return result
        })
    },
    'quirky.hosting/merge': () => ({ state: 'merged', number: 7, head: HEAD }),
    'quirky.session/list': () => []
  } satisfies FakeCalls)
  manifestViolations.push(checked.violations)

  const t = makeTestApp({ fakeCalls: checked.fakes })
  handOff(t.app)
  t.app.store.mandates.put(sampleMandate({ level: 'full', switches: { messaging: false, historyRewrite: false, deploys: false } }))
  t.app.journal('wt-1', 'finding', { reviewed: true, headSha: HEAD })
  t.app.services.brain.wake = () => { wakes++ }
  t.app.services.supervisor.send = async (worktreeId, text) => {
    sent.push([worktreeId, text])
    return options.sendResult ?? { sent: true }
  }

  disposers.push(registerHandoff(t.app, { claudeVersion: async () => '2.1.300' }))
  disposers.push(registerShipping(t.app))
  await t.app.services.shipping.reconcileOutbox()
  t.calls.length = 0

  return {
    ...t,
    shipping: t.app.services.shipping,
    handoff: t.app.services.handoff,
    resolveCalls,
    reviewCommentCalls,
    sent,
    wakes: () => wakes
  }
}

type TestSetup = TestApp & {
  shipping: AvatarApp['services']['shipping']
  handoff: AvatarApp['services']['handoff']
  resolveCalls: Record<string, unknown>[]
  reviewCommentCalls: Record<string, unknown>[]
  sent: [string, string][]
  wakes: () => number
}

async function holdHumanFinding(t: TestSetup) {
  const firstMerge = await t.shipping.merge('wt-1')
  if (firstMerge.ok) throw new Error('the unresolved human thread should block the first merge')
  const finding = t.app.store.findings.list({ worktreeId: 'wt-1' })[0]
  if (finding === undefined) throw new Error('the thread was not taken in as a finding')
  expect(firstMerge.reason).toContain(`finding ${finding.id} is not judged`)
  expect(firstMerge.reason).toContain('thread T1 is unresolved')

  await t.shipping.judgeFinding('wt-1', finding.id, false, 'the name is fine')
  const need = t.app.needs.list({ worktreeId: 'wt-1', open: true }).find((item) => item.kind === 'merge-blocked')
  if (need === undefined) throw new Error('the held finding did not raise a need')
  expect(need).toMatchObject({
    title: 'A human review thread needs you: Please rename this',
    detail: { findingId: finding.id, threadId: 'T1', reason: 'the name is fine' },
    actions: ['finding-dismiss', 'finding-valid', 'take-back']
  })
  return { finding, need }
}

function blockedReason(result: { ok: boolean; reason?: string }): string {
  return result.ok ? '' : result.reason ?? ''
}

const personFinding = (t: TestSetup, findingId: string) =>
  t.app.store.journalSince(0).find((entry) => entry.kind === 'finding' && entry.data.findingId === findingId && entry.data.by === 'person')

const needResolved = (t: TestSetup, needId: string) =>
  t.app.store.journalSince(0).find((entry) => entry.kind === 'event' && entry.data.type === 'need-resolved' && entry.data.needId === needId)

describe('human review finding needs', () => {
  test('dismissing resolves the thread without replying and lets the merge proceed', async () => {
    const t = await setup()
    const { finding, need } = await holdHumanFinding(t)

    const before = await t.shipping.merge('wt-1')
    expect(before.ok).toBe(false)
    expect(blockedReason(before)).toContain(`finding ${finding.id} is not judged`)
    expect(blockedReason(before)).toContain('thread T1 is unresolved')
    const wakesBefore = t.wakes()

    expect(await t.handoff.resolveNeed(need.id, 'finding-dismiss')).toEqual({ ok: true })
    expect(t.resolveCalls).toEqual([{ worktree: 'wt-1', number: 7, threadId: 'T1', action: 'resolve' }])
    expect(t.reviewCommentCalls).toEqual([])
    expect(t.app.store.outbox.list({ kind: 'thread-reply' })).toEqual([])
    expect(t.app.store.findings.get(finding.id)).toMatchObject({
      valid: false,
      reason: 'the name is fine',
      detail: { verdictBy: 'person' }
    })

    const findingEntry = personFinding(t, finding.id)
    const resolvedEntry = needResolved(t, need.id)
    expect(findingEntry).toMatchObject({
      kind: 'finding',
      data: { judged: true, findingId: finding.id, valid: false, source: 'reviewer', reason: 'the name is fine', by: 'person', threadResolved: true }
    })
    expect(resolvedEntry).toMatchObject({
      kind: 'event',
      data: { type: 'need-resolved', needId: need.id, action: 'finding-dismiss', resolution: 'dismissed', findingId: finding.id }
    })
    expect(findingEntry!.seq).toBeLessThan(resolvedEntry!.seq)
    expect(t.app.store.needs.get(need.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: 'dismissed' })
    expect(t.wakes()).toBe(wakesBefore + 1)
    expect(await t.shipping.merge('wt-1')).toEqual({ ok: true })
  })

  test("sending a valid finding to the worker records the person's verdict and quoted request", async () => {
    const t = await setup()
    const { finding, need } = await holdHumanFinding(t)
    const wakesBefore = t.wakes()

    expect(await t.handoff.resolveNeed(need.id, 'finding-valid')).toEqual({ ok: true })
    expect(t.app.store.findings.get(finding.id)).toMatchObject({
      valid: true,
      reason: 'judged valid by you',
      detail: { sends: 1, verdictBy: 'person' }
    })
    expect(t.sent).toEqual([[
      'wt-1',
      `A review finding was judged valid. Fix it and say when it is done.\n${quoteAsData('review finding (reviewer)', 'src/a.ts:3\nPlease rename this')}`
    ]])
    expect(personFinding(t, finding.id)).toMatchObject({
      data: { judged: true, findingId: finding.id, valid: true, source: 'reviewer', reason: 'judged valid by you', sends: 1, by: 'person' }
    })
    expect(needResolved(t, need.id)).toMatchObject({
      data: { type: 'need-resolved', needId: need.id, action: 'finding-valid', resolution: 'sent-to-worker', findingId: finding.id }
    })
    expect(t.app.store.needs.get(need.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: 'sent-to-worker' })
    expect(t.wakes()).toBe(wakesBefore + 1)
  })

  test('a failed thread resolve leaves the need and finding retryable, then retry clears the merge bar', async () => {
    let attempts = 0
    const t = await setup({
      resolveThread: () => {
        attempts++
        if (attempts === 1) throw new Error('boom')
        return { threadId: 'T1', action: 'resolve', resolved: true }
      }
    })
    const { finding, need } = await holdHumanFinding(t)
    const before = await t.shipping.merge('wt-1')
    expect(before.ok).toBe(false)
    expect(blockedReason(before)).toContain(`finding ${finding.id} is not judged`)
    expect(blockedReason(before)).toContain('thread T1 is unresolved')

    expect(await t.handoff.resolveNeed(need.id, 'finding-dismiss')).toEqual({ ok: false, error: 'could not resolve the thread: boom' })
    expect(t.app.store.findings.get(finding.id)).toMatchObject({ valid: null })
    expect(t.app.store.findings.get(finding.id)?.detail.verdictBy).toBeUndefined()
    expect(t.app.store.needs.get(need.id)).toMatchObject({ resolvedAt: null, resolution: null })
    expect(personFinding(t, finding.id)).toMatchObject({ data: { resolveFailed: true, findingId: finding.id, error: 'boom', by: 'person' } })
    expect(needResolved(t, need.id)).toBeUndefined()

    expect(await t.handoff.resolveNeed(need.id, 'finding-dismiss')).toEqual({ ok: true })
    expect(t.resolveCalls).toHaveLength(2)
    expect(t.app.store.findings.get(finding.id)).toMatchObject({ valid: false, reason: 'the name is fine', detail: { verdictBy: 'person' } })
    expect(t.app.store.needs.get(need.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: 'dismissed' })
    expect(await t.shipping.merge('wt-1')).toEqual({ ok: true })
  })

  test("a resolve answer arriving after take-back does not write the person's verdict", async () => {
    const entered = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<unknown>()
    const t = await setup({
      resolveThread: () => {
        entered.resolve()
        return reply.promise
      }
    })
    const { finding, need } = await holdHumanFinding(t)

    const resolving = t.handoff.resolveNeed(need.id, 'finding-dismiss')
    await entered.promise
    expect(await t.handoff.takeBack({ worktreeIds: ['wt-1'] })).toMatchObject([{ worktreeId: 'wt-1', ok: true }])
    reply.resolve({ threadId: 'T1', action: 'resolve', resolved: true })

    expect(await resolving).toEqual({ ok: false, error: 'this worktree was taken back' })
    expect(t.app.store.findings.get(finding.id)).toMatchObject({ valid: null })
    expect(personFinding(t, finding.id)).toBeUndefined()
    expect(needResolved(t, need.id)).toBeUndefined()
    expect(t.app.store.needs.get(need.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: 'handed-back' })
  })

  test('a valid verdict closes the need even when the worker cannot be reached', async () => {
    const t = await setup({ sendResult: { sent: false, reason: 'agent-blocked' } })
    const { finding, need } = await holdHumanFinding(t)

    expect(await t.handoff.resolveNeed(need.id, 'finding-valid', '  it is a <!-- hidden -->real bug  ')).toEqual({ ok: true })
    expect(t.app.store.findings.get(finding.id)).toMatchObject({
      valid: true,
      reason: 'it is a real bug',
      detail: { sends: 1, verdictBy: 'person' }
    })
    expect(t.app.store.needs.get(need.id)).toMatchObject({ resolvedAt: expect.any(Number), resolution: 'sent-to-worker' })
    expect(t.app.store.journalSince(0).find((entry) => entry.kind === 'event' && entry.data.type === 'send-failed' && entry.data.findingId === finding.id)).toMatchObject({
      data: { type: 'send-failed', reason: 'agent-blocked', findingId: finding.id }
    })
  })
})
