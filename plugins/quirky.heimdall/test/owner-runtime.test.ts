import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PluginContext, Session } from '@quirky/protocol'
import type { Enrollment, JournalAppend, JournalEntry, KernelStore, Snapshot } from '../src/contracts'
import {
  MAX_OWNER_REPORT_BYTES,
  OWNER_BRIEF_MAX_STATE_BYTES,
  OWNER_DEVIATION_KINDS,
  type OwnerApplyResult,
  type OwnerController,
  type OwnerDeviation,
  type OwnerEnrollment,
  type OwnerPending,
  type OwnerIntervention,
  type OwnerRuntimeHost
} from '../src/owner/contracts'
import { createOwnerController, parseOwnerConfig, parseOwnerDeviation, parseOwnerIntervention } from '../src/owner/runtime'

type FakeCalls = {
  creates: { params: Record<string, unknown>; session: string }[]
  sends: { params: Record<string, unknown> }[]
  resumes: { params: Record<string, unknown>; session: string }[]
  gets: string[]
  stops: string[]
  ownedStops: { key: string; stopped: string[]; unknown: string[] }[]
}
type Fixture = {
  root: string
  reportDirectory: string
  enrollment: OwnerEnrollment
  store: KernelStore
  calls: FakeCalls
  controller: OwnerController
  controllers: OwnerController[]
  now: () => number
  setNow: (value: number) => void
  snapshot: Snapshot
  applyCalls: { intervention: OwnerIntervention; deviation: OwnerDeviation; snapshot: Snapshot }[]
  applyResults: OwnerApplyResult[]
  wakeCalls: string[]
  parks: { escalationId: string; detail: string }[]
  loseNextCreateReply: () => void
  loseNextSendReply: () => void
  breakNativeIdentity: (sessionId: string) => void
  delayNextSend: () => { entered: Promise<void>; release: () => void }
  setDispatchAllowed: (allowed: boolean) => void
  restart: () => OwnerController
  addWatcher: (watcherId: string) => OwnerEnrollment
  removeWatcher: (watcherId: string) => void
  createIndependentSession: () => Promise<string>
  setNextOwnedStopReply: (reply: unknown) => void
}

let testHome = ''
let previousHome: string | undefined
let previousQuirkyHome: string | undefined
const fixtures: Fixture[] = []

beforeEach(async () => {
  previousHome = process.env.HOME
  previousQuirkyHome = process.env.QUIRKY_HOME
  testHome = await mkdtemp(join(tmpdir(), 'heimdall-owner-test-'))
  const isolatedHome = join(testHome, 'home')
  const isolatedQuirkyHome = join(testHome, 'quirky-home')
  process.env.HOME = isolatedHome
  process.env.QUIRKY_HOME = isolatedQuirkyHome
  await mkdir(isolatedHome, { recursive: true })
  await mkdir(isolatedQuirkyHome, { recursive: true })
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const controller of fixture.controllers) await controller.shutdown().catch(() => undefined)
  }
  if (testHome !== '') await rm(testHome, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
})

function makeFixture(): Fixture {
  const root = testHome
  const reportDirectory = join(root, 'owner-reports')
  let currentTime = 10_000
  const now = () => currentTime
  const setNow = (value: number) => { currentTime = value }
  const snapshot: Snapshot = { freshness: 'live', contentIdentity: 'tree:initial', observedAtMs: currentTime, world: { branch: 'main' } }
  const enrollment: OwnerEnrollment = {
    watcherId: 'watcher-1', kind: 'fixture', enabled: true, paused: false, commandRevision: 1,
    workspaceKey: 'workspace-1', workspacePath: root, executionHostId: 'local', schedulerOwner: 'daemon',
    repoId: null, worktreeId: 'worktree-1', kindPayload: {}, undo: null,
    capabilities: {}, budget: { wallClockActiveMs: null, turns: null },
    coordinator: { handle: 'coordinator', paneKey: 'pane' }, orchestrationRunId: 'run-1',
    createdAtMs: currentTime, terminalAtMs: null, parkReason: null, haltReason: null,
    owner: { agent: 'claude', model: 'claude-sonnet-4', effort: 'high' }, ownerInterventionCapability: 'on'
  }
  const enrollments = new Map<string, OwnerEnrollment>([[enrollment.watcherId, enrollment]])
  const registrations = [{
    id: 'fixture', displayName: 'Fixture', enrollmentPayloadSchema: { type: 'object' },
    hooks: { authorize: 'fixture/authorize', read: 'fixture/read', decide: 'fixture/decide', execute: 'fixture/execute' },
    pluginId: 'fixture-plugin'
  }]
  const journalByWatcher = new Map<string, JournalEntry[]>()
  const store = {
    readOnly: false,
    get: (id: string) => enrollments.get(id) as Enrollment | undefined ?? null,
    list: () => [...enrollments.values()] as Enrollment[],
    live: () => null,
    save: () => undefined,
    transaction: <T>(work: () => T): T => work(),
    journal: (id: string) => journalByWatcher.get(id) ?? [],
    append: (id: string, append: JournalAppend) => {
      const entries = journalByWatcher.get(id) ?? []
      const row = { ...append, seq: entries.length + 1, eventId: append.eventId ?? `event-${entries.length + 1}`, watcherId: id, atMs: append.atMs ?? currentTime } as JournalEntry
      entries.push(row)
      journalByWatcher.set(id, entries)
      return row
    },
    traces: () => [],
    trace: () => undefined,
    nextTraceSeq: () => 1,
    retain: () => undefined,
    terminal: () => undefined,
    summary: () => null,
    registrations: () => registrations,
    close: () => undefined
  } as unknown as KernelStore

  let sessionCounter = 0
  const sessions = new Map<string, Session>()
  const conversation = new Map<string, string[]>()
  const ownerKeyBySession = new Map<string, string>()
  let loseCreateReply = false
  let loseSendReply = false
  let dispatchAllowed = true
  let sendGate: { signalEntered: () => void; wait: Promise<void> } | null = null
  let nextOwnedStopReply: unknown
  let hasNextOwnedStopReply = false
  const calls: FakeCalls = { creates: [], sends: [], resumes: [], gets: [], stops: [], ownedStops: [] }
  const session = (values: Partial<Session> = {}): Session => {
    sessionCounter += 1
    const id = `owner-session-${sessionCounter}`
    return {
      id, kind: 'structured', agent: 'claude', worktreeId: 'worktree-1', cwd: root, title: 'Owner',
      status: 'running', createdAt: currentTime, lastActivityAt: currentTime, exitCode: null,
      exitSignal: null, exitCause: null, restorable: false, providerSession: { id: `native-${sessionCounter}` },
      ...values
    } as Session
  }
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === 'quirky.structured/create') {
        const created = session()
        sessions.set(created.id, created)
        conversation.set(created.id, [String(params.prompt)])
        calls.creates.push({ params, session: created.id })
        if (params.lifetime === 'plugin' && typeof params.lifetimeKey === 'string') {
          ownerKeyBySession.set(created.id, params.lifetimeKey)
        }
        if (loseCreateReply) {
          loseCreateReply = false
          throw new Error('create completed but its reply was lost')
        }
        return created
      }
      if (method === 'quirky.structured/send') {
        const sessionId = String(params.session)
        if (!sessions.has(sessionId)) throw new Error(`no such session ${sessionId}`)
        const gate = sendGate
        if (gate) {
          sendGate = null
          gate.signalEntered()
          await gate.wait
        }
        conversation.get(sessionId)?.push(String(params.text))
        calls.sends.push({ params })
        if (loseSendReply) {
          loseSendReply = false
          throw new Error('send may have reached the owner but its reply was lost')
        }
        return { ok: true }
      }
      if (method === 'quirky.session/get') {
        const sessionId = String(params.session)
        calls.gets.push(sessionId)
        const found = sessions.get(sessionId)
        if (!found) throw new Error(`no such session ${sessionId}`)
        return found
      }
      if (method === 'quirky.structured/resume') {
        const oldId = String(params.session)
        const old = sessions.get(oldId)
        if (!old?.providerSession?.id) throw new Error(`session ${oldId} has no native identity`)
        const resumed = session({ resumedFrom: oldId, providerSession: old.providerSession })
        sessions.set(resumed.id, resumed)
        if (params.lifetime === 'plugin' && typeof params.lifetimeKey === 'string') {
          ownerKeyBySession.set(resumed.id, params.lifetimeKey)
        }
        conversation.set(resumed.id, [...(conversation.get(oldId) ?? []), String(params.prompt ?? '')])
        calls.resumes.push({ params, session: resumed.id })
        return resumed
      }
      if (method === 'quirky.structured/stop') {
        const sessionId = String(params.session)
        calls.stops.push(sessionId)
        const found = sessions.get(sessionId)
        if (found) sessions.set(sessionId, { ...found, status: 'exited', exitCode: 0 })
        return { ok: true }
      }
      if (method === 'quirky.structured/stopOwned') {
        const key = String(params.key)
        const stopped: string[] = []
        const unknown: string[] = []
        for (const [sessionId, ownerKey] of ownerKeyBySession) {
          if (ownerKey !== key) continue
          const existing = sessions.get(sessionId)
          if (!existing) {
            unknown.push(sessionId)
          } else if (existing.status !== 'exited') {
            sessions.set(sessionId, { ...existing, status: 'exited', exitCode: 0 })
            stopped.push(sessionId)
            ownerKeyBySession.delete(sessionId)
          }
        }
        calls.ownedStops.push({ key, stopped, unknown })
        if (hasNextOwnedStopReply) {
          hasNextOwnedStopReply = false
          return nextOwnedStopReply
        }
        return { stopped, unknown }
      }
      throw new Error(`unexpected structured API call: ${method}`)
    }
  } as unknown as PluginContext

  const applyCalls: Fixture['applyCalls'] = []
  const applyResults: OwnerApplyResult[] = []
  const wakeCalls: string[] = []
  const parks: Fixture['parks'] = []
  const host: OwnerRuntimeHost = {
    context, store, reportDirectory, now,
    canDispatch: () => dispatchAllowed,
    apply: async (_enrollment, intervention, deviation, currentSnapshot) => {
      applyCalls.push({ intervention, deviation, snapshot: currentSnapshot })
      return applyResults.shift() ?? { kind: 'applied' }
    },
    park: (_enrollment, escalationId, detail) => parks.push({ escalationId, detail }),
    wake: (watcherId) => wakeCalls.push(watcherId)
  }
  const controller = createOwnerController(host)
  const fixture: Fixture = {
    root, reportDirectory, enrollment, store, calls, controller, controllers: [controller], now, setNow,
    snapshot, applyCalls, applyResults, wakeCalls, parks,
    addWatcher: (watcherId) => {
      const next = { ...enrollment, watcherId, coordinator: { ...enrollment.coordinator } }
      enrollments.set(watcherId, next)
      return next
    },
    removeWatcher: (watcherId) => {
      enrollments.delete(watcherId)
      journalByWatcher.delete(watcherId)
    },
    createIndependentSession: async () => {
      const created = await context.call('quirky.structured/create', {
        agent: 'claude', worktree: 'id:worktree-1', prompt: 'independent structured session'
      })
      if (!created || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') throw new Error('independent session was not created')
      return created.id
    },
    setDispatchAllowed: (allowed) => { dispatchAllowed = allowed },
    loseNextCreateReply: () => { loseCreateReply = true },
    delayNextSend: () => {
      const entered = Promise.withResolvers<void>()
      const send = Promise.withResolvers<void>()
      sendGate = { signalEntered: () => entered.resolve(), wait: send.promise }
      return { entered: entered.promise, release: () => send.resolve() }
    },
    loseNextSendReply: () => { loseSendReply = true },
    breakNativeIdentity: (sessionId) => {
      const existing = sessions.get(sessionId)
      if (existing) sessions.set(sessionId, { ...existing, providerSession: null })
    },
    restart: () => {
      const next = createOwnerController(host)
      fixture.controllers.push(next)
      return next
    },
    setNextOwnedStopReply: (reply) => {
      nextOwnedStopReply = reply
      hasNextOwnedStopReply = true
    },
  }
  fixtures.push(fixture)
  return fixture
}

const deviation = (naturalKey: string, detail = `failure ${naturalKey}`): OwnerDeviation => ({ kind: 'check-failed', naturalKey, detail })

async function issue(fixture: Fixture, item = deviation('check:one')): Promise<Record<string, unknown>> {
  await fixture.controller.step(fixture.enrollment, fixture.snapshot, [item])
  return fixture.controller.inspect(fixture.enrollment.watcherId) as unknown as Record<string, unknown>
}

async function writeReport(fixture: Fixture, intervention: unknown, path?: string): Promise<string> {
  const state = fixture.controller.inspect(fixture.enrollment.watcherId)
  const reportPath = path ?? state.pending?.reportPath
  if (!reportPath) throw new Error('owner did not issue a report path')
  await writeFile(reportPath, JSON.stringify(intervention), 'utf8')
  return reportPath
}

describe('owner runtime validation', () => {
  test('accepts all deviation kinds and requires the stable natural key', () => {
    for (const kind of OWNER_DEVIATION_KINDS) {
      expect(parseOwnerDeviation({ kind, naturalKey: `${kind}:1`, detail: 'source-grounded detail' })).toEqual({
        kind, naturalKey: `${kind}:1`, detail: 'source-grounded detail'
      })
    }
    expect(() => parseOwnerDeviation({ kind: 'check-failed', detail: 'missing key' })).toThrow()
    expect(() => parseOwnerDeviation({ kind: 'check-failed', naturalKey: 'k', detail: 'bad', surprise: true })).toThrow()
    expect(() => parseOwnerDeviation({ kind: 'unknown', naturalKey: 'k', detail: 'bad' })).toThrow()
  })

  test('accepts only Claude owner config with optional valid model and effort strings', () => {
    expect(parseOwnerConfig({ agent: 'claude' })).toEqual({ agent: 'claude' })
    expect(parseOwnerConfig({ agent: 'claude', model: 'claude-sonnet-4', effort: 'high' })).toEqual({
      agent: 'claude', model: 'claude-sonnet-4', effort: 'high'
    })
    expect(parseOwnerConfig(undefined)).toBeNull()
    expect(() => parseOwnerConfig({ agent: 'codex' })).toThrow()
    expect(() => parseOwnerConfig({ agent: 'claude', model: ' ' })).toThrow()
    expect(() => parseOwnerConfig({ agent: 'claude', model: undefined })).toThrow()
    expect(() => parseOwnerConfig({ agent: 'claude', effort: 'high', extra: true })).toThrow()
  })

  test('rejects extra or malformed intervention fields', () => {
    expect(parseOwnerIntervention({ kind: 'continue' })).toEqual({ kind: 'continue' })
    expect(parseOwnerIntervention({ kind: 'ask-human', question: 'Which branch?' })).toEqual({ kind: 'ask-human', question: 'Which branch?' })
    expect(parseOwnerIntervention({ kind: 'abandon', reason: 'stop this run' })).toEqual({ kind: 'abandon', reason: 'stop this run' })
    expect(parseOwnerIntervention({ kind: 'answer-worker', dispatchId: 'd', messageId: 'm', body: 'answer' })).toEqual({
      kind: 'answer-worker', dispatchId: 'd', messageId: 'm', body: 'answer'
    })
    expect(parseOwnerIntervention({ kind: 'stop-worker', dispatchId: 'd' })).toEqual({ kind: 'stop-worker', dispatchId: 'd' })
    expect(parseOwnerIntervention({ kind: 'message-worker', dispatchId: 'd', body: 'message' })).toEqual({
      kind: 'message-worker', dispatchId: 'd', body: 'message'
    })
    expect(parseOwnerIntervention({ kind: 'kind-action', action: { fixture: true } })).toEqual({
      kind: 'kind-action', action: { fixture: true }
    })
    expect(() => parseOwnerIntervention({ kind: 'continue', dispatchId: 'unrelated' })).toThrow()
    expect(() => parseOwnerIntervention({ kind: 'message-worker', dispatchId: 'd', body: 3 })).toThrow()
    expect(() => parseOwnerIntervention({ kind: 'unknown' })).toThrow()
  })
})

describe('owner runtime journal and conversation', () => {
  test('deduplicates an applied natural key durably across later ticks', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:stable'))
    const openEscalation = fixture.store.journal(fixture.enrollment.watcherId).find((entry) => entry.kind === 'escalation')
    expect(openEscalation).toMatchObject({
      escalationId: 'owner-deviation:watcher-1:check:stable',
      status: 'open',
      foldCount: 1,
      detail: 'failure check:stable',
      deviation: { kind: 'check-failed', naturalKey: 'check:stable', detail: 'failure check:stable' }
    })
    const intervalId = fixture.store.journal(fixture.enrollment.watcherId).find((entry) => entry.kind === 'interval-open')?.intervalId
    expect(fixture.store.journal(fixture.enrollment.watcherId).find((entry) => entry.kind === 'interval-open')).toMatchObject({ cause: 'owner-in-flight' })
    const firstKey = fixture.controller.inspect(fixture.enrollment.watcherId).pending?.reportKey
    await writeReport(fixture, { kind: 'continue' })
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, firstKey!)).toEqual({ kind: 'accepted' })
    expect(fixture.store.journal(fixture.enrollment.watcherId).find((entry) => entry.kind === 'interval-close')).toMatchObject({ intervalId, reason: 'settled' })
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [deviation('check:stable')])
    await fixture.controller.shutdown()
    const restarted = fixture.restart()
    await restarted.step(fixture.enrollment, fixture.snapshot, [deviation('check:stable')])
    expect(fixture.calls.creates).toHaveLength(1)
    expect(fixture.calls.sends).toHaveLength(0)
    const entries = fixture.store.journal(fixture.enrollment.watcherId).filter((entry) => entry.kind === 'owner-deviation')
    expect(entries.at(-1)).toMatchObject({ naturalKey: 'check:stable', resolved: true, status: 'applied' })
    const escalations = fixture.store.journal(fixture.enrollment.watcherId).filter((entry) => entry.kind === 'escalation')
    expect(new Set(escalations.map((entry) => entry.escalationId))).toEqual(new Set(['owner-deviation:watcher-1:check:stable']))
    expect(escalations.at(-1)).toMatchObject({ status: 'resolved', resolved: true })
  })

  test('persists queued deviations across restart and issues only one report at a time', async () => {
    const fixture = makeFixture()
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [deviation('check:first'), deviation('check:second')])
    let state = fixture.controller.inspect(fixture.enrollment.watcherId) as unknown as Record<string, unknown>
    expect(state.pending).toMatchObject({ deviation: { naturalKey: 'check:first' }, contentIdentity: fixture.snapshot.contentIdentity })
    expect(state.queue).toHaveLength(1)
    await fixture.controller.shutdown()
    const restarted = fixture.restart()
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    const firstPending = restarted.inspect(fixture.enrollment.watcherId).pending!
    expect(firstPending.reportKey).toBeTruthy()
    await writeFile(firstPending.reportPath, JSON.stringify({ kind: 'continue' }), 'utf8')
    await restarted.ready(fixture.enrollment.watcherId, firstPending.reportKey)
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    state = restarted.inspect(fixture.enrollment.watcherId) as unknown as Record<string, unknown>
    expect(state.pending).toMatchObject({ deviation: { naturalKey: 'check:second' }, contentIdentity: fixture.snapshot.contentIdentity })
    expect(fixture.calls.creates).toHaveLength(1)
    expect(fixture.calls.resumes).toHaveLength(1)
    expect(fixture.calls.sends).toHaveLength(1)
    expect(state.queue).toEqual([])
  })

  test('keeps the full UTF-8 brief within its byte cap and includes issued report details', async () => {
    const fixture = makeFixture()
    const text = `prefix-detail-${'é'.repeat(40_000)}`
    await issue(fixture, deviation('check:unicode', text))
    const prompt = String(fixture.calls.creates[0]?.params.prompt)
    const pending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(OWNER_BRIEF_MAX_STATE_BYTES)
    expect(prompt).toContain('prefix-detail-')
    expect(prompt).toContain(pending.reportKey)
    expect(prompt).toContain(pending.reportPath)
    expect(prompt).toContain(`quirky heimdall owner-ready --watcher-id ${fixture.enrollment.watcherId} --report-key ${pending.reportKey}`)
  })

  test('captures bounded issue-time snapshot, enrollment, hooks, budget, attempts, approvals, and domain evidence', async () => {
    const fixture = makeFixture()
    fixture.snapshot.world = { branch: 'main', source: 'grounded-world', huge: '界'.repeat(40_000) }
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'interval-open', resolved: false,
      eventId: 'budget-active', atMs: fixture.now() - 2_000, intervalId: 'budget-active', cause: 'worker-dispatched'
    })
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'attempt', resolved: false,
      eventId: 'attempt-running', atMs: fixture.now(), attemptId: 'attempt-live', state: 'running',
      action: { kind: 'dispatch', contentIdentity: 'tree:initial' }, dispatchId: 'dispatch-live'
    })
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'attempt', resolved: true,
      eventId: 'attempt-settled', atMs: fixture.now(), attemptId: 'attempt-done', state: 'settled'
    })
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'approval', resolved: false,
      eventId: 'approval-latest', atMs: fixture.now(), status: 'approved',
      approvalScope: { actionKind: 'dispatch', contentIdentity: 'tree:initial', evidenceKey: 'evidence:1' }
    })
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'evidence', resolved: true,
      eventId: 'recent-domain', atMs: fixture.now(), evidenceKind: 'domain-check', payload: { conclusion: 'world-source' }
    })
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'owner-state', resolved: false,
      eventId: 'recursive-owner-state', state: { secret: 'must-not-enter-brief' }
    })
    fixture.store.append(fixture.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'owner-report-issued', resolved: false,
      eventId: 'recursive-owner-report', reportKey: 'must-not-enter-brief'
    })

    await issue(fixture, { ...deviation('check:grounded'), dispatchId: 'dispatch-live', messageId: 'message-live', trigger: 'idle' })
    const prompt = String(fixture.calls.creates[0]?.params.prompt)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(OWNER_BRIEF_MAX_STATE_BYTES)
    expect(prompt).toContain('"activeMs":2000')
    expect(prompt).toContain('"turns":0')
    expect(prompt).toContain('grounded-world')
    expect(prompt).toContain('branch')
    expect(prompt).toContain('fixture/read')
    expect(prompt).toContain('fixture-plugin')
    expect(prompt).toContain('attempt-live')
    expect(prompt).not.toContain('attempt-done')
    expect(prompt).toContain('approval-latest')
    expect(prompt).toContain('world-source')
    expect(prompt).toContain('dispatch-live')
    expect(prompt).toContain('message-live')
    expect(prompt).toContain('[truncated')
    expect(prompt).not.toContain('must-not-enter-brief')

    await fixture.controller.shutdown()
    fixture.snapshot.world = { branch: 'later-world' }
    const restarted = fixture.restart()
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    const resumedPrompt = String(fixture.calls.resumes[0]?.params.prompt)
    expect(resumedPrompt).toContain('grounded-world')
    expect(resumedPrompt).not.toContain('later-world')
    expect(Buffer.byteLength(resumedPrompt, 'utf8')).toBeLessThanOrEqual(OWNER_BRIEF_MAX_STATE_BYTES)
  })

  test('an unowned watcher with no owner state does not persist bookkeeping or activate a provider', async () => {
    const fixture = makeFixture()
    fixture.enrollment.owner = null
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [deviation('check:unowned')])
    expect(fixture.calls.creates).toHaveLength(0)
    expect(fixture.calls.resumes).toHaveLength(0)
    expect(fixture.store.journal(fixture.enrollment.watcherId).some((entry) => entry.kind === 'owner-state')).toBe(false)
  })

  test('rejects stale and replayed report identities without rereading an issued report', async () => {
    const fixture = makeFixture()
    await issue(fixture)
    const key = fixture.controller.inspect(fixture.enrollment.watcherId).pending!.reportKey
    await writeReport(fixture, { kind: 'continue' })
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, `${key}-stale`)).toMatchObject({ kind: 'refused' })
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, key)).toEqual({ kind: 'accepted' })
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, key)).toMatchObject({ kind: 'refused' })
    expect(fixture.applyCalls).toHaveLength(0)
  })

  test('refuses malformed JSON and extra intervention fields but permits a corrected current report', async () => {
    const fixture = makeFixture()
    await issue(fixture)
    const pending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    await writeFile(pending.reportPath, '{not json', 'utf8')
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, pending.reportKey)).toMatchObject({ kind: 'refused' })
    expect(fixture.store.journal(fixture.enrollment.watcherId).some((entry) => entry.kind === 'owner-report-rejected')).toBe(true)
    await writeFile(pending.reportPath, JSON.stringify({ kind: 'continue', unexpected: true }), 'utf8')
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, pending.reportKey)).toMatchObject({ kind: 'refused' })
    await writeReport(fixture, { kind: 'continue' }, pending.reportPath)
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, pending.reportKey)).toEqual({ kind: 'accepted' })
    expect(fixture.applyCalls).toHaveLength(0)
  })

  test('enforces the 64 KiB report limit and accepts a report at the byte boundary', async () => {
    const oversized = makeFixture()
    await issue(oversized, deviation('check:large'))
    const largePending = oversized.controller.inspect(oversized.enrollment.watcherId).pending!
    await writeFile(largePending.reportPath, ' '.repeat(MAX_OWNER_REPORT_BYTES + 1), 'utf8')
    expect(await oversized.controller.ready(oversized.enrollment.watcherId, largePending.reportKey)).toMatchObject({ kind: 'refused' })

    const boundary = makeFixture()
    await issue(boundary, deviation('check:boundary'))
    const exactPending = boundary.controller.inspect(boundary.enrollment.watcherId).pending!
    const valid = JSON.stringify({ kind: 'continue' })
    await writeFile(exactPending.reportPath, valid + ' '.repeat(MAX_OWNER_REPORT_BYTES - Buffer.byteLength(valid, 'utf8')), 'utf8')
    expect(Buffer.byteLength(await readFile(exactPending.reportPath), 'utf8')).toBe(MAX_OWNER_REPORT_BYTES)
    expect(await boundary.controller.ready(boundary.enrollment.watcherId, exactPending.reportKey)).toEqual({ kind: 'accepted' })
  })

  test('refuses symlink reports and traversal-shaped report keys', async () => {
    const fixture = makeFixture()
    await issue(fixture)
    const pending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const target = join(fixture.root, 'outside.json')
    await writeFile(target, JSON.stringify({ kind: 'continue' }), 'utf8')
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, '../../outside.json')).toMatchObject({ kind: 'refused' })
    await unlink(pending.reportPath)
    await symlink(target, pending.reportPath)
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, pending.reportKey)).toMatchObject({ kind: 'refused' })
    expect(fixture.applyCalls).toHaveLength(0)
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify({ kind: 'continue' }))
  })

  test('keeps held interventions ready and blocks retries after indeterminate execution', async () => {
    const held = makeFixture()
    await issue(held, deviation('check:held'))
    const heldKey = held.controller.inspect(held.enrollment.watcherId).pending!.reportKey
    await writeReport(held, { kind: 'continue' })
    await held.controller.ready(held.enrollment.watcherId, heldKey)
    held.applyResults.push({ kind: 'held', reason: 'approval required' }, { kind: 'applied' })
    await held.controller.step(held.enrollment, held.snapshot, [])
    expect(held.controller.inspect(held.enrollment.watcherId).pending?.phase).toBe('ready')
    expect(held.applyCalls).toHaveLength(1)
    await held.controller.step(held.enrollment, held.snapshot, [])
    expect(held.controller.inspect(held.enrollment.watcherId).pending).toBeNull()
    expect(held.applyCalls).toHaveLength(2)

    const uncertain = makeFixture()
    await issue(uncertain, deviation('check:uncertain'))
    const uncertainKey = uncertain.controller.inspect(uncertain.enrollment.watcherId).pending!.reportKey
    await writeReport(uncertain, { kind: 'continue' })
    await uncertain.controller.ready(uncertain.enrollment.watcherId, uncertainKey)
    uncertain.applyResults.push({ kind: 'indeterminate', reason: 'lost result' })
    await uncertain.controller.step(uncertain.enrollment, uncertain.snapshot, [])
    await uncertain.controller.step(uncertain.enrollment, uncertain.snapshot, [])
    expect(uncertain.controller.inspect(uncertain.enrollment.watcherId).pending?.phase).toBe('indeterminate')
    expect(uncertain.applyCalls).toHaveLength(1)
  })

  test('cleared applied and refused reports request the next tick at the current host time', async () => {
    for (const result of [{ kind: 'applied' }, { kind: 'refused', reason: 'not accepted' }] as const) {
      const fixture = makeFixture()
      await issue(fixture, deviation(`check:${result.kind}`))
      const key = fixture.controller.inspect(fixture.enrollment.watcherId).pending!.reportKey
      await writeReport(fixture, { kind: 'continue' })
      await fixture.controller.ready(fixture.enrollment.watcherId, key)
      fixture.applyResults.push(result)
      const applied = await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
      expect(applied.nextCheckAtMs).toBe(fixture.now())
    }
  })

  test('resumes the persisted native conversation after restart without creating another owner', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:restart'))
    const old = fixture.controller.inspect(fixture.enrollment.watcherId).pending as OwnerPending & { contentIdentity: string }
    await fixture.controller.shutdown()
    const restarted = fixture.restart()
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    const pending = restarted.inspect(fixture.enrollment.watcherId).pending as OwnerPending & { contentIdentity: string }
    expect(fixture.calls.creates).toHaveLength(1)
    expect(fixture.calls.resumes).toHaveLength(1)
    expect(pending.reportKey).not.toBe(old.reportKey)
    expect(pending.contentIdentity).toBe(fixture.snapshot.contentIdentity)
    expect(fixture.calls.resumes[0]?.params.prompt).toContain(pending.reportPath)
    expect(fixture.calls.ownedStops).toHaveLength(0)
    expect(fixture.calls.resumes[0]?.params).toMatchObject({ lifetime: 'plugin', lifetimeKey: fixture.enrollment.watcherId })
  })

  test('owner config changes release the old conversation before issuing a fresh snapshot-bound turn', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:config-change'))
    const oldPending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const oldSession = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    const freshSnapshot = { ...fixture.snapshot, contentIdentity: 'tree:after-config-change', observedAtMs: fixture.now() }
    fixture.enrollment.owner = { agent: 'claude', model: 'claude-opus-4', effort: 'low' }
    await fixture.controller.step(fixture.enrollment, freshSnapshot, [])
    const current = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    expect(current.deviation.naturalKey).toBe('check:config-change')
    expect(current.reportKey).not.toBe(oldPending.reportKey)
    expect(current.contentIdentity).toBe(freshSnapshot.contentIdentity)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).sessionId).not.toBe(oldSession)
    expect(fixture.calls.creates).toHaveLength(2)
    expect(fixture.calls.resumes).toHaveLength(0)
    expect(fixture.calls.ownedStops).toEqual([{ key: fixture.enrollment.watcherId, stopped: [oldSession], unknown: [] }])
    expect(await Bun.file(oldPending.reportPath).exists()).toBe(false)
    expect(fixture.store.journal(fixture.enrollment.watcherId).some((entry) =>
      entry.kind === 'owner-reset' && entry.reason === 'config-changed'
    )).toBe(true)
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, oldPending.reportKey)).toMatchObject({ kind: 'refused' })
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).pending?.reportKey).toBe(current.reportKey)
  })

  test('records config change after a parent-confirmed release before creating the replacement', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:released-config-change'))
    const oldPending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const oldSession = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    await fixture.controller.release(fixture.enrollment.watcherId)
    fixture.enrollment.owner = { agent: 'claude', model: 'claude-opus-4', effort: 'low' }
    const freshSnapshot = { ...fixture.snapshot, contentIdentity: 'tree:parent-released-config' }

    await fixture.controller.step(fixture.enrollment, freshSnapshot, [])
    const current = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    expect(fixture.calls.ownedStops).toHaveLength(1)
    expect(fixture.calls.ownedStops[0]?.stopped).toContain(oldSession)
    expect(fixture.calls.creates).toHaveLength(2)
    expect(fixture.calls.resumes).toHaveLength(0)
    expect(current.contentIdentity).toBe(freshSnapshot.contentIdentity)
    expect(current.reportKey).not.toBe(oldPending.reportKey)
    expect(await Bun.file(oldPending.reportPath).exists()).toBe(false)
    expect(fixture.store.journal(fixture.enrollment.watcherId).some((entry) =>
      entry.kind === 'owner-reset' && entry.reason === 'config-changed'
    )).toBe(true)
  })

  test('owner removal releases the existing conversation and re-addition creates fresh unresolved work', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:remove-readd'))
    const oldPending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const oldSession = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    fixture.enrollment.owner = null
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.calls.ownedStops).toEqual([{ key: fixture.enrollment.watcherId, stopped: [oldSession], unknown: [] }])
    expect(fixture.controller.inspect(fixture.enrollment.watcherId)).toMatchObject({ sessionId: null, pending: null })
    expect(await Bun.file(oldPending.reportPath).exists()).toBe(false)

    fixture.enrollment.owner = { agent: 'claude', model: 'claude-sonnet-4', effort: 'high' }
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [deviation('check:remove-readd')])
    const next = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    expect(fixture.calls.creates).toHaveLength(2)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).sessionId).not.toBe(oldSession)
    expect(next.reportKey).not.toBe(oldPending.reportKey)
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, oldPending.reportKey)).toMatchObject({ kind: 'refused' })
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).pending?.reportKey).toBe(next.reportKey)
  })

  test('records ambiguous create and send outcomes without blindly retrying', async () => {
    const lostCreate = makeFixture()
    lostCreate.loseNextCreateReply()
    await issue(lostCreate, deviation('check:create-lost'))
    await lostCreate.controller.step(lostCreate.enrollment, lostCreate.snapshot, [])
    expect(lostCreate.calls.creates).toHaveLength(1)
    expect(lostCreate.controller.inspect(lostCreate.enrollment.watcherId).pending?.phase).toBe('indeterminate')
    expect(lostCreate.store.journal(lostCreate.enrollment.watcherId).some((entry) => entry.kind === 'owner-error' && entry.uncertainty === true)).toBe(true)

    const lostSend = makeFixture()
    await issue(lostSend, deviation('check:initial'))
    const firstKey = lostSend.controller.inspect(lostSend.enrollment.watcherId).pending!.reportKey
    await writeReport(lostSend, { kind: 'continue' })
    await lostSend.controller.ready(lostSend.enrollment.watcherId, firstKey)
    await lostSend.controller.step(lostSend.enrollment, lostSend.snapshot, [])
    lostSend.setNow(10)
    const delayedSend = lostSend.delayNextSend()
    lostSend.loseNextSendReply()
    const sending = lostSend.controller.step(lostSend.enrollment, lostSend.snapshot, [deviation('check:send-lost')])
    await delayedSend.entered
    const intervalId = lostSend.store.journal(lostSend.enrollment.watcherId).filter((entry) => entry.kind === 'interval-open').at(-1)?.intervalId
    expect(intervalId).toBeTruthy()
    lostSend.setNow(100)
    lostSend.store.append(lostSend.enrollment.watcherId, {
      class: 'fact', origin: 'owner', kind: 'interval-checkpoint', resolved: false,
      eventId: 'owner-interval-checkpoint-test', atMs: 100, intervalId, checkpointAtMs: 10
    })
    delayedSend.release()
    await sending
    await lostSend.controller.step(lostSend.enrollment, lostSend.snapshot, [])
    const close = lostSend.store.journal(lostSend.enrollment.watcherId)
      .filter((entry) => entry.kind === 'interval-close' && entry.reason === 'contact-lost')
      .at(-1)
    expect(close).toMatchObject({ intervalId, reason: 'contact-lost', checkpointAtMs: 10, atMs: 100 })
    expect(lostSend.calls.sends).toHaveLength(1)
    expect(lostSend.controller.inspect(lostSend.enrollment.watcherId).pending?.phase).toBe('indeterminate')
  })

  test('treats missing persisted native identity as uncertainty instead of creating a replacement', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:no-native-id'))
    const originalSession = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    await fixture.controller.shutdown()
    fixture.breakNativeIdentity(originalSession)
    const restarted = fixture.restart()
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.calls.creates).toHaveLength(1)
    expect(fixture.calls.resumes).toHaveLength(0)
    expect(restarted.inspect(fixture.enrollment.watcherId).pending?.phase).toBe('indeterminate')
  })

  test('sends one silence reminder and parks once after the second interval', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:silence'))
    fixture.setNow(10_000 + 900_000 - 1)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.calls.sends).toHaveLength(0)
    fixture.setNow(10_000 + 900_000)
    fixture.setDispatchAllowed(false)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.calls.sends).toHaveLength(0)
    fixture.setDispatchAllowed(true)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.calls.sends).toHaveLength(1)
    fixture.setNow(10_000 + 1_800_000 - 1)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.parks).toHaveLength(0)
    fixture.setNow(10_000 + 1_800_000)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.parks).toHaveLength(1)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).pending?.phase).toBe('parked')
    const intervalId = fixture.store.journal(fixture.enrollment.watcherId).find((entry) => entry.kind === 'interval-open')?.intervalId
    expect(fixture.store.journal(fixture.enrollment.watcherId).filter((entry) => entry.kind === 'interval-close').at(-1)).toMatchObject({
      intervalId, reason: 'contact-lost'
    })
    expect(fixture.calls.sends).toHaveLength(1)
  })

  test('accepts only the exact parked escalation answer and sends its body to the same conversation', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:answer'))
    fixture.setNow(10_000 + 900_000)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    fixture.setNow(10_000 + 1_800_000)
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    const before = fixture.controller.inspect(fixture.enrollment.watcherId)
    const escalationId = fixture.parks[0]?.escalationId
    expect(escalationId).toBeTruthy()
    expect(await fixture.controller.answer(fixture.enrollment.watcherId, `${escalationId}-wrong`, 'wrong answer')).toMatchObject({ handled: false })
    expect(fixture.calls.sends).toHaveLength(1)
    const answer = 'Keep the current plan; do not alter unrelated workers.'
    expect(await fixture.controller.answer(fixture.enrollment.watcherId, escalationId!, answer)).toMatchObject({ handled: true })
    expect(fixture.calls.sends).toHaveLength(2)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).pending?.phase).toBe('waiting')
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).pending?.reportKey).not.toBe(before.pending?.reportKey)
  })

  test('parks a landed ask-human proposal and resumes with a fresh report identity', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:ask-human'))
    const before = fixture.controller.inspect(fixture.enrollment.watcherId).pending as OwnerPending & { contentIdentity: string }
    await writeReport(fixture, { kind: 'ask-human', question: 'Which result should be kept?' })
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, before.reportKey)).toEqual({ kind: 'accepted' })
    // The runner's landed ask-human action has already parked the enrollment before reconciliation.
    fixture.enrollment.enabled = false
    fixture.enrollment.parkReason = 'owner-escalation'
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    const parked = fixture.controller.inspect(fixture.enrollment.watcherId).pending as OwnerPending & { contentIdentity: string }
    expect(parked.phase).toBe('parked')
    expect(parked.intervention).toEqual({ kind: 'ask-human', question: 'Which result should be kept?' })
    expect(fixture.parks).toEqual([{ escalationId: parked.escalationId, detail: 'Which result should be kept?' }])
    fixture.enrollment.enabled = false
    expect(await fixture.controller.answer(fixture.enrollment.watcherId, parked.escalationId, 'Keep the result from the first run.')).toMatchObject({
      handled: true, reason: 'owner-answer-sent'
    })
    expect(fixture.enrollment.enabled).toBe(false)
    const resumed = fixture.controller.inspect(fixture.enrollment.watcherId).pending as OwnerPending & { contentIdentity: string }
    expect(resumed.phase).toBe('waiting')
    expect(resumed.reportKey).not.toBe(before.reportKey)
    expect(resumed.contentIdentity).toBe(before.contentIdentity)
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, before.reportKey)).toMatchObject({ kind: 'refused' })
  })

  test('releasing one watcher closes only its owner turn and preserves another watcher and independent sessions', async () => {
    const fixture = makeFixture()
    const independentSession = await fixture.createIndependentSession()
    await issue(fixture, deviation('check:release-one'))
    const firstPending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const firstSession = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    const firstInterval = fixture.store.journal(fixture.enrollment.watcherId)
      .filter((entry) => entry.kind === 'interval-open').at(-1)?.intervalId

    const second = fixture.addWatcher('watcher-2')
    await fixture.controller.step(second, fixture.snapshot, [deviation('check:release-two')])
    const secondPending = fixture.controller.inspect(second.watcherId).pending!
    const secondSession = fixture.controller.inspect(second.watcherId).sessionId!

    await fixture.controller.release(fixture.enrollment.watcherId)
    expect(fixture.calls.ownedStops).toEqual([{ key: fixture.enrollment.watcherId, stopped: [firstSession], unknown: [] }])
    expect(fixture.calls.stops).toEqual([])
    expect(fixture.calls.ownedStops[0]?.stopped).not.toContain(secondSession)
    expect(fixture.calls.ownedStops[0]?.stopped).not.toContain(independentSession)
    expect(await Bun.file(firstPending.reportPath).exists()).toBe(false)
    expect(await Bun.file(secondPending.reportPath).exists()).toBe(true)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId)).toMatchObject({ sessionId: null, pending: null })
    expect(fixture.controller.inspect(second.watcherId).pending).toMatchObject({ reportKey: secondPending.reportKey, phase: 'waiting' })
    expect(fixture.store.journal(fixture.enrollment.watcherId).filter((entry) => entry.kind === 'interval-close').at(-1)).toMatchObject({
      intervalId: firstInterval, reason: 'settled'
    })
    expect(fixture.store.journal(second.watcherId).some((entry) => entry.kind === 'interval-close')).toBe(false)
    const firstJournalSize = fixture.store.journal(fixture.enrollment.watcherId).length
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, firstPending.reportKey)).toMatchObject({ kind: 'refused' })
    expect(fixture.store.journal(fixture.enrollment.watcherId)).toHaveLength(firstJournalSize)
    await fixture.controller.release(fixture.enrollment.watcherId)
    expect(fixture.calls.ownedStops).toHaveLength(1)

    await writeFile(secondPending.reportPath, JSON.stringify({ kind: 'continue' }), 'utf8')
    expect(await fixture.controller.ready(second.watcherId, secondPending.reportKey)).toEqual({ kind: 'accepted' })
  })

  test('release uses cached inventory after enrollment and journal removal without writing to the removed watcher', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:removed'))
    const pending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const sessionId = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    fixture.removeWatcher(fixture.enrollment.watcherId)
    expect(fixture.store.journal(fixture.enrollment.watcherId)).toHaveLength(0)
    await fixture.controller.release(fixture.enrollment.watcherId)
    expect(fixture.calls.ownedStops).toEqual([{ key: fixture.enrollment.watcherId, stopped: [sessionId], unknown: [] }])
    expect(await Bun.file(pending.reportPath).exists()).toBe(false)
    expect(fixture.store.journal(fixture.enrollment.watcherId)).toHaveLength(0)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId)).toMatchObject({ sessionId: null, pending: null })
    await fixture.controller.release(fixture.enrollment.watcherId)
    expect(fixture.calls.ownedStops).toHaveLength(1)
  })

  test('release stops an ambiguously created owner through its lifetime key without a returned session ID', async () => {
    const fixture = makeFixture()
    fixture.loseNextCreateReply()
    await issue(fixture, deviation('check:release-lost-create'))
    const createdSession = fixture.calls.creates[0]?.session
    expect(createdSession).toBeTruthy()
    expect(fixture.controller.inspect(fixture.enrollment.watcherId)).toMatchObject({ sessionId: null, pending: { phase: 'indeterminate' } })

    await fixture.controller.release(fixture.enrollment.watcherId)
    expect(fixture.calls.ownedStops).toEqual([{ key: fixture.enrollment.watcherId, stopped: [createdSession!], unknown: [] }])
    expect(fixture.calls.stops).toEqual([])
    expect(fixture.controller.inspect(fixture.enrollment.watcherId)).toMatchObject({ sessionId: null, pending: null })
  })

  test('unknown or malformed keyed release results remain uncertain and block replacement owners', async () => {
    for (const stopReply of [
      { stopped: [], unknown: ['unrecognized-owner-session'] },
      { stopped: 'malformed', unknown: [] }
    ]) {
      const fixture = makeFixture()
      await issue(fixture, deviation('check:release-uncertain'))
      fixture.setNextOwnedStopReply(stopReply)
      await fixture.controller.release(fixture.enrollment.watcherId)
      const state = fixture.controller.inspect(fixture.enrollment.watcherId) as unknown as Record<string, unknown>
      expect(state.releaseUncertain).toBe(true)
      expect(fixture.store.journal(fixture.enrollment.watcherId).some((entry) =>
        entry.kind === 'owner-error' && entry.operation === 'release-owner' && entry.uncertainty === true
      )).toBe(true)
      fixture.enrollment.owner = { agent: 'claude', model: 'claude-opus-4', effort: 'low' }
      await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
      expect(fixture.calls.creates).toHaveLength(1)
    }
  })

  test('release is bounded during a hung owner call and the late result cannot write state', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:release-hung'))
    const pending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    const sessionId = fixture.controller.inspect(fixture.enrollment.watcherId).sessionId!
    fixture.setNow(10_000 + 900_000)
    const delayed = fixture.delayNextSend()
    const tick = fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    await delayed.entered
    const timeout = Promise.withResolvers<never>()
    const watchdog = setTimeout(() => timeout.reject(new Error('watcher release did not respect its deadline')), 2_500)
    try {
      await Promise.race([fixture.controller.release(fixture.enrollment.watcherId), timeout.promise])
      expect(fixture.calls.ownedStops.some((result) => result.key === fixture.enrollment.watcherId && result.stopped.includes(sessionId))).toBe(true)
      expect(await Bun.file(pending.reportPath).exists()).toBe(false)
      const journal = structuredClone(fixture.store.journal(fixture.enrollment.watcherId))
      delayed.release()
      await tick
      expect(fixture.store.journal(fixture.enrollment.watcherId)).toEqual(journal)
    } finally {
      clearTimeout(watchdog)
      delayed.release()
      await tick
    }
  })
  test('shutdown removes issued reports and fences later work', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:shutdown'))
    const pending = fixture.controller.inspect(fixture.enrollment.watcherId).pending!
    await fixture.controller.shutdown()
    const intervalId = fixture.store.journal(fixture.enrollment.watcherId).find((entry) => entry.kind === 'interval-open')?.intervalId
    expect(fixture.store.journal(fixture.enrollment.watcherId).filter((entry) => entry.kind === 'interval-close').at(-1)).toMatchObject({
      intervalId, reason: 'shutdown'
    })
    expect(await Bun.file(pending.reportPath).exists()).toBe(false)
    const appendCount = fixture.store.journal(fixture.enrollment.watcherId).length
    expect(await fixture.controller.ready(fixture.enrollment.watcherId, pending.reportKey)).toMatchObject({ kind: 'refused' })
    expect(fixture.store.journal(fixture.enrollment.watcherId)).toHaveLength(appendCount)
    expect(fixture.calls.creates).toHaveLength(1)
    expect(fixture.calls.sends).toHaveLength(0)
  })

  test('shutdown returns while an owner send is hung and late completion cannot mutate state', async () => {
    const fixture = makeFixture()
    await issue(fixture, deviation('check:hung-send'))
    fixture.setNow(10_000 + 900_000)
    const delayed = fixture.delayNextSend()
    const tick = fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    await delayed.entered
    // Integrates the real performance.now/setTimeout deadline; the host's logical clock stays frozen.
    const timeout = Promise.withResolvers<never>()
    const watchdog = setTimeout(() => timeout.reject(new Error('owner shutdown did not bound its in-flight send')), 2_250)
    try {
      await Promise.race([
        fixture.controller.shutdown(),
        timeout.promise
      ])
      const journal = structuredClone(fixture.store.journal(fixture.enrollment.watcherId))
      delayed.release()
      await tick
      expect(fixture.store.journal(fixture.enrollment.watcherId)).toEqual(journal)
      expect(await fixture.controller.ready(fixture.enrollment.watcherId, 'late-report')).toMatchObject({ kind: 'refused' })
    } finally {
      clearTimeout(watchdog)
      delayed.release()
      await tick
    }
  })

  test('a control fence defers an unstarted owner turn durably until dispatch is allowed', async () => {
    const fixture = makeFixture()
    fixture.setDispatchAllowed(false)
    await issue(fixture, deviation('check:control-fence'))
    expect(fixture.calls.creates).toHaveLength(0)
    expect(fixture.controller.inspect(fixture.enrollment.watcherId).pending?.phase).toBe('deferred')
    const restarted = fixture.restart()
    fixture.setDispatchAllowed(true)
    await restarted.step(fixture.enrollment, fixture.snapshot, [])
    expect(restarted.inspect(fixture.enrollment.watcherId).pending?.phase).toBe('waiting')
    expect(fixture.calls.creates).toHaveLength(1)
  })

  test('pause and disarm never call the owner or apply new proposals', async () => {
    const fixture = makeFixture()
    fixture.enrollment.paused = true
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [deviation('check:paused')])
    expect(fixture.calls.creates).toHaveLength(0)
    expect(fixture.calls.sends).toHaveLength(0)
    expect(fixture.applyCalls).toHaveLength(0)
    expect(fixture.wakeCalls).toHaveLength(0)
    fixture.enrollment.paused = false
    fixture.enrollment.enabled = false
    await fixture.controller.step(fixture.enrollment, fixture.snapshot, [])
    expect(fixture.calls.creates).toHaveLength(0)
    expect(fixture.applyCalls).toHaveLength(0)
  })
})
