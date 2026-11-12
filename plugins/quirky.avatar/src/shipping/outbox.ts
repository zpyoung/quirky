import { createHash, randomUUID } from 'node:crypto'
import type { AvatarApp, Level, OutboxRow } from '../contracts'

type Kind = OutboxRow['kind']
type Payload = Record<string, unknown>
type Evidence = { kind: 'done'; result: Payload } | { kind: 'absent' } | { kind: 'unknown' | 'refused'; error: string }

/** What an outbox row needs to know about outside state: the call that made it and a way to see whether it happened. */
export type Outbox = {
  enqueue(kind: Kind, worktreeId: string, payload: Payload): OutboxRow
  run(id: string): Promise<OutboxRow | null>
  reconcile(): Promise<void>
  cancel(worktreeId: string): number
}

const REMOTE = 'origin'
const OUTPUT_LIMIT = 4000


const LEVEL_RANK: Record<Level, number> = { shadow: 0, local: 1, 'own-branch': 2, full: 3 }

/** Identifies the active hand-off that may authorize a shipping workflow. */
export function handoffEpoch(app: AvatarApp, worktreeId: string): number | null {
  const handoff = app.store.handoffs.get(worktreeId)
  return handoff?.active ? handoff.handedOffAt : null
}

/** Refuses sends whose hand-off ended, was replaced, or no longer grants the action. */
export function sendRefusal(app: AvatarApp, kind: Kind, worktreeId: string, epoch: number | null): string | null {
  const handoff = app.store.handoffs.get(worktreeId)
  if (!handoff?.active) return 'this worktree is not handed off'
  if (handoff.handedOffAt !== epoch) return 'this worktree was taken back and handed off again'
  const mandate = app.store.mandates.get(worktreeId)
  if (mandate === null) return 'no mandate for this worktree'
  const minimum = kind === 'merge-main-in' ? 'local' : kind === 'merge' || kind === 'pr-ready' ? 'full' : 'own-branch'
  return LEVEL_RANK[mandate.level] < LEVEL_RANK[minimum] ? `level ${mandate.level} does not allow ${kind}` : null
}

class SendRefused extends Error {}
/** The key that makes an outward action one row: `sha256(kind, worktreeId, headSha, target)`. */
export function outboxKey(kind: Kind, worktreeId: string, headSha: string | null, target: string | null): string {
  return createHash('sha256').update(JSON.stringify([kind, worktreeId, headSha, target])).digest('hex')
}

/** Single-quotes `value` for a POSIX shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type CheckRun = { ran: boolean; pass: boolean; output: string; stdout: string; timedOut: boolean; truncated: boolean; exitCode: number | null; error?: string }

/** Runs `command` in the worktree through `quirky.checks/run` and flattens the bounded result. */
export async function runCheck(app: AvatarApp, worktreeId: string, command: string, timeoutSeconds = 60): Promise<CheckRun> {
  const raw = (await app.context.call('quirky.checks/run', { command, worktree: worktreeId, timeoutSeconds })) as Record<string, unknown>
  const stdout = typeof raw.stdoutTail === 'string' ? raw.stdoutTail : ''
  const stderr = typeof raw.stderrTail === 'string' ? raw.stderrTail : ''
  const output = [stdout, stderr].filter((part) => part !== '').join('\n')
  const result: CheckRun = {
    ran: raw.ran !== false,
    pass: raw.pass === true,
    output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output,
    stdout,
    timedOut: raw.timedOut === true,
    truncated: raw.stdoutTruncated === true || raw.stderrTruncated === true,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null
  }
  if (typeof raw.error === 'string') result.error = raw.error
  return result
}

/** The worktree's HEAD commit and branch from `quirky.git/status`; either is null when git does not know it. */
export async function readHead(app: AvatarApp, worktreeId: string): Promise<{ head: string | null; branch: string | null }> {
  const status = (await app.context.call('quirky.git/status', { worktree: worktreeId })) as Record<string, unknown>
  return {
    head: typeof status.head === 'string' && status.head !== '' ? status.head : null,
    branch: typeof status.branch === 'string' && status.branch !== '' ? status.branch : null
  }
}

/** The ref and changed files the branch is compared against, from `quirky.git/compare`; `base` is null when the compare is not ready. */
export async function readCompare(app: AvatarApp, worktreeId: string): Promise<{ base: string | null; files: string[] }> {
  const compare = (await app.context.call('quirky.git/compare', { worktree: worktreeId })) as Record<string, unknown>
  const base = compare.status === 'ready' && typeof compare.base === 'string' && compare.base !== '' ? compare.base : null
  const entries = Array.isArray(compare.entries) ? (compare.entries as Record<string, unknown>[]) : []
  return { base, files: entries.flatMap((entry) => (typeof entry.path === 'string' ? [entry.path] : [])) }
}

/** The default branch name (`main`) the worktree is compared against, without a remote prefix. */
export function branchName(ref: string): string {
  return ref.replace(/^(?:refs\/remotes\/)?origin\//, '')
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null)

function review(value: unknown): { kind: string; review: Record<string, unknown> } {
  const envelope = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const found = typeof envelope.review === 'object' && envelope.review !== null ? (envelope.review as Record<string, unknown>) : {}
  return { kind: typeof envelope.kind === 'string' ? envelope.kind : 'unavailable', review: found }
}

/**
 * Records every outward action (push, PR, merge, thread reply, merge-main-in) before it runs, so a
 * crash leaves a visible row. `run` and `reconcile` look at what actually happened remotely
 * before any call, and a row that may have happened is never repeated blindly (R-34).
 */
export function createOutbox(app: AvatarApp): Outbox {
  const call = (method: string, params: Payload): Promise<unknown> => app.context.call(method, params)
  const active = new Map<string, { issued: boolean }>()

  function begin(row: OutboxRow): void {
    const refusal = sendRefusal(app, row.kind, row.worktreeId, typeof row.payload.handedOffAt === 'number' ? row.payload.handedOffAt : null)
    if (refusal !== null) throw new SendRefused(refusal)
    if (app.store.outbox.get(row.id)?.state === 'cancelled') throw new SendRefused('cancelled by take-back')
    const flight = active.get(row.id)
    if (flight !== undefined) flight.issued = true
  }

  const record = (row: OutboxRow, note: string): void => {
    app.store.transaction(() => {
      app.store.outbox.put(row)
      app.journal(row.worktreeId, 'outbox', { id: row.id, kind: row.kind, state: row.state, note, ...(row.result === null ? {} : { result: row.result }) })
    })
  }

  /** Moves `recorded` to `running` in one transaction before any await, so only one concurrent `run` of a row proceeds. */
  function claim(id: string): { won: true; row: OutboxRow } | { won: false; row: OutboxRow | null } {
    return app.store.transaction(() => {
      const row = app.store.outbox.get(id)
      if (row === null || row.state !== 'recorded') return { won: false, row }
      const running: OutboxRow = { ...row, state: 'running' }
      record(running, 'running')
      return { won: true, row: running }
    })
  }

  function cancelRow(row: OutboxRow, error: string): OutboxRow {
    const current = app.store.outbox.get(row.id)
    if (current?.state === 'cancelled') return current
    const cancelled: OutboxRow = { ...row, state: 'cancelled', result: { error } }
    if (current?.payload.handedOffAt === row.payload.handedOffAt) record(cancelled, 'cancelled: send refused')
    return cancelled
  }

  async function pushEvidence(row: OutboxRow): Promise<Evidence> {
    const branch = str(row.payload.branch) as string
    const headSha = str(row.payload.headSha) as string
    try {
      const target = (await call('quirky.git/pushTarget', { worktree: row.worktreeId, purpose: 'creation' })) as Payload
      if (target.ready !== true) return { kind: 'refused', error: `push refused (${target.reason}): ${target.message}` }
      const remote = str(target.remote)
      if (remote === null) return { kind: 'unknown', error: 'could not read the push remote' }
      if (target.localBranch !== branch) return { kind: 'refused', error: `push refused: the worktree is on ${target.localBranch}, not ${branch}` }
      if (target.branch !== branch) return { kind: 'refused', error: `push refused: the push would go to ${remote}/${target.branch}, not ${remote}/${branch}` }
      if (target.localHead !== headSha) return { kind: 'refused', error: `push refused: HEAD is ${target.localHead}, not the recorded ${headSha}` }
      const lookup = await runCheck(app, row.worktreeId, `git ls-remote --symref ${shellQuote(remote)} HEAD ${shellQuote(`refs/heads/${branch}`)}`)
      if (!lookup.ran || !lookup.pass) return { kind: 'unknown', error: lookup.error ?? 'could not read the remote branch' }
      const lines = lookup.stdout.split('\n')
      const defaultBranch = lines.map((line) => /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line)?.[1]).find((name) => name !== undefined)
      if (defaultBranch === undefined) return { kind: 'unknown', error: `could not read the default branch of ${remote}` }
      if (defaultBranch === branch) return { kind: 'refused', error: `push refused: ${branch} is the default branch of ${remote}` }
      const remoteSha = lines.map((line) => line.split('\t')).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0]
      return remoteSha === headSha ? { kind: 'done', result: { remote, branch, remoteSha } } : { kind: 'absent' }
    } catch (error) {
      return { kind: 'unknown', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function evidence(row: OutboxRow): Promise<Evidence> {
    const p = row.payload
    const worktree = row.worktreeId
    try {
      if (row.kind === 'push') {
        const branch = str(p.branch)
        const headSha = str(p.headSha)
        if (branch === null || headSha === null) return { kind: 'absent' }
        const remote = str(p.remote) ?? REMOTE
        const lookup = await runCheck(app, worktree, `git ls-remote ${shellQuote(remote)} ${shellQuote(`refs/heads/${branch}`)}`)
        if (!lookup.ran || !lookup.pass) return { kind: 'unknown', error: lookup.error ?? 'could not read the remote branch' }
        const remoteSha = lookup.stdout.trim().split(/\s+/)[0] ?? ''
        return remoteSha === headSha ? { kind: 'done', result: { remote, branch, remoteSha } } : { kind: 'absent' }
      }
      if (row.kind === 'pr') {
        const branch = str(p.branch)
        if (branch === null) return { kind: 'refused', error: 'pr needs a branch' }
        const headOid = str(p.headSha)
        const found = review(await call('quirky.hosting/forBranch', { worktree, branch, ...(headOid === null ? {} : { headOid }), fresh: true }))
        if (found.kind === 'unavailable') return { kind: 'unknown', error: 'hosting is unavailable' }
        if (found.kind === 'found' && (found.review.state === 'open' || found.review.state === 'draft')) {
          return { kind: 'done', result: { number: num(found.review.number), url: str(found.review.url), existing: true } }
        }
        return { kind: 'absent' }
      }
      if (row.kind === 'pr-ready' || row.kind === 'merge') {
        const number = num(p.number)
        if (number === null) return { kind: 'absent' }
        const found = review(await call('quirky.hosting/review', { worktree, number }))
        if (found.kind !== 'found') return { kind: 'unknown', error: 'hosting did not return the pull request' }
        if (row.kind === 'merge') {
          return found.review.state === 'merged'
            ? { kind: 'done', result: { state: 'merged', number, head: str(found.review.headRefOid) } }
            : { kind: 'absent' }
        }
        return found.review.state === 'draft' ? { kind: 'absent' } : { kind: 'done', result: { number, state: str(found.review.state) } }
      }
      if (row.kind === 'thread-reply') {
        const number = num(p.number)
        const body = str(p.body)
        if (number === null || body === null) return { kind: 'absent' }
        const listed = (await call('quirky.hosting/comments', { worktree, number, noCache: true })) as Record<string, unknown>
        const comments = Array.isArray(listed.comments) ? (listed.comments as Record<string, unknown>[]) : []
        return comments.some((comment) => comment.body === body && comment.threadId === (str(p.threadId) ?? comment.threadId))
          ? { kind: 'done', result: { replied: true } }
          : { kind: 'absent' }
      }
      return { kind: 'absent' }
    } catch (error) {
      return { kind: 'unknown', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * What a `running` merge-main-in row left in the worktree: a merge still in progress, the default
   * branch already an ancestor of HEAD, or neither. Only a clean "neither" lets the merge run again.
   */
  async function mergeEvidence(row: OutboxRow): Promise<Evidence | { kind: 'partial'; reason: string }> {
    const branch = str(row.payload.defaultBranch)
    if (branch === null) return { kind: 'absent' }
    try {
      const midway = await runCheck(app, row.worktreeId, 'test -f "$(git rev-parse --git-path MERGE_HEAD)"')
      if (!midway.ran) return { kind: 'unknown', error: midway.error ?? 'could not look for a merge in progress' }
      if (midway.pass) return { kind: 'partial', reason: 'a merge was left in progress in the worktree; resolve or abort it, then ask again' }
      const ancestor = await runCheck(app, row.worktreeId, `git merge-base --is-ancestor ${shellQuote(`${REMOTE}/${branch}`)} HEAD`)
      if (ancestor.ran && ancestor.pass) return { kind: 'done', result: { conflict: false, alreadyMerged: true } }
      if (ancestor.ran && ancestor.exitCode === 1) return { kind: 'absent' }
      return { kind: 'unknown', error: ancestor.error ?? 'could not tell whether the default branch is already merged in' }
    } catch (error) {
      return { kind: 'unknown', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function execute(row: OutboxRow): Promise<Payload> {
    const p = row.payload
    const worktree = row.worktreeId
    if (row.kind === 'push') {
      begin(row)
      return (await call('quirky.git/push', { worktree, purpose: 'creation' })) as Payload
    }
    if (row.kind === 'pr') {
      const base = str(p.base)
      const head = str(p.head)
      begin(row)
      return (await call('quirky.hosting/create', {
        worktree,
        title: str(p.title) ?? 'Update',
        body: typeof p.body === 'string' ? p.body : '',
        draft: p.draft !== false,
        ...(base === null ? {} : { base }),
        ...(head === null ? {} : { head })
      })) as Payload
    }
    if (row.kind === 'pr-ready') {
      const number = num(p.number)
      if (number === null) throw new Error('pr-ready needs a pull request number')
      begin(row)
      return (await call('quirky.hosting/updateReview', { worktree, number, action: 'ready' })) as Payload
    }
    if (row.kind === 'merge') {
      const number = num(p.number)
      const reviewedSha = str(p.reviewedSha)
      if (number === null) throw new Error('merge needs a pull request number')
      if (reviewedSha === null || reviewedSha !== p.checkedSha) throw new Error('merge needs the reviewed and checked commit to be the same')
      begin(row)
      return (await call('quirky.hosting/merge', {
        worktree,
        number,
        expectedHead: reviewedSha,
        method: str(p.method) ?? 'squash',
        action: str(p.action) ?? 'direct',
        yes: true
      })) as Payload
    }
    if (row.kind === 'thread-reply') {
      const number = num(p.number)
      const replyToId = num(p.replyToId)
      const body = str(p.body)
      if (number === null || replyToId === null || body === null) throw new Error('thread-reply needs a pull request, a comment to reply to and a body')
      begin(row)
      return (await call('quirky.hosting/reviewComment', { worktree, number, action: 'reply', body, replyToId })) as Payload
    }
    return mergeMainIn(row)
  }

  async function mergeMainIn(row: OutboxRow): Promise<Payload> {
    const branch = str(row.payload.defaultBranch)
    if (branch === null) throw new Error('merge-main-in needs the default branch')
    begin(row)
    const merged = await runCheck(app, row.worktreeId, `git merge --no-edit ${shellQuote(`${REMOTE}/${branch}`)}`, 300)
    if (merged.ran && merged.pass) return { conflict: false }
    const listed = await runCheck(app, row.worktreeId, 'git diff --name-only --diff-filter=U')
    const files = listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    if (files.length === 0) throw new Error(merged.error ?? (merged.output || 'git merge failed'))
    await runCheck(app, row.worktreeId, 'git merge --abort')
    return { conflict: true, files }
  }

  const outbox: Outbox = {
    enqueue(kind, worktreeId, payload) {
      const epoch = handoffEpoch(app, worktreeId)
      const refusal = sendRefusal(app, kind, worktreeId, epoch)
      const stamped = { ...payload, handedOffAt: epoch }
      const headSha = str(payload.headSha)
      const target = str(payload.target)
      const idempotencyKey = outboxKey(kind, worktreeId, headSha, target)
      const existing = app.store.outbox.list({ idempotencyKey })[0]
      if (existing !== undefined) {
        if (refusal !== null || (existing.state !== 'failed' && existing.state !== 'cancelled')) return existing
        const again: OutboxRow = { ...existing, payload: stamped, state: 'recorded', result: null }
        record(again, 'recorded again')
        return again
      }
      const row: OutboxRow = {
        id: randomUUID(), worktreeId, kind, payload: stamped, idempotencyKey,
        state: refusal === null ? 'recorded' : 'cancelled', result: refusal === null ? null : { error: refusal }
      }
      record(row, refusal === null ? 'recorded' : 'cancelled: send refused')
      return row
    },

    async run(id) {
      const claimed = claim(id)
      if (claimed.won === false) return claimed.row
      const row = claimed.row
      const flight = { issued: false }
      active.set(id, flight)
      try {
        const epoch = typeof row.payload.handedOffAt === 'number' ? row.payload.handedOffAt : null
        const refusal = sendRefusal(app, row.kind, row.worktreeId, epoch)
        if (refusal !== null) return cancelRow(row, refusal)
        if (row.kind === 'push') {
          const branch = str(row.payload.branch)
          if (branch === null || str(row.payload.headSha) === null) throw new Error('push needs a branch and a commit')
          if (branch === str(row.payload.base)) throw new Error(`push refused: ${branch} is the branch this worktree is compared against`)
        }
        if (row.kind === 'pr' && str(row.payload.branch) === null) throw new Error('pr needs a branch')
        const seen = row.kind === 'push' ? await pushEvidence(row) : await evidence(row)
        if (seen.kind === 'done') {
          const done: OutboxRow = { ...row, state: 'done', result: seen.result }
          record(done, 'already happened')
          return done
        }
        const stopped = sendRefusal(app, row.kind, row.worktreeId, epoch)
        if (stopped !== null) return cancelRow(row, stopped)
        const current = app.store.outbox.get(id)
        if (current?.state === 'cancelled') return current
        if (seen.kind === 'refused') throw new Error(seen.error)
        if (seen.kind === 'unknown') {
          const recorded: OutboxRow = { ...row, state: 'recorded' }
          app.store.transaction(() => {
            app.store.outbox.put(recorded)
            app.journal(row.worktreeId, 'outbox', { id, kind: row.kind, state: 'recorded', note: 'not run: could not check what happened', error: seen.error })
          })
          return recorded
        }
        const result = await execute(row)
        const done: OutboxRow = { ...row, state: 'done', result }
        record(done, handoffEpoch(app, row.worktreeId) === epoch ? 'done' : 'done after take-back')
        return done
      } catch (error) {
        if (error instanceof SendRefused) return cancelRow(row, error.message)
        const failed: OutboxRow = { ...row, state: 'failed', result: { error: error instanceof Error ? error.message : String(error) } }
        record(failed, 'failed')
        return failed
      } finally {
        if (active.get(id) === flight) active.delete(id)
      }
    },

    async reconcile() {
      for (const row of app.store.outbox.list()) {
        if (row.state !== 'recorded' && row.state !== 'running') continue
        if (active.has(row.id)) continue
        const epoch = typeof row.payload.handedOffAt === 'number' ? row.payload.handedOffAt : null
        const seen = row.kind === 'merge-main-in'
          ? row.state === 'running' ? await mergeEvidence(row) : { kind: 'absent' as const }
          : await evidence(row)
        if (seen.kind === 'done') {
          record({ ...row, state: 'done', result: seen.result }, 'reconciled: already happened')
          continue
        }
        const refusal = sendRefusal(app, row.kind, row.worktreeId, epoch)
        if (refusal !== null) {
          cancelRow(row, refusal)
          continue
        }
        if (seen.kind === 'partial') record({ ...row, state: 'failed', result: { error: seen.reason } }, 'reconciled: merge left half-done, not repeated')
        else if (seen.kind === 'refused') record({ ...row, state: 'failed', result: { error: seen.error } }, 'reconciled: invalid action')
        else if (seen.kind === 'unknown' && row.kind === 'merge-main-in') app.journal(row.worktreeId, 'outbox', { id: row.id, kind: row.kind, state: row.state, note: 'reconcile: could not check what happened, not repeated', error: seen.error })
        else if (row.state === 'running') record({ ...row, state: 'recorded' }, 'reconciled: did not happen, not repeated')
      }
    },

    cancel(worktreeId) {
      let cancelled = 0
      for (const row of app.store.outbox.list({ worktreeId })) {
        if (row.state !== 'recorded' && !(row.state === 'running' && active.get(row.id)?.issued === false)) continue
        record({ ...row, state: 'cancelled' }, 'cancelled by take-back')
        cancelled++
      }
      return cancelled
    }
  }
  return outbox
}
