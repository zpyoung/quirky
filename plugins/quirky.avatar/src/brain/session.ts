import { randomUUID } from 'node:crypto'
import type { AvatarApp, BrainAction, BrainService, JournalEntry, JournalKind, Mandate, ToolCall } from '../contracts'
import { callFingerprint } from '../fingerprint'
import { parseActions } from './actions'
import { dispatchActions } from './dispatch'
import { event as eventPrompt, judgment as judgmentPrompt, rebuild, retry as retryPrompt, type RebuildState, type SharedGoalBrief, type WorktreeBrief } from './prompt'

type JudgeAction = Extract<BrainAction, { type: 'judge' }>
type Usage = { contextTokens: number; contextWindow: number | null }
type Live = { id: string; rowId: string; ready: boolean; usage: Usage | null }
type Waiter = { sessionId: string; lastAssistant: string | null; resolve(text: string): void; reject(error: Error): void }
type Pending = { call: ToolCall; resolve(value: Awaited<ReturnType<BrainService['judge']>>): void; timedOut: boolean }

const LIFETIME_KEY = 'avatar-brain'
const CONTEXT_CAP = 300_000
const WINDOW_SHARE = 0.8
const TURN_TIMEOUT_MS = 5 * 60_000
const BATCH_SIZE = 25
const MAX_AUTO_RESTARTS = 3
const BRAIN_KINDS: readonly JournalKind[] = ['event', 'ask', 'finding', 'stuck', 'done-check', 'outbox', 'skipped-call']
const DECISIONS_KEPT = 5

const isBrainKind = (kind: JournalKind): boolean => BRAIN_KINDS.includes(kind)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The context size at which a session is replaced: 300k tokens, or 80% of the model's window when that is smaller. */
export function rotationLimit(contextWindow: number | null): number {
  return contextWindow === null ? CONTEXT_CAP : Math.min(CONTEXT_CAP, Math.floor(WINDOW_SHARE * contextWindow))
}

function describe(data: Record<string, unknown>): string {
  for (const key of ['note', 'summary', 'reason', 'signal']) if (typeof data[key] === 'string') return data[key] as string
  return JSON.stringify(data).slice(0, 200)
}

function decisionText(entry: JournalEntry): string {
  if (entry.kind === 'gate') return `${String(entry.data.toolName ?? 'call')}: ${String(entry.data.outcome ?? entry.data.decision ?? 'decided')} (${String(entry.data.reason ?? '')})`
  const action = entry.data.action as { type?: string } | undefined
  return `${action?.type ?? 'action'}: ${String(entry.data.outcome ?? 'done')}`
}

function progressText(entry: JournalEntry | undefined): string {
  if (entry === undefined) return ''
  return entry.data.pass === true ? 'done when passed' : `done when failing: ${String(entry.data.output ?? entry.data.reason ?? '').slice(-300)}`
}

/** Gathers what a fresh session is told from the handed-off mandates, the needs queue, guesses, shared goals and the journal. */
export function collectRebuildState(app: AvatarApp): RebuildState {
  const active = app.services.handoff.active()
  const worktrees: WorktreeBrief[] = active.map(({ worktreeId, state, mandate }) => {
    const page = app.store.journalPage({ worktreeId, limit: 300 })
    return {
      mandate,
      state,
      progress: progressText(page.find((entry) => entry.kind === 'done-check')),
      openNeeds: app.needs.list({ worktreeId, open: true }).map((need) => ({ id: need.id, kind: need.kind, title: need.title })),
      guesses: app.store.guesses.list({ worktreeId }).filter((guess) => guess.redoneAt === null).map((guess) => ({ question: guess.question, choice: guess.choice, confirmed: guess.confirmedAt !== null })),
      deadEnds: page.filter((entry) => entry.kind === 'stuck' || entry.kind === 'ladder').map((entry) => describe(entry.data)).reverse(),
      decisions: page.filter((entry) => entry.kind === 'gate' || entry.kind === 'brain-action').slice(0, DECISIONS_KEPT).map(decisionText).reverse()
    }
  })
  const stateOf = new Map(active.map((entry) => [entry.worktreeId, entry.state]))
  const sharedGoals: SharedGoalBrief[] = app.store.sharedGoals
    .list()
    .filter((goal) => goal.worktreeIds.some((id) => stateOf.has(id)))
    .map((goal) => {
      const mergeOrder = goal.mergeOrder.length > 0 ? goal.mergeOrder : goal.worktreeIds
      return {
        id: goal.id,
        goal: goal.goal,
        mergeOrder,
        waitsOn: mergeOrder.flatMap((id, index) => {
          if (!stateOf.has(id)) return []
          const ahead = mergeOrder.slice(0, index).filter((other) => stateOf.has(other) && stateOf.get(other) !== 'merged' && stateOf.get(other) !== 'done')
          return [{ worktreeId: id, waitsOn: ahead }]
        })
      }
    })
  return { houseRules: app.settings().houseRules, worktrees, sharedGoals }
}

/**
 * Installs the brain: one background structured session with every tool denied, started on the
 * first wake or judgment. It answers event prompts and judgment prompts one turn at a time (a
 * judgment goes ahead of queued events), journal entries reach it in sequence order and are marked
 * delivered only after its actions are dispatched, and the session is replaced between turns once
 * its context passes the rotation limit. Returns the disposer.
 */
export function register(app: AvatarApp): () => void {
  const { context } = app
  let current: Live | null = null
  let waiter: Waiter | null = null
  let busy = false
  let draining = false
  let woken = false
  let disposed = false
  let deaths = 0
  const queue: { priority: number; run: () => void }[] = []
  const judgments = new Map<string, Pending>()

  const log = (text: string) => context.log(`avatar brain: ${text}`)

  function pump(): void {
    if (busy || queue.length === 0) return
    let best = 0
    for (const [index, item] of queue.entries()) if (item.priority > queue[best]!.priority) best = index
    const [item] = queue.splice(best, 1)
    busy = true
    item!.run()
  }

  function exclusive<T>(priority: number, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        priority,
        run: () =>
          void work()
            .then(resolve, reject)
            .finally(() => {
              busy = false
              pump()
            })
      })
      pump()
    })
  }

  function turn(live: Live, text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        if (waiter === mine) waiter = null
        finish()
      }
      const mine: Waiter = { sessionId: live.id, lastAssistant: null, resolve: (answer) => settle(() => resolve(answer)), reject: (error) => settle(() => reject(error)) }
      const timer = setTimeout(() => mine.reject(new Error('the brain did not answer in time')), TURN_TIMEOUT_MS)
      waiter = mine
      context.call('quirky.structured/send', { session: live.id, text }).then(
        (result) => {
          if ((result as { ok?: boolean } | null)?.ok === false) mine.reject(new Error(`the brain session refused the message: ${String((result as { reason?: string }).reason ?? 'unknown')}`))
        },
        (error) => mine.reject(error instanceof Error ? error : new Error(String(error)))
      )
    })
  }

  function closeRow(live: Live): void {
    const row = app.store.brainSessions.get(live.rowId)
    if (row !== null && row.endedAt === null) app.store.brainSessions.put({ ...row, endedAt: app.now(), endTokens: live.usage?.contextTokens ?? null })
  }

  function settleJudgment(action: JudgeAction): void {
    const pending = judgments.get(action.requestId)
    if (pending === undefined) return
    judgments.delete(action.requestId)
    if (!pending.timedOut) {
      pending.resolve({ decision: action.decision, reliedOn: action.reliedOn, reason: action.reason })
      return
    }
    if (action.decision === 'held') return
    const { agent, worktreeId, toolName, toolInput } = pending.call
    app.store.lateAnswers.put({ fingerprint: callFingerprint(agent, worktreeId, toolName, toolInput), worktreeId, decision: action.decision, reason: action.reason, createdAt: app.now(), usedAt: null })
  }

  function failPending(): void {
    for (const [requestId, pending] of [...judgments]) {
      judgments.delete(requestId)
      if (!pending.timedOut) pending.resolve('unavailable')
    }
  }

  function died(live: Live, reason: string): void {
    if (current !== live) return
    current = null
    deaths += 1
    closeRow(live)
    app.journal(null, 'brain-error', { reason: 'session-died', detail: reason, session: live.id })
    if (waiter?.sessionId === live.id) waiter.reject(new Error(`the brain session ended: ${reason}`))
    failPending()
    if (deaths <= MAX_AUTO_RESTARTS) void kick().catch((error) => log(`restart failed: ${errorText(error)}`))
  }

  async function startNew(worktree: string, rotation?: { fromTokens: number; fromSession: string }): Promise<void> {
    const settings = app.settings()
    const created = (await context.call('quirky.structured/create', {
      agent: settings.brainAgent,
      ...(settings.brainModel === null ? {} : { model: settings.brainModel }),
      options: { toolPolicy: 'deny-all' },
      lifetime: 'plugin',
      lifetimeKey: LIFETIME_KEY,
      background: true,
      deferStart: true,
      title: 'Avatar brain',
      worktree
    })) as { id: string }
    const live: Live = { id: created.id, rowId: randomUUID(), ready: false, usage: null }
    current = live
    app.store.brainSessions.put({ id: live.rowId, sessionId: live.id, startedAt: app.now(), endedAt: null, endTokens: null })
    if (rotation !== undefined) app.journal(null, 'rotation', { fromTokens: rotation.fromTokens, fromSession: rotation.fromSession, toSession: live.id })
    try {
      const answer = await turn(live, rebuild(collectRebuildState(app)))
      live.ready = true
      deaths = 0
      const parsed = parseActions(answer)
      if (parsed.ok) await dispatchActions(app, parsed.actions, { onJudge: settleJudgment })
    } catch (error) {
      if (current === live) current = null
      closeRow(live)
      void context.call('quirky.structured/stop', { session: live.id }).catch(() => {})
      throw error
    }
  }

  /** Makes sure a ready session exists, creating one for `hint` or the first active worktree. Runs inside the turn lock. */
  async function ensureStarted(hint?: string | null): Promise<boolean> {
    if (current?.ready === true) return true
    if (disposed || current !== null) return false
    const worktree = hint ?? app.services.handoff.active()[0]?.worktreeId
    if (worktree === undefined) return false
    try {
      await startNew(worktree)
      return true
    } catch (error) {
      app.journal(null, 'brain-error', { reason: 'session-start-failed', detail: errorText(error) })
      return false
    }
  }

  function kick(hint?: string | null): Promise<void> {
    return exclusive(1, () => ensureStarted(hint)).then((started) => {
      if (started) wake()
    })
  }

  async function rotateIfNeeded(): Promise<void> {
    const live = current
    if (live === null || !live.ready || live.usage === null || live.usage.contextTokens < rotationLimit(live.usage.contextWindow)) return
    const fromTokens = live.usage.contextTokens
    const worktree = app.services.handoff.active()[0]?.worktreeId
    live.ready = false
    current = null
    closeRow(live)
    try {
      await context.call('quirky.structured/stop', { session: live.id })
    } catch (error) {
      log(`could not stop session ${live.id}: ${errorText(error)}`)
    }
    if (worktree === undefined) return
    try {
      await startNew(worktree, { fromTokens, fromSession: live.id })
    } catch (error) {
      app.journal(null, 'brain-error', { reason: 'rotation-failed', detail: errorText(error), fromTokens })
    }
  }

  async function parkEvents(chunk: JournalEntry[], error: string): Promise<void> {
    const worktrees = [...new Set(chunk.map((entry) => entry.worktreeId ?? ''))]
    for (const worktreeId of worktrees) {
      app.needs.add({ worktreeId, kind: 'brain-error', title: 'The brain could not answer an event', detail: { error, seqs: chunk.filter((entry) => (entry.worktreeId ?? '') === worktreeId).map((entry) => entry.seq) }, actions: ['take-back', 'restart'] })
    }
  }

  /** Delivers the oldest undelivered batch; true when a batch was handled and another may follow. Runs inside the turn lock. */
  async function processBatch(): Promise<boolean> {
    const undeliveredEvents = (): JournalEntry[] => {
      const pending = app.store.undeliveredJournal()
      for (const entry of pending) if (!isBrainKind(entry.kind)) app.store.markDelivered(entry.seq)
      return pending.filter((entry) => isBrainKind(entry.kind))
    }
    const waiting = undeliveredEvents()
    if (waiting.length === 0) return false
    if (!(await ensureStarted(waiting.find((entry) => entry.worktreeId !== null)?.worktreeId))) return false
    const live = current
    if (live === null || !live.ready) return false
    const events = undeliveredEvents()
    if (events.length === 0) return false

    const chunk = events.slice(0, BATCH_SIZE)
    const seqs = chunk.map((entry) => entry.seq)
    try {
      let answer = await turn(live, eventPrompt(chunk))
      let parsed = parseActions(answer)
      if (!parsed.ok) {
        app.journal(null, 'brain-error', { reason: 'unparseable-reply', error: parsed.error, seqs, attempt: 1 })
        answer = await turn(live, retryPrompt(parsed.error))
        parsed = parseActions(answer)
        if (!parsed.ok) {
          app.journal(null, 'brain-error', { reason: 'unparseable-reply', error: parsed.error, seqs, attempt: 2 })
          await parkEvents(chunk, parsed.error)
          for (const seq of seqs) app.store.markDelivered(seq)
          await rotateIfNeeded()
          return true
        }
      }
      await dispatchActions(app, parsed.actions, { onJudge: settleJudgment })
      for (const seq of seqs) app.store.markDelivered(seq)
      deaths = 0
    } catch (error) {
      log(`event turn failed: ${errorText(error)}`)
      return false
    }
    await rotateIfNeeded()
    return true
  }

  async function drain(): Promise<void> {
    draining = true
    try {
      while (woken && !disposed) {
        woken = false
        await new Promise((resolve) => setTimeout(resolve, 0))
        while (!disposed && (await exclusive(0, processBatch))) {}
      }
    } catch (error) {
      log(`wake failed: ${errorText(error)}`)
    } finally {
      draining = false
    }
  }

  function wake(): void {
    if (disposed) return
    woken = true
    if (!draining) void drain()
  }

  async function runJudgment(requestId: string, call: ToolCall, mandate: Mandate): Promise<void> {
    const live = current
    const pending = judgments.get(requestId)
    if (live === null || !live.ready || pending === undefined) {
      if (pending !== undefined) {
        judgments.delete(requestId)
        if (!pending.timedOut) pending.resolve('unavailable')
      }
      return
    }
    try {
      let answer = await turn(live, judgmentPrompt(call, mandate, app.settings().houseRules, requestId))
      let matching = findJudge(answer, requestId)
      if (typeof matching === 'string') {
        app.journal(call.worktreeId, 'brain-error', { reason: 'unusable-judgment', error: matching, requestId, attempt: 1 })
        answer = await turn(live, retryPrompt(matching))
        matching = findJudge(answer, requestId)
      }
      if (typeof matching === 'string') {
        app.journal(call.worktreeId, 'brain-error', { reason: 'unusable-judgment', error: matching, requestId, attempt: 2 })
        judgments.delete(requestId)
        if (!pending.timedOut) pending.resolve('unavailable')
      } else {
        await dispatchActions(app, [matching], { onJudge: settleJudgment })
      }
    } catch (error) {
      log(`judgment turn failed: ${errorText(error)}`)
      judgments.delete(requestId)
      if (!pending.timedOut) pending.resolve('unavailable')
      return
    }
    await rotateIfNeeded()
  }

  function findJudge(answer: string, requestId: string): JudgeAction | string {
    const parsed = parseActions(answer)
    if (!parsed.ok) return parsed.error
    const match = parsed.actions.find((action): action is JudgeAction => action.type === 'judge' && action.requestId === requestId)
    return match ?? `the reply holds no judge action with requestId "${requestId}"`
  }

  const unsubscribe = context.subscribe((incoming) => {
    const data = (incoming as { data?: unknown }).data as Record<string, unknown> | undefined
    if (data === undefined) return
    if (incoming.type === 'quirky.structured/message') {
      const message = data.message as { sessionId?: string; role?: string; text?: string; data?: { usage?: Usage; is_error?: boolean } } | undefined
      if (message === undefined || current === null || message.sessionId !== current.id) return
      if (message.role === 'assistant') {
        if (typeof message.text === 'string' && waiter?.sessionId === current.id) waiter.lastAssistant = message.text
        const usage = message.data?.usage
        if (usage !== undefined && typeof usage.contextTokens === 'number') current.usage = { contextTokens: usage.contextTokens, contextWindow: typeof usage.contextWindow === 'number' ? usage.contextWindow : null }
      } else if (message.role === 'result' && message.data?.is_error === true) {
        died(current, String(message.text ?? 'the session reported an error'))
      }
    } else if (incoming.type === 'quirky.structured/settled') {
      if (waiter === null || data.sessionId !== waiter.sessionId) return
      const text = waiter.lastAssistant ?? (typeof data.lastAssistantMessage === 'string' ? data.lastAssistantMessage : null)
      if (text === null) waiter.reject(new Error('the brain settled without an answer'))
      else waiter.resolve(text)
    } else if (incoming.type === 'quirky.session/changed') {
      const session = data.session as { id?: string; status?: string } | undefined
      if (current !== null && session?.id === current.id && session.status === 'exited') died(current, 'the session exited')
    }
  })
  const unbind = app.on((busEvent) => {
    if (busEvent.type === 'journal' && isBrainKind(busEvent.entry.kind)) wake()
  })

  app.services.brain = {
    ready: () => current?.ready === true,
    wake,
    judge(call, mandate, deadlineMs) {
      if (current?.ready !== true) {
        void kick(call.worktreeId).catch((error) => log(`start failed: ${errorText(error)}`))
        return Promise.resolve('unavailable')
      }
      const requestId = randomUUID()
      return new Promise((resolve) => {
        const pending: Pending = { call, timedOut: false, resolve: (value) => (clearTimeout(timer), resolve(value)) }
        const timer = setTimeout(() => {
          if (judgments.get(requestId) !== pending) return
          pending.timedOut = true
          resolve('timeout')
        }, deadlineMs)
        judgments.set(requestId, pending)
        void exclusive(1, () => runJudgment(requestId, call, mandate)).catch((error) => {
          log(`judgment failed: ${errorText(error)}`)
          judgments.delete(requestId)
          if (!pending.timedOut) pending.resolve('unavailable')
        })
      })
    }
  }

  return () => {
    disposed = true
    unsubscribe()
    unbind()
    waiter?.reject(new Error('the avatar is shutting down'))
    failPending()
  }
}
