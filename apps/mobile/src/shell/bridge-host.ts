import type { MobileCallOptions, MobileConnectionState, MobileNativeActions, MobilePageInit, MobileRoute, MobileRpc, MobileStorage } from '../contracts'
import { MOBILE_BRIDGE_MAX_BYTES } from '../contracts'
import { encodeBase64 } from './generation'
import { isPageMutation, sanitizeConnectionState, utf8ByteLength, validatePageInit, validatePageReport, validatePageRpc, validateRoute } from './bridge-policy'
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
  const json = JSON.stringify(value)
  if (json === undefined || utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES - 2048) throw new Error('Quirky response exceeds the page bridge limit')
  return value
}

function exactEnvelope(value: unknown, keys: readonly string[]): value is JsonRecord {
  return isRecord(value) && exactKeys(value, keys) && value.v === 1 && typeof value.kind === 'string'
}

function rawStorageKey(hostId: string, key: string): string {
  return `${STORAGE_PREFIX}:${hostId}:${key}`
}

export function createBridgeHost(options: BridgeHostOptions): PageBridgeHost {
  let rpc = options.rpc
  let rpcEpoch = 0
  let ready = false
  let closed = false
  let init = { ...options.init, connectionState: sanitizeConnectionState(rpc.state) }
  validatePageInit(init)
  const activeStreams = new Set<number>()
  const streamSubscriptions = new Map<number, () => void>()
  const pendingRequests = new Map<string, 'rpc' | 'other'>()
  let pendingStreamAttachments = 0
  let stopState: (() => void) | undefined
  let rememberedWorktreeId = init.route.kind === 'session' ? init.route.worktreeId : null

  function send(value: JsonRecord): void {
    if (closed || !ready) return
    const json = JSON.stringify(value)
    if (utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES) throw new Error('bridge message exceeds the size limit')
    try {
      const result = options.sendToPage(json)
      if (result && typeof (result as Promise<void>).then === 'function') void Promise.resolve(result).catch(() => {})
    } catch {}
  }

  function sendReply(requestId: string, result: unknown): void {
    try {
      const safe = safeResponse(result)
      send({ v: 1, kind: 'reply', sessionId: init.sessionId, requestId, ok: true, result: safe })
    } catch (error) {
      send({ v: 1, kind: 'reply', sessionId: init.sessionId, requestId, ok: false, error: { message: safeError(error) } })
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

  function bindRpc(next: MobileRpc): void {
    if (closed || rpc === next && stopState) return
    stopState?.()
    stopState = undefined
    clearStreams()
    for (const [requestId, kind] of pendingRequests) {
      if (kind !== 'rpc') continue
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
    pendingRequests.set(requestId, rpcBound ? 'rpc' : 'other')
    void Promise.resolve().then(operation).then((value) => {
      if (!pendingRequests.delete(requestId)) return
      sendReply(requestId, value)
    }, (error: unknown) => {
      if (!pendingRequests.delete(requestId)) return
      sendError(requestId, error)
    })
  }

  async function invokeRpc(message: JsonRecord): Promise<unknown> {
    const requestId = message.requestId as string
    const method = message.method as string
    const params = message.params as Record<string, unknown>
    validatePageRpc(method, params, init.grants)
    if (isPageMutation(method) && rpc.state.phase !== 'connected') throw new Error('mutations require a connected desktop')
    const timeoutMs = message.timeoutMs
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_TIMEOUT_MS)) throw new Error('page RPC timeout is invalid')
    const attaching = method === 'quirky.terminal/attach'
    if (attaching && activeStreams.size + pendingStreamAttachments >= MAX_ACTIVE_PAGE_STREAMS) throw new Error('page stream limit reached')
    if (attaching) pendingStreamAttachments++
    const active = rpc
    const epoch = rpcEpoch
    let result: unknown
    try {
      result = await active.call(method, params, { requestId, timeoutMs: (timeoutMs as number | undefined) ?? MAX_TIMEOUT_MS })
    } finally {
      if (attaching) pendingStreamAttachments--
    }
    if (closed || active !== rpc || epoch !== rpcEpoch) throw new Error('connection changed before the operation completed; retry explicitly if needed')
    if (method === 'quirky.terminal/attach' && isRecord(result) && Number.isSafeInteger(result.streamId) && (result.streamId as number) > 0) activeStreams.add(result.streamId as number)
    if (method === 'quirky.terminal/detach') {
      const streamId = params.streamId as number
      activeStreams.delete(streamId)
      streamSubscriptions.get(streamId)?.()
      streamSubscriptions.delete(streamId)
    }
    return result
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
        if (state.route === 'session' && typeof state.worktreeId === 'string' && state.worktreeId !== rememberedWorktreeId) {
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
    }
  }
}
