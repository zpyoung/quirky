import type { MobileCallOptions, MobileConnectionState, MobileNativeActions, MobilePageInit, MobileRoute, MobileRpc, MobileStorage } from '../contracts'
import { MOBILE_BRIDGE_MAX_BYTES } from '../contracts'
import { encodeBase64 } from './generation'
import { isPageMutation, refreshedTerminalArtifactGrant, sanitizeConnectionState, utf8ByteLength, validatePageInit, validatePageReport, validatePageRpc, validateRoute } from './bridge-policy'
import { safeExternalUrl } from './shell-security'

const MAX_TIMEOUT_MS = 30_000
const STREAM_FRAME_BYTES = 48 * 1024
const STORAGE_PREFIX = 'quirky.mobile.page'
const MAX_PENDING_PAGE_REQUESTS = 128
const MAX_ACTIVE_PAGE_STREAMS = 32

export type BridgeHostOptions = {
  init: MobilePageInit
  rpc: MobileRpc
  storage: MobileStorage
  native: Pick<MobileNativeActions, 'clipboardRead' | 'clipboardWrite' | 'openExternal' | 'haptic'>
  sendToPage(json: string): void | Promise<void>
  onNavigate(route: MobileRoute | { kind: 'home' }): void | Promise<void>
  rememberWorkspace(hostId: string, worktreeId: string): Promise<void>
  onReport?(state: Record<string, unknown>): void
}

export type PageBridgeHost = {
  receive(json: string): void
  setRpc(rpc: MobileRpc): void
  close(): void
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function safeError(error: unknown): string {
  const source = error instanceof Error ? error.message : 'Page request failed'
  return source.replace(/\b[0-9a-f]{48}\b/gi, '[redacted]').replace(/(?:token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, '[redacted]').slice(0, 512)
}

function safeResponse(value: unknown): unknown {
  const result = value === undefined ? null : value
  const json = JSON.stringify(result)
  if (json === undefined || utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES - 2048) throw new Error('Quirky response exceeds the page bridge limit')
  return result
}

function exactEnvelope(value: unknown, keys: readonly string[]): value is JsonRecord {
  return isRecord(value) && exactKeys(value, keys) && value.v === 1 && typeof value.kind === 'string'
}

function rawStorageKey(hostId: string, key: string): string {
  return `${STORAGE_PREFIX}:${hostId}:${key}`
}

const RESOURCE_CLEANUP_TIMEOUT_MS = 5_000
const TERMINAL_ATTACH = 'quirky.terminal/attach'
const TERMINAL_DETACH = 'quirky.terminal/detach'
const BROWSER_WATCH_CREATE = 'quirky.mobile/browserWatchCreate'
const BROWSER_WATCH_START = 'quirky.mobile/browserWatchStart'
const BROWSER_WATCH_STOP = 'quirky.mobile/browserWatchStop'

type ResourceOwner = { closed: boolean; resources: Set<BridgeResource> }
type ResourceBase = {
  ledger: ResourceLedger
  owners: Set<ResourceOwner>
  releaseRequested: boolean
  cleanupAttempted: boolean
  cleanupInFlight: boolean
  cleanupPromise?: Promise<void>
}
type TerminalStreamResource = ResourceBase & { kind: 'terminal'; streamId: number }
type BrowserWatchResource = ResourceBase & { kind: 'watch'; worktreeId: string; tabId: string; watchId: string }
type BridgeResource = TerminalStreamResource | BrowserWatchResource
type ResourceLedger = {
  rpc: MobileRpc
  terminal: Map<number, TerminalStreamResource>
  watches: Map<string, BrowserWatchResource>
  pendingWatchStarts: Map<string, Set<object>>
}
type BrowserWatchIdentity = { worktreeId: string; tabId: string; watchId: string }

const resourceLedgers = new WeakMap<MobileRpc, ResourceLedger>()

function ledgerFor(rpc: MobileRpc): ResourceLedger {
  let ledger = resourceLedgers.get(rpc)
  if (!ledger) {
    ledger = { rpc, terminal: new Map(), watches: new Map(), pendingWatchStarts: new Map() }
    resourceLedgers.set(rpc, ledger)
  }
  return ledger
}

function watchTabKey(worktreeId: string, tabId: string): string {
  return JSON.stringify([worktreeId, tabId])
}

function watchLeaseKey(worktreeId: string, tabId: string, watchId: string): string {
  return JSON.stringify([worktreeId, tabId, watchId])
}

function hasPendingWatchStart(ledger: ResourceLedger, worktreeId: string, tabId: string, except?: object): boolean {
  const pending = ledger.pendingWatchStarts.get(watchTabKey(worktreeId, tabId))
  return !!pending && [...pending].some((reservation) => reservation !== except)
}

function removeResource(entry: BridgeResource): void {
  for (const owner of entry.owners) owner.resources.delete(entry)
  entry.owners.clear()
  if (entry.kind === 'terminal') {
    if (entry.ledger.terminal.get(entry.streamId) === entry) entry.ledger.terminal.delete(entry.streamId)
  } else {
    const key = watchLeaseKey(entry.worktreeId, entry.tabId, entry.watchId)
    if (entry.ledger.watches.get(key) === entry) entry.ledger.watches.delete(key)
  }
}

function beginTerminalRelease(entry: TerminalStreamResource): Promise<void> {
  if (entry.owners.size > 0 || entry.cleanupInFlight || entry.cleanupAttempted) {
    return entry.cleanupPromise ?? Promise.resolve()
  }
  entry.releaseRequested = true
  entry.cleanupAttempted = true
  entry.cleanupInFlight = true
  const cleanup = Promise.resolve().then(async () => {
    try {
      const result: unknown = await entry.ledger.rpc.call(TERMINAL_DETACH, { streamId: entry.streamId }, { timeoutMs: RESOURCE_CLEANUP_TIMEOUT_MS })
      if (isRecord(result) && result.ok === true) removeResource(entry)
    } catch {}
    finally {
      entry.cleanupInFlight = false
      entry.cleanupPromise = undefined
    }
  })
  entry.cleanupPromise = cleanup
  return cleanup
}

function beginWatchRelease(entry: BrowserWatchResource): Promise<void> {
  if (entry.owners.size > 0 || hasPendingWatchStart(entry.ledger, entry.worktreeId, entry.tabId) ||
    entry.cleanupInFlight || entry.cleanupAttempted) return entry.cleanupPromise ?? Promise.resolve()
  entry.releaseRequested = true
  entry.cleanupAttempted = true
  entry.cleanupInFlight = true
  const cleanup = Promise.resolve().then(async () => {
    try {
      const result: unknown = await entry.ledger.rpc.call(BROWSER_WATCH_STOP, {
        worktree: entry.worktreeId, tabId: entry.tabId, watchId: entry.watchId
      }, { timeoutMs: RESOURCE_CLEANUP_TIMEOUT_MS })
      if (isRecord(result) && result.closed === true) removeResource(entry)
    } catch {}
    finally {
      entry.cleanupInFlight = false
      entry.cleanupPromise = undefined
    }
  })
  entry.cleanupPromise = cleanup
  return cleanup
}

function releaseResource(entry: BridgeResource, owner: ResourceOwner): Promise<void> {
  if (!entry.owners.delete(owner)) return Promise.resolve()
  owner.resources.delete(entry)
  entry.releaseRequested = true
  return entry.kind === 'terminal' ? beginTerminalRelease(entry) : beginWatchRelease(entry)
}


function addResourceOwner(entry: BridgeResource, owner: ResourceOwner): void {
  if (owner.closed || entry.cleanupInFlight) return
  entry.owners.add(owner)
  owner.resources.add(entry)
  entry.releaseRequested = false
  entry.cleanupAttempted = false
}

function reserveWatchStart(ledger: ResourceLedger, worktreeId: string, tabId: string): object {
  const key = watchTabKey(worktreeId, tabId)
  const reservations = ledger.pendingWatchStarts.get(key) ?? new Set<object>()
  const reservation = {}
  reservations.add(reservation)
  ledger.pendingWatchStarts.set(key, reservations)
  return reservation
}

function finishWatchStart(ledger: ResourceLedger, worktreeId: string, tabId: string, reservation: object): void {
  const key = watchTabKey(worktreeId, tabId)
  const reservations = ledger.pendingWatchStarts.get(key)
  reservations?.delete(reservation)
  if (reservations?.size === 0) ledger.pendingWatchStarts.delete(key)
  for (const entry of ledger.watches.values()) {
    if (entry.worktreeId === worktreeId && entry.tabId === tabId && entry.releaseRequested) void beginWatchRelease(entry)
  }
}

async function waitForWatchCleanup(ledger: ResourceLedger, worktreeId: string, tabId: string): Promise<void> {
  const cleanups = [...ledger.watches.values()]
    .filter((entry) => entry.worktreeId === worktreeId && entry.tabId === tabId && entry.cleanupInFlight && entry.cleanupPromise)
    .map((entry) => entry.cleanupPromise!)
  await Promise.all(cleanups)
}

function browserWatchIdentity(method: string, params: Record<string, unknown>, value: unknown): BrowserWatchIdentity | null {
  if (!isRecord(value) || !isRecord(value.tab) || typeof params.worktree !== 'string' ||
    typeof value.watchId !== 'string' || value.watchId.length === 0 || value.watchId.length > 128 ||
    value.tab.kind !== 'browser' || value.tab.browserMode !== 'watch' ||
    typeof value.tab.worktreeId !== 'string' || value.tab.worktreeId.length === 0 || value.tab.worktreeId.length > 1024 ||
    value.tab.worktreeId !== params.worktree ||
    typeof value.tab.tabId !== 'string' || value.tab.tabId.length === 0 || value.tab.tabId.length > 128) return null
  if (method === BROWSER_WATCH_START && value.tab.tabId !== params.tabId) return null
  return { worktreeId: value.tab.worktreeId, tabId: value.tab.tabId, watchId: value.watchId }
}

function trackTerminalAcquisition(
  ledger: ResourceLedger,
  owner: ResourceOwner,
  streamId: number,
  canOwn: boolean
): TerminalStreamResource {
  let entry = ledger.terminal.get(streamId)
  if (!entry) {
    entry = {
      kind: 'terminal', ledger, streamId, owners: new Set(), releaseRequested: false,
      cleanupAttempted: false, cleanupInFlight: false
    }
    ledger.terminal.set(streamId, entry)
  }
  if (canOwn) addResourceOwner(entry, owner)
  else if (entry.owners.size === 0) {
    if (!entry.cleanupInFlight) entry.cleanupAttempted = false
    entry.releaseRequested = true
    void beginTerminalRelease(entry)
  }
  return entry
}

function trackBrowserWatchAcquisition(
  ledger: ResourceLedger,
  owner: ResourceOwner,
  identity: BrowserWatchIdentity,
  canOwn: boolean,
  currentReservation?: object
): BrowserWatchResource {
  const key = watchLeaseKey(identity.worktreeId, identity.tabId, identity.watchId)
  let entry = ledger.watches.get(key)
  if (!entry) {
    entry = {
      kind: 'watch', ledger, ...identity, owners: new Set(), releaseRequested: false,
      cleanupAttempted: false, cleanupInFlight: false
    }
    ledger.watches.set(key, entry)
  }
  if (canOwn) addResourceOwner(entry, owner)
  else if (entry.owners.size === 0) {
    if (!entry.cleanupInFlight) entry.cleanupAttempted = false
    entry.releaseRequested = true
    if (!hasPendingWatchStart(ledger, identity.worktreeId, identity.tabId, currentReservation)) void beginWatchRelease(entry)
  }
  return entry
}

function releaseOwnerResources(owner: ResourceOwner, rpc?: MobileRpc): void {
  for (const entry of [...owner.resources]) {
    if (rpc !== undefined && entry.ledger.rpc !== rpc) continue
    releaseResource(entry, owner)
  }
}
export function createBridgeHost(options: BridgeHostOptions): PageBridgeHost {
  let rpc = options.rpc
  let rpcEpoch = 0
  let ready = false
  let closed = false
  let init = { ...options.init, connectionState: sanitizeConnectionState(rpc.state) }
  let artifactGrant = init.route.kind === 'terminal-artifact' ? init.route.grant : undefined
  validatePageInit(init)
  const activeStreams = new Set<number>()
  const streamSubscriptions = new Map<number, () => void>()
  const pendingRequests = new Map<string, { kind: 'rpc' | 'other'; resource?: BridgeResource }>()
  const resourceOwner: ResourceOwner = { closed: false, resources: new Set() }
  let pendingStreamAttachments = 0
  let stopState: (() => void) | undefined
  let rememberedWorktreeId = init.host.lastWorktree ?? null

  function send(value: JsonRecord): boolean | Promise<boolean> {
    if (closed || !ready) return false
    const json = JSON.stringify(value)
    if (json === undefined || utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES) return false
    try {
      const delivered = options.sendToPage(json)
      if (delivered === undefined) return !closed
      return delivered.then(() => !closed, () => false)
    } catch {
      return false
    }
  }

  function sendReply(requestId: string, result: unknown): boolean | Promise<boolean> {
    try {
      const safe = safeResponse(result)
      return send({ v: 1, kind: 'reply', sessionId: init.sessionId, requestId, ok: true, result: safe })
    } catch (error) {
      send({ v: 1, kind: 'reply', sessionId: init.sessionId, requestId, ok: false, error: { message: safeError(error) } })
      return false
    }
  }


  function sendError(requestId: string, error: unknown): void {
    send({ v: 1, kind: 'reply', sessionId: init.sessionId, requestId, ok: false, error: { message: safeError(error) } })
  }

  function reportState(value: MobileConnectionState): void {
    let state: MobileConnectionState
    try { state = sanitizeConnectionState(value) } catch { return }
    if (state.phase !== 'connected') {
      for (const stop of streamSubscriptions.values()) stop()
      streamSubscriptions.clear()
      activeStreams.clear()
    }
    send({ v: 1, kind: 'state', sessionId: init.sessionId, state })
  }

  function clearStreams(): void {
    for (const stop of streamSubscriptions.values()) stop()
    streamSubscriptions.clear()
    activeStreams.clear()
  }
  function clearLocalStream(streamId: number): void {
    activeStreams.delete(streamId)
    streamSubscriptions.get(streamId)?.()
    streamSubscriptions.delete(streamId)
  }

  function bindRpc(next: MobileRpc): void {
    if (closed || rpc === next && stopState) return
    const previous = rpc
    stopState?.()
    stopState = undefined
    clearStreams()
    releaseOwnerResources(resourceOwner, previous)
    for (const [requestId, pending] of pendingRequests) {
      if (pending.kind !== 'rpc') continue
      pendingRequests.delete(requestId)
      sendError(requestId, new Error('connection changed before the operation completed; retry explicitly if needed'))
    }
    rpc = next
    rpcEpoch++
    stopState = rpc.onState(reportState)
    reportState(rpc.state)
  }

  function replyRequest(requestId: unknown, operation: () => unknown | Promise<unknown>, rpcBound = false): void {
    if (!isRequestId(requestId) || pendingRequests.has(requestId)) return
    if (pendingRequests.size >= MAX_PENDING_PAGE_REQUESTS) {
      sendError(requestId, new Error('page bridge request limit reached'))
      return
    }
    pendingRequests.set(requestId, { kind: rpcBound ? 'rpc' : 'other' })
    void Promise.resolve().then(operation).then(async (value) => {
      const pending = pendingRequests.get(requestId)
      if (!pending) return
      pendingRequests.delete(requestId)
      if (!await sendReply(requestId, value) && pending.resource) {
        const resource = pending.resource
        const cleanup = releaseResource(resource, resourceOwner)
        if (resource.kind === 'terminal') clearLocalStream(resource.streamId)
        await cleanup
      }
    }, (error: unknown) => {
      if (!pendingRequests.delete(requestId)) return
      sendError(requestId, error)
    })
  }

  async function invokeRpc(message: JsonRecord): Promise<unknown> {
    const requestId = message.requestId as string
    const method = message.method as string
    const params = message.params as Record<string, unknown>
    const artifactGrantAtStart = artifactGrant
    validatePageRpc(method, params, init.grants, init.route, artifactGrantAtStart)
    if (isPageMutation(method, params) && rpc.state.phase !== 'connected') throw new Error('mutations require a connected desktop')
    const timeoutMs = message.timeoutMs
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_TIMEOUT_MS)) throw new Error('page RPC timeout is invalid')
    const active = rpc
    const epoch = rpcEpoch
    const ledger = ledgerFor(active)
    const attaching = method === TERMINAL_ATTACH
    if (attaching && activeStreams.size + pendingStreamAttachments >= MAX_ACTIVE_PAGE_STREAMS) throw new Error('page stream limit reached')
    const startWorktree = method === BROWSER_WATCH_START && typeof params.worktree === 'string' ? params.worktree : undefined
    const startTab = method === BROWSER_WATCH_START && typeof params.tabId === 'string' ? params.tabId : undefined
    const reservation = startWorktree !== undefined && startTab !== undefined
      ? reserveWatchStart(ledger, startWorktree, startTab)
      : undefined
    let explicitResource: BridgeResource | undefined
    let finishExplicitResource: (() => void) | undefined
    if (method === TERMINAL_DETACH) {
      const streamId = params.streamId
      const resource = typeof streamId === 'number' ? ledger.terminal.get(streamId) : undefined
      if (!resource || !resource.owners.has(resourceOwner)) throw new Error('page does not own this terminal stream')
      if (resource.cleanupInFlight) throw new Error('terminal stream detach is already in progress')
      if (resource.owners.size > 1) throw new Error('terminal stream is still owned by another page')
      resource.cleanupAttempted = true
      resource.cleanupInFlight = true
      explicitResource = resource
    }
    if (method === BROWSER_WATCH_STOP) {
      const worktreeId = params.worktree
      const tabId = params.tabId
      const watchId = params.watchId
      if (typeof worktreeId !== 'string' || typeof tabId !== 'string' || typeof watchId !== 'string') throw new Error('page Watch stop identity is invalid')
      const resource = ledger.watches.get(watchLeaseKey(worktreeId, tabId, watchId))
      if (!resource || !resource.owners.has(resourceOwner)) throw new Error('page does not own this Browser Watch lease')
      if (resource.cleanupInFlight) throw new Error('Browser Watch stop is already in progress')
      // `closed: false` means this page released its reference; another owner still holds the lease.
      if (resource.owners.size > 1 || hasPendingWatchStart(ledger, worktreeId, tabId)) {
        releaseResource(resource, resourceOwner)
        return { closed: false }
      }
      resource.cleanupAttempted = true
      resource.cleanupInFlight = true
      explicitResource = resource
    }
    if (explicitResource) {
      const completion = Promise.withResolvers<void>()
      explicitResource.cleanupPromise = completion.promise
      finishExplicitResource = completion.resolve
    }
    if (attaching) pendingStreamAttachments++
    let result: unknown
    let acquired: BridgeResource | undefined
    try {
      if (reservation && startWorktree !== undefined && startTab !== undefined) {
        await waitForWatchCleanup(ledger, startWorktree, startTab)
        if (closed || active !== rpc || epoch !== rpcEpoch) throw new Error('connection changed before the operation completed; retry explicitly if needed')
      }
      result = await active.call(method, params, { requestId, timeoutMs: (timeoutMs as number | undefined) ?? MAX_TIMEOUT_MS })

      const canOwn = !closed && active === rpc && epoch === rpcEpoch
      if (attaching && isRecord(result) && Number.isSafeInteger(result.streamId) && typeof result.streamId === 'number' && result.streamId > 0) {
        const resource = trackTerminalAcquisition(ledger, resourceOwner, result.streamId, canOwn)
        if (canOwn && resource.owners.has(resourceOwner)) {
          activeStreams.add(result.streamId)
          acquired = resource
        }
      }
      if (method === BROWSER_WATCH_CREATE || method === BROWSER_WATCH_START) {
        const identity = browserWatchIdentity(method, params, result)
        if (identity) {
          const resource = trackBrowserWatchAcquisition(ledger, resourceOwner, identity, canOwn, reservation)
          if (canOwn && resource.owners.has(resourceOwner)) acquired = resource
        }
      }
      if (explicitResource) {
        const acknowledged = explicitResource.kind === 'terminal'
          ? isRecord(result) && result.ok === true
          : isRecord(result) && result.closed === true
        if (acknowledged) {
          if (explicitResource.kind === 'terminal' && active === rpc && epoch === rpcEpoch) clearLocalStream(explicitResource.streamId)
          removeResource(explicitResource)
        }
      }
      if (method === 'quirky.terminal/artifacts' && params.action === 'refresh' &&
        params.grant === artifactGrantAtStart && artifactGrant === artifactGrantAtStart && active.state.phase === 'connected') {
        const nextGrant = refreshedTerminalArtifactGrant(init.route, result)
        if (nextGrant && nextGrant !== artifactGrant) artifactGrant = nextGrant
      }
      if (acquired) {
        const pending = pendingRequests.get(requestId)
        if (pending?.kind === 'rpc') pending.resource = acquired
      }
      if (closed || active !== rpc || epoch !== rpcEpoch) throw new Error('connection changed before the operation completed; retry explicitly if needed')
      return result
    } finally {
      if (explicitResource) {
        explicitResource.cleanupInFlight = false
        explicitResource.cleanupPromise = undefined
        finishExplicitResource?.()
      }
      if (attaching) pendingStreamAttachments--
      if (reservation && startWorktree !== undefined && startTab !== undefined) {
        finishWatchStart(ledger, startWorktree, startTab, reservation)
      }
    }
  }

  function subscribeStream(streamId: number): void {
    if (!init.grants.includes('terminal') || !activeStreams.has(streamId) || streamSubscriptions.has(streamId)) throw new Error('page stream is unavailable')
    streamSubscriptions.set(streamId, rpc.onStream(streamId, (bytes) => {
      if (closed || rpc.state.phase !== 'connected' || !activeStreams.has(streamId)) return
      for (let offset = 0; offset < bytes.byteLength; offset += STREAM_FRAME_BYTES) {
        const data = encodeBase64(bytes.subarray(offset, Math.min(offset + STREAM_FRAME_BYTES, bytes.byteLength)))
        try { send({ v: 1, kind: 'stream', sessionId: init.sessionId, streamId, data }) } catch { return }
      }
    }))
  }

  function handleStorage(message: JsonRecord): unknown | Promise<unknown> {
    if (!init.grants.includes('storage') || typeof message.operation !== 'string' || typeof message.key !== 'string' ||
      message.key.length === 0 || message.key.length > 1024) throw new Error('page storage request is unavailable')
    const key = rawStorageKey(init.host.id, message.key)
    if (message.operation === 'get' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'operation', 'key'])) return options.storage.get(key)
    if (message.operation === 'set' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'operation', 'key', 'value']) &&
      typeof message.value === 'string' && utf8ByteLength(message.value) <= MOBILE_BRIDGE_MAX_BYTES) return options.storage.set(key, message.value)
    if (message.operation === 'remove' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'operation', 'key'])) return options.storage.remove(key)
    throw new Error('page storage request is invalid')
  }

  function handleNative(message: JsonRecord): unknown | Promise<unknown> {
    if (typeof message.action !== 'string') throw new Error('page native action is invalid')
    if (message.action === 'clipboardRead' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'action']) && init.grants.includes('clipboard.read')) return options.native.clipboardRead()
    if (message.action === 'clipboardWrite' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'action', 'text']) && init.grants.includes('clipboard.write') &&
      typeof message.text === 'string' && utf8ByteLength(message.text) <= MOBILE_BRIDGE_MAX_BYTES) return options.native.clipboardWrite(message.text)
    if (message.action === 'openExternal' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'action', 'url']) && init.grants.includes('externalLink')) {
      const url = safeExternalUrl(message.url)
      if (!url) throw new Error('only valid http(s) links can be opened')
      return options.native.openExternal(url)
    }
    if (message.action === 'haptic' && exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'action']) && init.grants.includes('haptics')) return options.native.haptic()
    throw new Error('page native action is unavailable')
  }

  function handleNavigate(message: JsonRecord): Promise<void> | void {
    if (!init.grants.includes('navigate') || !exactKeys(message, ['v', 'kind', 'sessionId', 'requestId', 'route']) || !isRecord(message.route)) throw new Error('page navigation is unavailable')
    validateRoute(message.route as MobileRoute | { kind: 'home' })
    return options.onNavigate(message.route as MobileRoute | { kind: 'home' })
  }

  function receive(json: string): void {
    if (closed || typeof json !== 'string' || utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES) return
    let value: unknown
    try { value = JSON.parse(json) as unknown } catch { return }
    if (!isRecord(value) || value.v !== 1 || typeof value.kind !== 'string') return
    if (value.kind === 'ready') {
      if (!exactKeys(value, ['v', 'kind']) || ready) return
      ready = true
      send({ v: 1, kind: 'init', sessionId: init.sessionId, init })
      return
    }
    if (!ready || value.sessionId !== init.sessionId) return
    if (value.kind === 'call') {
      if (!exactKeys(value, ['v', 'kind', 'sessionId', 'requestId', 'method', 'params', ...(value.timeoutMs === undefined ? [] : ['timeoutMs'])])) return
      replyRequest(value.requestId, () => invokeRpc(value), true)
      return
    }
    if (value.kind === 'storage' || value.kind === 'native' || value.kind === 'navigate') {
      const expectedKeys = value.kind === 'storage' ? ['v', 'kind', 'sessionId', 'requestId', 'operation', 'key', ...(value.operation === 'set' ? ['value'] : [])] :
        value.kind === 'navigate' ? ['v', 'kind', 'sessionId', 'requestId', 'route'] :
          ['v', 'kind', 'sessionId', 'requestId', 'action', ...(value.action === 'clipboardWrite' ? ['text'] : value.action === 'openExternal' ? ['url'] : [])]
      if (!exactKeys(value, expectedKeys)) return
      const handler = value.kind === 'storage' ? () => handleStorage(value) : value.kind === 'native' ? () => handleNative(value) : () => handleNavigate(value)
      replyRequest(value.requestId, handler)
      return
    }
    if (value.kind === 'report') {
      if (!exactKeys(value, ['v', 'kind', 'sessionId', 'state'])) return
      try {
        validatePageReport(value.state)
        const state = value.state as Record<string, unknown>
        if (typeof state.worktreeId === 'string' && state.worktreeId !== rememberedWorktreeId) {
          rememberedWorktreeId = state.worktreeId
          void options.rememberWorkspace(init.host.id, state.worktreeId).catch(() => {})
        }
        options.onReport?.(state)
      } catch {}
      return
    }
    if (value.kind === 'stream-subscribe' || value.kind === 'stream-unsubscribe') {
      if (!exactKeys(value, ['v', 'kind', 'sessionId', 'streamId']) || !Number.isSafeInteger(value.streamId) || (value.streamId as number) <= 0) return
      const streamId = value.streamId as number
      if (value.kind === 'stream-subscribe') {
        try { subscribeStream(streamId) } catch {
          send({ v: 1, kind: 'stream-error', sessionId: init.sessionId, streamId })
        }
      } else {
        streamSubscriptions.get(streamId)?.()
        streamSubscriptions.delete(streamId)
      }
    }
  }

  bindRpc(rpc)

  return {
    receive,
    setRpc(next) {
      if (closed || next === rpc) return
      bindRpc(next)
    },
    close() {
      if (closed) return
      closed = true
      stopState?.()
      stopState = undefined
      clearStreams()
      pendingRequests.clear()
      ready = false
      resourceOwner.closed = true
      releaseOwnerResources(resourceOwner)
    }
  }
}
