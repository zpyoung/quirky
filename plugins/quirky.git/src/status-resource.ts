import type { GitStatus, UiPluginContext } from '@quirky/protocol'
import { canonicalContext } from './ui-control'

const STATUS_START_SPACING_MS = 3_000
const SNAPSHOT_REUSE_MS = 3_000
const INACTIVE_CLOCK_TTL_MS = 3_000
const MAX_INACTIVE_CLOCKS = 16
type TimerHandle = ReturnType<typeof setInterval>

type StatusResult = { status: GitStatus | null; error: unknown | null }
type StatusListener = (result: StatusResult) => void

type Clock = { lastStartedAt: number | null; expiresAt: number }
type OwnerResources = { active: Map<string, Resource>; inactive: Map<string, Clock> }
type Consumer = { pollMs: number; listener: StatusListener }
type Snapshot = { status: GitStatus; receivedAt: number; connectionGeneration: number }
type WaiterLocation = 'unattached' | 'pending' | 'flight' | 'settled'
type Waiter = {
  resource: Resource
  resolvePromise(status: GitStatus): void
  rejectPromise(error: unknown): void
  signal?: AbortSignal
  abortListener?: () => void
  location: WaiterLocation
  flight: Flight | null
}
type Flight = {
  generation: number
  connectionGeneration: number
  dirtyVersion: number
  unverifiedStart: boolean
  waiters: Set<Waiter>
}
type Resource = {
  owner: UiPluginContext
  ownerResources: OwnerResources
  worktree: string
  clock: Clock
  consumers: Set<Consumer>
  pendingWaiters: Set<Waiter>
  inFlight: Flight | null
  snapshot: Snapshot | null
  generation: number
  connectionGeneration: number
  connectionState: 'unknown' | 'connected' | 'reconnecting'
  failedRead: boolean
  dirtyVersion: number
  dirty: boolean
  pendingFresh: boolean
  dispatchQueued: boolean
  pollTimer: TimerHandle | undefined
  pollMs: number | null
  trailingTimer: TimerHandle | undefined
  unsubscribeEvents: () => void
  unsubscribeConnection: () => void
  released: boolean
}

type WaiterPromise = { waiter: Waiter; promise: Promise<GitStatus> }

const resourcesByOwner = new WeakMap<UiPluginContext, OwnerResources>()

function ownerResourcesFor(owner: UiPluginContext): OwnerResources {
  let resources = resourcesByOwner.get(owner)
  if (!resources) {
    resources = { active: new Map(), inactive: new Map() }
    resourcesByOwner.set(owner, resources)
  }
  const now = Date.now()
  for (const [worktree, clock] of resources.inactive) {
    if (clock.expiresAt <= now) resources.inactive.delete(worktree)
  }
  return resources
}

function resourceFor(context: UiPluginContext, worktree: string): Resource {
  const owner = canonicalContext(context)
  const ownerResources = ownerResourcesFor(owner)
  const active = ownerResources.active.get(worktree)
  if (active) return active

  const clock = ownerResources.inactive.get(worktree) ?? { lastStartedAt: null, expiresAt: 0 }
  ownerResources.inactive.delete(worktree)
  const resource: Resource = {
    owner,
    ownerResources,
    worktree,
    clock,
    consumers: new Set(),
    pendingWaiters: new Set(),
    inFlight: null,
    snapshot: null,
    generation: 0,
    connectionGeneration: 0,
    connectionState: 'unknown',
    failedRead: false,
    dirtyVersion: 0,
    dirty: false,
    pendingFresh: false,
    dispatchQueued: false,
    pollTimer: undefined,
    pollMs: null,
    trailingTimer: undefined,
    unsubscribeEvents: () => {},
    unsubscribeConnection: () => {},
    released: false
  }
  ownerResources.active.set(worktree, resource)
  resource.unsubscribeEvents = owner.subscribe((event) => {
    if (resource.released || event.type !== 'quirky.git/changed') return
    const data = event.data
    const worktreeId = typeof data === 'object' && data !== null && !Array.isArray(data) && 'worktreeId' in data
      ? data.worktreeId
      : undefined
    if (typeof worktreeId !== 'string' || worktreeId === worktree) invalidate(resource)
  })
  resource.unsubscribeConnection = owner.onConnection((state) => {
    if (resource.released) return
    if (state === 'reconnecting') {
      resource.connectionState = 'reconnecting'
      return
    }
    const reconnecting = resource.connectionState === 'reconnecting'
    const failedBeforeConnection = resource.connectionState === 'unknown' && resource.failedRead
    resource.connectionState = 'connected'
    if (reconnecting || failedBeforeConnection) recoverConnection(resource)
  })
  return resource
}

function waiterCount(resource: Resource): number {
  return resource.pendingWaiters.size + (resource.inFlight?.waiters.size ?? 0)
}

function detachWaiter(waiter: Waiter): void {
  const resource = waiter.resource
  if (waiter.location === 'pending') resource.pendingWaiters.delete(waiter)
  if (waiter.location === 'flight') waiter.flight?.waiters.delete(waiter)
  waiter.location = 'settled'
  waiter.flight = null
  if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener('abort', waiter.abortListener)
}

function releaseIfIdle(resource: Resource): void {
  if (resource.released || resource.consumers.size > 0 || waiterCount(resource) > 0) return
  resource.released = true
  resource.generation += 1
  clearInterval(resource.pollTimer)
  clearTimeout(resource.trailingTimer)
  resource.pollTimer = undefined
  resource.trailingTimer = undefined
  resource.pollMs = null
  resource.unsubscribeEvents()
  resource.unsubscribeConnection()
  resource.snapshot = null
  resource.pendingFresh = false
  resource.inFlight = null
  resource.ownerResources.active.delete(resource.worktree)

  resource.clock.expiresAt = Date.now() + INACTIVE_CLOCK_TTL_MS
  const inactive = resource.ownerResources.inactive
  inactive.delete(resource.worktree)
  inactive.set(resource.worktree, resource.clock)
  while (inactive.size > MAX_INACTIVE_CLOCKS) {
    const oldest = inactive.keys().next().value
    if (oldest === undefined) break
    inactive.delete(oldest)
  }
}

function resolveWaiter(waiter: Waiter, status: GitStatus): void {
  if (waiter.location === 'settled') return
  detachWaiter(waiter)
  waiter.resolvePromise(status)
  releaseIfIdle(waiter.resource)
}

function rejectWaiter(waiter: Waiter, error: unknown): void {
  if (waiter.location === 'settled') return
  detachWaiter(waiter)
  waiter.rejectPromise(error)
  releaseIfIdle(waiter.resource)
}

function createWaiter(resource: Resource, signal?: AbortSignal): WaiterPromise {
  const { promise, resolve, reject } = Promise.withResolvers<GitStatus>()
  const waiter: Waiter = {
    resource,
    resolvePromise: resolve,
    rejectPromise: reject,
    ...(signal ? { signal } : {}),
    location: 'unattached',
    flight: null
  }
  if (signal) {
    waiter.abortListener = () => rejectWaiter(waiter, abortError())
    signal.addEventListener('abort', waiter.abortListener, { once: true })
  }
  return { waiter, promise }
}

function abortError(): Error {
  const error = new Error('The status read was cancelled.')
  error.name = 'AbortError'
  return error
}

function attachPending(resource: Resource, waiter: Waiter): void {
  waiter.location = 'pending'
  waiter.flight = null
  resource.pendingWaiters.add(waiter)
}

function attachFlight(flight: Flight, waiter: Waiter): void {
  waiter.location = 'flight'
  waiter.flight = flight
  flight.waiters.add(waiter)
}

function transferFlightWaiters(resource: Resource, flight: Flight): void {
  for (const waiter of flight.waiters) {
    flight.waiters.delete(waiter)
    attachPending(resource, waiter)
  }
}

function notify(resource: Resource, result: StatusResult): void {
  for (const consumer of resource.consumers) consumer.listener(result)
}

function clearTrailingTimer(resource: Resource): void {
  clearTimeout(resource.trailingTimer)
  resource.trailingTimer = undefined
}

function scheduleTrailing(resource: Resource, deadline: number): void {
  if (resource.released || resource.trailingTimer !== undefined) return
  resource.trailingTimer = setTimeout(() => {
    resource.trailingTimer = undefined
    ensureAutomaticRead(resource)
  }, Math.max(0, deadline - Date.now()))
}

function ensureAutomaticRead(resource: Resource): void {
  if (resource.released || resource.inFlight || resource.pendingFresh || !resource.dirty || resource.connectionState === 'reconnecting') return
  const lastStartedAt = resource.clock.lastStartedAt
  const deadline = lastStartedAt === null ? Date.now() : lastStartedAt + STATUS_START_SPACING_MS
  if (deadline <= Date.now()) dispatch(resource)
  else scheduleTrailing(resource, deadline)
}

function invalidate(resource: Resource): void {
  if (resource.released) return
  resource.dirtyVersion += 1
  resource.dirty = true
  ensureAutomaticRead(resource)
}

function syncPoll(resource: Resource): void {
  let shortest: number | null = null
  for (const consumer of resource.consumers) {
    const pollMs = Math.max(1, consumer.pollMs)
    shortest = shortest === null ? pollMs : Math.min(shortest, pollMs)
  }
  if (shortest === resource.pollMs) return
  clearInterval(resource.pollTimer)
  resource.pollTimer = undefined
  resource.pollMs = shortest
  if (shortest === null) return
  const tick = () => {
    if (resource.released || resource.clock.lastStartedAt === Date.now()) return
    invalidate(resource)
  }
  const lastStart = resource.clock.lastStartedAt
  const delay = lastStart === null ? shortest : Math.max(0, lastStart + shortest - Date.now())
  if (delay === shortest) resource.pollTimer = setInterval(tick, shortest)
  else resource.pollTimer = setTimeout(() => {
    resource.pollTimer = setInterval(tick, shortest)
    tick()
  }, delay)
}

function dispatch(resource: Resource): void {
  if (resource.released || resource.inFlight || resource.connectionState === 'reconnecting') return
  if (resource.consumers.size === 0 && waiterCount(resource) === 0) {
    releaseIfIdle(resource)
    return
  }
  clearTrailingTimer(resource)
  resource.pendingFresh = false
  resource.failedRead = false
  resource.dirty = false
  resource.snapshot = null
  const flight: Flight = {
    generation: resource.generation,
    connectionGeneration: resource.connectionGeneration,
    dirtyVersion: resource.dirtyVersion,
    unverifiedStart: resource.connectionState === 'unknown',
    waiters: new Set()
  }
  for (const waiter of resource.pendingWaiters) {
    resource.pendingWaiters.delete(waiter)
    attachFlight(flight, waiter)
  }
  resource.clock.lastStartedAt = Date.now()
  resource.inFlight = flight
  try {
    void resource.owner.call('quirky.git/status', { worktree: resource.worktree }).then(
      (status) => completeSuccess(resource, flight, status as GitStatus),
      (error: unknown) => completeFailure(resource, flight, error)
    )
  } catch (error) {
    completeFailure(resource, flight, error)
  }
}

function completeSuccess(resource: Resource, flight: Flight, status: GitStatus): void {
  if (resource.released || resource.inFlight !== flight || resource.generation !== flight.generation) return
  resource.inFlight = null
  if (resource.connectionState === 'reconnecting' || resource.connectionGeneration !== flight.connectionGeneration) {
    transferFlightWaiters(resource, flight)
    resource.dirty = true
    if (resource.connectionState === 'connected') ensureAutomaticRead(resource)
    return
  }

  resource.failedRead = false
  if (flight.unverifiedStart && resource.connectionState === 'unknown') resource.connectionState = 'connected'
  resource.snapshot = { status, receivedAt: Date.now(), connectionGeneration: resource.connectionGeneration }
  resource.dirty = resource.dirtyVersion !== flight.dirtyVersion
  notify(resource, { status, error: null })
  for (const waiter of flight.waiters) resolveWaiter(waiter, status)
  if (resource.released) return
  if (resource.dirty || resource.pendingWaiters.size > 0) {
    resource.dirty = true
    ensureAutomaticRead(resource)
  }
}

function completeFailure(resource: Resource, flight: Flight, error: unknown): void {
  if (resource.released || resource.inFlight !== flight || resource.generation !== flight.generation) return
  resource.inFlight = null
  if (resource.connectionState === 'reconnecting' || resource.connectionGeneration !== flight.connectionGeneration) {
    transferFlightWaiters(resource, flight)
    resource.dirty = true
    if (resource.connectionState === 'connected') ensureAutomaticRead(resource)
    return
  }

  resource.snapshot = null
  resource.failedRead = true
  resource.dirty = resource.dirtyVersion !== flight.dirtyVersion
  if (flight.unverifiedStart && resource.connectionState === 'connected') recoverConnection(resource)
  notify(resource, { status: null, error })
  for (const waiter of flight.waiters) rejectWaiter(waiter, error)
  if (resource.released) return
  if (resource.dirty || resource.pendingWaiters.size > 0) {
    resource.dirty = true
    ensureAutomaticRead(resource)
  }
}

function queueFreshDispatch(resource: Resource): void {
  if (resource.dispatchQueued) return
  resource.dispatchQueued = true
  queueMicrotask(() => {
    resource.dispatchQueued = false
    if (resource.released || !resource.pendingFresh) return
    if (resource.connectionState === 'reconnecting') return
    resource.pendingFresh = false
    dispatch(resource)
  })
}

function requestFresh(resource: Resource, waiter: Waiter): void {
  attachPending(resource, waiter)
  resource.generation += 1
  const flight = resource.inFlight
  if (flight) {
    resource.inFlight = null
    transferFlightWaiters(resource, flight)
  }
  resource.snapshot = null
  clearTrailingTimer(resource)
  resource.pendingFresh = true
  queueFreshDispatch(resource)
}

function recoverConnection(resource: Resource): void {
  resource.connectionGeneration += 1
  resource.generation += 1
  resource.snapshot = null
  resource.dirtyVersion += 1
  resource.dirty = true
  clearTrailingTimer(resource)
  if (resource.inFlight) {
    const flight = resource.inFlight
    resource.inFlight = null
    transferFlightWaiters(resource, flight)
  }
  resource.pendingFresh = true
  queueFreshDispatch(resource)
}


export function subscribeWindowStatus(
  context: UiPluginContext,
  worktree: string,
  pollMs: number,
  listener: StatusListener
): () => void {
  const resource = resourceFor(context, worktree)
  const consumer: Consumer = { pollMs, listener }
  resource.consumers.add(consumer)
  syncPoll(resource)

  const snapshot = resource.snapshot
  if (snapshot && !resource.dirty && !resource.inFlight && !resource.pendingFresh &&
      snapshot.connectionGeneration === resource.connectionGeneration && Date.now() - snapshot.receivedAt <= SNAPSHOT_REUSE_MS) {
    listener({ status: snapshot.status, error: null })
  } else if (!resource.inFlight && !resource.pendingFresh && !resource.dirty) {
    invalidate(resource)
  } else {
    ensureAutomaticRead(resource)
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    resource.consumers.delete(consumer)
    syncPoll(resource)
    releaseIfIdle(resource)
  }
}

export function readWindowStatus(
  context: UiPluginContext,
  worktree: string,
  options: { fresh: boolean; signal?: AbortSignal }
): Promise<GitStatus> {
  if (options.signal?.aborted) return Promise.reject(abortError())
  const resource = resourceFor(context, worktree)
  const { waiter, promise } = createWaiter(resource, options.signal)
  if (options.fresh) {
    requestFresh(resource, waiter)
    return promise
  }

  const snapshot = resource.snapshot
  if (!resource.dirty && !resource.inFlight && !resource.pendingFresh && snapshot &&
      snapshot.connectionGeneration === resource.connectionGeneration && Date.now() - snapshot.receivedAt <= SNAPSHOT_REUSE_MS) {
    resolveWaiter(waiter, snapshot.status)
    return promise
  }
  if (resource.inFlight && !resource.dirty && !resource.pendingFresh) attachFlight(resource.inFlight, waiter)
  else {
    attachPending(resource, waiter)
    if (!resource.inFlight && !resource.pendingFresh) {
      if (!resource.dirty) {
        resource.dirtyVersion += 1
        resource.dirty = true
      }
      ensureAutomaticRead(resource)
    }
  }
  return promise
}
