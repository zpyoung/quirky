import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, Schema } from '@quirky/protocol'
import { HostPowerService } from '../../../packages/daemon/src/host-power'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createEnrollmentService } from '../src/enrollment'
import { createKernelStore } from '../src/store'
import { actionFingerprint } from '../src/gate'
import { createRunner } from '../src/runner'
import { createWorkspaceLease } from '../src/lease'
import { createKindRegistry } from '../src/registry'
import type {
  AuthorizedEnrollment,
  Enrollment,
  EnrollmentService,
  HandoffRequest,
  HandoffResult,
  KernelAction,
  KernelOptions,
  KernelStore,
  KindRegistry,
  OrchestrationPort,
  WatcherKind
} from '../src/contracts'

type HandoffService = EnrollmentService

type Fixture = {
  home: string
  workspacePath: string
  context: PluginContext
  store: KernelStore
  reopen(): void
  cleanup(): void
}
const fixtures: Fixture[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'heimdall-handoff-'))
  const workspacePath = join(home, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const canonicalWorkspacePath = realpathSync.native(workspacePath)
  const dataDir = join(home, 'plugin-data', 'quirky.heimdall')
  mkdirSync(dataDir, { recursive: true })
  const handles: Array<{ close(): void }> = []
  const context = {
    pluginId: 'quirky.heimdall',
    dir: home,
    dataDir,
    home,
    hostPower: new HostPowerService(() => {}, null).forPlugin('quirky.heimdall', () => false),
    log() {},
    provide() {},
    emit() { return false },
    subscribe() { return () => {} },
    call: async () => { throw new Error('unexpected context.call') },
    openStore(migrations: string[], options?: Parameters<PluginContext['openStore']>[1]) {
      const opened = openPluginStore({
        home,
        pluginId: 'quirky.heimdall',
        migrations,
        isActive: () => true,
        newerVersion: options?.newerVersion
      })
      handles.push(opened)
      return opened.store
    },
    getSetting() { return undefined },
    storedSettingValue() { return undefined },
    error(_kind: never, message: string) { return new Error(message) },
    pty: {},
    notify() {},
    launch: {}
  } as unknown as PluginContext
  let store = createKernelStore(context)
  const result: Fixture = {
    home,
    workspacePath: canonicalWorkspacePath,
    get store() { return store },
    reopen() {
      store.close()
      handles.pop()?.close()
      store = createKernelStore(context)
    },
    cleanup() {
      store.close()
      for (const handle of handles.splice(0).reverse()) handle.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
  fixtures.push(result)
  return result
}

function sourceEnrollment(workspacePath: string, overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    watcherId: 'source-watcher',
    kind: 'test-objective',
    workspaceKey: `local::${workspacePath}`,
    workspacePath,
    executionHostId: 'local',
    schedulerOwner: 'daemon',
    kindPayload: { name: 'source' },
    enabled: true,
    paused: false,
    commandRevision: 4,
    capabilities: { land: 'gated' },
    budget: { wallClockActiveMs: 1_000, turns: 10 },
    coordinator: { handle: 'source-coordinator', paneKey: 'source-pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    owner: { agent: 'claude', model: 'opus' },
    ownerInterventionCapability: 'gated',
    ...overrides
  }
}

function seedUsage(store: KernelStore, watcherId = 'source-watcher'): void {
  store.append(watcherId, {
    kind: 'turn', class: 'fact', origin: 'owner', resolved: true,
    eventId: `turn:${watcherId}:dispatch-1`, dispatchId: 'dispatch-1', generation: `initial:${watcherId}`
  })
  store.append(watcherId, {
    kind: 'interval-open', class: 'fact', origin: 'owner', resolved: true,
    eventId: `interval-open:${watcherId}`, intervalId: `interval-${watcherId}`,
    generation: `initial:${watcherId}`, cause: 'work', atMs: 1_000
  })
  store.append(watcherId, {
    kind: 'interval-checkpoint', class: 'fact', origin: 'owner', resolved: true,
    eventId: `interval-checkpoint:${watcherId}`, intervalId: `interval-${watcherId}`,
    generation: `initial:${watcherId}`, checkpointAtMs: 1_250
  })
}

function targetKind(authority: Partial<AuthorizedEnrollment> = {}, options: {
  schema?: Schema
  authorize?: WatcherKind['authorizeEnrollment']
  validate?: WatcherKind['validateEnrollment']
  undo?: WatcherKind['undoAuthorization']
} = {}): WatcherKind {
  return {
    id: 'test-sitter',
    displayName: 'Test sitter',
    enrollmentPayloadSchema: options.schema ?? { type: 'object', additionalProperties: true },
    async authorizeEnrollment(input) {
      if (options.authorize) return options.authorize(input)
      return {
        workspaceKey: 'untrusted::key',
        workspacePath: authority.workspacePath ?? fixtureWorkspace,
        executionHostId: authority.executionHostId ?? 'local',
        schedulerOwner: authority.schedulerOwner ?? 'daemon',
        kindPayload: authority.kindPayload ?? input.kindPayload,
        ...(authority.repoId !== undefined ? { repoId: authority.repoId } : {}),
        ...(authority.worktreeId !== undefined ? { worktreeId: authority.worktreeId } : {})
      }
    },
    validateEnrollment: options.validate,
    undoAuthorization: options.undo,
    async read() { return { freshness: 'live', contentIdentity: 'test', observedAtMs: 1_250, world: null } },
    decide() { return { action: null, reason: 'idle' } },
    async execute() { return { effect: 'landed' } }
  }
}
let fixtureWorkspace = ''

function testRegistry(kinds: WatcherKind[]): KindRegistry {
  return {
    get(id) { return kinds.find((kind) => kind.id === id) },
    register() {},
    registerDescriptor() {},
    descriptors() { return [] }
  }
}

function serviceFor(
  stored: Fixture,
  target: WatcherKind,
  overrides: Partial<KernelOptions> = {},
  store: KernelStore = stored.store,
  onEnrolled: (enrollment: Enrollment) => void = () => {}
): HandoffService {
  const options: KernelOptions = {
    context: stored.context,
    store,
    registry: testRegistry([target]),
    orchestration: {} as OrchestrationPort,
    now: () => 1_250,
    executionHostId: 'local',
    schedulerOwner: 'daemon',
    ...overrides
  }
  return createEnrollmentService(options, onEnrolled)
}
const request: HandoffRequest = {
  kind: 'test-sitter',
  kindPayload: {
    expectedReview: {
      number: 12,
      url: 'https://github.invalid/repo/pull/12',
      repository: { host: 'github.invalid', owner: 'repo', repo: 'project' },
      headRepository: { host: 'github.invalid', owner: 'repo', repo: 'project' },
      headRefName: 'objective/12',
      baseRefName: 'main',
      headSha: 'a'.repeat(40)
    }
  },
  capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'off' }
}

const stop = (handoff: HandoffRequest): Parameters<HandoffService['handoff']>[1] => ({
  kind: 'terminal', state: 'landed', reason: 'hosted-review landing bar reached', handoff
})

describe('Heimdall atomic sitter handoff', () => {
  test('handoff commits one successor or retains the source', async () => {
    const stored = fixture()
    fixtureWorkspace = stored.workspacePath
    const source = sourceEnrollment(stored.workspacePath)
    stored.store.save(source)
    seedUsage(stored.store)
    stored.store.append(source.watcherId, {
      kind: 'approval', class: 'fact', origin: 'owner', resolved: true,
      eventId: 'approval:source', capability: 'merge'
    })
    const authorizedInputs: unknown[] = []
    const started: Enrollment[] = []
    const sitter = targetKind({}, {
      authorize: async (input) => {
        authorizedInputs.push(input)
        return {
          workspaceKey: 'ignored', workspacePath: stored.workspacePath,
          executionHostId: 'local', schedulerOwner: 'daemon', kindPayload: input.kindPayload
        }
      }
    })
    const service = serviceFor(stored, sitter, {}, stored.store, (enrollment) => started.push(enrollment))
    const completed = await service.handoff(
      { watcherId: source.watcherId, commandRevision: source.commandRevision },
      stop(request),
      () => null
    )

    if (completed.kind === 'refused') {
      throw new Error(`Handoff refused (${completed.reason}): ${completed.detail}`)
    }
    expect(completed.kind).toBe('handed-off')
    if (completed.kind !== 'handed-off') return
    expect(authorizedInputs).toHaveLength(1)
    expect(completed.summary).toMatchObject({
      watcherId: source.watcherId, kind: source.kind, state: 'landed', reason: 'hosted-review landing bar reached'
    })
    expect(completed.link).toEqual({ watcherId: completed.enrollment.watcherId, kind: 'test-sitter' })
    expect(stored.store.get(source.watcherId)).toMatchObject({ enabled: false, terminalAtMs: 1_250 })
    expect(stored.store.journal(source.watcherId).filter((entry) => entry.kind === 'terminal')).toHaveLength(1)
    expect(stored.store.journal(source.watcherId).find((entry) => entry.kind === 'terminal')?.handoff).toEqual(completed.link)
    expect(stored.store.list().filter((entry) => entry.workspaceKey === source.workspaceKey && entry.terminalAtMs === null)).toEqual([completed.enrollment])
    expect(completed.enrollment).toMatchObject({
      kind: 'test-sitter', workspaceKey: source.workspaceKey, workspacePath: source.workspacePath,
      executionHostId: source.executionHostId, schedulerOwner: source.schedulerOwner,
      capabilities: request.capabilities, budget: { wallClockActiveMs: 750, turns: 9 }, owner: null
    })
    expect(completed.enrollment.kindPayload).toEqual(request.kindPayload)
    expect(completed.enrollment).not.toHaveProperty('ownerInterventionCapability')
    expect(started).toEqual([])
    expect(stored.store.journal(completed.enrollment.watcherId).map((entry) => entry.evidenceKind)).toEqual(['budget-generation'])

    const ordinary = await service.enroll({ kind: 'test-sitter', kindPayload: request.kindPayload })
    expect(ordinary).toMatchObject({ kind: 'refused', reason: 'duplicate-workspace' })

    // Replaying after reopening the SQLite store returns the recorded child, not a second enrollment.
    stored.reopen()
    const afterRestart = serviceFor(stored, sitter)
    const replay = await afterRestart.handoff(
      { watcherId: source.watcherId, commandRevision: source.commandRevision }, stop(request), () => null
    )
    expect(replay).toMatchObject({ kind: 'handed-off', enrollment: { watcherId: completed.enrollment.watcherId }, link: completed.link })
    expect(stored.store.list().filter((entry) => entry.workspaceKey === source.workspaceKey && entry.terminalAtMs === null)).toHaveLength(1)

    const rollbackFixture = fixture()
    fixtureWorkspace = rollbackFixture.workspacePath
    const rollbackSource = sourceEnrollment(rollbackFixture.workspacePath)
    rollbackFixture.store.save(rollbackSource)
    let undone = 0
    const rollbackSitter = targetKind({}, { undo: async () => { undone++ } })
    const rollbackStore = {
      ...rollbackFixture.store,
      transaction() { throw new Error('injected transaction failure') }
    } as KernelStore
    const rollback = await serviceFor(rollbackFixture, rollbackSitter, {}, rollbackStore).handoff(
      { watcherId: rollbackSource.watcherId, commandRevision: rollbackSource.commandRevision }, stop(request), () => null
    )
    expect(rollback.kind).toBe('refused')
    expect(undone).toBe(1)
    expect(rollbackFixture.store.get(rollbackSource.watcherId)).toMatchObject({ enabled: true, terminalAtMs: null })
    expect(rollbackFixture.store.list()).toHaveLength(1)

    for (const failure of ['unknown-kind', 'wrong-workspace', 'wrong-host', 'invalid-payload', 'authorization-failed', 'read-only']) {
      const failed = fixture()
      fixtureWorkspace = failed.workspacePath
      const row = sourceEnrollment(failed.workspacePath)
      failed.store.save(row)
      let failedService: HandoffService
      if (failure === 'unknown-kind') {
        failedService = serviceFor(failed, targetKind())
      } else if (failure === 'wrong-workspace') {
        failedService = serviceFor(failed, targetKind({ workspacePath: join(failed.home, 'elsewhere') }))
      } else if (failure === 'wrong-host') {
        failedService = serviceFor(failed, targetKind({ executionHostId: 'remote' }))
      } else if (failure === 'invalid-payload') {
        failedService = serviceFor(failed, targetKind({}, { schema: {
          type: 'object', properties: { requiredValue: { type: 'string' } }, required: ['requiredValue'], additionalProperties: false
        } }))
      } else if (failure === 'authorization-failed') {
        failedService = serviceFor(failed, targetKind({}, { authorize: async () => { throw new Error('denied') } }))
      } else {
        failedService = serviceFor(failed, targetKind(), { store: { ...failed.store, readOnly: true } as KernelStore })
      }
      const requested = failure === 'unknown-kind' ? { ...request, kind: 'missing-kind' } : request
      const result = await failedService.handoff(
        { watcherId: row.watcherId, commandRevision: row.commandRevision }, stop(requested), () => null
      )
      expect(result.kind).toBe('refused')
      expect(failed.store.get(row.watcherId)).toMatchObject({ enabled: true, terminalAtMs: null })
      expect(failed.store.list()).toHaveLength(1)
    }

    for (const race of ['revision', 'pause', 'disarm', 'remove', 'guard']) {
      const raced = fixture()
      fixtureWorkspace = raced.workspacePath
      const row = sourceEnrollment(raced.workspacePath)
      raced.store.save(row)
      let releaseAuthorization!: () => void
      let authorizationStarted!: () => void
      const startedAuthorization = new Promise<void>((resolve) => { authorizationStarted = resolve })
      const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve })
      const delayedTarget = targetKind({}, { authorize: async (input) => {
        authorizationStarted()
        await authorizationGate
        return {
          workspaceKey: 'ignored', workspacePath: raced.workspacePath,
          executionHostId: 'local', schedulerOwner: 'daemon', kindPayload: input.kindPayload
        }
      } })
      const pending = serviceFor(raced, delayedTarget).handoff(
        { watcherId: row.watcherId, commandRevision: row.commandRevision }, stop(request),
        () => race === 'guard' ? 'current tick/control/lease changed' : null
      )
      await startedAuthorization
      if (race === 'revision') raced.store.save({ ...row, commandRevision: row.commandRevision + 1 })
      if (race === 'pause') raced.store.save({ ...row, paused: true })
      if (race === 'disarm') raced.store.save({ ...row, enabled: false, haltReason: 'operator-disarmed' })
      if (race === 'remove') raced.store.remove?.(row.watcherId)
      releaseAuthorization()
      const result = await pending
      expect(result.kind).toBe('refused')
      if (race === 'remove') {
        expect(raced.store.get(row.watcherId)).toBeNull()
      } else if (race === 'revision') {
        expect(raced.store.get(row.watcherId)).toMatchObject({ enabled: true, commandRevision: row.commandRevision + 1, terminalAtMs: null })
      } else if (race === 'pause') {
        expect(raced.store.get(row.watcherId)).toMatchObject({ enabled: true, paused: true, terminalAtMs: null })
      } else if (race === 'disarm') {
        expect(raced.store.get(row.watcherId)).toMatchObject({ enabled: false, haltReason: 'operator-disarmed', terminalAtMs: null })
      } else {
        expect(raced.store.get(row.watcherId)).toMatchObject({ enabled: true, terminalAtMs: null })
      }
    }

    const nullBudget = fixture()
    fixtureWorkspace = nullBudget.workspacePath
    const unlimited = sourceEnrollment(nullBudget.workspacePath, { budget: { wallClockActiveMs: null, turns: null } })
    nullBudget.store.save(unlimited)
    const unlimitedResult = await serviceFor(nullBudget, targetKind()).handoff(
      { watcherId: unlimited.watcherId, commandRevision: unlimited.commandRevision }, stop(request), () => null
    )
    expect(unlimitedResult).toMatchObject({ kind: 'handed-off', enrollment: { budget: { wallClockActiveMs: null, turns: null } } })

    const zeroBudget = fixture()
    fixtureWorkspace = zeroBudget.workspacePath
    const depleted = sourceEnrollment(zeroBudget.workspacePath, { budget: { wallClockActiveMs: 0, turns: 0 } })
    zeroBudget.store.save(depleted)
    const zeroResult = await serviceFor(zeroBudget, targetKind()).handoff(
      { watcherId: depleted.watcherId, commandRevision: depleted.commandRevision }, stop(request), () => null
    )
    expect(zeroResult).toMatchObject({ kind: 'handed-off', enrollment: { budget: { wallClockActiveMs: 0, turns: 0 } } })

    const descriptorFixture = fixture()
    fixtureWorkspace = descriptorFixture.workspacePath
    const replies = new Map<string, unknown>([
      ['test.plugin/stop', { kind: 'terminal', state: 'landed', reason: 'ordinary stop' }],
      ['test.plugin/badStop', { kind: 'terminal', state: 'landed', reason: 'bad handoff', handoff: {
        kind: 'test-sitter', kindPayload: { bad: Number.POSITIVE_INFINITY }, capabilities: { merge: 'off' }
      } }],
      ['test.plugin/badCapabilities', { kind: 'terminal', state: 'landed', reason: 'bad handoff', handoff: {
        kind: 'test-sitter', kindPayload: { review: 'x' }, capabilities: { merge: 'wild' }
      } }]
    ])
    const descriptorContext = {
      ...descriptorFixture.context,
      call: async (method: string) => {
        if (replies.has(method)) return replies.get(method)
        throw new Error(`unexpected method ${method}`)
      }
    } as unknown as PluginContext
    const descriptorRegistry = createKindRegistry(descriptorContext, descriptorFixture.store)
    const descriptor = (stopHook: string) => ({
      id: 'test-plugin-kind', displayName: 'Test plugin kind', enrollmentPayloadSchema: { type: 'object' },
      hooks: {
        authorize: 'test.plugin/authorize', read: 'test.plugin/read', decide: 'test.plugin/decide',
        execute: 'test.plugin/execute', stop: stopHook
      }
    })
    descriptorRegistry.registerDescriptor(descriptor('test.plugin/stop'), 'test.plugin')
    const ordinaryStop = await descriptorRegistry.get('test-plugin-kind')!.stop!(
      { freshness: 'live', contentIdentity: 'x', observedAtMs: 1, world: null }, [], sourceEnrollment(descriptorFixture.workspacePath)
    )
    expect(ordinaryStop).toEqual({ kind: 'terminal', state: 'landed', reason: 'ordinary stop' })
    descriptorRegistry.registerDescriptor(descriptor('test.plugin/badStop'), 'test.plugin')
    await expect(descriptorRegistry.get('test-plugin-kind')!.stop!(
      { freshness: 'live', contentIdentity: 'x', observedAtMs: 1, world: null }, [], sourceEnrollment(descriptorFixture.workspacePath)
    )).rejects.toThrow('invalid result')
    descriptorRegistry.registerDescriptor(descriptor('test.plugin/badCapabilities'), 'test.plugin')
    await expect(descriptorRegistry.get('test-plugin-kind')!.stop!(
      { freshness: 'live', contentIdentity: 'x', observedAtMs: 1, world: null }, [], sourceEnrollment(descriptorFixture.workspacePath)
    )).rejects.toThrow('invalid result')

    // A valid request is serialized with ordinary enrollment; it can never leave two live owners.
    const concurrent = fixture()
    fixtureWorkspace = concurrent.workspacePath
    const concurrentSource = sourceEnrollment(concurrent.workspacePath)
    concurrent.store.save(concurrentSource)
    let authorizationCalls = 0
    const { promise: enteredAuthorization, resolve: markAuthorizationEntered } = Promise.withResolvers<void>()
    const { promise: waitForAuthorization, resolve: finish } = Promise.withResolvers<void>()
    const concurrentTarget = targetKind({}, { authorize: async (input) => {
      if (authorizationCalls++ === 0) {
        markAuthorizationEntered()
        await waitForAuthorization
      }
      return {
        workspaceKey: 'ignored', workspacePath: concurrent.workspacePath,
        executionHostId: 'local', schedulerOwner: 'daemon', kindPayload: input.kindPayload
      }
    } })
    const concurrentService = serviceFor(concurrent, concurrentTarget)
    const transfer = concurrentService.handoff(
      { watcherId: concurrentSource.watcherId, commandRevision: concurrentSource.commandRevision }, stop(request), () => null
    )
    await enteredAuthorization
    const competing = await concurrentService.enroll({ kind: 'test-sitter', kindPayload: request.kindPayload })
    expect(competing).toMatchObject({ kind: 'refused', reason: 'duplicate-workspace' })
    finish()
    const transferResult = await transfer
    expect(transferResult.kind).toBe('handed-off')
    expect(concurrent.store.list().filter((entry) => entry.workspaceKey === concurrentSource.workspaceKey && entry.terminalAtMs === null)).toHaveLength(1)
  })
  test('handoff drains unresolved work and starts the successor after lease release', async () => {
    const stored = fixture()
    fixtureWorkspace = stored.workspacePath
    const source = sourceEnrollment(stored.workspacePath, {
      orchestrationRunId: 'run-handoff',
      capabilities: { work: 'on' }
    })
    stored.store.save(source)
    const workerAction: KernelAction = {
      kind: 'finish-existing-work',
      capability: 'work',
      visibility: 'local',
      contentIdentity: 'source-tree',
      evidenceKey: 'existing-worker'
    }
    const nextAction: KernelAction = {
      kind: 'continue-after-drain',
      capability: 'work',
      visibility: 'local',
      contentIdentity: 'source-tree',
      evidenceKey: 'after-drain'
    }
    stored.store.append(source.watcherId, {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt:existing-worker:running',
      attemptId: 'existing-worker',
      fingerprint: actionFingerprint(workerAction),
      action: workerAction,
      state: 'running',
      generation: 'initial:source-watcher',
      requestId: 'request-existing',
      workerRequest: { spec: 'existing work', worktree: stored.workspacePath, mode: 'structured' },
      dispatchId: 'dispatch-existing'
    })

    let stopCalls = 0
    let decisions = 0
    let executions = 0
    let transfers = 0
    let workerReleases = 0
    const handoffResults: HandoffResult[] = []
    let successorStartedAfterRelease = false
    let successorCallbackCalled = false
    let observedLeaseKind: string | null = null
    const sourceKind: WatcherKind = {
      id: source.kind,
      displayName: 'Test objective',
      enrollmentPayloadSchema: { type: 'object', additionalProperties: true },
      async authorizeEnrollment() { throw new Error('unused') },
      async read() {
        return { freshness: 'live', contentIdentity: 'source-tree', observedAtMs: 1_250, world: null }
      },
      decide() {
        decisions++
        return executions === 0 ? { action: nextAction } : { action: null, reason: 'done' }
      },
      async execute() {
        executions++
        return { effect: 'landed' }
      },
      async stop() {
        stopCalls++
        return stopCalls === 2 ? null : stop(request)
      }
    }
    const sitter = targetKind()
    const registry = testRegistry([sourceKind, sitter])
    const service = serviceFor(stored, sitter, { registry })
    let mailboxCalls = 0
    const orchestration: OrchestrationPort = {
      async restore() {},
      async dispatch() { return { kind: 'indeterminate', requestId: 'unused' } },
      async recover() { return null },
      async observeWorkers() {
        return [{
          dispatchId: 'dispatch-existing',
          sessionId: 'session-existing',
          processIncarnation: 'process-existing',
          state: 'live',
          assignmentActive: true,
          lastContactAtMs: 1_250
        }]
      },
      async mailbox() {
        mailboxCalls++
        return mailboxCalls === 2 ? [{
          id: 'worker-done',
          type: 'worker_done',
          dispatchId: 'dispatch-existing',
          body: 'completed existing work',
          outcome: 'succeeded'
        }] : []
      },
      async acknowledge() {},
      async release(_enrollment, dispatchId) {
        if (dispatchId === 'dispatch-existing') workerReleases++
      },
      dispose() {}
    }
    const runnerContext = {
      ...stored.context,
      dataDir: join(stored.home, 'plugin-data', 'quirky.heimdall')
    } as PluginContext
    const runner = createRunner({
      context: runnerContext,
      store: stored.store,
      registry,
      orchestration,
      now: () => 1_250,
      executionHostId: 'local',
      schedulerOwner: 'daemon',
      enrollment: source,
      handoff: async (...args) => {
        transfers++
        const result = await service.handoff(...args)
        handoffResults.push(result)
        return result
      },
      onHandoffCommitted() {
        successorCallbackCalled = true
        const observer = createWorkspaceLease({
          workspacePath: stored.workspacePath,
          workspaceKind: 'folder',
          holderId: 'handoff-successor-observer'
        })
        const claim = observer.acquire()
        observedLeaseKind = claim.kind
        successorStartedAfterRelease = claim.kind === 'acquired'
        if (claim.kind === 'acquired') observer.release(claim)
      }
    })

    await runner.pulse()
    expect(stored.store.get(source.watcherId)).toMatchObject({ enabled: true, terminalAtMs: null })
    expect(transfers).toBe(0)
    await runner.pulse()
    if (executions !== 1) {
      const journal = stored.store.journal(source.watcherId)
      throw new Error(`Runner did not drain then execute: ${JSON.stringify({
        executions,
        decisions,
        stopCalls,
        status: runner.status(),
        attempts: journal.filter((entry) => entry.kind === 'attempt').map((entry) => ({
          attemptId: entry.attemptId, state: entry.state, effect: entry.effect, fingerprint: entry.fingerprint
        })),
        gates: journal.filter((entry) => entry.kind === 'action-gate').map((entry) => entry.payload)
      })}`)
    }
    const handoffResult = handoffResults.at(-1)
    if (handoffResult?.kind === 'refused') {
      throw new Error(`Runner handoff refused (${handoffResult.reason}): ${handoffResult.detail}`)
    }
    expect(handoffResult?.kind).toBe('handed-off')
    expect(transfers).toBe(1)
    expect(workerReleases).toBe(1)
    expect({ successorCallbackCalled, observedLeaseKind }).toEqual({
      successorCallbackCalled: true,
      observedLeaseKind: 'acquired'
    })
    expect(successorStartedAfterRelease).toBe(true)
    expect(stored.store.get(source.watcherId)).toMatchObject({ enabled: false, terminalAtMs: 1_250 })
    await runner.shutdown(0)
  })
})
