import { describe, expect, test } from 'bun:test'
import type { PluginContext, PluginStore } from '@quirky/protocol'
import type { DispatchId, MessageId, MessageType, RunId } from '../src/contracts'
import type { OrchestrationCore } from '../src/core'
import { OrchestrationPointers } from '../src/pointers'
import type { OrchestrationMessages } from '../src/messaging'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

type Call = { method: string; params: Record<string, unknown> }
type Mailbox = { kind: 'run'; runId: RunId } | { kind: 'dispatch'; dispatchId: DispatchId }
type FixtureOptions = {
  blockMethod?: string
  blocked?: Deferred<unknown>
  identityKind?: 'terminal' | 'structured'
  eligibilityValue?: unknown
  startupRows?: { mailbox_kind: string; mailbox_id: string }[]
  pendingOperation?: Record<string, unknown> | null
}

const runMailbox: Mailbox = { kind: 'run', runId: 'run_test' }
const dispatchMailbox: Mailbox = { kind: 'dispatch', dispatchId: 'ctx_test' }

function pointerFixture(options: FixtureOptions = {}) {
  const calls: Call[] = []
  const seenCalls = new Map<string, Deferred<void>>()
  let closed = false
  let accessesAfterClose = 0
  let messageArrivalListener: ((arrival: never) => void) | null = null
  let mailboxAvailableListener: ((mailbox: never) => void) | null = null
  let eventListener: ((event: never) => void | Promise<void>) | null = null

  const touchStore = () => {
    if (!closed) return
    accessesAfterClose += 1
    throw new Error('orchestration store is closed')
  }
  const identity = {
    sessionId: 'session_test',
    live: true,
    runtimeEpoch: 'runtime_test',
    processIncarnation: 'incarnation_test',
    source: options.identityKind === 'structured' ? 'structured_lease' : 'terminal_launch',
    kind: options.identityKind ?? 'structured',
    providerId: null,
    worktreeId: 'worktree_test'
  }

  const context = {
    call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ method, params })
      seenCalls.get(method)?.resolve()
      if (method === options.blockMethod && options.blocked) return options.blocked.promise
      if (method === 'quirky.session/identity') return Promise.resolve(identity)
      if (method === 'quirky.session/get') return Promise.resolve(options.eligibilityValue ?? { status: 'running' })
      if (method === 'quirky.agent-status/explain') {
        return Promise.resolve(options.eligibilityValue ?? { state: 'idle', screen: {} })
      }
      if (method === 'quirky.session/pointer') {
        return Promise.resolve({
          operationId: params.operationId,
          result: { status: 'submitted', transport: 'structured_session' }
        })
      }
      return Promise.resolve(null)
    },
    subscribe(listener: (event: never) => void | Promise<void>) {
      eventListener = listener
      return () => {
        eventListener = null
      }
    },
    log() {}
  } as unknown as PluginContext

  const store = {
    get<T>(sql: string): T | null {
      touchStore()
      if (sql.includes('SELECT COUNT(*) AS count FROM pointer_operations')) return { count: 0 } as T
      if (sql.includes('SELECT * FROM pointer_operations')) return (options.pendingOperation ?? null) as T | null
      if (sql.includes('FROM runs')) return { coordinator_session_id: 'session_test' } as T
      if (sql.includes('FROM dispatches')) {
        return {
          run_id: 'run_test',
          status: 'dispatched',
          assignee_session_id: 'session_test',
          process_incarnation: 'incarnation_test',
          supervised: 0
        } as T
      }
      return null
    },
    all<T>(sql: string): T[] {
      touchStore()
      if (sql.includes('SELECT mailbox_kind, mailbox_id FROM (')) return (options.startupRows ?? []) as T[]
      return []
    },
    run() {
      touchStore()
      return { changes: 1, lastInsertRowid: 1 }
    },
    exec() {
      touchStore()
    },
    transaction<T>(work: () => T): T {
      touchStore()
      return work()
    }
  } as unknown as PluginStore

  const messages = {
    onArrival(listener: (arrival: never) => void | Promise<void>) {
      messageArrivalListener = listener
      return () => {
        messageArrivalListener = null
      }
    },
    onMailboxAvailable(listener: (mailbox: never) => void) {
      mailboxAvailableListener = listener
      return () => {
        mailboxAvailableListener = null
      }
    },
    reservedTypes() {
      return new Set<MessageType>()
    },
    pointerCandidates() {
      return [{ id: 'msg_test' as MessageId, type: 'status' as const }]
    }
  } as unknown as OrchestrationMessages

  const core = { workerForDispatch: () => null } as unknown as OrchestrationCore
  const pointers = new OrchestrationPointers(context, store, core, messages)
  return {
    pointers,
    calls,
    get accessesAfterClose() { return accessesAfterClose },
    watchCall(method: string): Promise<void> {
      if (calls.some((call) => call.method === method)) return Promise.resolve()
      let waiter = seenCalls.get(method)
      if (!waiter) {
        waiter = deferred<void>()
        seenCalls.set(method, waiter)
      }
      return waiter.promise
    },
    closeStore() {
      closed = true
    }
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

describe('orchestration pointer lifecycle', () => {
  test('dispose returns during unresolved identity, eligibility, and submission calls', async () => {
    const stages: { method: string; resolution(call: Call): unknown }[] = [
      { method: 'quirky.session/identity', resolution: () => ({
        sessionId: 'session_test', live: true, runtimeEpoch: 'runtime_test',
        processIncarnation: 'incarnation_test', source: 'structured_lease', kind: 'structured',
        providerId: null, worktreeId: 'worktree_test'
      }) },
      { method: 'quirky.session/get', resolution: () => ({ status: 'running' }) },
      { method: 'quirky.session/pointer', resolution: (call) => ({
        operationId: call.params.operationId,
        result: { status: 'submitted', transport: 'structured_session' }
      }) }
    ]

    for (const stage of stages) {
      for (const settlement of ['resolve', 'reject'] as const) {
        const blocked = deferred<unknown>()
        const fixture = pointerFixture({ blockMethod: stage.method, blocked })
        fixture.pointers.scheduleMailbox(runMailbox)
        await fixture.watchCall(stage.method)

        await fixture.pointers.dispose()
        const callsAtDispose = fixture.calls.length
        fixture.closeStore()
        const blockedCall = fixture.calls.find((call) => call.method === stage.method)!
        if (settlement === 'resolve') blocked.resolve(stage.resolution(blockedCall))
        else blocked.reject(new Error('late pointer dependency rejection'))
        await drainMicrotasks()

        expect(fixture.accessesAfterClose).toBe(0)
        expect(fixture.calls).toHaveLength(callsAtDispose)
      }
    }
  })

  test('startup recovery scan stops using the store after disposal during identity lookup', async () => {
    const blocked = deferred<unknown>()
    const fixture = pointerFixture({
      blockMethod: 'quirky.session/identity',
      blocked,
      startupRows: [{ mailbox_kind: 'run', mailbox_id: runMailbox.runId }]
    })
    const scan = (fixture.pointers as unknown as { scanStartup(): Promise<void> }).scanStartup()
    await fixture.watchCall('quirky.session/identity')

    await fixture.pointers.dispose()
    fixture.closeStore()
    blocked.resolve({
      sessionId: 'session_test', live: true, runtimeEpoch: 'runtime_test',
      processIncarnation: 'incarnation_test', source: 'structured_lease', kind: 'structured',
      providerId: null, worktreeId: 'worktree_test'
    })
    await scan

    expect(fixture.accessesAfterClose).toBe(0)
    expect(fixture.calls.map((call) => call.method)).toEqual(['quirky.session/identity'])
  })


  test('reset fences stale message work but tasks reset preserves unrelated Run work', async () => {
    const staleIdentity = deferred<unknown>()
    const stale = pointerFixture({ blockMethod: 'quirky.session/identity', blocked: staleIdentity })
    stale.pointers.scheduleMailbox(runMailbox)
    await stale.watchCall('quirky.session/identity')
    stale.pointers.reset('messages')
    stale.closeStore()
    const accessesBeforeLateIdentity = stale.calls.length
    staleIdentity.resolve({
      sessionId: 'session_test', live: true, runtimeEpoch: 'runtime_test',
      processIncarnation: 'incarnation_test', source: 'structured_lease', kind: 'structured',
      providerId: null, worktreeId: 'worktree_test'
    })
    await drainMicrotasks()
    expect(stale.calls).toHaveLength(accessesBeforeLateIdentity)
    expect(stale.accessesAfterClose).toBe(0)
    await stale.pointers.dispose()

    const runEligibility = deferred<unknown>()
    const preserved = pointerFixture({ blockMethod: 'quirky.session/get', blocked: runEligibility })
    preserved.pointers.scheduleMailbox(runMailbox)
    await preserved.watchCall('quirky.session/get')
    preserved.pointers.reset('tasks')
    runEligibility.resolve({ status: 'running' })
    await preserved.watchCall('quirky.session/pointer')
    expect(preserved.calls.map((call) => call.method)).toContain('quirky.session/pointer')
    await preserved.pointers.dispose()

    const dispatchIdentity = deferred<unknown>()
    const dispatch = pointerFixture({ blockMethod: 'quirky.session/identity', blocked: dispatchIdentity })
    dispatch.pointers.scheduleMailbox(dispatchMailbox)
    await dispatch.watchCall('quirky.session/identity')
    dispatch.pointers.reset('tasks')
    dispatchIdentity.resolve({
      sessionId: 'session_test', live: true, runtimeEpoch: 'runtime_test',
      processIncarnation: 'incarnation_test', source: 'structured_lease', kind: 'structured',
      providerId: null, worktreeId: 'worktree_test'
    })
    await drainMicrotasks()
    expect(dispatch.calls.map((call) => call.method)).toEqual(['quirky.session/identity'])
    await dispatch.pointers.dispose()
  })

  test('message reset fences a late pointer result from settlement and delivery updates', async () => {
    const blockedPointer = deferred<unknown>()
    const fixture = pointerFixture({ blockMethod: 'quirky.session/pointer', blocked: blockedPointer })
    fixture.pointers.scheduleMailbox(runMailbox)
    await fixture.watchCall('quirky.session/pointer')
    const pointerCall = fixture.calls.find((call) => call.method === 'quirky.session/pointer')!
    fixture.pointers.reset('messages')
    const callsAtReset = fixture.calls.length
    fixture.closeStore()
    blockedPointer.resolve({
      operationId: pointerCall.params.operationId,
      result: { status: 'submitted', transport: 'structured_session' }
    })
    await drainMicrotasks()

    expect(fixture.calls).toHaveLength(callsAtReset)
    expect(fixture.accessesAfterClose).toBe(0)
    await fixture.pointers.dispose()
  })


  test('same-mailbox submissions remain single-flight and recovery reuses the durable operation ID', async () => {
    const blockedPointer = deferred<unknown>()
    const flight = pointerFixture({ blockMethod: 'quirky.session/pointer', blocked: blockedPointer })
    flight.pointers.scheduleMailbox(runMailbox)
    await flight.watchCall('quirky.session/pointer')
    flight.pointers.scheduleMailbox(runMailbox)
    await drainMicrotasks()
    expect(flight.calls.filter((call) => call.method === 'quirky.session/pointer')).toHaveLength(1)
    await flight.pointers.dispose()
    flight.closeStore()
    blockedPointer.reject(new Error('late pointer rejection'))
    await drainMicrotasks()
    expect(flight.accessesAfterClose).toBe(0)

    const sharedSession = deferred<unknown>()
    const shared = pointerFixture({ blockMethod: 'quirky.session/pointer', blocked: sharedSession })
    shared.pointers.scheduleMailbox(runMailbox)
    shared.pointers.scheduleMailbox(dispatchMailbox)
    await shared.watchCall('quirky.session/pointer')
    await drainMicrotasks()
    expect(shared.calls.filter((call) => call.method === 'quirky.session/pointer')).toHaveLength(1)
    await shared.pointers.dispose()
    shared.closeStore()
    sharedSession.reject(new Error('late shared-session pointer rejection'))
    await drainMicrotasks()
    expect(shared.accessesAfterClose).toBe(0)

    const pendingOperation = {
      mailbox_kind: 'run', mailbox_id: runMailbox.runId, session_id: 'session_test',
      expected_incarnation: 'incarnation_test', operation_id: 'operation_recover',
      batch_fingerprint: 'fingerprint', message_ids_json: JSON.stringify(['msg_test']),
      phase: 'write_attempted', result_json: null, created_at: 'now', updated_at: 'now'
    }
    const recovered = pointerFixture({ pendingOperation })
    recovered.pointers.scheduleMailbox(runMailbox)
    await recovered.watchCall('quirky.session/pointer')
    expect(recovered.calls.filter((call) => call.method === 'quirky.session/pointer')[0]?.params.operationId)
      .toBe('operation_recover')
    expect(recovered.calls.some((call) => call.method === 'quirky.session/identity')).toBe(false)
    await recovered.pointers.dispose()
  })
})
