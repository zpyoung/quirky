import { randomUUID } from 'node:crypto'
import type { AvatarApp, BrainAction, HandoffInput, Level, Mandate } from '../contracts'

type JudgeAction = Extract<BrainAction, { type: 'judge' }>
type AskUserAction = Extract<BrainAction, { type: 'askUser' }>
type Result = { outcome: 'done' | 'refused' | 'failed'; [key: string]: unknown }

/** What dispatching one action came to; `would-have` means Shadow journaled it without running it. */
export type DispatchOutcome = { action: BrainAction; outcome: 'done' | 'would-have' | 'refused' | 'failed' }

export type DispatchOptions = {
  /** Receives each `judge` action; the brain session matches it to the waiting call by `requestId`. */
  onJudge?: (action: JudgeAction) => void
}

const LEVEL_RANK: Record<Level, number> = { shadow: 0, local: 1, 'own-branch': 2, full: 3 }
const SHADOW_EXEMPT: BrainAction['type'][] = ['noop', 'judge', 'askUser', 'proposeMandateEdit']
const REQUIRED_LEVEL: Partial<Record<BrainAction['type'], Level>> = {
  send: 'local',
  stepIn: 'local',
  answerAsk: 'local',
  guess: 'local',
  judgeFinding: 'local',
  startSession: 'local',
  restartWorker: 'local',
  runDoneWhen: 'local',
  startReview: 'local',
  park: 'local',
  splitWorktree: 'local',
  setMergeOrder: 'local',
  openPr: 'own-branch',
  mergeMainIn: 'own-branch',
  merge: 'full'
}

const done = (extra: Record<string, unknown> = {}): Result => ({ outcome: 'done', ...extra })
const refused = (reason: string): Result => ({ outcome: 'refused', reason })
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const lowest = (levels: Level[]): Level => levels.reduce((a, b) => (LEVEL_RANK[b] < LEVEL_RANK[a] ? b : a))

type Scope = { worktreeId: string | null; level: Level | null } | { refusal: string }

function activeMandate(app: AvatarApp, worktreeId: string): Mandate | null {
  return app.services.handoff.active().find((entry) => entry.worktreeId === worktreeId)?.mandate ?? null
}

async function resolveScope(app: AvatarApp, action: BrainAction): Promise<Scope> {
  switch (action.type) {
    case 'noop':
    case 'judge':
      return { worktreeId: null, level: null }
    case 'setMergeOrder': {
      const goal = app.store.sharedGoals.get(action.sharedGoalId)
      if (goal === null) return { refusal: `unknown shared goal ${action.sharedGoalId}` }
      const levels = goal.worktreeIds.flatMap((id) => activeMandate(app, id)?.level ?? [])
      return levels.length === 0 ? { refusal: 'no worktree of that shared goal is handed off' } : { worktreeId: null, level: lowest(levels) }
    }
    case 'answerAsk': {
      const asks = (await app.context.call('quirky.ask/list', { askId: action.askId })) as { id: string; worktreeId: string | null }[]
      const worktreeId = asks.find((ask) => ask.id === action.askId)?.worktreeId ?? null
      const mandate = worktreeId === null ? null : activeMandate(app, worktreeId)
      return worktreeId === null || mandate === null ? { refusal: `ask ${action.askId} does not belong to a handed-off worktree` } : { worktreeId, level: mandate.level }
    }
    default: {
      const mandate = activeMandate(app, action.worktreeId)
      return mandate === null ? { refusal: `worktree ${action.worktreeId} is not handed off` } : { worktreeId: action.worktreeId, level: mandate.level }
    }
  }
}

function mergeAskBatches(actions: BrainAction[]): { action: BrainAction; merged: number }[] {
  const out: { action: BrainAction; merged: number }[] = []
  const firstAsk = new Map<string, { action: AskUserAction; merged: number }>()
  for (const action of actions) {
    if (action.type !== 'askUser') {
      out.push({ action, merged: 1 })
      continue
    }
    const batch = firstAsk.get(action.worktreeId)
    if (batch === undefined) {
      const entry = { action: { ...action }, merged: 1 }
      firstAsk.set(action.worktreeId, entry)
      out.push(entry)
    } else {
      batch.action.questions = [...batch.action.questions, ...action.questions]
      batch.action.blocks = `${batch.action.blocks}; ${action.blocks}`
      batch.merged += 1
    }
  }
  return out
}

async function askUser(app: AvatarApp, action: AskUserAction, level: Level): Promise<Result> {
  const created = (await app.context.call('quirky.ask/create', {
    spec: { title: 'The avatar needs your decision', questions: action.questions },
    worktree: action.worktreeId
  })) as { askId: string }
  const first = action.questions[0] as { text?: unknown } | undefined
  app.needs.add({
    worktreeId: action.worktreeId,
    kind: 'question',
    title: typeof first?.text === 'string' ? first.text : 'A question for you',
    detail: { askId: created.askId, questions: action.questions, blocks: action.blocks },
    actions: ['answer']
  })
  if (level === 'shadow') return done({ askId: created.askId })
  const sent = await app.services.supervisor.send(action.worktreeId, `Please don't start: ${action.blocks} until answered. Carry on with everything else.`)
  return done({ askId: created.askId, workerNotified: sent.sent })
}

/** Validates the finding belongs to the worktree, then hands the verdict to shipping, which owns what a judged finding triggers. */
async function judgeFinding(app: AvatarApp, action: Extract<BrainAction, { type: 'judgeFinding' }>): Promise<Result> {
  const finding = app.store.findings.get(action.findingId)
  if (finding === null || finding.worktreeId !== action.worktreeId) return refused(`unknown finding ${action.findingId} for this worktree`)
  await app.services.shipping.judgeFinding(action.worktreeId, action.findingId, action.valid, action.reason)
  return done({ valid: action.valid })
}

const filesKey = (files: unknown): string => (Array.isArray(files) ? [...files].map(String).sort().join('\n') : '')

async function mergeMainIn(app: AvatarApp, worktreeId: string): Promise<Result> {
  const seen = new Set(app.store.outbox.list({ worktreeId, kind: 'merge-main-in' }).map((row) => row.id))
  const result = await app.services.shipping.mergeMainIn(worktreeId)
  const rows = app.store.outbox.list({ worktreeId, kind: 'merge-main-in' })
  const latest = rows.filter((row) => !seen.has(row.id)).at(-1)
  if (latest?.result?.conflict !== true) return result.ok ? done() : { outcome: 'failed', reason: result.reason ?? 'merging main in failed' }

  const files = (latest.result.files as string[] | undefined) ?? []
  const repeated = rows.some((row) => row.id !== latest.id && row.result?.conflict === true && filesKey(row.result.files) === filesKey(files))
  if (repeated) {
    app.needs.add({ worktreeId, kind: 'merge-blocked', title: 'Merging main in conflicts again on the same files', detail: { files }, actions: ['answer', 'take-back'] })
    return done({ conflict: true, files, blocked: true })
  }
  const sent = await app.services.supervisor.send(worktreeId, `Merging main into your branch conflicted in: ${files.join(', ')}. Resolve these conflicts and commit the merge; do not rebase.`)
  return done({ conflict: true, files, sent: sent.sent })
}

async function splitWorktree(app: AvatarApp, action: Extract<BrainAction, { type: 'splitWorktree' }>, mandate: Mandate): Promise<Result> {
  if (!mandate.allowSplit) return refused('this mandate does not allow splitting the work')
  const parent = (await app.context.call('quirky.worktree/show', { worktree: action.worktreeId })) as { repoId: string; branch: string | null }
  const created = (await app.context.call('quirky.worktree/create', {
    repo: parent.repoId,
    branchName: action.branch,
    base: parent.branch ?? undefined,
    parent: action.worktreeId
  })) as { worktree?: { id?: string }; id?: string }
  const id = created.worktree?.id ?? created.id
  if (typeof id !== 'string') return { outcome: 'failed', reason: 'the new worktree has no id' }
  const { worktreeId: _worktreeId, updatedAt: _updatedAt, sharedGoalId, ...inherited } = mandate
  const input: HandoffInput = { ...inherited, worktreeId: id, goal: action.goal, allowSplit: false }
  if (sharedGoalId !== null) input.sharedGoal = { id: sharedGoalId, goal: app.store.sharedGoals.get(sharedGoalId)?.goal ?? action.goal }
  const [handedOff] = await app.services.handoff.handoff([input])
  return handedOff?.ok === true ? done({ newWorktreeId: id }) : { outcome: 'failed', newWorktreeId: id, reason: handedOff?.error ?? 'hand-off failed' }
}

async function execute(app: AvatarApp, action: BrainAction, scope: { worktreeId: string | null; level: Level | null }): Promise<Result> {
  const { services } = app
  const mandate = 'worktreeId' in action ? activeMandate(app, action.worktreeId) : null
  switch (action.type) {
    case 'noop':
      return done()
    case 'judge':
      return done()
    case 'send': {
      const result = await services.supervisor.send(action.worktreeId, action.text)
      return done({ sent: result.sent, reason: result.reason })
    }
    case 'stepIn': {
      const result = await services.supervisor.stepIn(action.worktreeId, action.text)
      return done({ sent: result.sent, reason: result.reason })
    }
    case 'startSession': {
      const result = await services.supervisor.startSession(action.worktreeId, action.note)
      return done({ sessionId: result.sessionId, error: result.error })
    }
    case 'restartWorker': {
      const result = await services.supervisor.restartWorker(action.worktreeId, action.note)
      return done({ sessionId: result.sessionId, error: result.error })
    }
    case 'park':
      services.supervisor.park(action.worktreeId, action.story)
      return done()
    case 'runDoneWhen': {
      const result = await services.shipping.runDoneWhen(action.worktreeId)
      return done({ pass: result.pass })
    }
    case 'startReview': {
      const result = await services.shipping.startReview(action.worktreeId)
      return done({ started: result.started, reason: result.reason })
    }
    case 'openPr':
    case 'merge': {
      const result = await (action.type === 'openPr' ? services.shipping.openPr : services.shipping.merge)(action.worktreeId)
      return result.ok ? done() : { outcome: 'failed', reason: result.reason ?? `${action.type} failed` }
    }
    case 'mergeMainIn':
      return mergeMainIn(app, action.worktreeId)
    case 'answerAsk':
      await app.context.call('quirky.ask/answer', { askId: action.askId, answers: action.answers })
      return done()
    case 'askUser':
      return askUser(app, action, scope.level ?? 'full')
    case 'guess': {
      if (!action.reversible) return refused('an irreversible choice must be asked, not guessed')
      const guess = { id: randomUUID(), worktreeId: action.worktreeId, question: action.question, choice: action.choice, confirmedAt: null, redoneAt: null, commitsSince: [] }
      app.store.guesses.put(guess)
      app.journal(action.worktreeId, 'guess', { guessId: guess.id, question: action.question, choice: action.choice })
      app.needs.add({ worktreeId: action.worktreeId, kind: 'guess', title: `Confirm a guess: ${action.question}`, detail: { guessId: guess.id, question: action.question, choice: action.choice }, actions: ['confirm', 'redo'] })
      return done({ guessId: guess.id })
    }
    case 'proposeMandateEdit':
      app.journal(action.worktreeId, 'mandate-proposal', { patch: action.patch, why: action.why })
      app.needs.add({ worktreeId: action.worktreeId, kind: 'mandate-edit', title: 'Mandate edit proposed', detail: { patch: action.patch, why: action.why }, actions: ['review-accept', 'review-reject'] })
      return done()
    case 'judgeFinding':
      return judgeFinding(app, action)
    case 'splitWorktree':
      return splitWorktree(app, action, mandate as Mandate)
    case 'setMergeOrder': {
      const goal = app.store.sharedGoals.get(action.sharedGoalId) as NonNullable<ReturnType<typeof app.store.sharedGoals.get>>
      const known = new Set(goal.worktreeIds)
      const unknown = action.order.filter((id) => !known.has(id))
      if (unknown.length > 0) return refused(`not part of the shared goal: ${unknown.join(', ')}`)
      app.store.sharedGoals.put({ ...goal, mergeOrder: action.order })
      return done()
    }
  }
}

/**
 * Runs the brain's validated actions through the avatar's own services and public methods, never
 * anything the brain could not reach itself. Every action is checked against its worktree's level
 * first; at Shadow all but `noop`, `judge`, `askUser` and `proposeMandateEdit` are journaled as
 * `wouldHave` without running. Each action is journaled as `brain-action` with its outcome, and one
 * failing action never stops the next. Several `askUser` actions for one worktree become one ask.
 */
export async function dispatchActions(app: AvatarApp, actions: BrainAction[], options: DispatchOptions = {}): Promise<DispatchOutcome[]> {
  const outcomes: DispatchOutcome[] = []
  for (const { action, merged } of mergeAskBatches(actions)) {
    let scope: Scope
    try {
      scope = await resolveScope(app, action)
    } catch (error) {
      scope = { refusal: `could not resolve the worktree: ${message(error)}` }
    }
    const worktreeId = 'refusal' in scope ? ('worktreeId' in action ? action.worktreeId : null) : scope.worktreeId
    const note = merged > 1 ? { merged } : {}
    const finish = (outcome: DispatchOutcome['outcome'], data: Record<string, unknown>) => {
      app.journal(worktreeId, 'brain-action', { action, outcome, ...note, ...data })
      outcomes.push({ action, outcome })
    }

    if ('refusal' in scope) {
      finish('refused', { reason: scope.refusal })
      continue
    }
    if (scope.level === 'shadow' && !SHADOW_EXEMPT.includes(action.type)) {
      finish('would-have', { wouldHave: true })
      continue
    }
    const required = REQUIRED_LEVEL[action.type]
    if (scope.level !== null && required !== undefined && LEVEL_RANK[scope.level] < LEVEL_RANK[required]) {
      finish('refused', { reason: `level ${scope.level} is below ${required}, which ${action.type} needs` })
      continue
    }
    try {
      const { outcome, ...data } = await execute(app, action, scope)
      finish(outcome, data)
      if (action.type === 'judge' && outcome === 'done') options.onJudge?.(action)
    } catch (error) {
      finish('failed', { error: message(error) })
    }
  }
  return outcomes
}

export type CheckFailure = {
  worktreeId: string
  prNumber: number
  check: string
  sha: string
  passedBefore: boolean
  failureOutput: string
  diffFiles: string[]
}

/**
 * Decides what a failed required check gets: one rerun of the failed jobs when it looks flaky (it
 * passed before on this sha, or its output names no file in the diff), otherwise, or when the rerun
 * already happened, the failure goes back to the worker.
 */
export async function handleCheckFailure(app: AvatarApp, failure: CheckFailure): Promise<'rerun' | 'sent-back' | 'would-have' | 'refused'> {
  const mandate = activeMandate(app, failure.worktreeId)
  if (mandate === null || LEVEL_RANK[mandate.level] < LEVEL_RANK['own-branch']) {
    if (mandate?.level === 'shadow') {
      app.journal(failure.worktreeId, 'brain-action', { action: { type: 'checkFailure', check: failure.check, sha: failure.sha }, outcome: 'would-have', wouldHave: true })
      return 'would-have'
    }
    return 'refused'
  }
  const key = `${failure.check}@${failure.sha}`
  const rerunBefore = app.store.journalPage({ worktreeId: failure.worktreeId, limit: 500 }).some((entry) => entry.kind === 'brain-action' && entry.data.rerun === key)
  const flaky = failure.passedBefore || !failure.diffFiles.some((file) => failure.failureOutput.includes(file))
  if (flaky && !rerunBefore) {
    await app.context.call('quirky.hosting/rerunChecks', { worktree: failure.worktreeId, number: failure.prNumber, failedOnly: true })
    app.journal(failure.worktreeId, 'brain-action', { action: { type: 'rerunChecks', check: failure.check, sha: failure.sha }, outcome: 'done', rerun: key })
    return 'rerun'
  }
  await app.services.supervisor.send(failure.worktreeId, `Required check ${failure.check} failed on ${failure.sha}:\n${failure.failureOutput}`)
  app.journal(failure.worktreeId, 'brain-action', { action: { type: 'checkFailure', check: failure.check, sha: failure.sha }, outcome: 'done', sent: true })
  return 'sent-back'
}
