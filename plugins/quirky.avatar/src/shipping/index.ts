import type { AvatarApp, ShippingService, WorktreeState } from '../contracts'
import { quoteAsData, sanitize } from '../sanitize'
import { createDoneWhen } from './donewhen'
import { looksFlaky, mergeReady, nextFlakyStep, predecessorsOf, stopAt } from './mergebar'
import { branchName, createOutbox, handoffEpoch, readCompare, readHead, runCheck, sendRefusal, shellQuote } from './outbox'
import { createReview } from './review'

type Pr = { number: number; state: string; headSha: string | null; mergeQueueRequired: boolean }
type PrLookup = { kind: 'found'; pr: Pr } | { kind: 'no-review' } | { kind: 'unavailable'; reason: string; message: string } | { kind: 'no-branch' }

const GREEN = new Set(['success', 'neutral', 'skipped'])
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error'])
const JOURNAL_WINDOW = 500

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Wires done-when, review, merge and the outbox into `app.services.shipping`. The outbox is
 * reconciled against GitHub first, and every other call waits for that, so a crash between
 * recording and running an action is resolved before anything is repeated (SC-23).
 */
export function register(app: AvatarApp): () => void {
  const outbox = createOutbox(app)
  const review = createReview(app, outbox)
  const doneWhen = createDoneWhen(app, (worktreeId) => service.startReview(worktreeId))
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => app.context.call(method, params)

  let reconciling: Promise<void> = Promise.resolve()
  const reconcile = (): Promise<void> => {
    reconciling = reconciling
      .then(() => outbox.reconcile())
      .catch((error: unknown) => void app.journal(null, 'outbox', { reconcileFailed: true, error: message(error) }))
    return reconciling
  }
  const ready = reconcile()
  const afterReconcile =
    <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await ready
      return work(...args)
    }

  const afterReconcileWithEpoch =
    <A extends unknown[], R>(work: (worktreeId: string, epoch: number | null, ...args: A) => Promise<R>) =>
    async (worktreeId: string, ...args: A): Promise<R> => {
      const epoch = handoffEpoch(app, worktreeId)
      await ready
      return work(worktreeId, epoch, ...args)
    }

  const setState = (worktreeId: string, state: WorktreeState, note: string): void => app.services.handoff.setState(worktreeId, state, note)
  const mergeRefusal = (worktreeId: string, epoch: number | null): string | null => {
    const refusal = sendRefusal(app, 'merge', worktreeId, epoch)
    if (refusal === null || !refusal.startsWith('level ')) return refusal
    const mandate = app.store.mandates.get(worktreeId)
    return mandate === null ? refusal : `level ${mandate.level} stops at ${stopAt(mandate.level)}`
  }

  const handoffRefusal = (worktreeId: string, epoch: number | null): string | null => {
    if (epoch === null || handoffEpoch(app, worktreeId) === null) return 'this worktree is not handed off'
    if (handoffEpoch(app, worktreeId) !== epoch) return 'this worktree was taken back and handed off again'
    return null
  }

  async function findPr(worktreeId: string): Promise<PrLookup> {
    const { head, branch } = await readHead(app, worktreeId)
    if (head === null || branch === null) return { kind: 'no-branch' }
    const found = (await call('quirky.hosting/forBranch', { worktree: worktreeId, branch, headOid: head, fresh: true })) as Record<string, unknown>
    if (found.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        reason: typeof found.reason === 'string' ? found.reason : 'unavailable',
        message: typeof found.message === 'string' ? found.message : 'the pull request lookup is unavailable'
      }
    }
    const pr = typeof found.review === 'object' && found.review !== null ? (found.review as Record<string, unknown>) : null
    if (found.kind !== 'found' || pr === null || typeof pr.number !== 'number') return { kind: 'no-review' }
    return {
      kind: 'found',
      pr: {
        number: pr.number,
        state: typeof pr.state === 'string' ? pr.state : 'open',
        headSha: typeof pr.headRefOid === 'string' ? pr.headRefOid : null,
        mergeQueueRequired: pr.mergeQueueRequired === true
      }
    }
  }

  const recentJournal = (worktreeId: string) => app.store.journalPage({ worktreeId, limit: JOURNAL_WINDOW })

  type Check = { name: string; conclusion: string | null; checkRunId: number | null }

  function readChecks(raw: Record<string, unknown>): Check[] {
    const list = Array.isArray(raw.checks) ? (raw.checks as Record<string, unknown>[]) : []
    return list
      .filter((check) => check.kind !== 'approval')
      .map((check) => {
        const conclusion = typeof check.conclusion === 'string' ? check.conclusion.toLowerCase() : null
        const status = typeof check.status === 'string' ? check.status.toLowerCase() : ''
        return {
          name: typeof check.name === 'string' ? check.name : 'check',
          conclusion: conclusion ?? (GREEN.has(status) || FAILED.has(status) ? status : null),
          checkRunId: typeof check.checkRunId === 'number' ? check.checkRunId : null
        }
      })
  }

  async function failureOutput(worktreeId: string, number: number, check: Check): Promise<string | null> {
    if (check.checkRunId === null) return null
    try {
      const details = (await call('quirky.hosting/checkDetails', { worktree: worktreeId, number, checkRunId: check.checkRunId })) as Record<string, unknown>
      return JSON.stringify([details.logTails ?? [], details.annotations ?? []])
    } catch {
      return null
    }
  }

  /** Handles failed required checks: one rerun of a flaky-looking failure, otherwise back to the worker. Returns the reason merging stopped. */
  async function handleFailedChecks(worktreeId: string, pr: Pr, checkedSha: string | null, failed: Check[], epoch: number | null): Promise<string> {
    const journal = recentJournal(worktreeId)
    const green = journal.filter((entry) => entry.kind === 'event' && entry.data.checksGreen === true && entry.data.headSha === checkedSha)
    const reruns = journal.filter((entry) => entry.kind === 'event' && entry.data.flakyRerun === true && entry.data.headSha === checkedSha).length
    const { files } = await readCompare(app, worktreeId).catch(() => ({ files: [] as string[] }))
    let refusal = mergeRefusal(worktreeId, epoch)
    if (refusal !== null) return refusal
    const outputs = new Map<string, string | null>()
    const steps = []
    for (const check of failed) {
      const output = await failureOutput(worktreeId, pr.number, check)
      refusal = mergeRefusal(worktreeId, epoch)
      if (refusal !== null) return refusal
      outputs.set(check.name, output)
      const passedBeforeOnSha = green.some((entry) => Array.isArray(entry.data.names) && entry.data.names.includes(check.name))
      steps.push(nextFlakyStep({ looksFlaky: looksFlaky({ passedBeforeOnSha, failureOutput: output, diffFiles: files }), rerunsOnSha: reruns }))
    }
    const names = failed.map((check) => check.name).join(', ')
    if (steps.every((step) => step === 'rerun')) {
      refusal = mergeRefusal(worktreeId, epoch)
      if (refusal !== null) return refusal
      app.journal(worktreeId, 'event', { flakyRerun: true, headSha: checkedSha, checks: names })
      refusal = mergeRefusal(worktreeId, epoch)
      if (refusal !== null) return refusal
      await call('quirky.hosting/rerunChecks', { worktree: worktreeId, number: pr.number, failedOnly: true })
      return `required check ${names} looks flaky, rerunning once`
    }
    const detail = failed.map((check) => `${check.name}: ${outputs.get(check.name) ?? 'no output available'}`).join('\n')
    refusal = mergeRefusal(worktreeId, epoch)
    if (refusal !== null) return refusal
    setState(worktreeId, 'working', `required check failed: ${names}`)
    refusal = mergeRefusal(worktreeId, epoch)
    if (refusal !== null) return refusal
    await app.services.supervisor.send(worktreeId, `Required check ${names} failed on the pull request. Fix it and say when it is done.\n${quoteAsData('check output', detail.slice(-3000))}`)
    return `required check ${names} failed and went back to the worker`
  }

  const service: ShippingService = {
    runDoneWhen: afterReconcile((worktreeId: string) => doneWhen.runDoneWhen(worktreeId)),

    startReview: afterReconcile((worktreeId: string) => review.startReview(worktreeId)),

    judgeFinding: afterReconcileWithEpoch((worktreeId, epoch, findingId: string, valid: boolean, reason: string) =>
      review.judgeFinding(worktreeId, findingId, valid, reason, epoch)),

    openPr: afterReconcileWithEpoch(async (worktreeId, epoch) => {
      const refusal = handoffRefusal(worktreeId, epoch)
      if (refusal !== null) return fail(refusal)
      const mandate = app.store.mandates.get(worktreeId)
      if (mandate === null) return fail('no mandate for this worktree')
      const stop = stopAt(mandate.level)
      if (stop === 'none') return fail('shadow level does not ship')
      if (stop === 'commit') {
        setState(worktreeId, 'committed', 'local level stops at a commit')
        return fail('local level stops at a commit')
      }
      try {
        const { head, branch } = await readHead(app, worktreeId)
        let sendError = sendRefusal(app, 'push', worktreeId, epoch)
        if (sendError !== null) return fail(sendError)
        const { base } = await readCompare(app, worktreeId)
        sendError = sendRefusal(app, 'push', worktreeId, epoch)
        if (sendError !== null) return fail(sendError)
        if (head === null || branch === null) return fail('the worktree has no branch with a commit to push')
        const baseName = base === null ? null : branchName(base)
        const pushRow = outbox.enqueue('push', worktreeId, {
          headSha: head,
          target: branch,
          branch,
          ...(baseName === null ? {} : { base: baseName })
        })
        const pushed = await outbox.run(pushRow.id)
        sendError = sendRefusal(app, 'pr', worktreeId, epoch)
        if (sendError !== null) return fail(sendError)
        if (pushed?.state !== 'done') return fail(String(pushed?.result?.error ?? 'the push did not finish'))
        const title = mandate.goal.split('\n')[0]?.trim() || 'Update'
        sendError = sendRefusal(app, 'pr', worktreeId, epoch)
        if (sendError !== null) return fail(sendError)
        const prRow = outbox.enqueue('pr', worktreeId, {
          headSha: head,
          target: branch,
          branch,
          title: sanitize(title).slice(0, 200),
          body: sanitize(mandate.goal),
          draft: true,
          head: branch,
          ...(baseName === null ? {} : { base: baseName })
        })
        const opened = await outbox.run(prRow.id)
        sendError = sendRefusal(app, 'pr', worktreeId, epoch)
        if (sendError !== null) return fail(sendError)
        if (opened?.state !== 'done') return fail(String(opened?.result?.error ?? 'the pull request was not opened'))
        if (stop === 'draft-pr') setState(worktreeId, 'pr-ready', 'draft pull request open')
        return { ok: true }
      } catch (error) {
        return fail(message(error))
      }
    }),

    merge: afterReconcileWithEpoch(async (worktreeId, epoch) => {
      let refusal = mergeRefusal(worktreeId, epoch)
      if (refusal !== null) return fail(refusal)
      const mandate = app.store.mandates.get(worktreeId)
      if (mandate === null) return fail('no mandate for this worktree')
      try {
        const intake = await review.intakeComments(worktreeId)
        refusal = mergeRefusal(worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        const lookup = await findPr(worktreeId)
        refusal = mergeRefusal(worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        if (lookup.kind === 'no-branch') return fail('the worktree has no branch')
        if (lookup.kind === 'unavailable') return fail(`could not look up the pull request (${lookup.reason}): ${lookup.message}`)
        if (lookup.kind === 'no-review') return fail('there is no pull request for this worktree')
        const pr = lookup.pr
        if (intake.number !== pr.number) return fail('the review threads on the pull request could not be read')
        if (intake.partial) return fail('the review threads on the pull request could not all be read')

        const raw = (await call('quirky.hosting/checks', { worktree: worktreeId, number: pr.number, noCache: true })) as Record<string, unknown>
        refusal = mergeRefusal(worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        if (raw.partial === true) return fail('the checks on the pull request could not all be read')
        const checks = readChecks(raw)
        const checkedSha = typeof raw.headSha === 'string' ? raw.headSha : null

        const failed = checks.filter((check) => check.conclusion !== null && FAILED.has(check.conclusion))
        if (failed.length > 0) return fail(await handleFailedChecks(worktreeId, pr, checkedSha, failed, epoch))
        if (checks.length > 0 && checks.every((check) => check.conclusion !== null && GREEN.has(check.conclusion))) {
          const names = checks.map((check) => check.name)
          const known = recentJournal(worktreeId).some((entry) => entry.kind === 'event' && entry.data.checksGreen === true && entry.data.headSha === checkedSha && names.every((name) => Array.isArray(entry.data.names) && entry.data.names.includes(name)))
          if (!known) app.journal(worktreeId, 'event', { checksGreen: true, headSha: checkedSha, names })
        }

        const sharedGoal = mandate.sharedGoalId === null ? null : app.store.sharedGoals.get(mandate.sharedGoalId)
        const order = sharedGoal === null ? null : sharedGoal.mergeOrder.length > 0 ? sharedGoal.mergeOrder : sharedGoal.worktreeIds
        const findings = app.store.findings.list({ worktreeId })
        const verdict = mergeReady({
          level: mandate.level,
          checks: checks.map((check) => ({ name: check.name, required: true, conclusion: check.conclusion })),
          findings: findings.map((finding) => ({ id: finding.id, valid: finding.valid, fixed: finding.detail.fixed === true })),
          threads: intake.threads.map((thread) => ({ id: thread.id, resolved: thread.resolved })),
          guessesOpen: app.store.guesses.list({ worktreeId }).filter((guess) => guess.confirmedAt === null && guess.redoneAt === null).length,
          headSha: pr.headSha,
          reviewedSha: review.reviewedSha(worktreeId),
          checkedSha,
          sharedGoalOrder: order === null ? null : predecessorsOf(order, worktreeId),
          mergedIds: app.store.handoffs.list({ state: 'merged' }).map((row) => row.worktreeId)
        })
        if (!verdict.ready) {
          refusal = mergeRefusal(worktreeId, epoch)
          if (refusal !== null) return fail(refusal)
          if (findings.some((finding) => finding.valid === null)) app.services.brain.wake()
          return fail(verdict.reasons.join('; '))
        }

        refusal = mergeRefusal(worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        setState(worktreeId, 'merge-ready', 'the merge bar is met')
        const reviewedSha = pr.headSha as string
        if (pr.state === 'draft') {
          refusal = mergeRefusal(worktreeId, epoch)
          if (refusal !== null) return fail(refusal)
          const readyRow = outbox.enqueue('pr-ready', worktreeId, { headSha: reviewedSha, target: String(pr.number), number: pr.number })
          const opened = await outbox.run(readyRow.id)
          refusal = mergeRefusal(worktreeId, epoch)
          if (refusal !== null) return fail(refusal)
          if (opened?.state !== 'done') return fail(String(opened?.result?.error ?? 'the pull request could not be marked ready'))
        }
        refusal = mergeRefusal(worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        const mergeRow = outbox.enqueue('merge', worktreeId, {
          headSha: reviewedSha,
          target: String(pr.number),
          number: pr.number,
          reviewedSha,
          checkedSha: reviewedSha,
          method: 'squash',
          action: pr.mergeQueueRequired ? 'queue' : 'direct'
        })
        const merged = await outbox.run(mergeRow.id)
        refusal = mergeRefusal(worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        if (merged?.state !== 'done') return fail(String(merged?.result?.error ?? 'the merge did not finish'))
        if (merged.result?.state === 'merged') setState(worktreeId, 'merged', 'merged')
        return { ok: true, ...(merged.result?.state === 'merged' ? {} : { reason: String(merged.result?.state ?? 'pending') }) }
      } catch (error) {
        return fail(message(error))
      }
    }),

    mergeMainIn: afterReconcileWithEpoch(async (worktreeId, epoch) => {
      let refusal = handoffRefusal(worktreeId, epoch)
      if (refusal !== null) return fail(refusal)
      const mandate = app.store.mandates.get(worktreeId)
      if (mandate === null) return fail('no mandate for this worktree')
      if (stopAt(mandate.level) === 'none') return fail('shadow level does not ship')
      try {
        const { head } = await readHead(app, worktreeId)
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        const { base } = await readCompare(app, worktreeId)
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        if (head === null || base === null) return fail('there is no commit or base branch to merge into')
        const defaultBranch = branchName(base)
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        await call('quirky.git/fetch', { worktree: worktreeId })
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        const tip = await runCheck(app, worktreeId, `git rev-parse ${shellQuote(`origin/${defaultBranch}`)}`)
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        if (!tip.ran || !tip.pass) return fail('could not read the default branch tip')

        const recorded = outbox.enqueue('merge-main-in', worktreeId, { headSha: head, target: `${defaultBranch}@${tip.stdout.trim()}`, defaultBranch })
        const row = recorded.state === 'done' ? recorded : await outbox.run(recorded.id)
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        if (row?.state !== 'done') return fail(String(row?.result?.error ?? 'merging the default branch did not finish'))
        if (row.result?.conflict !== true) return { ok: true }

        const files = (Array.isArray(row.result.files) ? row.result.files : []).map(String).sort()
        if (recorded.state === 'done') return fail(`conflict in ${files.join(', ')}`)
        refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
        if (refusal !== null) return fail(refusal)
        const previous = recentJournal(worktreeId).find((entry) => entry.kind === 'outbox' && Array.isArray(entry.data.mergeMainConflict))
        const previousFiles = ((previous?.data.mergeMainConflict as unknown[] | undefined) ?? []).map(String).sort()
        app.journal(worktreeId, 'outbox', { kind: 'merge-main-in', mergeMainConflict: files })
        if (previousFiles.length > 0 && previousFiles.join('\n') === files.join('\n')) {
          refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
          if (refusal !== null) return fail(refusal)
          app.needs.add({
            worktreeId,
            kind: 'merge-blocked',
            title: `Merging ${defaultBranch} conflicts again in ${files.join(', ')}`,
            detail: { files, defaultBranch },
            actions: ['restart', 'take-back']
          })
        } else {
          refusal = sendRefusal(app, 'merge-main-in', worktreeId, epoch)
          if (refusal !== null) return fail(refusal)
          await app.services.supervisor.send(
            worktreeId,
            `Merging origin/${defaultBranch} into this branch conflicts. Merge it yourself and resolve these files, without rebasing or force-pushing.\n${quoteAsData('conflicted files', files.join('\n'))}`
          )
        }
        return fail(`conflict in ${files.join(', ')}`)
      } catch (error) {
        return fail(message(error))
      }
    }),

    reconcileOutbox: reconcile,

    cancelOutbox: (worktreeId) => outbox.cancel(worktreeId)
  }

  app.services.shipping = service
  const unsubscribe = app.context.subscribe((event) => review.onEvent(event))
  return () => {
    unsubscribe()
  }
}
