import type {
  MobileConnectionState,
  MobileHost,
  MobileLogEntry,
  MobileNativeActions,
  MobilePreferences,
  MobileRpc,
  MobileRuntime,
  MobileSecretStorage,
  MobileStorage
} from '../contracts'
import { createMobileRpc, MobileRpcError, type MobileRpcClientOptions, type MobileWebSocketConstructor } from '../transport/client'
import { decodeBase64, sha256 } from '../transport/crypto'
import { normalizeEditedEndpoint, parseMobileOffer } from './pairing'
import type { MobilePairOffer } from './pairing'

const METADATA_KEY = 'quirky.mobile.runtime.v1'
const MAX_HOSTS = 6
const MAX_LOG_ENTRIES = 200
const MAX_SHORTCUTS = 24
const TERMINAL_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
const RETRY_DELAYS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const
const DEFAULT_PAIRING_TIMEOUT_MS = 25_000
const DEFAULT_CONNECT_TIMEOUT_MS = 12_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PREFERENCES: MobilePreferences = {
  sessionView: 'terminal',
  onboardingCompleted: false,
  notificationChoice: 'unset',
  terminalTextScale: 1,
  autocomplete: false,
  terminalLinkMode: 'phone',
  shortcuts: []
}

export type MobileRuntimeDependencies = {
  storage: MobileStorage
  secrets: MobileSecretStorage
  native: MobileNativeActions
  WebSocket?: MobileWebSocketConstructor
  randomBytes?: MobileRpcClientOptions['randomBytes']
  now?: () => number
  pairingTimeoutMs?: number
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
}
export type MobileRuntimeInstance = MobileRuntime & {
  connectionState(hostId: string): MobileConnectionState
  pendingCredentialCleanup(): Promise<string[]>
  cancelPairing(): void
}

type StoredHost = {
  id: string
  name: string
  personalName: string | null
  machineName: string
  platform: string
  endpoint: string
  publicKeyB64: string
  lastConnected: number | null
  lastWorktree: string | null
  v2Latched: boolean
  createdAt: number
  cleanupPending: boolean
  manualDisconnect: boolean
}
type RuntimeState = {
  v: 1
  hosts: StoredHost[]
  cleanupIds: string[]
  preferences: MobilePreferences
  logs: Record<string, MobileLogEntry[]>
}
type Connection = { rpc: MobileRpc; generation: number }
type OpenedConnection = { rpc: MobileRpc; generation: number; previousGeneration?: number }
type StateUpdate<T> = { next: RuntimeState; result: T }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hex(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

export function mobileHostIdForPublicKey(publicKeyB64: string): string {
  return `host_${hex(sha256(decodeBase64(publicKeyB64, 32)))}`
}

function defaultState(): RuntimeState {
  return { v: 1, hosts: [], cleanupIds: [], preferences: { ...DEFAULT_PREFERENCES, shortcuts: [] }, logs: {} }
}

function safeShortcut(value: unknown): { id: string; label: string; text: string } | null {
  const candidate = record(value)
  if (!candidate || !exactKeys(candidate, ['id', 'label', 'text'])) return null
  if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(candidate.id) ||
    typeof candidate.label !== 'string' || candidate.label.trim().length === 0 || candidate.label.trim().length > 32 ||
    typeof candidate.text !== 'string' || candidate.text.length === 0 || candidate.text.length > 1024) return null
  return { id: candidate.id, label: candidate.label.trim(), text: candidate.text }
}

function validPreferences(value: unknown): MobilePreferences | null {
  const candidate = record(value)
  if (!candidate || !exactKeys(candidate, ['sessionView', 'onboardingCompleted', 'notificationChoice', 'terminalTextScale', 'autocomplete', 'terminalLinkMode', 'shortcuts'])) return null
  if (candidate.sessionView !== 'terminal' || typeof candidate.onboardingCompleted !== 'boolean' ||
    !['unset', 'disabled', 'enabled'].includes(String(candidate.notificationChoice)) ||
    !TERMINAL_SCALES.includes(candidate.terminalTextScale as typeof TERMINAL_SCALES[number]) || typeof candidate.autocomplete !== 'boolean' ||
    (candidate.terminalLinkMode !== 'desktop' && candidate.terminalLinkMode !== 'phone') || !Array.isArray(candidate.shortcuts) || candidate.shortcuts.length > MAX_SHORTCUTS) return null
  const shortcuts = candidate.shortcuts.map(safeShortcut)
  if (shortcuts.some((shortcut) => shortcut === null)) return null
  const ids = new Set<string>()
  for (const shortcut of shortcuts) {
    if (!shortcut || ids.has(shortcut.id)) return null
    ids.add(shortcut.id)
  }
  return {
    sessionView: 'terminal',
    onboardingCompleted: candidate.onboardingCompleted,
    notificationChoice: candidate.notificationChoice as MobilePreferences['notificationChoice'],
    terminalTextScale: candidate.terminalTextScale as MobilePreferences['terminalTextScale'],
    autocomplete: candidate.autocomplete,
    terminalLinkMode: candidate.terminalLinkMode,
    shortcuts: shortcuts as { id: string; label: string; text: string }[]
  }
}

function parseStoredHost(value: unknown): StoredHost | null {
  const candidate = record(value)
  const keys = ['id', 'name', 'personalName', 'machineName', 'platform', 'endpoint', 'publicKeyB64', 'lastConnected', 'lastWorktree', 'v2Latched', 'createdAt', 'cleanupPending', 'manualDisconnect']
  if (!candidate || !exactKeys(candidate, keys)) return null
  if (typeof candidate.id !== 'string' || !/^host_[0-9a-f]{64}$/.test(candidate.id) || typeof candidate.name !== 'string' ||
    typeof candidate.machineName !== 'string' || typeof candidate.platform !== 'string' || typeof candidate.endpoint !== 'string' ||
    typeof candidate.publicKeyB64 !== 'string' || (candidate.personalName !== null && typeof candidate.personalName !== 'string') ||
    (candidate.lastConnected !== null && !isFiniteNumber(candidate.lastConnected)) ||
    (candidate.lastWorktree !== null && typeof candidate.lastWorktree !== 'string') || typeof candidate.v2Latched !== 'boolean' ||
    !isFiniteNumber(candidate.createdAt) || typeof candidate.cleanupPending !== 'boolean' || typeof candidate.manualDisconnect !== 'boolean') return null
  try {
    if (mobileHostIdForPublicKey(candidate.publicKeyB64) !== candidate.id || normalizeEditedEndpoint(candidate.endpoint, candidate.endpoint) !== candidate.endpoint) return null
  } catch { return null }
  if (candidate.name.length > 128 || candidate.machineName.length > 128 || candidate.platform.length > 32 ||
    (typeof candidate.personalName === 'string' && candidate.personalName.length > 64) ||
    (typeof candidate.lastWorktree === 'string' && candidate.lastWorktree.length > 256)) return null
  return candidate as StoredHost
}

function parseLogs(value: unknown): Record<string, MobileLogEntry[]> | null {
  const candidate = record(value)
  if (!candidate) return null
  const logs: Record<string, MobileLogEntry[]> = {}
  for (const [hostId, entries] of Object.entries(candidate)) {
    if (!/^host_[0-9a-f]{64}$/.test(hostId) || !Array.isArray(entries) || entries.length > MAX_LOG_ENTRIES) return null
    const parsed = entries.map((entry) => {
      const item = record(entry)
      if (!item || !exactKeys(item, ['at', 'stage', 'message']) || !isFiniteNumber(item.at) || typeof item.stage !== 'string' || item.stage.length > 32 || typeof item.message !== 'string' || item.message.length > 256) return null
      return { at: item.at, stage: item.stage, message: item.message }
    })
    if (parsed.some((entry) => entry === null)) return null
    logs[hostId] = parsed as MobileLogEntry[]
  }
  return logs
}

function parseState(text: string): RuntimeState {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { throw new Error('Stored mobile metadata is invalid') }
  const candidate = record(value)
  if (!candidate || !exactKeys(candidate, ['v', 'hosts', 'cleanupIds', 'preferences', 'logs']) || candidate.v !== 1 ||
    !Array.isArray(candidate.hosts) || !Array.isArray(candidate.cleanupIds)) throw new Error('Stored mobile metadata is invalid')
  const hosts = candidate.hosts.map(parseStoredHost)
  if (hosts.some((host) => host === null) || hosts.length > MAX_HOSTS * 2) throw new Error('Stored mobile host metadata is invalid')
  const ids = new Set<string>()
  for (const host of hosts) {
    if (!host || ids.has(host.id)) throw new Error('Stored mobile host metadata is invalid')
    ids.add(host.id)
  }
  const cleanupIds = candidate.cleanupIds
  if (cleanupIds.some((id) => typeof id !== 'string' || !/^host_[0-9a-f]{64}$/.test(id)) || new Set(cleanupIds).size !== cleanupIds.length) throw new Error('Stored mobile cleanup metadata is invalid')
  const preferences = validPreferences(candidate.preferences)
  const logs = parseLogs(candidate.logs)
  if (!preferences || !logs) throw new Error('Stored mobile settings are invalid')
  return { v: 1, hosts: hosts as StoredHost[], cleanupIds: cleanupIds as string[], preferences, logs }
}

function publicHost(host: StoredHost): MobileHost {
  return {
    id: host.id,
    name: host.name,
    ...(host.personalName ? { personalName: host.personalName } : {}),
    machineName: host.machineName,
    platform: host.platform,
    endpoint: host.endpoint,
    publicKeyB64: host.publicKeyB64,
    lastConnected: host.lastConnected,
    ...(host.lastWorktree ? { lastWorktree: host.lastWorktree } : {})
  }
}

function validHostInfo(value: unknown): { machineName: string; platform: string } | null {
  const candidate = record(value)
  if (!candidate || !exactKeys(candidate, ['machineName', 'platform', 'deviceScope']) || candidate.deviceScope !== 'mobile' ||
    typeof candidate.machineName !== 'string' || candidate.machineName.trim().length === 0 || candidate.machineName.length > 128 ||
    typeof candidate.platform !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(candidate.platform)) return null
  return { machineName: candidate.machineName.trim(), platform: candidate.platform }
}

function retryDelay(attempt: number): number {
  if (attempt > RETRY_DELAYS.length) return 90_000
  return RETRY_DELAYS[Math.max(attempt - 1, 0)] ?? 90_000
}

function messageForError(error: unknown): string {
  if (error instanceof MobileRpcError) {
    if (error.kind === 'auth-failed') return 'Pairing is invalid; pair this desktop again'
    if (error.kind === 'timeout') return 'The direct connection timed out'
    if (error.kind === 'protocol') return 'The encrypted desktop protocol was invalid'
    if (error.kind === 'closed') return 'The direct connection closed'
  }
  return 'Connection failed; check the desktop address and network'
}


export function createMobileRuntime(dependencies: MobileRuntimeDependencies): MobileRuntimeInstance {
  const now = dependencies.now ?? Date.now
  const WebSocket = dependencies.WebSocket
  const randomBytes = dependencies.randomBytes
  const pairingTimeoutMs = dependencies.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS
  const connectTimeoutMs = dependencies.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const handshakeTimeoutMs = dependencies.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let stateValue: RuntimeState | null = null
  let stateLoad: Promise<RuntimeState> | null = null
  let mutationQueue: Promise<void> = Promise.resolve()
  let foreground = false
  let disposed = false
  const listeners = new Set<() => void>()
  const connectionStates = new Map<string, MobileConnectionState>()
  const connections = new Map<string, Connection>()
  const activeGenerations = new Map<string, number>()
  const nextGenerations = new Map<string, number>()
  const inFlight = new Map<string, Promise<MobileRpc>>()
  const reconnectControllers = new Map<string, AbortController>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const manualDisconnects = new Set<string>()
  const pairingHosts = new Set<string>()
  const pairingControllers = new Set<AbortController>()
  const pairingClients = new Set<MobileRpc>()
  const orphanedCredentialIds = new Set<string>()
  const attemptCounts = new Map<string, number>()

  const publish = () => {
    for (const listener of listeners) {
      try { listener() } catch { /* Subscribers do not own the runtime. */ }
    }
  }

  const loadState = async (): Promise<RuntimeState> => {
    if (stateValue) return stateValue
    if (!stateLoad) {
      stateLoad = (async () => {
        const text = await dependencies.storage.get(METADATA_KEY)
        const state = text === null ? defaultState() : parseState(text)
        stateValue = state
        for (const host of state.hosts) if (host.manualDisconnect) manualDisconnects.add(host.id)
        return state
      })()
    }
    try { return await stateLoad } finally { stateLoad = null }
  }

  const updateState = <T>(work: (current: RuntimeState) => Promise<StateUpdate<T>> | StateUpdate<T>): Promise<T> => {
    const operation = mutationQueue.then(async () => {
      const current = await loadState()
      const update = await work(current)
      await dependencies.storage.set(METADATA_KEY, JSON.stringify(update.next))
      stateValue = update.next
      publish()
      return update.result
    })
    mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  const stableState = async (): Promise<RuntimeState> => {
    await mutationQueue
    return loadState()
  }

  const setConnectionState = (hostId: string, state: MobileConnectionState): void => {
    connectionStates.set(hostId, { ...state })
    publish()
  }

  const recordLog = (hostId: string, stage: string, message: string): Promise<void> => updateState((current) => {
    const entry: MobileLogEntry = { at: now(), stage: stage.slice(0, 32), message: message.slice(0, 256) }
    const entries = [...(current.logs[hostId] ?? []), entry].slice(-MAX_LOG_ENTRIES)
    return { next: { ...current, logs: { ...current.logs, [hostId]: entries } }, result: undefined }
  })

  const setPhaseAndLog = (hostId: string, state: MobileConnectionState, stage: string, message: string): void => {
    const previous = connectionStates.get(hostId)
    setConnectionState(hostId, state)
    if (previous?.phase !== state.phase || previous?.message !== state.message) void recordLog(hostId, stage, message).catch(() => {})
  }

  const cancelRetry = (hostId: string) => {
    const timer = retryTimers.get(hostId)
    if (timer !== undefined) {
      clearTimeout(timer)
      retryTimers.delete(hostId)
    }
  }

  const scheduleReconnect = (hostId: string): void => {
    if (disposed || !foreground || manualDisconnects.has(hostId) || retryTimers.has(hostId) || pairingHosts.has(hostId)) return
    const attempts = (attemptCounts.get(hostId) ?? 0) + 1
    attemptCounts.set(hostId, attempts)
    setConnectionState(hostId, { phase: 'reconnecting', attempts, message: 'Retrying encrypted direct connection' })
    void recordLog(hostId, 'reconnect', 'Desktop connection interrupted; retry scheduled').catch(() => {})
    const timer = setTimeout(() => {
      retryTimers.delete(hostId)
      void reconnect(hostId).catch(() => {})
    }, retryDelay(attempts))
    retryTimers.set(hostId, timer)
  }

  const startConnection = async (host: StoredHost, token: string, pairing: boolean, signal?: AbortSignal): Promise<OpenedConnection> => {
    const generation = (nextGenerations.get(host.id) ?? 0) + 1
    nextGenerations.set(host.id, generation)
    const previousGeneration = activeGenerations.get(host.id)
    activeGenerations.set(host.id, generation)
    if (!pairing) setPhaseAndLog(host.id, { phase: 'connecting', attempts: attemptCounts.get(host.id) ?? 0, message: 'Connecting securely' }, 'connect', 'Starting encrypted direct connection')
    let rpc: MobileRpc | null = null
    try {
      const client = await createMobileRpc({
        endpoint: host.endpoint,
        publicKeyB64: host.publicKeyB64,
        token,
        ...(WebSocket ? { WebSocket } : {}),
        ...(randomBytes ? { randomBytes } : {}),
        connectTimeoutMs,
        handshakeTimeoutMs,
        requestTimeoutMs,
        ...(signal ? { signal } : {}),
        onState: (state) => {
          if (activeGenerations.get(host.id) !== generation) return
          if (pairing && connections.has(host.id)) return
          setPhaseAndLog(host.id, state, 'connection', state.message ?? 'Desktop connection state changed')
          if (state.phase === 'connected') {
            attemptCounts.set(host.id, 0)
            if (!pairing) void updateState((current) => ({
              next: { ...current, hosts: current.hosts.map((item) => item.id === host.id ? { ...item, lastConnected: now() } : item) },
              result: undefined
            })).catch(() => {})
          }
          if (state.phase === 'unreachable' && !pairing) {
            if (connections.get(host.id)?.generation === generation) connections.delete(host.id)
            scheduleReconnect(host.id)
          }
          if (state.phase === 'auth-failed' && connections.get(host.id)?.generation === generation) connections.delete(host.id)
        }
      })
      rpc = client
      if (activeGenerations.get(host.id) !== generation) {
        client.close()
        throw new MobileRpcError('closed', 'Connection was superseded')
      }
      if (client.state.phase !== 'connected') throw new MobileRpcError('connection', 'Desktop disconnected during connection setup')
      if (!pairing) connections.set(host.id, { rpc: client, generation })
      return { rpc: client, generation, previousGeneration }
    } catch (error) {
      if (activeGenerations.get(host.id) === generation) {
        if (previousGeneration === undefined) activeGenerations.delete(host.id)
        else activeGenerations.set(host.id, previousGeneration)
      }
      const phase = error instanceof MobileRpcError && error.kind === 'auth-failed' ? 'auth-failed' : error instanceof MobileRpcError && error.kind === 'closed' ? 'disconnected' : 'unreachable'
      if (!pairing && phase !== 'disconnected') {
        setPhaseAndLog(host.id, { phase, attempts: attemptCounts.get(host.id) ?? 0, message: messageForError(error) }, 'connect', messageForError(error))
        if (phase === 'unreachable') scheduleReconnect(host.id)
      }
      rpc?.close()
      throw error
    }
  }

  async function reconnect(hostId: string): Promise<MobileRpc> {
    if (disposed) throw new MobileRpcError('closed', 'Mobile runtime is disposed')
    if (!foreground) throw new MobileRpcError('closed', 'Connection attempts are paused in the background')
    cancelRetry(hostId)
    const current = connections.get(hostId)
    if (current?.rpc.state.phase === 'connected') return current.rpc
    const pending = inFlight.get(hostId)
    if (pending) return pending
    manualDisconnects.delete(hostId)
    let controller: AbortController | undefined
    const operation = (async () => {
      const state = await stableState()
      const host = state.hosts.find((item) => item.id === hostId)
      if (!host) throw new Error('Desktop host was not found')
      if (host.cleanupPending || state.cleanupIds.includes(hostId)) {
        setPhaseAndLog(hostId, { phase: 'credential-unavailable', attempts: 0, message: 'Secure credential cleanup is pending' }, 'credential', 'Secure credential cleanup is pending')
        throw new MobileRpcError('closed', 'Retry secure credential cleanup before reconnecting')
      }
      if (!host.v2Latched) {
        setPhaseAndLog(hostId, { phase: 'auth-failed', attempts: 0, message: 'Pair this desktop again to use encrypted v2' }, 'auth', 'The saved desktop is not latched to encrypted v2')
        throw new MobileRpcError('auth-failed', 'Pair this desktop again to use encrypted v2')
      }
      const credential = await dependencies.secrets.read(hostId)
      if (credential.kind === 'missing') {
        setPhaseAndLog(hostId, { phase: 'credential-missing', attempts: 0, message: 'Pairing credential is missing; pair again' }, 'credential', 'Secure pairing credential is missing')
        throw new MobileRpcError('auth-failed', 'Pairing credential is missing; pair this desktop again')
      }
      if (credential.kind === 'unavailable') {
        setPhaseAndLog(hostId, { phase: 'credential-unavailable', attempts: 0, message: 'Unlock secure storage, then retry' }, 'credential', 'Secure storage is temporarily unavailable')
        throw new MobileRpcError('connection', 'Secure storage is temporarily unavailable')
      }
      const latestState = await stableState()
      const latestHost = latestState.hosts.find((item) => item.id === hostId)
      if (!latestHost) throw new MobileRpcError('closed', 'Desktop host was removed')
      if (latestHost.cleanupPending || latestState.cleanupIds.includes(hostId)) {
        setPhaseAndLog(hostId, { phase: 'credential-unavailable', attempts: 0, message: 'Secure credential cleanup is pending' }, 'credential', 'Secure credential cleanup is pending')
        throw new MobileRpcError('closed', 'Retry secure credential cleanup before reconnecting')
      }
      if (!latestHost.v2Latched) throw new MobileRpcError('auth-failed', 'Pair this desktop again to use encrypted v2')
      if (!foreground || disposed) throw new MobileRpcError('closed', 'Connection attempt was paused')
      controller = new AbortController()
      reconnectControllers.set(hostId, controller)
      try {
        const opened = await startConnection(latestHost, credential.token, false, controller.signal)
        if (controller.signal.aborted || !foreground || disposed) {
          opened.rpc.close()
          throw new MobileRpcError('closed', 'Connection attempt was paused')
        }
        connections.set(hostId, { rpc: opened.rpc, generation: opened.generation })
        return opened.rpc
      } finally {
        if (reconnectControllers.get(hostId) === controller) reconnectControllers.delete(hostId)
      }
    })()
    inFlight.set(hostId, operation)
    try { return await operation } finally { if (inFlight.get(hostId) === operation) inFlight.delete(hostId) }
  }

  const makeStoredHost = (offer: MobilePairOffer, hostId: string, info: { machineName: string; platform: string }, existing: StoredHost | undefined): StoredHost => ({
    id: hostId,
    name: info.machineName,
    personalName: existing?.personalName ?? null,
    machineName: info.machineName,
    platform: info.platform,
    endpoint: offer.endpoint,
    publicKeyB64: offer.publicKeyB64,
    lastConnected: now(),
    lastWorktree: existing?.lastWorktree ?? null,
    v2Latched: true,
    createdAt: existing?.createdAt ?? now(),
    cleanupPending: false,
    manualDisconnect: false
  })

  const savePairedHost = async (offer: MobilePairOffer, hostId: string, info: { machineName: string; platform: string }): Promise<StoredHost> => {
    const rollback: {
      value: {
        host: StoredHost | undefined
        credential: Awaited<ReturnType<MobileSecretStorage['read']>>
      } | undefined
    } = { value: undefined }
    let writeAttempted = false
    let evictedId: string | undefined
    let pairedHost: StoredHost
    try {
      const saved = await updateState(async (current) => {
        const previousHost = current.hosts.find((host) => host.id === hostId)
        if (previousHost?.cleanupPending) throw new MobileRpcError('connection', 'Retry secure credential cleanup before pairing this desktop again')
        const previousCredential: Awaited<ReturnType<MobileSecretStorage['read']>> = previousHost
          ? await dependencies.secrets.read(hostId)
          : { kind: 'missing' }
        if (previousCredential.kind === 'unavailable') throw new MobileRpcError('connection', 'Secure storage is temporarily unavailable')
        rollback.value = { host: previousHost, credential: previousCredential }
        const activeHosts = current.hosts.filter((host) => !host.cleanupPending && host.id !== hostId)
        if (!previousHost && current.hosts.length >= MAX_HOSTS * 2 && activeHosts.length < MAX_HOSTS) {
          throw new MobileRpcError('connection', 'Retry secure credential cleanup before pairing more desktops')
        }
        const evicted = !previousHost && activeHosts.length >= MAX_HOSTS
          ? activeHosts.slice().sort((left, right) => (left.lastConnected ?? left.createdAt) - (right.lastConnected ?? right.createdAt))[0]
          : undefined
        if (evicted) {
          const oldValue = await dependencies.secrets.read(evicted.id)
          if (oldValue.kind === 'unavailable') throw new MobileRpcError('connection', 'Secure storage is temporarily unavailable; retry cleanup before pairing')
        }
        writeAttempted = true
        await dependencies.secrets.write(hostId, offer.deviceToken)
        const host = makeStoredHost(offer, hostId, info, previousHost)
        const hosts = current.hosts.filter((item) => item.id !== hostId && item.id !== evicted?.id)
        const next: RuntimeState = {
          ...current,
          hosts: [...hosts, host],
          cleanupIds: [...new Set([...current.cleanupIds.filter((id) => id !== hostId), ...(evicted ? [evicted.id] : [])])]
        }
        if (JSON.stringify(next).includes(offer.deviceToken)) throw new Error('Credential material cannot be stored in mobile metadata')
        return { next, result: { host, evictedId: evicted?.id } }
      })
      pairedHost = saved.host
      evictedId = saved.evictedId
    } catch (error) {
      if (writeAttempted) {
        const previous = rollback.value
        try {
          if (previous?.host && previous.credential.kind === 'available') await dependencies.secrets.write(hostId, previous.credential.token)
          else await dependencies.secrets.remove(hostId)
        } catch {
          orphanedCredentialIds.add(hostId)
          await updateState((current) => ({
            next: {
              ...current,
              cleanupIds: [...new Set([...current.cleanupIds, hostId])],
              hosts: previous?.host ? current.hosts.map((host) => host.id === hostId ? { ...host, cleanupPending: true } : host) : current.hosts
            },
            result: undefined
          })).then(() => orphanedCredentialIds.delete(hostId), () => {})
        }
      }
      throw error
    }
    if (evictedId) {
      const removedId = evictedId
      cancelRetry(removedId)
      const generation = Math.max(nextGenerations.get(removedId) ?? 0, activeGenerations.get(removedId) ?? 0) + 1
      nextGenerations.set(removedId, generation)
      activeGenerations.set(removedId, generation)
      reconnectControllers.get(removedId)?.abort()
      reconnectControllers.delete(removedId)
      inFlight.delete(removedId)
      const oldConnection = connections.get(removedId)
      connections.delete(removedId)
      oldConnection?.rpc.close()
      connectionStates.delete(removedId)
      attemptCounts.delete(removedId)
      manualDisconnects.delete(removedId)
      try {
        await dependencies.secrets.remove(removedId)
        await updateState((current) => {
          const logs = { ...current.logs }
          delete logs[removedId]
          return { next: { ...current, cleanupIds: current.cleanupIds.filter((id) => id !== removedId), logs }, result: undefined }
        })
      } catch { /* The eviction cleanup id was committed with the new host. */ }
    }
    return pairedHost
  }

  const runtime: MobileRuntimeInstance = {
    storage: dependencies.storage,
    native: dependencies.native,
    cancelPairing() {
      for (const controller of pairingControllers) controller.abort()
      for (const client of pairingClients) client.close()
    },
    async hosts() {
      const state = await stableState()
      return state.hosts.filter((host) => !host.cleanupPending).map(publicHost).sort((left, right) => (left.personalName ?? left.name).localeCompare(right.personalName ?? right.name))
    },
    async preferences() {
      const state = await stableState()
      return { ...state.preferences, shortcuts: state.preferences.shortcuts.map((shortcut) => ({ ...shortcut })) }
    },
    async updatePreferences(patch) {
      const allowed = new Set(['sessionView', 'onboardingCompleted', 'notificationChoice', 'terminalTextScale', 'autocomplete', 'terminalLinkMode', 'shortcuts'])
      if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error('Unsupported native preference')
      const state = await updateState((current) => {
        const preferences = validPreferences({ ...current.preferences, ...patch })
        if (!preferences) throw new Error('Native preferences are invalid')
        return { next: { ...current, preferences }, result: preferences }
      })
      return { ...state, shortcuts: state.shortcuts.map((shortcut) => ({ ...shortcut })) }
    },
    async pair(input, onLog) {
      if (disposed) throw new MobileRpcError('closed', 'Mobile runtime is disposed')
      const offer = parseMobileOffer(input)
      if (pairingHosts.size > 0) throw new MobileRpcError('connection', 'A pairing attempt is already in progress')
      const hostId = mobileHostIdForPublicKey(offer.publicKeyB64)
      pairingHosts.add(hostId)
      let stage = 'offer'
      let client: MobileRpc | undefined
      let opened: OpenedConnection | undefined
      let savePromise: Promise<StoredHost> | undefined
      let savedHost = false
      const controller = new AbortController()
      pairingControllers.add(controller)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new MobileRpcError('timeout', `Pairing timed out during ${stage}`))
        }, pairingTimeoutMs)
      })
      const addLog = async (nextStage: string, message: string) => {
        stage = nextStage
        const entry: MobileLogEntry = { at: now(), stage: nextStage, message }
        onLog?.(entry)
        await recordLog(hostId, nextStage, message)
      }
      const logBeforeTimeout = (nextStage: string, message: string) => Promise.race([addLog(nextStage, message), timeout])
      try {
        await logBeforeTimeout('offer', 'Strict mobile v2 offer validated; no connection has been made yet')
        await logBeforeTimeout('connect', 'Opening the desktop direct encrypted endpoint')
        opened = await Promise.race([startConnection({
          id: hostId, name: '', personalName: null, machineName: '', platform: '', endpoint: offer.endpoint,
          publicKeyB64: offer.publicKeyB64, lastConnected: null, lastWorktree: null, v2Latched: true,
          createdAt: now(), cleanupPending: false, manualDisconnect: false
        }, offer.deviceToken, true, controller.signal), timeout])
        client = opened.rpc
        pairingClients.add(client)
        await logBeforeTimeout('identity', 'Verifying the authenticated desktop identity')
        const infoValue = await Promise.race([client.call<unknown>('quirky.mobile/info', {}), timeout])
        const info = validHostInfo(infoValue)
        if (!info) throw new MobileRpcError('protocol', 'Desktop identity response was invalid')
        await logBeforeTimeout('credential', 'Saving the pairing credential to secure storage')
        if (controller.signal.aborted) throw new MobileRpcError('closed', 'Pairing was cancelled')
        savePromise = savePairedHost(offer, hostId, info)
        const host = await Promise.race([savePromise, timeout])
        savedHost = true
        if (controller.signal.aborted || disposed) {
          await runtime.removeHost(hostId)
          throw new MobileRpcError('closed', 'Pairing was cancelled')
        }
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        const previous = connections.get(hostId)
        activeGenerations.set(hostId, opened.generation)
        connections.set(hostId, { rpc: client, generation: opened.generation })
        if (previous && previous.rpc !== client) previous.rpc.close()
        manualDisconnects.delete(hostId)
        attemptCounts.set(hostId, 0)
        setConnectionState(hostId, client.state)
        await addLog('complete', 'Desktop paired with encrypted v2 and identity verified').catch(() => {})
        return publicHost(host)
      } catch (error) {
        controller.abort()
        client?.close()
        if (savePromise) {
          const lateHost = await savePromise.catch(() => undefined)
          if (lateHost) {
            savedHost = true
            await runtime.removeHost(hostId).catch(() => {})
          }
        }
        if (!savedHost && opened && activeGenerations.get(hostId) === opened.generation) {
          if (opened.previousGeneration === undefined) activeGenerations.delete(hostId)
          else activeGenerations.set(hostId, opened.previousGeneration)
          const previous = connections.get(hostId)
          setConnectionState(hostId, previous?.rpc.state ?? { phase: 'disconnected', attempts: 0, message: 'Pairing cancelled' })
        }
        const message = error instanceof MobileRpcError && error.kind === 'timeout'
          ? `Pairing timed out during ${stage}`
          : 'Pairing did not complete; no host was reported as paired'
        const entry: MobileLogEntry = { at: now(), stage: `${stage}-failed`.slice(0, 32), message }
        onLog?.(entry)
        await recordLog(hostId, entry.stage, message).catch(() => {})
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        pairingControllers.delete(controller)
        if (client) pairingClients.delete(client)
        pairingHosts.delete(hostId)
      }
    },
    async editHost(hostId, patch) {
      const result = await updateState((current) => {
        const existing = current.hosts.find((host) => host.id === hostId)
        if (!existing) throw new Error('Desktop host was not found')
        if (patch.personalName !== undefined && patch.personalName.trim().length > 64) throw new Error('Personal name cannot exceed 64 characters')
        const endpoint = patch.endpoint === undefined ? existing.endpoint : normalizeEditedEndpoint(patch.endpoint, existing.endpoint)
        const personalName = patch.personalName === undefined ? existing.personalName : patch.personalName.trim() || null
        const updated = { ...existing, personalName, endpoint }
        return { next: { ...current, hosts: current.hosts.map((host) => host.id === hostId ? updated : host) }, result: { host: updated, endpointChanged: endpoint !== existing.endpoint } }
      })
      if (result.endpointChanged) runtime.disconnect(hostId)
      return publicHost(result.host)
    },
    async removeHost(hostId) {
      const current = await stableState()
      const host = current.hosts.find((item) => item.id === hostId)
      if (!host) return { cleanupPending: current.cleanupIds.includes(hostId) }
      cancelRetry(hostId)
      reconnectControllers.get(hostId)?.abort()
      reconnectControllers.delete(hostId)
      inFlight.delete(hostId)
      manualDisconnects.add(hostId)
      const existing = connections.get(hostId)
      connections.delete(hostId)
      activeGenerations.set(hostId, (nextGenerations.get(hostId) ?? 0) + 1)
      existing?.rpc.close()
      setConnectionState(hostId, { phase: 'credential-unavailable', attempts: 0, message: 'Removing secure credential' })
      await updateState((state) => ({
        next: {
          ...state,
          hosts: state.hosts.map((item) => item.id === hostId ? { ...item, cleanupPending: true, manualDisconnect: true } : item),
          cleanupIds: [...new Set([...state.cleanupIds, hostId])]
        },
        result: undefined
      }))
      try {
        await dependencies.secrets.remove(hostId)
      } catch {
        setConnectionState(hostId, { phase: 'credential-unavailable', attempts: 0, message: 'Removal is waiting for secure storage; retry cleanup' })
        await recordLog(hostId, 'cleanup', 'Secure credential deletion is pending; retry cleanup after unlocking the device').catch(() => {})
        return { cleanupPending: true }
      }
      await updateState((state) => {
        const logs = { ...state.logs }
        delete logs[hostId]
        return { next: { ...state, hosts: state.hosts.filter((item) => item.id !== hostId), cleanupIds: state.cleanupIds.filter((id) => id !== hostId), logs }, result: undefined }
      })
      connectionStates.delete(hostId)
      manualDisconnects.delete(hostId)
      publish()
      return { cleanupPending: false }
    },
    async retryCredentialCleanup() {
      const state = await stableState()
      const pending = [...new Set([...state.cleanupIds, ...state.hosts.filter((host) => host.cleanupPending).map((host) => host.id), ...orphanedCredentialIds])]
      for (const hostId of pending) {
        try {
          await dependencies.secrets.remove(hostId)
          await updateState((current) => {
            const logs = { ...current.logs }
            delete logs[hostId]
            return { next: { ...current, hosts: current.hosts.filter((host) => host.id !== hostId), cleanupIds: current.cleanupIds.filter((id) => id !== hostId), logs }, result: undefined }
          })
          orphanedCredentialIds.delete(hostId)
          connectionStates.delete(hostId)
          manualDisconnects.delete(hostId)
        } catch {
          setConnectionState(hostId, { phase: 'credential-unavailable', attempts: 0, message: 'Removal is waiting for secure storage; retry cleanup' })
        }
      }
      const remaining = await stableState()
      publish()
      return [...new Set([...remaining.cleanupIds, ...remaining.hosts.filter((host) => host.cleanupPending).map((host) => host.id), ...orphanedCredentialIds])]
    },
    async getRpc(hostId) {
      if (disposed) throw new MobileRpcError('closed', 'Mobile runtime is disposed')
      if (!foreground) throw new MobileRpcError('closed', 'Connection attempts are paused in the background')
      const current = connections.get(hostId)
      if (current?.rpc.state.phase === 'connected') return current.rpc
      return runtime.reconnect(hostId)
    },
    disconnect(hostId) {
      cancelRetry(hostId)
      reconnectControllers.get(hostId)?.abort()
      reconnectControllers.delete(hostId)
      inFlight.delete(hostId)
      manualDisconnects.add(hostId)
      const current = connections.get(hostId)
      connections.delete(hostId)
      activeGenerations.set(hostId, (nextGenerations.get(hostId) ?? 0) + 1)
      current?.rpc.close()
      setConnectionState(hostId, { phase: 'disconnected', attempts: 0, message: 'Disconnected' })
      void updateState((state) => ({
        next: { ...state, hosts: state.hosts.map((host) => host.id === hostId ? { ...host, manualDisconnect: true } : host) }, result: undefined
      })).catch(() => {})
    },
    async reconnect(hostId) {
      if (disposed) throw new MobileRpcError('closed', 'Mobile runtime is disposed')
      if (!foreground) throw new MobileRpcError('closed', 'Connection attempts are paused in the background')
      manualDisconnects.delete(hostId)
      await updateState((state) => ({
        next: { ...state, hosts: state.hosts.map((host) => host.id === hostId ? { ...host, manualDisconnect: false } : host) }, result: undefined
      }))
      return reconnect(hostId)
    },
    async logs(hostId) {
      const state = await stableState()
      return (state.logs[hostId] ?? []).slice(-MAX_LOG_ENTRIES).map((entry) => ({ ...entry }))
    },
    async rememberWorkspace(hostId, worktreeId) {
      if (typeof worktreeId !== 'string' || worktreeId.length === 0 || worktreeId.length > 256) throw new Error('Workspace identifier is invalid')
      await updateState((current) => {
        if (!current.hosts.some((host) => host.id === hostId)) throw new Error('Desktop host was not found')
        return { next: { ...current, hosts: current.hosts.map((host) => host.id === hostId ? { ...host, lastWorktree: worktreeId } : host) }, result: undefined }
      })
    },
    subscribe(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    setForeground(active) {
      if (disposed) return
      if (active) {
        if (foreground) return
        foreground = true
        void stableState().then((state) => {
          for (const host of state.hosts) {
            if (host.cleanupPending || host.manualDisconnect || manualDisconnects.has(host.id)) continue
            void reconnect(host.id).catch(() => {})
          }
        }).catch(() => {})
        return
      }
      foreground = false
      runtime.cancelPairing()
      const hostIds = new Set([...connections.keys(), ...reconnectControllers.keys(), ...retryTimers.keys(), ...inFlight.keys()])
      for (const hostId of hostIds) {
        cancelRetry(hostId)
        activeGenerations.set(hostId, (nextGenerations.get(hostId) ?? 0) + 1)
        reconnectControllers.get(hostId)?.abort()
        reconnectControllers.delete(hostId)
        inFlight.delete(hostId)
        const current = connections.get(hostId)
        connections.delete(hostId)
        current?.rpc.close()
        setConnectionState(hostId, { phase: 'disconnected', attempts: attemptCounts.get(hostId) ?? 0, message: 'Paused while the app is in the background' })
      }
    },
    dispose() {
      if (disposed) return
      runtime.cancelPairing()
      disposed = true
      foreground = false
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      for (const [hostId, controller] of reconnectControllers) {
        activeGenerations.set(hostId, (nextGenerations.get(hostId) ?? 0) + 1)
        controller.abort()
      }
      reconnectControllers.clear()
      inFlight.clear()
      for (const { rpc } of connections.values()) rpc.close()
      connections.clear()
      listeners.clear()
    },
    connectionState(hostId) {
      return { ...(connectionStates.get(hostId) ?? { phase: 'disconnected', attempts: 0 }) }
    },
    async pendingCredentialCleanup() {
      const state = await stableState()
      return [...new Set([...state.cleanupIds, ...state.hosts.filter((host) => host.cleanupPending).map((host) => host.id), ...orphanedCredentialIds])]
    }
  }

  return runtime
}
