import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import type { Enrollment, KindRegistration } from '../src/contracts'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createKernelService, type KernelService } from '../src/service'

type PowerListener = { suspend(): void; resume(): void }
type PowerSource = {
  readonly supported: boolean
  readonly suspended: boolean
  readonly subscriberCount: number
  subscribe(listener: PowerListener): () => void
  suspend(): void
  resume(): void
}
type TestSnapshot = { freshness: 'cached' | 'live'; contentIdentity: string; observedAtMs: number; world: { contentIdentity: string } }
type HookCall = (method: string, params?: Record<string, unknown>) => Promise<unknown> | unknown

const OWNER_PLUGIN = 'power.fixture'
const KIND_ID = 'power-demo'
const HOOKS = {
  authorize: `${OWNER_PLUGIN}/authorize`,
  read: `${OWNER_PLUGIN}/read`,
  decide: `${OWNER_PLUGIN}/decide`,
  execute: `${OWNER_PLUGIN}/execute`
}
const descriptor: KindRegistration = {
  id: KIND_ID,
  displayName: 'Power fixture',
  enrollmentPayloadSchema: { type: 'object', additionalProperties: true },
  hooks: HOOKS
}
const contributions = Object.values(HOOKS).map((id) => ({
  kind: 'method', status: 'effective', plugin: OWNER_PLUGIN, id: `method:${id}`
}))
const roots: string[] = []
const databaseClosers: Array<() => void> = []
const services: KernelService[] = []

afterEach(async () => {
  const shutdowns = services.splice(0).reverse().map((service) =>
    Promise.resolve().then(() => service.shutdown())
  )
  await Promise.allSettled(shutdowns)
  for (const close of databaseClosers.splice(0).reverse()) close()
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
})

function makePowerSource(initiallySuspended = false): PowerSource {
  let suspended = initiallySuspended
  const listeners = new Set<PowerListener>()
  return {
    supported: true,
    get suspended() { return suspended },
    get subscriberCount() { return listeners.size },
    subscribe(listener) {
      listeners.add(listener)
      if (suspended) listener.suspend()
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
    suspend() {
      if (suspended) return
      suspended = true
      for (const listener of [...listeners]) listener.suspend()
    },
    resume() {
      if (!suspended) return
      suspended = false
      for (const listener of [...listeners]) listener.resume()
    }
  }
}

function makeFixture(options: {
  initiallySuspended?: boolean
  now?: () => number
  call?: HookCall
  emit?: (event: string, value: unknown) => boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-host-power-'))
  roots.push(root)
  const home = join(root, 'home')
  const dataDir = join(home, 'plugin-data', 'quirky.heimdall')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const power = makePowerSource(options.initiallySuspended)
  const emitted: Array<{ event: string; value: unknown }> = []
  const context = {
    pluginId: 'quirky.heimdall',
    dir: root,
    dataDir,
    home,
    hostPower: power,
    log() {},
    provide() {},
    emit(event: string, value: unknown) {
      emitted.push({ event, value })
      return options.emit?.(event, value) ?? false
    },
    subscribe() { return () => {} },
    async call(method: string, params?: Record<string, unknown>) {
      if (method === 'plugin.contributions') return contributions
      if (options.call) return await options.call(method, params)
      throw new Error(`unexpected hook call ${method}`)
    },
    openStore(migrations: Parameters<PluginContext['openStore']>[0]) {
      const opened = openPluginStore({ home, pluginId: 'quirky.heimdall', migrations, isActive: () => true })
      databaseClosers.push(opened.close)
      return opened.store
    },
    getSetting() { return undefined },
    storedSettingValue() { return undefined },
    error(_kind: never, message: string) { return new Error(message) },
    pty: {},
    notify() {},
    launch: {}
  } as unknown as PluginContext
  const service = createKernelService(context, options.now)
  services.push(service)
  return { context, service, power, emitted }
}

function enrollment(watcherId: string, workspacePath = `/workspace/${watcherId}`): Enrollment {
  return {
    watcherId,
    kind: KIND_ID,
    workspaceKey: `local::${workspacePath}`,
    workspacePath,
    executionHostId: 'local',
    schedulerOwner: 'daemon',
    kindPayload: { name: watcherId },
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { publish: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    coordinator: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 0,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null
  }
}

function createWorkspace(service: KernelService): string {
  return realpathSync.native(mkdtempSync(join(service.context.dataDir, 'workspace-')))
}

function seed(service: KernelService, ...watcherIds: string[]): void {
  service.registry.registerDescriptor(descriptor, OWNER_PLUGIN)
  for (const watcherId of watcherIds) {
    service.store.save(enrollment(watcherId, createWorkspace(service)))
  }
}

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function readCall(params: Record<string, unknown> | undefined): {
  enrollment: Enrollment
  fresh: boolean
} {
  const target = params?.enrollment as Enrollment | undefined
  const options = params?.options as { fresh?: unknown } | undefined
  if (!target || typeof options?.fresh !== 'boolean') throw new Error('invalid fixture read call')
  return { enrollment: target, fresh: options.fresh }
}

function snapshot(contentIdentity: string, now: () => number, freshness: 'cached' | 'live' = 'live'): TestSnapshot {
  return { freshness, contentIdentity, observedAtMs: now(), world: { contentIdentity } }
}

describe('Heimdall host-power lifecycle binding', () => {
  test('fences an in-flight read, resumes with a live read, and excludes the sleeping interval from budget', async () => {
    let clock = 1_000
    const firstReadStarted = deferred<void>()
    const finishFirstRead = deferred<unknown>()
    const wakeReadStarted = deferred<void>()
    const executeStarted = deferred<void>()
    const finishExecute = deferred<unknown>()
    const reads: Array<{ watcherId: string; fresh: boolean; contentIdentity: string }> = []
    const decided = new Set<string>()
    let executeCount = 0
    const fixture = makeFixture({
      now: () => clock,
      call: async (method, params) => {
        if (method === HOOKS.read) {
          const { enrollment: current, fresh } = readCall(params)
          const index = reads.length + 1
          if (index === 1) {
            reads.push({ watcherId: current.watcherId, fresh, contentIdentity: 'before-sleep' })
            firstReadStarted.resolve(undefined)
            return await finishFirstRead.promise
          }
          if (index === 3) wakeReadStarted.resolve(undefined)
          const contentIdentity = `live-${index}`
          reads.push({ watcherId: current.watcherId, fresh, contentIdentity })
          return snapshot(contentIdentity, () => clock)
        }
        if (method === HOOKS.decide) {
          const current = params?.enrollment as Enrollment
          const observed = params?.snapshot as TestSnapshot
          if (decided.has(current.watcherId)) return { action: null, reason: 'settled' }
          decided.add(current.watcherId)
          return {
            action: {
              kind: 'publish', capability: 'publish', visibility: 'external',
              contentIdentity: observed.contentIdentity, evidenceKey: 'host-power-wake',
              expectedState: { target: 'revision', before: observed.contentIdentity }
            }
          }
        }
        if (method === HOOKS.execute) {
          executeCount++
          executeStarted.resolve(undefined)
          return await finishExecute.promise
        }
        throw new Error(`unexpected hook call ${method}`)
      }
    })
    const { service, power } = fixture
    const watcherId = 'watcher-in-flight-read'
    seed(service, watcherId)

    await service.start()
    await firstReadStarted.promise
    const suspendedRead = service.runner(watcherId)!.pulse()
    power.suspend()
    finishFirstRead.resolve(snapshot('before-sleep', () => clock, 'cached'))
    await suspendedRead

    expect(decided.size).toBe(0)
    expect(executeCount).toBe(0)

    power.resume()
    await executeStarted.promise
    const activeAction = service.runner(watcherId)!.pulse()
    clock = 1_200
    power.suspend()

    expect(service.inspect(watcherId)[0]?.budget.activeMs).toBe(200)
    clock = 61_200
    expect(service.inspect(watcherId)[0]?.budget.activeMs).toBe(200)

    finishExecute.resolve({ effect: 'landed' })
    await activeAction
    expect(service.store.journal(watcherId).some((entry) => entry.kind === 'attempt-resolved')).toBe(false)

    power.resume()
    await wakeReadStarted.promise
    expect(reads[2]).toMatchObject({ watcherId, fresh: true, contentIdentity: 'live-3' })
    expect(service.inspect(watcherId)[0]?.budget.activeMs).toBe(200)
    expect(executeCount).toBe(1)

    await service.shutdown()
  })

  test('restored and newly enrolled runners remain dormant while the host is suspended', async () => {
    const readWatchers: string[] = []
    const executedWatchers: string[] = []
    const readBoth = deferred<void>()
    const executeBoth = deferred<void>()
    const decided = new Set<string>()
    let newlyEnrolledWorkspacePath = ''
    const fixture = makeFixture({
      initiallySuspended: true,
      call: async (method, params) => {
        if (method === HOOKS.authorize) {
          const input = params?.input as { kindPayload: unknown }
          return {
            workspaceKey: 'ignored-by-authority', workspacePath: newlyEnrolledWorkspacePath,
            executionHostId: 'local', schedulerOwner: 'daemon', kindPayload: input.kindPayload
          }
        }
        if (method === HOOKS.read) {
          const { enrollment: current } = readCall(params)
          readWatchers.push(current.watcherId)
          if (readWatchers.length === 2) readBoth.resolve(undefined)
          return snapshot(`live-${current.watcherId}`, Date.now)
        }
        if (method === HOOKS.decide) {
          const current = params?.enrollment as Enrollment
          const observed = params?.snapshot as TestSnapshot
          if (decided.has(current.watcherId)) return { action: null, reason: 'settled' }
          decided.add(current.watcherId)
          return {
            action: {
              kind: 'publish', capability: 'publish', visibility: 'external',
              contentIdentity: observed.contentIdentity, evidenceKey: current.watcherId,
              expectedState: { target: 'revision', before: observed.contentIdentity }
            }
          }
        }
        if (method === HOOKS.execute) {
          executedWatchers.push((params?.enrollment as Enrollment).watcherId)
          if (executedWatchers.length === 2) executeBoth.resolve(undefined)
          return { effect: 'landed' }
        }
        throw new Error(`unexpected hook call ${method}`)
      }
    })
    const { service, power } = fixture
    newlyEnrolledWorkspacePath = createWorkspace(service)
    const restoredWatcher = 'watcher-restored-asleep'
    seed(service, restoredWatcher)

    await service.start()
    await service.reconcile(restoredWatcher)
    expect(readWatchers).toEqual([])
    expect(executedWatchers).toEqual([])

    const enrolled = await service.enroll({
      kind: KIND_ID,
      kindPayload: { name: 'newly-enrolled' },
      capabilities: { publish: 'on' }
    })
    expect(enrolled.kind).toBe('enrolled')
    if (enrolled.kind !== 'enrolled') throw new Error('fixture enrollment was refused')
    const enrolledWatcher = enrolled.enrollment.watcherId
    await service.reconcile(enrolledWatcher)
    expect(readWatchers).toEqual([])
    expect(executedWatchers).toEqual([])

    power.resume()
    await Promise.all([service.reconcile(restoredWatcher), service.reconcile(enrolledWatcher)])
    await readBoth.promise
    await executeBoth.promise
    expect(new Set(readWatchers)).toEqual(new Set([restoredWatcher, enrolledWatcher]))
    expect(new Set(executedWatchers)).toEqual(new Set([restoredWatcher, enrolledWatcher]))

    await service.shutdown()
  })

  test('removes its power subscription before shutdown and fences a pending read from stale effects', async () => {
    const readStarted = deferred<void>()
    const finishRead = deferred<unknown>()
    let decisions = 0
    let executions = 0
    const fixture = makeFixture({
      call: async (method) => {
        if (method === HOOKS.read) {
          readStarted.resolve(undefined)
          return await finishRead.promise
        }
        if (method === HOOKS.decide) {
          decisions++
          return { action: { kind: 'publish', capability: 'publish', visibility: 'external', contentIdentity: 'stale', evidenceKey: 'stale' } }
        }
        if (method === HOOKS.execute) {
          executions++
          return { effect: 'landed' }
        }
        throw new Error(`unexpected hook call ${method}`)
      }
    })
    const { service, power, emitted } = fixture
    const watcherId = 'watcher-shutdown-pending'
    seed(service, watcherId)

    await service.start()
    await readStarted.promise
    expect(power.subscriberCount).toBe(1)

    const shutdown = service.shutdown()
    expect(power.subscriberCount).toBe(0)
    const emittedAtShutdown = emitted.length
    power.suspend()
    power.resume()
    finishRead.resolve(snapshot('stale-read', Date.now))
    await shutdown

    expect(decisions).toBe(0)
    expect(executions).toBe(0)
    expect(emitted).toHaveLength(emittedAtShutdown)
  })

  test('attempts every synchronous runner fence and reports the failing watcher', async () => {
    const failFenceFor = 'watcher-fence-failure'
    const bothDecided = deferred<void>()
    const decidedWatchers = new Set<string>()
    const fixture = makeFixture({
      call: async (method, params) => {
        if (method === HOOKS.read) return snapshot('idle', Date.now)
        if (method === HOOKS.decide) {
          decidedWatchers.add((params?.enrollment as Enrollment).watcherId)
          if (decidedWatchers.size === 2) bothDecided.resolve(undefined)
          return { action: null, reason: 'idle' }
        }
        if (method === HOOKS.execute) return { effect: 'landed' }
        throw new Error(`unexpected hook call ${method}`)
      }
    })
    const { service, power } = fixture
    seed(service, failFenceFor, 'watcher-fence-survivor')

    await service.start()
    await bothDecided.promise
    const failingRunner = service.runner(failFenceFor)
    if (!failingRunner) throw new Error('fixture runner is unavailable')
    const suspend = failingRunner.suspend
    failingRunner.suspend = () => {
      suspend()
      throw new Error('runner fence failed')
    }

    let failure: unknown
    try {
      power.suspend()
    } catch (error) {
      failure = error
    }
    if (!(failure instanceof AggregateError)) throw new Error('runner fencing did not report aggregated errors')
    expect(failure.errors.map(String).join('\n')).toContain(failFenceFor)
    expect(service.runner(failFenceFor)?.status()).toMatchObject({ state: 'held', reason: 'suspended' })
    expect(service.runner('watcher-fence-survivor')?.status()).toMatchObject({ state: 'held', reason: 'suspended' })

    await service.shutdown()
  })
})
