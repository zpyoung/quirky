import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PluginContext, Schema } from '@quirky/protocol'
import type { AuthorizedEnrollment, Enrollment, EnrollmentInput, KernelOptions, KernelStore, KindRegistry, OrchestrationPort, WatcherKind } from '../src/contracts'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createEnrollmentService } from '../src/enrollment'
import { createKindRegistry } from '../src/registry'
import { createKernelStore } from '../src/store'

const tempHomes: string[] = []
const openedHandles: Array<() => void> = []

afterEach(() => {
  for (const close of openedHandles.splice(0).reverse()) close()
  for (const path of tempHomes.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

type ContextFixture = { context: PluginContext; home: string; dataDir: string; opens: () => number; close: () => void }

function makeContext(options: {
  call?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
} = {}): ContextFixture {
  const home = mkdtempSync(join(tmpdir(), 'heimdall-store-test-'))
  tempHomes.push(home)
  const dataDir = join(home, 'plugin-data', 'quirky.heimdall')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  let openCount = 0
  const context = {
    pluginId: 'quirky.heimdall',
    dir: home,
    dataDir,
    home,
    log() {},
    provide() {},
    emit() { return false },
    subscribe() { return () => {} },
    call: options.call ?? (async () => { throw new Error('unexpected context.call') }),
    openStore(migrations: Parameters<PluginContext['openStore']>[0]) {
      openCount++
      const opened = openPluginStore({ home, pluginId: 'quirky.heimdall', migrations, isActive: () => true })
      openedHandles.push(opened.close)
      return opened.store
    },
    getSetting() { return undefined },
    storedSettingValue() { return undefined },
    error(_kind: never, message: string) { return new Error(message) },
    pty: {},
    notify() {},
    launch: {}
  } as unknown as PluginContext
  return {
    context,
    home,
    dataDir,
    opens: () => openCount,
    close() {
      const close = openedHandles.pop()
      close?.()
    }
  }
}

function makeEnrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  const watcherId = overrides.watcherId ?? 'watcher-1'
  return {
    watcherId,
    kind: 'demo',
    workspaceKey: 'local::/workspace/demo',
    workspacePath: '/workspace/demo',
    executionHostId: 'local',
    schedulerOwner: 'daemon',
    kindPayload: { name: 'demo' },
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    coordinator: { handle: 'coordinator-1', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 10,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    ...overrides
  }
}

function kindFor(
  authorize: WatcherKind['authorizeEnrollment'],
  options: { undo?: WatcherKind['undoAuthorization']; schema?: Schema; validate?: WatcherKind['validateEnrollment'] } = {}
): WatcherKind {
  return {
    id: 'demo',
    displayName: 'Demo',
    enrollmentPayloadSchema: options.schema ?? {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    },
    authorizeEnrollment: authorize,
    undoAuthorization: options.undo,
    validateEnrollment: options.validate,
    async read() { return { freshness: 'live', contentIdentity: 'identity', observedAtMs: 10, world: {} } },
    decide() { return { action: null, reason: 'idle' } },
    async execute() { return { effect: 'landed' } }
  }
}

function createService(
  context: PluginContext,
  store: KernelStore,
  registry: KindRegistry,
  onEnrolled: (enrollment: Enrollment) => void = () => {},
  extra: Partial<KernelOptions> = {}
) {
  return createEnrollmentService({
    context,
    store,
    registry,
    orchestration: {} as OrchestrationPort,
    now: () => 100,
    ...extra
  }, onEnrolled)
}

const authority = (workspacePath = '/workspace/demo', kindPayload: unknown = { name: 'demo' }): AuthorizedEnrollment => ({
  workspaceKey: 'untrusted::caller-key',
  workspacePath,
  executionHostId: 'local',
  schedulerOwner: 'daemon',
  kindPayload: kindPayload as AuthorizedEnrollment['kindPayload'],
  undo: { resourceId: 'new-resource' }
})

const input: EnrollmentInput = { kind: 'demo', kindPayload: { name: 'demo' } }

describe('Heimdall persistence and enrollment', () => {
  test('uses the private public-plugin store and restores enrollments across reopen', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const enrollment = makeEnrollment()
    store.save(enrollment)

    expect(store.readOnly).toBe(false)
    expect(store.get(enrollment.watcherId)).toEqual(enrollment)
    expect(store.live(enrollment.workspaceKey)).toEqual(enrollment)
    expect(statSync(fixture.dataDir).mode & 0o777).toBe(0o700)
    fixture.close()
    const reopened = createKernelStore(fixture.context)
    expect(reopened.get(enrollment.watcherId)).toEqual(enrollment)
    expect(reopened.readOnly).toBe(false)
  })

  test('append IDs are idempotent, reject mismatches, and survive retention without sequence reuse', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const enrollment = makeEnrollment()
    store.save(enrollment)
    const fact = {
      eventId: 'fact-1', atMs: 10, class: 'fact' as const, origin: 'owner' as const,
      kind: 'evidence', resolved: true, evidenceKind: 'test-fact', payload: { value: 1 }
    }
    const first = store.append(enrollment.watcherId, fact)
    expect(store.append(enrollment.watcherId, fact)).toEqual(first)
    expect(() => store.append(enrollment.watcherId, { ...fact, payload: { value: 2 } })).toThrow()

    for (let index = 0; index < 55; index++) {
      store.append(enrollment.watcherId, {
        eventId: `fact-${index + 2}`, atMs: 20 + index, class: 'fact', origin: 'owner',
        kind: 'evidence', resolved: true, evidenceKind: 'keep', payload: { index }
      })
    }
    for (let index = 0; index < 57; index++) {
      store.append(enrollment.watcherId, {
        eventId: `observation-${index}`, atMs: 100 + index, class: 'observation', origin: 'owner',
        kind: 'attempt-abandoned', resolved: index !== 56, reason: 'gate-hold', fingerprint: `fingerprint-${index}`
      })
    }
    for (let index = 0; index < 53; index++) {
      const seq = store.nextTraceSeq(enrollment.watcherId)
      store.trace(enrollment.watcherId, {
        seq,
        watcherId: enrollment.watcherId,
        startedAtMs: 200 + index,
        durationMs: 1,
        exitPath: 'watching',
        pinned: index < 2,
        fullResyncDue: false,
        snapshotReadCount: 0,
        declined: []
      })
    }
    store.retain(enrollment.watcherId)

    const journal = store.journal(enrollment.watcherId)
    expect(journal.filter((entry) => entry.class === 'fact')).toHaveLength(56)
    expect(journal.filter((entry) => entry.class === 'observation' && entry.resolved)).toHaveLength(50)
    expect(journal.filter((entry) => entry.class === 'observation' && !entry.resolved)).toHaveLength(1)
    expect(store.traces(enrollment.watcherId)).toHaveLength(52)
    const lastSeq = Math.max(...journal.map((entry) => entry.seq))
    const next = store.append(enrollment.watcherId, {
      eventId: 'post-retention', atMs: 999, class: 'fact', origin: 'owner', kind: 'evidence', resolved: true,
      evidenceKind: 'after-retention', payload: null
    })
    expect(next.seq).toBeGreaterThan(lastSeq)
  })

  test('enforces one resolution per attempt and one terminal event per watcher', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const enrollment = makeEnrollment()
    store.save(enrollment)
    store.append(enrollment.watcherId, {
      eventId: 'attempt-write-ahead', atMs: 10, class: 'fact', origin: 'owner', kind: 'attempt', resolved: false,
      attemptId: 'attempt-1', fingerprint: 'fingerprint-1', action: { kind: 'write' }, state: 'settled', effect: 'indeterminate'
    })
    const resolution = {
      atMs: 20, class: 'fact' as const, origin: 'owner' as const, kind: 'attempt-resolved', resolved: true,
      attemptId: 'attempt-1', effect: 'landed'
    }
    store.append(enrollment.watcherId, { ...resolution, eventId: 'resolution-1' })
    expect(() => store.append(enrollment.watcherId, { ...resolution, eventId: 'resolution-2' })).toThrow()

    const terminal = {
      atMs: 30, class: 'fact' as const, origin: 'owner' as const, kind: 'terminal', resolved: true,
      state: 'complete', reason: 'done'
    }
    store.append(enrollment.watcherId, { ...terminal, eventId: 'terminal-1' })
    expect(() => store.append(enrollment.watcherId, { ...terminal, eventId: 'terminal-2' })).toThrow()
  })

  test('terminal compaction keeps terminal summary and unresolved attempts and pinned observations only', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const enrollment = makeEnrollment()
    store.save(enrollment)
    store.append(enrollment.watcherId, {
      eventId: 'fact', atMs: 1, class: 'fact', origin: 'owner', kind: 'evidence', resolved: true,
      evidenceKind: 'ordinary', payload: { keep: false }
    })
    store.append(enrollment.watcherId, {
      eventId: 'attempt', atMs: 2, class: 'fact', origin: 'owner', kind: 'attempt', resolved: false,
      attemptId: 'pending', fingerprint: 'fingerprint', action: { kind: 'write' }, state: 'running'
    })
    store.append(enrollment.watcherId, {
      eventId: 'unresolved-observation', atMs: 3, class: 'observation', origin: 'owner', kind: 'attempt-abandoned',
      resolved: false, attemptId: 'pending', reason: 'uncertain'
    })
    const summary = {
      watcherId: enrollment.watcherId,
      kind: enrollment.kind,
      state: 'complete',
      reason: 'finished',
      atMs: 4,
      budget: { activeMs: 10, turns: 1, exhausted: null }
    }
    store.terminal({ ...enrollment, enabled: false, terminalAtMs: 4 }, summary)

    const journal = store.journal(enrollment.watcherId)
    expect(journal.map((entry) => entry.kind)).toContain('terminal')
    expect(journal.some((entry) => entry.eventId === 'attempt')).toBe(true)
    expect(journal.some((entry) => entry.eventId === 'unresolved-observation')).toBe(true)
    expect(journal.some((entry) => entry.eventId === 'fact')).toBe(false)
    expect(store.summary(enrollment.watcherId)).toEqual(summary)
    expect(store.get(enrollment.watcherId)?.terminalAtMs).toBe(4)
  })

  test('future schema is inspected read-only without invoking openStore or altering the database', () => {
    const fixture = makeContext()
    const initial = createKernelStore(fixture.context)
    const enrollment = makeEnrollment()
    initial.save(enrollment)
    initial.close()
    fixture.close()
    const path = join(fixture.dataDir, 'store.db')
    const writable = new Database(path)
    const beforeVersion = (writable.query('PRAGMA user_version').get() as { user_version: number }).user_version
    writable.exec(`PRAGMA user_version = ${beforeVersion + 1}`)
    writable.close()
    const before = readFileSync(path)

    const future = createKernelStore(fixture.context)
    expect(future.readOnly).toBe(true)
    expect(future.get(enrollment.watcherId)).toEqual(enrollment)
    expect(fixture.opens()).toBe(1)
    future.close()

    expect(readFileSync(path)).toEqual(before)
  })
})

describe('Heimdall kind registry and enrollment', () => {
  test('a kind identity cannot be claimed by a second plugin or redirected to foreign hooks', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    const descriptor = {
      id: 'example-task', displayName: 'Example task',
      enrollmentPayloadSchema: { type: 'object', additionalProperties: true } as Schema,
      hooks: { authorize: 'example.kind/authorize', read: 'example.kind/read', decide: 'example.kind/decide', execute: 'example.kind/execute' }
    }
    registry.registerDescriptor(descriptor, 'example.kind')
    expect(() => registry.registerDescriptor({
      ...descriptor,
      hooks: { authorize: 'other.kind/authorize', read: 'other.kind/read', decide: 'other.kind/decide', execute: 'other.kind/execute' }
    }, 'other.kind')).toThrow()
    expect(() => registry.registerDescriptor({ ...descriptor, hooks: { ...descriptor.hooks, read: 'other.kind/read' } }, 'example.kind')).toThrow()
    expect(store.registrations().map((registration) => ({ id: registration.id, pluginId: registration.pluginId }))).toEqual([
      { id: 'example-task', pluginId: 'example.kind' }
    ])
  })

  test('authorized payload validation and failed persistence undo authorization resources exactly once', async () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    let undoCount = 0
    let invalidPayload = true
    registry.register(kindFor(async () => authority('/workspace/demo', invalidPayload ? { name: 7 } : { name: 'demo' }), {
      undo: async () => { undoCount++ }
    }))
    const service = createService(fixture.context, store, registry)
    const invalid = await service.enroll(input)
    expect(invalid).toMatchObject({ kind: 'refused', reason: 'invalid-payload' })
    expect(undoCount).toBe(1)

    invalidPayload = false
    const database = new Database(join(fixture.dataDir, 'store.db'))
    database.exec("CREATE TRIGGER fail_enrollment BEFORE INSERT ON enrollments BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    database.close()
    const persistence = await service.enroll(input)
    expect(persistence).toMatchObject({ kind: 'refused', reason: 'owner-not-executable' })
    expect(undoCount).toBe(2)
  })

  test('serializes concurrent enrollments and commits one live enrollment before notifying', async () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    let authorized = 0
    let undone = 0
    registry.register(kindFor(async () => {
      authorized++
      await Promise.resolve()
      return authority()
    }, { undo: async () => { undone++ } }))
    const notifications: Enrollment[] = []
    const service = createService(fixture.context, store, registry, (enrollment) => {
      expect(store.get(enrollment.watcherId)).toEqual(enrollment)
      notifications.push(enrollment)
    })
    const outcomes = await Promise.all([service.enroll(input), service.enroll(input)])

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['enrolled', 'refused'])
    expect(outcomes.find((outcome) => outcome.kind === 'refused')).toMatchObject({ reason: 'duplicate-workspace' })
    expect(store.list().filter((enrollment) => enrollment.terminalAtMs === null)).toHaveLength(1)
    expect(notifications).toHaveLength(1)
    expect(authorized).toBe(2)
    expect(undone).toBe(1)
  })

  test('re-arms disabled same-kind enrollment with spent budget and preserves its identity', async () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    registry.register(kindFor(async (_request) => authority()))
    const service = createService(fixture.context, store, registry)
    const first = await service.enroll({
      ...input,
      budget: { wallClockActiveMs: 100, turns: 10 }
    })
    expect(first.kind).toBe('enrolled')
    if (first.kind !== 'enrolled') return
    const existing = first.enrollment
    store.append(existing.watcherId, {
      eventId: 'interval-open', atMs: 100, class: 'fact', origin: 'owner', kind: 'interval-open', resolved: true,
      intervalId: 'interval-1', cause: 'worker-dispatched', generation: `initial:${existing.watcherId}`
    })
    store.append(existing.watcherId, {
      eventId: 'interval-close', atMs: 110, class: 'fact', origin: 'owner', kind: 'interval-close', resolved: true,
      intervalId: 'interval-1', reason: 'settled'
    })
    store.append(existing.watcherId, {
      eventId: 'turn-1', atMs: 111, class: 'fact', origin: 'owner', kind: 'turn', resolved: true,
      dispatchId: 'dispatch-1', generation: `initial:${existing.watcherId}`
    })
    store.append(existing.watcherId, {
      eventId: 'park-open', atMs: 112, class: 'fact', origin: 'owner', kind: 'escalation', resolved: false,
      escalationId: `park:${existing.watcherId}`, escalationKind: 'park', status: 'open', foldCount: 1
    })
    store.save({ ...existing, enabled: false, parkReason: 'budget' })
    const rearmed = await service.enroll({
      ...input,
      budget: { wallClockActiveMs: 20, turns: 2 }
    })
    expect(rearmed.kind).toBe('re-armed')
    if (rearmed.kind !== 're-armed') return
    expect(rearmed.enrollment.watcherId).toBe(existing.watcherId)
    expect(rearmed.enrollment.coordinator).toEqual(existing.coordinator)
    expect(rearmed.enrollment.budget).toEqual({ wallClockActiveMs: 30, turns: 3 })
    expect(rearmed.enrollment.enabled).toBe(true)
    expect(rearmed.enrollment.paused).toBe(false)
    expect(rearmed.enrollment.parkReason).toBeNull()
    expect(store.journal(existing.watcherId).some((entry) => entry.kind === 'escalation' && entry.status === 'acknowledged')).toBe(true)
  })

  test('explicit-disarm re-arm starts a new budget generation and terminal workspaces are reusable', async () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    registry.register(kindFor(async () => authority()))
    const service = createService(fixture.context, store, registry)
    const first = await service.enroll({ ...input, budget: { wallClockActiveMs: 100, turns: 10 } })
    expect(first.kind).toBe('enrolled')
    if (first.kind !== 'enrolled') return
    const existing = first.enrollment
    store.append(existing.watcherId, {
      eventId: 'spent-turn', atMs: 20, class: 'fact', origin: 'owner', kind: 'turn', resolved: true,
      dispatchId: 'dispatch-old', generation: `initial:${existing.watcherId}`
    })
    store.save({ ...existing, enabled: false, haltReason: 'operator-disarmed' })
    const rearmed = await service.enroll({ ...input, budget: { wallClockActiveMs: 20, turns: 2 } })
    expect(rearmed.kind).toBe('re-armed')
    if (rearmed.kind !== 're-armed') return
    expect(rearmed.enrollment.budget).toEqual({ wallClockActiveMs: 20, turns: 2 })
    expect(store.journal(existing.watcherId).filter((entry) => entry.evidenceKind === 'budget-generation')).toHaveLength(2)

    const terminal = { ...rearmed.enrollment, terminalAtMs: 200, enabled: false }
    store.save(terminal)
    const next = await service.enroll(input)
    expect(next.kind).toBe('enrolled')
    if (next.kind === 'enrolled') expect(next.enrollment.watcherId).not.toBe(existing.watcherId)
  })

  test('invalid persisted JSON and schema-incompatible kinds remain inspectable and dormant', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const enrollment = makeEnrollment()
    store.save(enrollment)
    const db = new Database(join(fixture.dataDir, 'store.db'))
    db.query('UPDATE enrollments SET kind_payload_json = ? WHERE watcher_id = ?').run('{', enrollment.watcherId)
    db.close()
    const damaged = store.get(enrollment.watcherId)
    expect(damaged).toMatchObject({ enabled: false, haltReason: 'invalid-kind-payload' })
    expect(store.registrations()).toHaveLength(0)
  })
})

describe('Heimdall storage lifecycle boundaries', () => {
  test('removal deletes only the target watcher history and remains deleted after reopen', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const target = makeEnrollment()
    const survivor = makeEnrollment({ watcherId: 'watcher-2', workspaceKey: 'local::/workspace/other', workspacePath: '/workspace/other' })
    store.save(target)
    store.save(survivor)
    store.append(target.watcherId, { kind:'evidence',class:'fact',origin:'owner',resolved:true,evidenceKind:'target',payload:{ value:1 } })
    store.append(survivor.watcherId, { kind:'evidence',class:'fact',origin:'owner',resolved:true,evidenceKind:'survivor',payload:{ value:2 } })
    store.trace(target.watcherId, {
      watcherId:target.watcherId,seq:store.nextTraceSeq(target.watcherId),startedAtMs:1,durationMs:0,
      exitPath:'watching',pinned:false,fullResyncDue:false,snapshotReadCount:1,declined:[]
    })
    store.remove!(target.watcherId)
    expect(store.get(target.watcherId)).toBeNull()
    expect(store.journal(target.watcherId)).toEqual([])
    expect(store.traces(target.watcherId)).toEqual([])
    expect(store.summary(target.watcherId)).toBeNull()
    expect(store.journal(survivor.watcherId).map((entry) => entry.payload)).toEqual([{ value:2 }])
    fixture.close()
    const reopened = createKernelStore(fixture.context)
    expect(reopened.get(target.watcherId)).toBeNull()
    expect(reopened.get(survivor.watcherId)).toEqual(survivor)
  })

  test('root owner configuration survives a kind authorizer that returns only workspace authority', async () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    registry.register(kindFor(async () => authority()))
    const service = createService(fixture.context, store, registry)
    const created = await service.enroll({
      ...input,owner:{ agent:'claude',model:'selected-model',effort:'high' },ownerInterventionCapability:'gated'
    })
    expect(created.kind).toBe('enrolled')
    if (created.kind === 'refused') throw new Error(created.detail)
    expect(store.get(created.enrollment.watcherId)?.owner).toEqual({ agent:'claude',model:'selected-model',effort:'high' })
    expect(store.get(created.enrollment.watcherId)?.ownerInterventionCapability).toBe('gated')
    store.save({ ...created.enrollment,enabled:false,haltReason:'operator-disarmed' })
    const cleared = await service.enroll({ ...input,owner:null })
    expect(cleared.kind).toBe('re-armed')
    if (cleared.kind === 'refused') throw new Error(cleared.detail)
    fixture.close()
    expect(createKernelStore(fixture.context).get(created.enrollment.watcherId)?.owner).toBeNull()
  })

  test('unknown and foreign-authority enrollments never persist and undo only completed authorization', async () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const registry = createKindRegistry(fixture.context, store)
    let authorizations = 0
    let undos = 0
    registry.register(kindFor(async () => {
      authorizations++
      return { ...authority(),executionHostId:'foreign-host' }
    }, { undo:async () => { undos++ } }))
    const service = createService(fixture.context, store, registry)
    expect(await service.enroll({ ...input,kind:'missing-kind' })).toMatchObject({ kind:'refused',reason:'unknown-kind' })
    expect(authorizations).toBe(0)
    expect(await service.enroll(input)).toMatchObject({ kind:'refused',reason:'owner-not-executable' })
    expect(undos).toBe(1)
    expect(store.list()).toEqual([])
  })

  test('terminal compaction does not retain an attempt whose uncertainty has positive resolution', () => {
    const fixture = makeContext()
    const store = createKernelStore(fixture.context)
    const current = makeEnrollment()
    store.save(current)
    store.append(current.watcherId, {
      kind:'attempt',class:'fact',origin:'owner',resolved:false,attemptId:'resolved-attempt',
      fingerprint:'resolved-fingerprint',action:{ kind:'publish' },state:'settled',effect:'indeterminate'
    })
    store.append(current.watcherId, {
      kind:'attempt-resolved',class:'fact',origin:'owner',resolved:true,attemptId:'resolved-attempt',effect:'landed'
    })
    store.terminal({ ...current,enabled:false,terminalAtMs:20 }, {
      watcherId:current.watcherId,kind:current.kind,state:'complete',reason:'confirmed',
      atMs:20,budget:{ activeMs:0,turns:0,exhausted:null }
    })
    expect(store.journal(current.watcherId).map((entry) => entry.kind)).toEqual(['terminal'])
  })
})
