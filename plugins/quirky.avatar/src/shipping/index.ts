import type { AvatarApp, ShippingService, WorktreeState } from '../contracts'
import { quoteAsData, sanitize } from '../sanitize'
import { createDoneWhen } from './donewhen'
import { looksFlaky, mergeReady, nextFlakyStep, predecessorsOf, stopAt } from './mergebar'
import { branchName, createOutbox, readCompare, readHead, runCheck, shellQuote } from './outbox'
import { createReview } from './review'

type Pr = { number: number; state: string; headSha: string | null; mergeQueueRequired: boolean }

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

  const setState = (worktreeId: string, state: WorktreeState, note: string): void => app.services.handoff.setState(worktreeId, state, note)

  async function findPr(worktreeId: string): Promise<Pr | null> {
    const found = (await call('quirky.hosting/forBranch', { worktree: worktreeId, fresh: true })) as Record<string, unknown>
    const pr = typeof found.review === 'object' && found.review !== null ? (found.review as Record<string, unknown>) : null
    if (found.kind !== 'found' || pr === null || typeof pr.number !== 'number') return null
    return {
      number: pr.number,
      state: typeof pr.state === 'string' ? pr.state : 'open',
      headSha: typeof pr.headRefOid === 'string' ? pr.headRefOid : null,
      mergeQueueRequired: pr.mergeQueueRequired === true
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
  async function handleFailedChecks(worktreeId: string, pr: Pr, checkedSha: string | null, failed: Check[]): Promise<string> {
    const journal = recentJournal(worktreeId)
    const green = journal.filter((entry) => entry.kind === 'event' && entry.data.checksGreen === true && entry.data.headSha === checkedSha)
    const reruns = journal.filter((entry) => entry.kind === 'event' && entry.data.flakyRerun === true && entry.data.headSha === checkedSha).length
    const { files } = await readCompare(app, worktreeId).catch(() => ({ files: [] as string[] }))
    const outputs = new Map<string, string | null>()
    const steps = []
    for (const check of failed) {
      const output = await failureOutput(worktreeId, pr.number, check)
      outputs.set(check.name, output)
      const passedBeforeOnSha = green.some((entry) => Array.isArray(entry.data.names) && entry.data.names.includes(check.name))
      steps.push(nextFlakyStep({ looksFlaky: looksFlaky({ passedBeforeOnSha, failureOutput: output, diffFiles: files }), rerunsOnSha: reruns }))
    }
    const names = failed.map((check) => check.name).join(', ')
    if (steps.every((step) => step === 'rerun')) {
      app.journal(worktreeId, 'event', { flakyRerun: true, headSha: checkedSha, checks: names })
      await call('quirky.hosting/rerunChecks', { worktree: worktreeId, number: pr.number, failedOnly: true })
      return `required check ${names} looks flaky, rerunning once`
    }
    const detail = failed.map((check) => `${check.name}: ${outputs.get(check.name) ?? 'no output available'}`).join('\n')
    setState(worktreeId, 'working', `required check failed: ${names}`)
    await app.services.supervisor.send(worktreeId, `Required check ${names} failed on the pull request. Fix it and say when it is done.\n${quoteAsData('check output', detail.slice(-3000))}`)
    return `required check ${names} failed and went back to the worker`
  }

  const service: ShippingService = {
    runDoneWhen: afterReconcile((worktreeId: string) => doneWhen.runDoneWhen(worktreeId)),

    startReview: afterReconcile((worktreeId: string) => review.startReview(worktreeId)),

    judgeFinding: afterReconcile((worktreeId: string, findingId: string, valid: boolean, reason: string) => review.judgeFinding(worktreeId, findingId, valid, reason)),

    openPr: afterReconcile(async (worktreeId: string) => {
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
        const { base } = await readCompare(app, worktreeId)
        if (head === null || branch === null) return fail('the worktree has no branch with a commit to push')
        const pushed = await outbox.run(outbox.enqueue('push', worktreeId, { headSha: head, target: branch, branch }).id)
        if (pushed?.state !== 'done') return fail(String(pushed?.result?.error ?? 'the push did not finish'))
        const title = mandate.goal.split('\n')[0]?.trim() || 'Update'
        const opened = await outbox.run(
          outbox.enqueue('pr', worktreeId, {
            headSha: head,
            target: branch,
            branch,
            title: sanitize(title).slice(0, 200),
            body: sanitize(mandate.goal),
            draft: true,
            head: branch,
            ...(base === null ? {} : { base: branchName(base) })
          }).id
        )
        if (opened?.state !== 'done') return fail(String(opened?.result?.error ?? 'the pull request was not opened'))
        if (stop === 'draft-pr') setState(worktreeId, 'pr-ready', 'draft pull request open')
        return { ok: true }
      } catch (error) {
        return fail(message(error))
      }
    }),

    merge: afterReconcile(async (worktreeId: string) => {
      const mandate = app.store.mandates.get(worktreeId)
      if (mandate === null) return fail('no mandate for this worktree')
      if (mandate.level !== 'full') return fail(`level ${mandate.level} stops at ${stopAt(mandate.level)}`)
      try {
        const intake = await review.intakeComments(worktreeId)
        const pr = await findPr(worktreeId)
        if (pr === null) return fail('there is no pull request for this worktree')
        const raw = (await call('quirky.hosting/checks', { worktree: worktreeId, number: pr.number, noCache: true })) as Record<string, unknown>
        const checks = readChecks(raw)
        const checkedSha = typeof raw.headSha === 'string' ? raw.headSha : null

        const failed = checks.filter((check) => check.conclusion !== null && FAILED.has(check.conclusion))
        if (failed.length > 0) return fail(await handleFailedChecks(worktreeId, pr, checkedSha, failed))
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
          if (findings.some((finding) => finding.valid === null)) app.services.brain.wake()
          return fail(verdict.reasons.join('; '))
        }

        setState(worktreeId, 'merge-ready', 'the merge bar is met')
        const reviewedSha = pr.headSha as string
        if (pr.state === 'draft') {
          const opened = await outbox.run(outbox.enqueue('pr-ready', worktreeId, { headSha: reviewedSha, target: String(pr.number), number: pr.number }).id)
          if (opened?.state !== 'done') return fail(String(opened?.result?.error ?? 'the pull request could not be marked ready'))
        }
        const merged = await outbox.run(
          outbox.enqueue('merge', worktreeId, {
            headSha: reviewedSha,
            target: String(pr.number),
            number: pr.number,
            reviewedSha,
            checkedSha: reviewedSha,
            method: 'squash',
            action: pr.mergeQueueRequired ? 'queue' : 'direct'
          }).id
        )
        if (merged?.state !== 'done') return fail(String(merged?.result?.error ?? 'the merge did not finish'))
        if (merged.result?.state === 'merged') setState(worktreeId, 'merged', 'merged')
        return { ok: true, ...(merged.result?.state === 'merged' ? {} : { reason: String(merged.result?.state ?? 'pending') }) }
      } catch (error) {
        return fail(message(error))
      }
    }),

    mergeMainIn: afterReconcile(async (worktreeId: string) => {
      const mandate = app.store.mandates.get(worktreeId)
      if (mandate === null) return fail('no mandate for this worktree')
      if (stopAt(mandate.level) === 'none') return fail('shadow level does not ship')
      try {
        const { head } = await readHead(app, worktreeId)
        const { base } = await readCompare(app, worktreeId)
        if (head === null || base === null) return fail('there is no commit or base branch to merge into')
        const defaultBranch = branchName(base)
        await call('quirky.git/fetch', { worktree: worktreeId })
        const tip = await runCheck(app, worktreeId, `git rev-parse ${shellQuote(`origin/${defaultBranch}`)}`)
        if (!tip.ran || !tip.pass) return fail('could not read the default branch tip')

        const recorded = outbox.enqueue('merge-main-in', worktreeId, { headSha: head, target: `${defaultBranch}@${tip.stdout.trim()}`, defaultBranch })
        const row = recorded.state === 'done' ? recorded : await outbox.run(recorded.id)
        if (row?.state !== 'done') return fail(String(row?.result?.error ?? 'merging the default branch did not finish'))
        if (row.result?.conflict !== true) return { ok: true }

        const files = (Array.isArray(row.result.files) ? row.result.files : []).map(String).sort()
        if (recorded.state === 'done') return fail(`conflict in ${files.join(', ')}`)
        const previous = recentJournal(worktreeId).find((entry) => entry.kind === 'outbox' && Array.isArray(entry.data.mergeMainConflict))
        const previousFiles = ((previous?.data.mergeMainConflict as unknown[] | undefined) ?? []).map(String).sort()
        app.journal(worktreeId, 'outbox', { kind: 'merge-main-in', mergeMainConflict: files })
        if (previousFiles.length > 0 && previousFiles.join('\n') === files.join('\n')) {
          app.needs.add({
            worktreeId,
            kind: 'merge-blocked',
            title: `Merging ${defaultBranch} conflicts again in ${files.join(', ')}`,
            detail: { files, defaultBranch },
            actions: ['restart', 'take-back']
          })
        } else {
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
