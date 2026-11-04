import { createHash } from 'node:crypto'
import type { AvatarApp, StuckRow, SupervisorService, WorktreeState } from '../contracts'
import { sanitize } from '../sanitize'
import { createLadder } from './ladder'
import { createRecords, type RecordsDeps } from './records'
import { createStepIn, type StepInDeps } from './stepin'
import { createEvidence, detectStuck, outputSignature, type Evidence, type StuckWindow } from './stuck'

const HOOKED_AGENTS: readonly string[] = ['claude', 'codex', 'pi', 'omp']
const WATCHED_STATES: ReadonlySet<WorktreeState> = new Set(['working', 'briefing', 'in-review'])
const SETTLED_TEXT_CHARS = 2000
const JOURNAL_WINDOW = 200
const IDLE_HOSTING_STATUSES: ReadonlySet<string> = new Set(['queued', 'in-flight', 'paused', 'skipped'])

export type SupervisorDeps = {
  stepIn?: StepInDeps
  records?: Partial<Omit<RecordsDeps, 'evidence'>>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const EVENTS = {
  'quirky.agent-status/settled': 'agent-settled',
  'quirky.agent-status/changed': 'agent-changed',
  'quirky.ask/resolved': 'ask-resolved',
  'quirky.hosting/refresh': 'hosting-refresh',
  'quirky.hosting/changed': 'hosting-changed',
  'quirky.hosting/reviewCacheChanged': 'hosting-review-changed'
} as const

/**
 * Installs `app.services.supervisor` and its jobs. Events about a handed-off worktree are
 * journaled and wake the brain; the watchdog job looks for stuck workers every minute and climbs
 * the ladder; the records job checks each session record against the gate's receipts. Returns a
 * disposer that stops the subscription and the file watchers.
 */
export function register(app: AvatarApp, deps: SupervisorDeps = {}): () => void {
  const call = <T>(method: string, params: Record<string, unknown>): Promise<T> => app.context.call(method, params) as Promise<T>
  const evidence: Evidence = createEvidence()
  const promptTimes = new Map<string, number>()
  const lastStates = new Map<string, string>()
  const hostingDigests = new Map<string, string>()
  const heads = new Map<string, string>()

  const stepin = createStepIn(app, { promptAt: (sessionId) => promptTimes.get(sessionId) ?? null, ...deps.stepIn })

  const activeRow = (worktreeId: string) => app.services.handoff.active().find((entry) => entry.worktreeId === worktreeId)

  async function defaultAgent(): Promise<string | null> {
    try {
      const listing = await call<Record<string, unknown>>('quirky.agents/list', {})
      const chosen = str(listing.defaultAgent)
      if (chosen !== null && HOOKED_AGENTS.includes(chosen)) return chosen
      const agents = Array.isArray(listing.agents) ? listing.agents.filter(isRecord) : []
      return agents.find((agent) => agent.installed === true && agent.enabled !== false && HOOKED_AGENTS.includes(String(agent.id)))?.id as string | undefined ?? null
    } catch {
      return null
    }
  }

  async function launch(worktreeId: string, note: string, replacing: boolean): Promise<{ sessionId: string | null; error?: string }> {
    const mandate = app.store.mandates.get(worktreeId)
    if (mandate === null) return { sessionId: null, error: 'no mandate for this worktree' }
    try {
      const agent = mandate.agent ?? (await defaultAgent())
      const row = app.store.handoffs.get(worktreeId)
      const previous = row?.sessionId ?? null
      if (replacing && previous !== null) {
        await call('quirky.session/close', { session: previous }).catch(() => undefined)
        app.services.gate.removeMarker(previous)
      }
      const created = await call<Record<string, unknown>>('quirky.session/create', { worktree: worktreeId, ...(agent === null ? {} : { agent }), prompt: note })
      const sessionId = str(created.id)
      if (sessionId === null) return { sessionId: null, error: 'the session was created without an id' }
      if (row !== null) app.store.handoffs.put({ ...row, sessionId })
      app.services.gate.writeMarker(sessionId, worktreeId, mandate.level)
      evidence.clear(worktreeId)
      if (replacing) app.services.handoff.setState(worktreeId, 'checking', 'restarted, checking the gate again')
      app.services.gate.gateCheck(worktreeId).catch((error) => app.journal(worktreeId, 'event', { type: 'gate-check-error', error: message(error) }))
      return { sessionId }
    } catch (error) {
      return { sessionId: null, error: message(error) }
    }
  }

  function park(worktreeId: string, story: string): void {
    const entry = activeRow(worktreeId)
    const alreadyParked = app.needs.list({ worktreeId, open: true }).some((need) => need.kind === 'parked')
    app.store.transaction(() => {
      app.services.handoff.setState(worktreeId, 'parked', story.split('\n')[0] ?? story)
      if (!alreadyParked) {
        const headline = (story.split('\n')[0] ?? story).slice(0, 120)
        app.needs.add({ worktreeId, kind: 'parked', title: `Parked: ${headline}`, detail: { story }, actions: ['restart', 'take-back'] })
      }
    })
    if (entry?.sessionId != null) app.services.gate.removeMarker(entry.sessionId)
  }

  const ladder = createLadder(app, {
    send: (worktreeId, text) => app.services.supervisor.send(worktreeId, text),
    restartWorker: (worktreeId, note) => app.services.supervisor.restartWorker(worktreeId, note),
    park: (worktreeId, story) => app.services.supervisor.park(worktreeId, story)
  })
  const records = createRecords(app, { ...deps.records, evidence })

  /** An allowed call since the last denial ends the streak, so only unbroken denials count as "in a row". */
  function denialsAfterAllow(worktreeId: string, sessionId: string | null): void {
    const { counters } = ladder.row(worktreeId)
    const lastDenialAt = counters.lastDenialAt
    if (sessionId === null || lastDenialAt === undefined || (counters.denialsConsecutive ?? 0) === 0) return
    const allowedSince = app.store.receipts.list({ sessionId }).some((receipt) => receipt.at > lastDenialAt && (receipt.outcome === 'allow' || receipt.outcome === 'passthrough'))
    if (allowedSince) ladder.patchCounters(worktreeId, { denialsConsecutive: 0 })
  }

  app.services.supervisor = {
    send: stepin.send,
    stepIn: stepin.stepIn,
    startSession: (worktreeId, note) => launch(worktreeId, note, false),
    restartWorker: (worktreeId, note) => launch(worktreeId, note, true),
    park,
    recordDenial(worktreeId, countsAsDenial) {
      if (!countsAsDenial) return
      denialsAfterAllow(worktreeId, activeRow(worktreeId)?.sessionId ?? null)
      const { counters } = ladder.row(worktreeId)
      ladder.patchCounters(worktreeId, {
        denialsConsecutive: (counters.denialsConsecutive ?? 0) + 1,
        denialsTotal: (counters.denialsTotal ?? 0) + 1,
        lastDenialAt: app.now()
      })
    }
  } satisfies SupervisorService

  function worktreeOf(data: unknown): string | null {
    if (!isRecord(data)) return null
    const nested = [data.row, data.envelope, data.ask].filter(isRecord)
    const direct = [data, ...nested].map((source) => str(source.worktreeId)).find((id) => id !== null)
    if (direct != null) return direct
    const sessionId = [data, ...nested].map((source) => str(source.sessionId)).find((id) => id !== null)
    return sessionId == null ? null : (app.services.handoff.active().find((entry) => entry.sessionId === sessionId)?.worktreeId ?? null)
  }

  function onEvent(type: string, data: unknown): void {
    const label = EVENTS[type as keyof typeof EVENTS]
    if (label === undefined) return
    const worktreeId = worktreeOf(data)
    if (worktreeId === null || activeRow(worktreeId) === undefined) return
    const record = isRecord(data) ? data : {}
    const sessionId = str(record.sessionId) ?? str(isRecord(record.row) ? record.row.sessionId : null)
    const at = typeof record.at === 'number' ? record.at : app.now()
    evidence.noteActivity(worktreeId, at)

    const detail: Record<string, unknown> = { type: label, source: type }
    if (sessionId !== null) detail.sessionId = sessionId

    if (label === 'agent-settled') {
      if (sessionId !== null) promptTimes.set(sessionId, at)
      for (const key of ['state', 'outcome', 'interrupted', 'toolName']) if (record[key] !== undefined) detail[key] = record[key]
      if (typeof record.lastAssistantMessage === 'string') detail.lastAssistantMessage = sanitize(record.lastAssistantMessage).slice(0, SETTLED_TEXT_CHARS)
    } else if (label === 'agent-changed') {
      const row = isRecord(record.row) ? record.row : null
      const state = str(row?.state)
      if (row === null || state === null || sessionId === null) return
      if (lastStates.get(sessionId) === state) return
      lastStates.set(sessionId, state)
      promptTimes.set(sessionId, at)
      detail.state = state
    } else if (label === 'ask-resolved') {
      detail.askId = record.askId
    } else {
      if (label === 'hosting-refresh' && typeof record.status === 'string' && IDLE_HOSTING_STATUSES.has(record.status)) return
      const digest = createHash('sha256').update(JSON.stringify(record.outcome ?? record.sequence ?? label)).digest('hex')
      if (hostingDigests.get(`${worktreeId}\0${label}`) === digest) return
      hostingDigests.set(`${worktreeId}\0${label}`, digest)
    }
    app.journal(worktreeId, 'event', detail)
    app.services.brain.wake()
  }

  const unsubscribe = app.context.subscribe((event) => onEvent(event.type, (event as { data?: unknown }).data))

  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

  async function noteProgress(worktreeId: string, row: StuckRow): Promise<void> {
    const entries = app.store.journalPage({ worktreeId, limit: JOURNAL_WINDOW }).reverse()
    const checks = entries.filter((entry) => entry.kind === 'done-check' && entry.data.kind === 'command')
    const latest = checks.at(-1)
    let progressed: string | null = null
    if (latest !== undefined && latest.seq > (row.counters.doneSeq ?? 0)) {
      const previous = checks.at(-2)
      const signatureOf = (data: Record<string, unknown>) => str(data.signature) ?? outputSignature(String(data.output ?? ''))
      if (latest.data.pass === true || (previous !== undefined && signatureOf(latest.data) !== signatureOf(previous.data))) progressed = 'done when output changed'
      ladder.patchCounters(worktreeId, { doneSeq: latest.seq })
    }
    const head = await call<Record<string, unknown>>('quirky.git/status', { worktree: worktreeId }).then((status) => str(status.head), () => null)
    if (head !== null) {
      const known = heads.get(worktreeId)
      heads.set(worktreeId, head)
      if (known !== undefined && known !== head) progressed = progressed ?? 'a new commit'
    }
    if (progressed === null) return
    if (row.rung > 0) app.journal(worktreeId, 'event', { type: 'progress', reason: progressed })
    ladder.reset(worktreeId)
    evidence.clear(worktreeId)
    ladder.patchCounters(worktreeId, { stepAt: 0 })
  }

  async function evaluate(worktreeId: string, sessionId: string | null, level: string): Promise<void> {
    await noteProgress(worktreeId, ladder.row(worktreeId))
    denialsAfterAllow(worktreeId, sessionId)
    const row = ladder.row(worktreeId)
    const stepAt = row.counters.stepAt ?? 0

    const session = sessionId === null ? null : await call<Record<string, unknown>>('quirky.session/get', { session: sessionId }).catch(() => null)
    const status = isRecord(session?.agentStatus) ? session.agentStatus : null
    const working = status?.state === 'working' || (status === null && session?.status === 'working')
    const seen = [number(session?.lastActivityAt), number(status?.evidenceAt), evidence.lastActivity(worktreeId), stepAt > 0 ? stepAt : null].filter((value): value is number => value !== null)

    const entries = app.store.journalPage({ worktreeId, limit: JOURNAL_WINDOW }).reverse()
    const window: StuckWindow = {
      now: app.now(),
      working,
      lastActivityAt: seen.length === 0 ? null : Math.max(...seen),
      doneWhen: entries
        .filter((entry) => entry.kind === 'done-check' && entry.data.kind === 'command' && entry.at > stepAt)
        .map((entry) => ({ signature: str(entry.data.signature) ?? outputSignature(String(entry.data.output ?? '')), pass: entry.data.pass === true, at: entry.at })),
      calls: evidence.calls(worktreeId, stepAt),
      edits: evidence.edits(worktreeId, stepAt),
      denials: { consecutive: row.counters.denialsConsecutive ?? 0, total: row.counters.denialsTotal ?? 0 }
    }
    const signal = detectStuck(window)
    if (signal === null) return
    if (signal.kind === 'silent') app.services.brain.wake()
    if (level === 'shadow') return
    await ladder.climb(worktreeId, signal)
  }

  async function watchdog(): Promise<void> {
    for (const entry of app.services.handoff.active()) {
      if (!WATCHED_STATES.has(entry.state)) continue
      try {
        await evaluate(entry.worktreeId, entry.sessionId, entry.mandate.level)
      } catch (error) {
        app.context.log(`avatar watchdog failed for ${entry.worktreeId}: ${message(error)}`)
      }
    }
  }

  app.context.provide('job:quirky.avatar/watchdog', watchdog)
  app.context.provide('job:quirky.avatar/records', () => records.check())

  return () => {
    unsubscribe()
    records.dispose()
  }
}
