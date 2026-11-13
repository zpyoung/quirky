import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { OrchestrationSubmission, PluginContext, PluginStore } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import type { MessageRow, RuntimeCallerEvidence } from '../src/contracts'
import type { OrchestrationCore } from '../src/core'
import type { FederationMessagingHooks, OrchestrationMessages } from '../src/messaging'
import {
  createFederationMail,
  type FederationMailComponent,
} from '../src/federation/mail'
import {
  FederationMailStore,
  federationMailMigrations,
} from '../src/federation/mail-store'
import type {
  FederationBinding,
  FederationEngine,
  FederationPeerPrincipal,
  FederationRelayItem,
} from '../src/federation/contracts'

const BINDING_ID = 'binding-a'
const HOME_RUN_ID = 'home-run-a'
const HOME_TASK_ID = 'home-task-a'
const HOME_DISPATCH_ID = 'home-dispatch-a'
const HOST_RUN_ID = 'host-run-a'
const HOST_TASK_ID = 'host-task-a'
const HOST_DISPATCH_ID = 'host-dispatch-a'
const SESSION_ID = 'worker-session-a'
const RUNTIME_EPOCH = 'runtime-epoch-a'
const PROCESS_INCARNATION = 'process-incarnation-a'
const PEER_ID = 'peer-a'
const PEER_FINGERPRINT = 'fingerprint-a'
const PEER_INCARNATION = 'peer-incarnation-a'
const ACCEPTED = { kind: 'accepted' }
const HEARTBEAT_ACCEPTED = { status: 'accepted', lastHeartbeatAt: '2026-01-01T00:00:00.000Z' }
const PULL_METHOD = 'quirky.orchestration/federationPull'
const ACK_METHOD = 'quirky.orchestration/federationAck'
const IMPORT_METHOD = 'quirky.orchestration/federationImport'

type RemoteCall = { method: string; params: Record<string, unknown> }
type OpenedPluginStore = { store: PluginStore; close(): void }
type ImportFederatedItem = (binding: FederationBinding, item: FederationRelayItem) => {
  message: MessageRow
  questionId: string | null
}
type Respond = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>

type HarnessOptions = {
  side?: 'home' | 'host'
  seedDispatch?: boolean
  respond?: Respond
  importFederatedItem?: ImportFederatedItem
  onCommitted?: () => void
}

type Harness = {
  mail: FederationMailComponent
  store: FederationMailStore
  binding: FederationBinding
  principal: FederationPeerPrincipal
  calls: RemoteCall[]
  hooks(): FederationMessagingHooks | null
  settleStartup(): Promise<void>
  setAssertBinding(handler: () => Promise<void>): void
  setGetDispatchHook(handler: () => void): void
  onCleanup(handler: () => void): void
}

const bindingFor = (side: 'home' | 'host'): FederationBinding => ({
  id: BINDING_ID,
  side,
  homeRunId: HOME_RUN_ID as FederationBinding['homeRunId'],
  homeTaskId: HOME_TASK_ID as FederationBinding['homeTaskId'],
  homeDispatchId: HOME_DISPATCH_ID as FederationBinding['homeDispatchId'],
  hostRunId: HOST_RUN_ID as FederationBinding['hostRunId'],
  hostTaskId: HOST_TASK_ID as FederationBinding['hostTaskId'],
  hostDispatchId: HOST_DISPATCH_ID as FederationBinding['hostDispatchId'],
  peer: {
    id: PEER_ID,
    label: 'Peer A',
    endpoint: 'http://peer-a.test',
    fingerprint: PEER_FINGERPRINT,
    pairingRevision: 1,
  },
  peerIncarnation: PEER_INCARNATION,
  sessionId: SESSION_ID,
  processIncarnation: PROCESS_INCARNATION,
  processRuntimeEpoch: RUNTIME_EPOCH,
  state: 'active',
})

const submissionForHost = (): OrchestrationSubmission => ({
  runId: HOST_RUN_ID,
  taskId: HOST_TASK_ID,
  dispatchId: HOST_DISPATCH_ID,
  type: 'worker_done',
  subject: 'Worker completed',
  body: 'The task completed successfully.',
  payload: {
    taskId: HOST_TASK_ID,
    dispatchId: HOST_DISPATCH_ID,
    outcome: 'succeeded',
  },
})

function defaultResponse(method: string, params: Record<string, unknown>): unknown {
  if (method === PULL_METHOD) return { items: [], through: params.after }
  if (method === ACK_METHOD) return { through: params.through }
  if (method === IMPORT_METHOD) {
    const items = params.items as FederationRelayItem[]
    return {
      through: items.at(-1)?.sequence ?? 0,
      results: items.map((item) => ({
        sequence: item.sequence,
        id: item.id,
        result: item.payload.type === 'heartbeat' ? HEARTBEAT_ACCEPTED : ACCEPTED,
        duplicate: false,
      })),
    }
  }
  throw new Error(`Unexpected federation method ${method}`)
}

async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-federation-mail-sync-'))
  let handle: OpenedPluginStore | null = null
  let mail: FederationMailComponent | null = null
  const cleanupHandlers: Array<() => void> = []
  try {
    handle = openPluginStore({
      home: root,
      pluginId: 'quirky.orchestration',
      migrations: federationMailMigrations,
      isActive: () => true,
    })
    handle.store.run(`
      CREATE TABLE dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        assignee_session_id TEXT,
        runtime_epoch TEXT,
        process_incarnation TEXT
      )
    `)
    handle.store.run(`
      CREATE TABLE worker_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      )
    `)
    if (options.seedDispatch) {
      handle.store.run(
        `INSERT INTO dispatches (id, run_id, task_id, status, assignee_session_id, runtime_epoch, process_incarnation)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        HOST_DISPATCH_ID,
        HOST_RUN_ID,
        HOST_TASK_ID,
        'dispatched',
        SESSION_ID,
        RUNTIME_EPOCH,
        PROCESS_INCARNATION,
      )
      handle.store.run(
        `INSERT INTO worker_dispatches (dispatch_id, record_json) VALUES (?, ?)`,
        HOST_DISPATCH_ID,
        JSON.stringify({
          state: 'running',
          sessionId: SESSION_ID,
          processIncarnation: PROCESS_INCARNATION,
          processRuntimeEpoch: RUNTIME_EPOCH,
        }),
      )
    }

    const binding = bindingFor(options.side ?? 'host')
    const principal: FederationPeerPrincipal = {
      peerId: binding.peer.id,
      fingerprint: binding.peer.fingerprint,
      pairingRevision: binding.peer.pairingRevision,
      incarnation: binding.peerIncarnation,
    }
    const calls: RemoteCall[] = []
    let assertBinding = async (): Promise<void> => {}
    let getDispatchHook: (() => void) | null = null
    let boundHooks: FederationMessagingHooks | null = null
    const messages = {
      bindFederation(hooks: FederationMessagingHooks) { boundHooks = hooks },
      unbindFederation() { boundHooks = null },
      importFederatedItem(bindingValue: FederationBinding, item: FederationRelayItem) {
        if (!options.importFederatedItem) throw new Error('Unexpected local federation import')
        return options.importFederatedItem(bindingValue, item)
      },
      onCommitted() { options.onCommitted?.() },
    }
    const core = {
      store: handle.store,
      getDispatch() {
        getDispatchHook?.()
        return { createdAt: '2026-01-01T00:00:00.000Z' }
      },
    }
    const engine = {
      home(dispatchId: string) {
        return binding.side === 'home' && dispatchId === binding.homeDispatchId ? binding : null
      },
      host(dispatchId: string) {
        return binding.side === 'host' && dispatchId === binding.hostDispatchId ? binding : null
      },
      reportAuthority() { return {} },
      bindings(side?: 'home' | 'host') {
        return side === undefined || side === binding.side ? [binding] : []
      },
      assertBinding() { return assertBinding() },
      async remote(_binding: FederationBinding, method: string, params: Record<string, unknown>) {
        calls.push({ method, params })
        const result = await (options.respond ?? defaultResponse)(method, params)
        return {
          peer: binding.peer,
          status: {
            fingerprint: binding.peer.fingerprint,
            incarnation: binding.peerIncarnation,
            capabilities: [],
          },
          result,
        }
      },
    }
    mail = createFederationMail(
      { log() {} } as PluginContext,
      core as unknown as OrchestrationCore,
      messages as unknown as OrchestrationMessages,
      engine as unknown as FederationEngine,
    )
    await run({
      mail,
      store: new FederationMailStore(handle.store),
      binding,
      principal,
      calls,
      hooks: () => boundHooks,
      settleStartup: () => mail!.sync(binding),
      setAssertBinding(handler) { assertBinding = handler },
      setGetDispatchHook(handler) { getDispatchHook = handler },
      onCleanup(handler) { cleanupHandlers.push(handler) },
    })
  } finally {
    for (const cleanup of cleanupHandlers) cleanup()
    await mail?.dispose()
    handle?.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('1: a submission queued during a background pass is sent by a later pass', async () => {
  const pullStarted = Promise.withResolvers<void>()
  const heldPull = Promise.withResolvers<unknown>()
  let pulls = 0
  await withHarness({
    respond(method, params) {
      if (method === PULL_METHOD && pulls++ === 0) {
        pullStarted.resolve()
        return heldPull.promise
      }
      return defaultResponse(method, params)
    },
  }, async (harness) => {
    harness.onCleanup(() => heldPull.resolve({ items: [], through: 0 }))
    await pullStarted.promise

    const queued = Promise.withResolvers<void>()
    harness.setGetDispatchHook(() => queued.resolve())
    const preflight = harness.mail.submissionPreflight(submissionForHost())
    await queued.promise
    heldPull.resolve({ items: [], through: 0 })

    expect(await preflight).toEqual(ACCEPTED)
    const imports = harness.calls.filter((call) => call.method === IMPORT_METHOD)
    expect(imports).toHaveLength(1)
    expect((imports[0]!.params.items as FederationRelayItem[]).map((item) => item.payload.type)).toEqual(['worker_done'])
  })
})

test('2: a heartbeat queued during a background pass gets the home verdict', async () => {
  const pullStarted = Promise.withResolvers<void>()
  const heldPull = Promise.withResolvers<unknown>()
  let pulls = 0
  await withHarness({
    seedDispatch: true,
    respond(method, params) {
      if (method === PULL_METHOD && pulls++ === 0) {
        pullStarted.resolve()
        return heldPull.promise
      }
      return defaultResponse(method, params)
    },
  }, async (harness) => {
    harness.onCleanup(() => heldPull.resolve({ items: [], through: 0 }))
    await pullStarted.promise

    const queued = Promise.withResolvers<void>()
    harness.setGetDispatchHook(() => queued.resolve())
    const caller = {
      callerSessionId: SESSION_ID,
      runtimeSessionId: SESSION_ID,
      runtimeOwned: true,
      live: true,
      attestation: {
        source: 'terminal_launch',
        runtimeEpoch: RUNTIME_EPOCH,
        processIncarnation: PROCESS_INCARNATION,
      },
    } as RuntimeCallerEvidence
    const heartbeat = harness.hooks()!.beforeHeartbeat({
      taskId: HOST_TASK_ID,
      dispatchId: HOST_DISPATCH_ID,
      phase: 'answered',
    }, caller)
    await queued.promise
    heldPull.resolve({ items: [], through: 0 })

    expect(await heartbeat).toEqual({ status: 'accepted', lastHeartbeatAt: '2026-01-01T00:00:00.000Z' })
    const imports = harness.calls.filter((call) => call.method === IMPORT_METHOD)
    expect(imports).toHaveLength(1)
    expect((imports[0]!.params.items as FederationRelayItem[]).map((item) => item.payload.type)).toEqual(['heartbeat'])
  })
})

test('3: a failed background pass does not prevent a submission pass', async () => {
  const pullStarted = Promise.withResolvers<void>()
  const heldPull = Promise.withResolvers<unknown>()
  let pulls = 0
  await withHarness({
    respond(method, params) {
      if (method === PULL_METHOD && pulls++ === 0) {
        pullStarted.resolve()
        return heldPull.promise
      }
      return defaultResponse(method, params)
    },
  }, async (harness) => {
    harness.onCleanup(() => heldPull.reject(new Error('pull failed')))
    await pullStarted.promise

    const queued = Promise.withResolvers<void>()
    harness.setGetDispatchHook(() => queued.resolve())
    const preflight = harness.mail.submissionPreflight(submissionForHost())
    await queued.promise
    heldPull.reject(new Error('pull failed'))

    expect(await preflight).toEqual(ACCEPTED)
    expect(harness.calls.filter((call) => call.method === IMPORT_METHOD)).toHaveLength(1)
  })
})

test('4: a submission with no background pass uses exactly one import and pull', async () => {
  await withHarness({}, async (harness) => {
    await harness.settleStartup()
    const beforeCall = harness.calls.length

    expect(await harness.mail.submissionPreflight(submissionForHost())).toEqual(ACCEPTED)
    const calls = harness.calls.slice(beforeCall)
    expect(calls.filter((call) => call.method === IMPORT_METHOD)).toHaveLength(1)
    expect(calls.filter((call) => call.method === PULL_METHOD)).toHaveLength(1)
  })
})

test('5: an unreachable home rejects and leaves the queued item pending', async () => {
  await withHarness({
    respond(method, params) {
      if (method === IMPORT_METHOD) throw new Error('peer offline')
      return defaultResponse(method, params)
    },
  }, async (harness) => {
    await harness.settleStartup()
    const beforeCall = harness.calls.length

    await expect(harness.mail.submissionPreflight(submissionForHost())).rejects.toThrow('peer offline')
    const calls = harness.calls.slice(beforeCall)
    expect(calls.filter((call) => call.method === IMPORT_METHOD)).toHaveLength(1)
    expect(harness.store.listOutbox(harness.binding.id, 'to_home', 0, 50)).toHaveLength(1)
    expect(harness.store.outboxCursor(harness.binding.id, 'to_home')).toBe(0)
  })
})

test('6: a valid home acknowledgement stores the result before the host pass reads its outbox', async () => {
  const assertStarted = Promise.withResolvers<void>()
  const releaseAssert = Promise.withResolvers<void>()
  await withHarness({}, async (harness) => {
    await harness.settleStartup()
    let checksAfterQueue = 0
    harness.setAssertBinding(async () => {
      checksAfterQueue += 1
      if (checksAfterQueue === 2) {
        assertStarted.resolve()
        await releaseAssert.promise
      }
    })
    const queued = Promise.withResolvers<void>()
    harness.setGetDispatchHook(() => queued.resolve())
    const beforeCall = harness.calls.length
    const preflight = harness.mail.submissionPreflight(submissionForHost())
    harness.onCleanup(() => releaseAssert.resolve())
    await queued.promise
    await assertStarted.promise

    const pulled = await harness.mail.inbound(PULL_METHOD, {
      bindingId: harness.binding.id,
      direction: 'to_home',
      after: 0,
      limit: 50,
    }, harness.principal) as { items: FederationRelayItem[]; through: number }
    expect(pulled).toMatchObject({ through: 1, items: [{ sequence: 1, kind: 'lifecycle' }] })
    const item = pulled.items[0]!
    expect(await harness.mail.inbound(ACK_METHOD, {
      bindingId: harness.binding.id,
      direction: 'to_home',
      through: 1,
      results: [{ sequence: item.sequence, id: item.id, result: ACCEPTED }],
    }, harness.principal)).toEqual({ through: 1 })
    expect(harness.store.outboxCursor(harness.binding.id, 'to_home')).toBe(1)
    expect(harness.store.result(harness.binding.id, 'to_home', item.id)).toEqual(ACCEPTED)

    releaseAssert.resolve()
    expect(await preflight).toEqual(ACCEPTED)
    expect(harness.calls.slice(beforeCall).filter((call) => call.method === IMPORT_METHOD)).toHaveLength(0)
  })
})

test('7: acknowledgements missing a matching result do not mutate mail state', async () => {
  await withHarness({}, async (harness) => {
    await harness.settleStartup()
    const item = harness.store.enqueue(harness.binding.id, 'to_home', 'queued-item-a', 'lifecycle', { type: 'worker_done' })
    const acknowledgements = [
      { through: 1 },
      { through: 1, results: [] },
      { through: 1, results: [{ sequence: 1, id: item.id }] },
      { through: 1, results: [{ sequence: 1, id: 'different-item', result: ACCEPTED }] },
      { through: 1, results: [{ sequence: 2, id: item.id, result: ACCEPTED }] },
    ]

    for (const acknowledgement of acknowledgements) {
      await expect(harness.mail.inbound(ACK_METHOD, {
        bindingId: harness.binding.id,
        direction: 'to_home',
        ...acknowledgement,
      }, harness.principal)).rejects.toThrow('Federation acknowledgement is missing an import result')
      expect(harness.store.outboxCursor(harness.binding.id, 'to_home')).toBe(0)
      expect(harness.store.result(harness.binding.id, 'to_home', item.id)).toBeNull()
    }
    expect(await harness.mail.inbound(ACK_METHOD, {
      bindingId: harness.binding.id,
      direction: 'to_home',
      through: 0,
    }, harness.principal)).toEqual({ through: 0 })
  })
})

test('8: a home acknowledgement includes each imported result', async () => {
  const ackSeen = Promise.withResolvers<void>()
  const importedItem: FederationRelayItem = {
    sequence: 1,
    id: 'home-message-a',
    bindingId: BINDING_ID,
    direction: 'to_home',
    kind: 'message',
    payload: { message: { id: 'home-message-a', body: 'Hello from home' } },
  }
  const message = {
    id: importedItem.id,
    read: false,
    type: 'dispatch',
    mailbox: { kind: 'dispatch', dispatchId: HOME_DISPATCH_ID },
  } as unknown as MessageRow
  let committed = 0
  await withHarness({
    side: 'home',
    respond(method, params) {
      if (method === PULL_METHOD) return { items: [importedItem], through: 1 }
      if (method === ACK_METHOD) {
        ackSeen.resolve()
        return { through: params.through }
      }
      return defaultResponse(method, params)
    },
    importFederatedItem: () => ({ message, questionId: null }),
    onCommitted: () => { committed += 1 },
  }, async (harness) => {
    await ackSeen.promise
    const acknowledgement = harness.calls.find((call) => call.method === ACK_METHOD)
    expect(acknowledgement?.params).toEqual({
      bindingId: harness.binding.id,
      direction: 'to_home',
      through: 1,
      results: [{
        sequence: 1,
        id: importedItem.id,
        result: { kind: 'accepted', messageId: importedItem.id },
      }],
    })
    expect(committed).toBe(1)
  })
})
