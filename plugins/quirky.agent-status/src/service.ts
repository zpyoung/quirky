import { join } from 'node:path'
import { RpcErrorCode, type AgentStatusSummary, type ContributionInfo, type PluginContext, type PtyFact, type QuirkyEvent, type Session } from '@quirky/protocol'
import { applyEvent } from './apply'
import { explanationOf, type Explanation } from './explain'
import { foldLead } from './fold'
import { facetOf, HOOK_SILENCE_MS, parseRecords, programEvidence, serializeRecords, titleEvidence } from './fallbacks'
import { decideIdentity, processAlive, type IsAlive } from './identity'
import {
  answered,
  awaitsAnswer,
  baselineOf,
  interruptIntent,
  interrupted,
  interruptible,
  keyCanInterrupt,
  needsDoubleEscape,
  sameBaseline,
  SETTLE_MS,
  type Baseline,
  type InterruptIntent
} from './inference'
import { coarseStatus, displayOf, readableDetail, summaryOf, toolOf } from './model'
import { normalize } from './normalize'
import { parseProgramStatusBody, ProgramStatusRecords, type ProgramStatusReport } from './program-status'
import { Matcher } from './rules/matcher'
import { RuleSources, type EffectiveRules } from './rules/sources'
import type { RuleListing } from './rules/types'
import { readScreen, ScreenSampler, type ScreenDeps, type ScreenReading } from './screen'
import { Sender, type SendResult } from './send'
import { scriptState, type ScriptState, type ScriptStateResult } from './script-state'
import { classifyTitle, type TitleStatus } from './title'
import type { RowStore } from './store'
import type { AgentRow, NormalizerCache, Normalized } from './types'
import { Waits, type OutputWaitOptions, type OutputWaitResult, type WaitResult } from './waits'

/** Rows older than this at startup are dropped instead of restored. */
const RESTORE_MAX_AGE_MS = 7 * 24 * 3_600_000
const MAX_PROVIDER_ID = 512
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** One hook, as the daemon delivered it or as the spool replays it. */
export type HookInput = {
  source: string
  sessionId: string
  payload: unknown
  event?: string
  agentPid?: number
  agentStart?: string
  /** The time of the evidence; defaults to now. */
  at?: number
  replay?: boolean
}

export type ListedRow = AgentStatusSummary & { sessionId: string; agent: string }

/** A session read for a script: its row, what the screen rules said, and the script state they gave. */
export type Inspection = { session: Session; row: AgentRow | null; reading: ScreenReading; result: ScriptStateResult; now: number }

const rejectsNotFound = (error: unknown) => (error as { code?: unknown } | null)?.code === RpcErrorCode.NotFound

/** The waits that tests shrink with `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE`. */
export type Timing = { settleMs: number; hookSilenceMs: number; scale: number }

/** The timing for an environment: the real waits times a positive `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE`, else the real waits. */
export function timingFrom(env: Record<string, string | undefined>): Timing {
  const scale = Number(env.QUIRKY_TEST_AGENT_STATUS_TIME_SCALE)
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { settleMs: SETTLE_MS * factor, hookSilenceMs: HOOK_SILENCE_MS * factor, scale: factor }
}

/** The states a row can settle into: the ones worth telling a user about. */
type SettledState = 'done' | 'waiting' | 'blocked'

const validProviderId = (id: string) => id.length >= 1 && id.length <= MAX_PROVIDER_ID && !id.startsWith('-') && !CONTROL_CHARACTERS.test(id)

const sameSummary = (a: AgentStatusSummary | null | undefined, b: AgentStatusSummary | null) => JSON.stringify(a ?? null) === JSON.stringify(b)

/**
 * Owns the agent rows: turns hooks, and where hooks are silent titles, OSC 7501 reports and typed
 * keys, into rows and keeps each terminal session's coarse status and summary in step. Events for
 * one session are handled strictly in arrival order, whatever produced them.
 */
export class AgentStatusService {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly caches = new Map<string, NormalizerCache>()
  private readonly records = new Map<string, ProgramStatusRecords>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly programRetries = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly escapes = new Map<string, { turn: string; count: number }>()
  private readonly titles = new Map<string, string>()
  private readonly commitListeners = new Map<string, Set<() => void>>()
  private readonly sends = new Map<string, Promise<unknown>>()
  private readonly sender: Sender
  private readonly waits: Waits
  private readonly sources: RuleSources
  private readonly matcher = new Matcher()
  private readonly sampler: ScreenSampler
  private readonly screen: ScreenDeps

  constructor(
    private readonly context: PluginContext,
    private readonly rows: RowStore,
    private readonly isAlive: IsAlive = processAlive,
    private readonly now: () => number = Date.now,
    private readonly timing: Timing = timingFrom(process.env)
  ) {
    this.sources = new RuleSources({
      userDir: join(context.home, 'agent-rules'),
      builtinDir: join(context.dir, 'rules'),
      contributions: async () => (await context.call('plugin.contributions', { kind: 'agent-rules' })) as ContributionInfo[],
      log: (message) => context.log(message)
    })
    this.sampler = new ScreenSampler(context.pty, (sessionId) => this.titles.get(sessionId), now, timing.scale)
    this.screen = { sources: this.sources, matcher: this.matcher, sampler: this.sampler, timeScale: timing.scale }
    this.sender = new Sender({
      context,
      inspect: (sessionId) => this.inspect(sessionId),
      row: (sessionId) => this.rows.get(sessionId) ?? null,
      onCommit: (sessionId, listener) => this.onCommit(sessionId, listener),
      nextCommit: (sessionId, timeoutMs) => this.nextCommit(sessionId, timeoutMs),
      settled: (sessionId) => this.queues.get(sessionId) ?? Promise.resolve(),
      now,
      scale: timing.scale
    })
    this.waits = new Waits({
      context,
      matcher: this.matcher,
      inspect: (sessionId) => this.inspect(sessionId),
      session: (ref) => this.requireSession(ref),
      onWake: (sessionId, listener) => this.onCommit(sessionId, listener),
      now,
      scale: timing.scale
    })
  }

  /** Cancels the waits still pending and stops the matcher; the service takes no more work afterwards. */
  shutdown(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.programRetries.clear()
    this.matcher.dispose()
  }

  /** Handles a hook after every earlier event for its session; failures are logged, never thrown. */
  ingest(input: HookInput): Promise<void> {
    return this.enqueue(input.sessionId, () => this.handle(input))
  }

  /** Forgets a session's row and normalizer memory once the session is gone. */
  drop(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      this.rows.delete(sessionId)
      this.rows.deleteRecords(sessionId)
      this.caches.delete(sessionId)
      this.records.delete(sessionId)
      this.escapes.delete(sessionId)
      this.titles.delete(sessionId)
      this.sampler.forget(sessionId)
      this.cancelProgramRetry(sessionId)
    })
  }

  /** Reads a title, an OSC 7501 report or a shell prompt mark off the terminal. */
  onFact(sessionId: string, fact: PtyFact): void {
    if (fact.kind === 'title') {
      this.titles.set(sessionId, fact.title)
      const status = classifyTitle(fact.title)
      if (status) void this.enqueue(sessionId, () => this.handleTitle(sessionId, status, fact.title))
    } else if (fact.kind === 'program-status') {
      const message = parseProgramStatusBody(fact.body)
      if (message?.type === 'report') void this.enqueue(sessionId, () => this.handleReport(sessionId, message.report))
    } else if (fact.kind === 'prompt') {
      void this.enqueue(sessionId, () => this.handlePrompt(sessionId))
    }
  }

  /** Reads what was typed into a session: a lone Esc or Ctrl+C may be an interrupt, Enter may answer a question. */
  onInput(sessionId: string, data: string): void {
    const intent = interruptIntent(data)
    if (intent) void this.enqueue(sessionId, () => this.handleInterruptKey(sessionId, intent))
    if (data.includes('\r')) void this.enqueue(sessionId, () => this.handleEnter(sessionId))
  }

  /**
   * Ends the rows whose agent process is gone, done rows included: the agent left without saying
   * so. Each is rechecked in its session's queue, because a hook may have moved the lead since.
   */
  async sweepPresence(): Promise<void> {
    const watched = this.rows.all().filter(({ row }) => row.lead.agentPid !== null && !row.lead.ended)
    await Promise.all(watched.map(({ row }) => this.enqueue(row.sessionId, () => this.endIfGone(row.sessionId))))
  }

  /** Follows session lifecycle events: an exited or removed session loses its row. */
  onEvent(event: QuirkyEvent): void {
    if (event.type === 'hook.received') {
      void this.ingest({
        source: event.agent,
        sessionId: event.sessionId,
        payload: event.payload,
        ...(event.event !== undefined ? { event: event.event } : {}),
        ...(event.agentPid !== undefined ? { agentPid: event.agentPid } : {}),
        ...(event.agentStart !== undefined ? { agentStart: event.agentStart } : {})
      })
    } else if (event.type === 'plugin.changed') {
      this.sources.invalidateContributions()
    } else if (event.type === 'quirky.session/changed') {
      const session = (event.data as { session?: Session }).session
      if (session?.status === 'exited') {
        this.wake(session.id)
        void this.drop(session.id)
      }
    } else if (event.type === 'quirky.session/removed') {
      void this.drop((event.data as { sessionId: string }).sessionId)
    }
  }

  /**
   * Restores rows after a restart: rows past seven days and rows of sessions that are gone are
   * dropped, unfinished rows come back unconfirmed, and every survivor's summary reaches its session.
   */
  async hydrate(): Promise<void> {
    for (const { row, updatedAt } of this.rows.all()) {
      const session = await this.findSession(row.sessionId)
      if (!session || session.kind !== 'terminal' || session.status === 'exited') {
        this.rows.delete(row.sessionId)
        continue
      }
      if (this.now() - updatedAt > RESTORE_MAX_AGE_MS) {
        await this.commit(session, null)
        continue
      }
      const restored: AgentRow = row.state === 'done' ? row : { ...row, restoredUnconfirmed: true }
      this.rows.put(restored, updatedAt)
      await this.publish(session, restored)
    }
    for (const sessionId of this.rows.recordSessions()) {
      const session = await this.findSession(sessionId)
      if (!session || session.kind !== 'terminal' || session.status === 'exited') this.rows.deleteRecords(sessionId)
    }
  }

  /** The row of every session that has one, optionally within one worktree. */
  async list(worktree?: string): Promise<ListedRow[]> {
    const sessions = (await this.context.call('quirky.session/list', worktree === undefined ? {} : { worktree })) as Session[]
    const listed: ListedRow[] = []
    for (const session of sessions) {
      const row = this.rows.get(session.id)
      if (row) listed.push({ ...summaryOf(row, this.now(), session.status !== 'exited'), sessionId: session.id, agent: row.agent })
    }
    return listed
  }

  /**
   * A session's row with the display it has at `at` (default now), or null when it has none. The
   * `detail` is the displayed one, so a decayed row says how long it has been quiet.
   */
  async get(sessionId: string, at?: number): Promise<(AgentRow & { display: string; label: string }) | null> {
    const row = this.rows.get(sessionId)
    if (!row) return null
    const session = await this.findSession(sessionId)
    const { display, label, detail } = displayOf(row, at ?? this.now(), session !== null && session.status !== 'exited')
    return { ...row, detail, display, label }
  }

  /**
   * Looks a session up by ID or name and reads its row and screen rules into a script state.
   * `at` (default now) is the time the row's freshness is judged at; the screen is always read live.
   * Rejects `not-found` for an unknown session and `invalid-params` for one without a terminal.
   */
  async inspect(ref: string, at?: number): Promise<Inspection> {
    const session = await this.requireSession(ref)
    const now = at ?? this.now()
    const row = this.rows.get(session.id) ?? null
    const agent = row?.agent ?? session.agent
    const reading = session.status === 'exited' ? await this.unreadScreen(agent) : await readScreen(this.screen, session.id, agent)
    return { session, row, reading, result: scriptState({ session, row, verdict: reading.verdict, now }), now }
  }

  /** Why a session's script state is what it is. */
  async explain(ref: string, at?: number): Promise<Explanation> {
    return explanationOf(await this.inspect(ref, at))
  }

  /**
   * Types `text` into a session's agent unless the agent is waiting for a person, then waits for
   * the agent to take it (see `Sender.send`). Sends to one session run one at a time, in order.
   * Rejects `not-found` for an unknown session; `startTimeoutMs` defaults to five seconds.
   */
  async send(ref: string, text: string, startTimeoutMs?: number): Promise<SendResult> {
    const { id } = await this.requireSession(ref)
    const turn = (this.sends.get(id) ?? Promise.resolve()).then(() => this.sender.send(id, text, startTimeoutMs))
    const tail = turn.then(
      () => undefined,
      () => undefined
    )
    this.sends.set(id, tail)
    void tail.then(() => {
      if (this.sends.get(id) === tail) this.sends.delete(id)
    })
    return turn
  }

  /**
   * Resolves once the session's script state is one of `until`, or reports it pending after
   * `timeoutMs` (see `Waits.wait`). Rejects `not-found` for an unknown session and `conflict`
   * (`session-exited`) when it has exited and `exited` is not wanted.
   */
  wait(ref: string, until: ScriptState[], timeoutMs: number): Promise<WaitResult> {
    return this.waits.wait(ref, until, timeoutMs)
  }

  /**
   * Resolves once recent text of the session matches a pattern, or reports it pending after the
   * timeout (see `Waits.waitOutput`). Rejects `invalid-params` for a bad, unsafe or too slow
   * pattern and `conflict` (`session-exited`) when the session exited without a match.
   */
  waitOutput(ref: string, options: OutputWaitOptions): Promise<OutputWaitResult> {
    return this.waits.waitOutput(ref, options)
  }

  /** The effective rules of every agent that has a rule source, with the sources skipped. */
  rulesListing(): Promise<RuleListing[]> {
    return this.sources.list()
  }

  /** The rule set that applies to `agent` and where it came from; null when none does. */
  async ruleSet(agent: string): Promise<(EffectiveRules & { agent: string }) | null> {
    const effective = await this.sources.effective(agent)
    return effective ? { agent, ...effective } : null
  }

  /** Calls `listener` after each commit of the session's row and when the session exits; the returned function stops it. */
  onCommit(sessionId: string, listener: () => void): () => void {
    const listeners = this.commitListeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.commitListeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.commitListeners.get(sessionId) === listeners) this.commitListeners.delete(sessionId)
    }
  }

  /** Resolves true at the session's next commit, false after `timeoutMs`. */
  nextCommit(sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const stop = this.onCommit(sessionId, () => done(true))
      const timer = setTimeout(() => done(false), timeoutMs)
      const done = (committed: boolean) => {
        clearTimeout(timer)
        stop()
        resolve(committed)
      }
    })
  }

  private async requireSession(ref: string): Promise<Session> {
    let session: Session
    try {
      session = (await this.context.call('quirky.session/get', { session: ref })) as Session
    } catch (error) {
      if (rejectsNotFound(error)) throw this.context.error('not-found', `no such session: ${ref}`)
      throw error
    }
    if (session.kind !== 'terminal') throw this.context.error('invalid-params', `session ${session.id} is not a terminal`)
    return session
  }

  private async unreadScreen(agent: string): Promise<ScreenReading> {
    const listing = await this.sources.listing(agent)
    const effective = await this.sources.effective(agent)
    return { origin: effective?.origin ?? null, verdict: null, ignored: listing?.ignored ?? [], sample: null }
  }

  private enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(sessionId) ?? Promise.resolve()).then(work).catch((error: Error) => {
      this.context.log(`agent status for ${sessionId} failed: ${error.message}`)
    })
    this.queues.set(sessionId, run)
    void run.then(() => {
      if (this.queues.get(sessionId) === run) this.queues.delete(sessionId)
    })
    return run
  }

  private async findSession(sessionId: string): Promise<Session | null> {
    try {
      return (await this.context.call('quirky.session/get', { session: sessionId })) as Session
    } catch {
      return null
    }
  }

  private async handle(input: HookInput): Promise<void> {
    const session = await this.findSession(input.sessionId)
    if (!session || session.kind !== 'terminal' || session.status === 'exited') return

    const cache = this.caches.get(session.id) ?? new Map()
    // a nested agent's event is ignored below, and the normalizer must not keep what it learned from it
    const before = structuredClone(cache)
    let normalized: Normalized | null = null
    try {
      normalized = normalize(input.source, input.payload, input.event, cache)
    } catch (error) {
      this.context.log(`${input.source} hook for ${session.id} not understood: ${(error as Error).message}`)
    }
    const rollBack = () => {
      cache.clear()
      for (const [key, value] of before) cache.set(key, value)
    }
    if (!normalized) {
      this.caches.set(session.id, cache)
      return
    }

    const now = this.now()
    // a row only titles or OSC 7501 fed has no lead to protect: a hook takes it over
    const stored = this.rows.get(session.id)
    const known = stored && stored.lastHookAt !== null ? stored : null
    const verdict = decideIdentity(
      known,
      { source: input.source, providerSession: normalized.providerSession?.id ?? null, movesLead: normalized.movesLead === true },
      now,
      this.isAlive
    )
    if (verdict === 'ignore') return rollBack()
    this.caches.set(session.id, cache)

    const starts = verdict === 'replace'
    const { row, settled } = applyEvent(starts ? null : known, normalized, {
      sessionId: session.id,
      source: input.source,
      at: input.at ?? now,
      replay: input.replay === true,
      ...(input.agentPid !== undefined ? { agentPid: input.agentPid } : {}),
      ...(input.agentStart !== undefined ? { agentStart: input.agentStart } : {})
    })
    await this.capture(session, normalized)
    // an event that can't start a row leaves the row it would have replaced alone
    if (starts && row === null) return
    if (row === known) return

    if (row) this.attachFacet(row)
    else this.caches.delete(session.id)
    await this.commit(session, row)
    if (row) this.watchProgram(session.id, row)
    if (row && settled) this.emitSettled(session, row, settled)
  }

  /** Stores a row (null removes it), sets the session's status and summary, and announces the change. */
  private async commit(session: Session, row: AgentRow | null): Promise<void> {
    if (row) this.rows.put(row, this.now())
    else this.rows.delete(session.id)
    await this.publish(session, row)
    this.context.emit('changed', { sessionId: session.id, row })
    this.wake(session.id)
  }

  private wake(sessionId: string): void {
    for (const listener of [...(this.commitListeners.get(sessionId) ?? [])]) listener()
  }

  private async liveSession(sessionId: string): Promise<Session | null> {
    const session = await this.findSession(sessionId)
    return session && session.kind === 'terminal' && session.status !== 'exited' ? session : null
  }

  private async handleTitle(sessionId: string, status: TitleStatus, title: string): Promise<void> {
    const prev = this.rows.get(sessionId)
    const at = this.now()
    // most titles change nothing, so the session is only looked up once one would
    if (titleEvidence(prev, status, { sessionId, agent: '', at, title }) === prev) return
    const session = await this.liveSession(sessionId)
    if (!session) return
    const row = titleEvidence(prev, status, { sessionId, agent: session.agent, at, title })
    if (row === prev) return
    await this.commit(session, row)
    // a title that starts a row only says what the terminal shows, not that anything finished
    if (prev) this.emitIfSettled(session, prev, row)
  }

  private async handleReport(sessionId: string, report: ProgramStatusReport): Promise<void> {
    const session = await this.liveSession(sessionId)
    if (!session) return
    const records = this.recordsFor(sessionId, true)!
    if (!records.apply(report)) return
    this.saveRecords(sessionId, records)
    await this.reconcile(session, records)
  }

  private async handlePrompt(sessionId: string): Promise<void> {
    const records = this.recordsFor(sessionId, false)
    if (!records?.endProgram()) return
    this.saveRecords(sessionId, records)
    const session = await this.liveSession(sessionId)
    if (session) await this.reconcile(session, records)
  }

  /** Applies a session's OSC 7501 root record to its row, or arranges to once the hooks' silence allows. */
  private async reconcile(session: Session, records: ProgramStatusRecords): Promise<void> {
    const prev = this.rows.get(session.id)
    const decision = programEvidence(prev, records.root(), this.programContext(session.id, session.agent))
    this.scheduleProgramRetry(session.id, decision.retryAt)
    if (decision.row === prev) return
    await this.commit(session, decision.row)
    if (decision.row) this.emitIfSettled(session, prev, decision.row)
  }

  /** Arranges the takeover a hook row owes the program once its hooks have been silent long enough. */
  private watchProgram(sessionId: string, row: AgentRow): void {
    const records = this.recordsFor(sessionId, false)
    if (!records) return
    this.scheduleProgramRetry(sessionId, programEvidence(row, records.root(), this.programContext(sessionId, row.agent)).retryAt)
  }

  private programContext(sessionId: string, agent: string) {
    return { sessionId, agent, at: this.now(), hooksOn: this.hooksOn(), silenceMs: this.timing.hookSilenceMs }
  }

  /** The `hooks` setting; a setting that isn't declared or can't be read counts as on. */
  private hooksOn(): boolean {
    try {
      return this.context.getSetting('hooks') !== false
    } catch {
      return true
    }
  }

  private recordsFor(sessionId: string, create: boolean): ProgramStatusRecords | undefined {
    const known = this.records.get(sessionId)
    if (known) return known
    const stored = this.rows.getRecords(sessionId)
    const records = stored !== null ? parseRecords(stored) : create ? new ProgramStatusRecords() : undefined
    if (records) this.records.set(sessionId, records)
    return records
  }

  private saveRecords(sessionId: string, records: ProgramStatusRecords): void {
    if (records.size > 0) {
      this.rows.putRecords(sessionId, serializeRecords(records))
    } else {
      this.rows.deleteRecords(sessionId)
      this.records.delete(sessionId)
    }
  }

  /** A row a hook just started carries the program's report beside it. */
  private attachFacet(row: AgentRow): void {
    if (row.programStatus) return
    const facet = facetOf(this.recordsFor(row.sessionId, false)?.root())
    if (!facet) return
    row.programStatus = facet
    row.detail = readableDetail(row)
  }

  private scheduleProgramRetry(sessionId: string, at: number | undefined): void {
    this.cancelProgramRetry(sessionId)
    if (at === undefined) return
    const timer = this.after(Math.max(0, at - this.now()), () => {
      this.programRetries.delete(sessionId)
      void this.enqueue(sessionId, async () => {
        const records = this.recordsFor(sessionId, false)
        const session = records ? await this.liveSession(sessionId) : null
        if (records && session) await this.reconcile(session, records)
      })
    })
    this.programRetries.set(sessionId, timer)
  }

  private cancelProgramRetry(sessionId: string): void {
    const pending = this.programRetries.get(sessionId)
    if (pending === undefined) return
    clearTimeout(pending)
    this.timers.delete(pending)
    this.programRetries.delete(sessionId)
  }

  private after(ms: number, work: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      work()
    }, ms)
    timer.unref()
    this.timers.add(timer)
    return timer
  }

  private async handleInterruptKey(sessionId: string, intent: InterruptIntent): Promise<void> {
    const row = this.rows.get(sessionId)
    if (!row || !keyCanInterrupt(row.agent, intent)) return
    if (needsDoubleEscape(row.agent, intent)) {
      // some agents' hooks never mark a turn start, so the lead's working stretch identifies the turn too
      const turn = `${row.turnStartedAt}/${row.lead.stateStartedAt}`
      const seen = this.escapes.get(sessionId)
      const count = seen?.turn === turn ? seen.count + 1 : 1
      this.escapes.set(sessionId, { turn, count })
      if (count < 2) return
    }
    if (!interruptible(row, this.now())) return
    const baseline = baselineOf(row)
    this.after(this.timing.settleMs, () => void this.enqueue(sessionId, () => this.settleInterrupt(sessionId, baseline, intent)))
  }

  /** Infers the interrupt when nothing else touched the row while the key settled. */
  private async settleInterrupt(sessionId: string, baseline: Baseline, intent: InterruptIntent): Promise<void> {
    const row = this.rows.get(sessionId)
    const at = this.now()
    if (!row || !interruptible(row, at) || !sameBaseline(row, baseline)) return
    const session = await this.liveSession(sessionId)
    if (session) await this.commit(session, interrupted(row, at, intent))
  }

  private async handleEnter(sessionId: string): Promise<void> {
    const row = this.rows.get(sessionId)
    if (!row || !awaitsAnswer(row)) return
    const session = await this.liveSession(sessionId)
    if (session) await this.commit(session, answered(row, this.now()))
  }

  private async endIfGone(sessionId: string): Promise<void> {
    const row = this.rows.get(sessionId)
    if (!row || row.lead.agentPid === null || row.lead.ended || this.isAlive(row.lead.agentPid, row.lead.agentStart)) return
    this.caches.delete(sessionId)
    const session = await this.liveSession(sessionId)
    if (session) await this.commit(session, null)
    else this.rows.delete(sessionId)
  }

  private async capture(session: Session, normalized: Normalized): Promise<void> {
    const found = normalized.providerSession
    if (!found || !validProviderId(found.id)) return
    const stored = session.providerSession
    if (stored?.id === found.id && (found.transcriptPath === null || stored.transcriptPath === found.transcriptPath)) return
    await this.context.call('quirky.session/setProviderSession', {
      session: session.id,
      id: found.id,
      ...(found.transcriptPath !== null ? { transcriptPath: found.transcriptPath } : {})
    })
  }

  /** Sets the session's coarse status and summary when either differs from what it holds. */
  private async publish(session: Session, row: AgentRow | null): Promise<void> {
    const summary = row ? summaryOf(row, this.now(), true) : null
    const status = coarseStatus(summary?.display ?? null, row?.state)
    if (session.status === status && sameSummary(session.agentStatus, summary)) return
    await this.context.call('quirky.session/setStatus', { session: session.id, status, agentStatus: summary })
  }

  /**
   * Announces a fallback row (title or OSC 7501) the way the hook path does: only a change into
   * done, waiting or blocked, never a session boundary, and never while children are still working.
   */
  private emitIfSettled(session: Session, prev: AgentRow | null, row: AgentRow): void {
    if (row.sessionBoundary) return
    const { state } = foldLead(row.lead.state, row.children, false)
    const before = prev ? foldLead(prev.lead.state, prev.children, false).state : null
    if (before !== state && state !== 'working') this.emitSettled(session, row, state)
  }

  /** Announces that a row settled into done, waiting or blocked, with what a banner would say about it. */
  private emitSettled(session: Session, row: AgentRow, state: SettledState): void {
    const tool = toolOf(row)
    this.context.emit('settled', {
      sessionId: session.id,
      worktreeId: session.worktreeId,
      agent: session.agent,
      state,
      outcome: row.outcome ?? null,
      interrupted: row.interrupted === true,
      prompt: row.prompt || null,
      toolName: tool.name,
      toolInput: tool.input,
      lastAssistantMessage: row.lastAssistantMessage ?? null,
      at: this.now()
    })
  }
}
