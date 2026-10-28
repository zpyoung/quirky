import type { MobileCallOptions, MobileConnectionState, MobileNativeActions, MobilePageBridge, MobilePageInit, MobileRoute } from '../contracts'
import { MOBILE_BRIDGE_MAX_BYTES } from '../contracts'
import { decodeBase64 } from './generation'
import { isPageMutation, sanitizeConnectionState, utf8ByteLength, validatePageInit, validatePageReport, validatePageRpc, validateRoute } from './bridge-policy'
import { safeExternalUrl } from './shell-security'

type PageMessageHandler = (json: string) => void
export type PageBridgePort = {
  postMessage(json: string): void | Promise<void>
  subscribe(handler: PageMessageHandler): () => void
}

type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void }

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function messageError(value: unknown): Error {
  const message = isRecord(value) && typeof value.message === 'string' ? value.message.slice(0, 512) : 'Page request failed'
  return new Error(message)
}

export function createPageBridge(port: PageBridgePort, init: MobilePageInit): MobilePageBridge {
  validatePageInit(init)
  let connectionState = sanitizeConnectionState(init.connectionState)
  let requestNumber = 0
  let closed = false
  const pending = new Map<string, Pending>()
  const stateListeners = new Set<(state: MobileConnectionState) => void>()
  const streamListeners = new Map<number, Set<(bytes: Uint8Array) => void>>()
  const subscribedStreams = new Set<number>()
  const MAX_PENDING_REQUESTS = 128
  const MAX_ACTIVE_STREAMS = 32

  function post(value: JsonRecord): void {
    if (closed) throw new Error('page bridge is closed')
    const json = JSON.stringify(value)
    if (utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES) throw new Error('page bridge envelope exceeds the message limit')
    const delivered = port.postMessage(json)
    if (delivered && typeof (delivered as Promise<void>).then === 'function') {
      void Promise.resolve(delivered).catch((error: unknown) => {
        if (typeof value.requestId !== 'string') return
        const task = pending.get(value.requestId)
        if (!task) return
        pending.delete(value.requestId)
        task.reject(error instanceof Error ? error : new Error('native page message delivery failed'))
      })
    }
  }

  function nextRequestId(requestId?: string): string {
    const value = requestId ?? `page-${++requestNumber}`
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('page request ID is invalid')
    if (pending.has(value)) throw new Error('page request ID is already in use')
    return value
  }

  function request<T>(kind: 'storage' | 'native' | 'navigate', body: JsonRecord, grant: string, options?: MobileCallOptions): Promise<T> {
    if (!init.grants.includes(grant as never)) return Promise.reject(new Error(`page route does not have the ${grant} grant`))
    if (closed) return Promise.reject(new Error('page bridge is closed'))
    if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('page bridge request limit reached'))
    let requestId: string
    try { requestId = nextRequestId(options?.requestId) } catch (error) { return Promise.reject(error) }
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { method: kind, resolve: resolve as (value: unknown) => void, reject })
      try {
        post({
          v: 1,
          kind,
          sessionId: init.sessionId,
          requestId,
          ...body,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        })
      } catch (error) {
        pending.delete(requestId)
        reject(error)
      }
    })
  }

  function call<T>(method: string, params: Record<string, unknown> = {}, options?: MobileCallOptions): Promise<T> {
    try {
      validatePageRpc(method, params, init.grants)
      if (isPageMutation(method) && connectionState.phase !== 'connected') throw new Error('terminal and workspace mutations require a connected desktop')
      if (closed) throw new Error('page bridge is closed')
      if (pending.size >= MAX_PENDING_REQUESTS) throw new Error('page bridge request limit reached')
      const requestId = nextRequestId(options?.requestId)
      const timeoutMs = options?.timeoutMs
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) throw new Error('page request timeout is invalid')
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, { method, resolve: resolve as (value: unknown) => void, reject })
        try {
          post({ v: 1, kind: 'call', sessionId: init.sessionId, requestId, method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
        } catch (error) {
          pending.delete(requestId)
          reject(error)
        }
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const storage = {
    get(key: string): Promise<string | null> {
      if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return Promise.reject(new Error('page storage key is invalid'))
      return request<string | null>('storage', { operation: 'get', key }, 'storage')
    },
    set(key: string, value: string): Promise<void> {
      if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || typeof value !== 'string' || utf8ByteLength(value) > MOBILE_BRIDGE_MAX_BYTES) return Promise.reject(new Error('page storage value is invalid'))
      return request<void>('storage', { operation: 'set', key, value }, 'storage')
    },
    remove(key: string): Promise<void> {
      if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return Promise.reject(new Error('page storage key is invalid'))
      return request<void>('storage', { operation: 'remove', key }, 'storage')
    }
  }

  const native: Pick<MobileNativeActions, 'clipboardRead' | 'clipboardWrite' | 'openExternal' | 'haptic'> = {
    clipboardRead() { return request<string>('native', { action: 'clipboardRead' }, 'clipboard.read') },
    clipboardWrite(text: string) {
      if (typeof text !== 'string' || utf8ByteLength(text) > MOBILE_BRIDGE_MAX_BYTES) return Promise.reject(new Error('clipboard value exceeds the bridge limit'))
      return request<void>('native', { action: 'clipboardWrite', text }, 'clipboard.write')
    },
    openExternal(value: string) {
      const url = safeExternalUrl(value)
      if (!url) return Promise.reject(new Error('only valid http(s) links can be opened'))
      return request<void>('native', { action: 'openExternal', url }, 'externalLink')
    },
    haptic() { return request<void>('native', { action: 'haptic' }, 'haptics') }
  }

  const unsubscribe = port.subscribe((json) => {
    if (closed || utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES) return
    let value: unknown
    try { value = JSON.parse(json) as unknown } catch { return }
    if (!isRecord(value) || value.v !== 1 || value.sessionId !== init.sessionId || typeof value.kind !== 'string') return
    if (value.kind === 'reply') {
      if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') return
      const task = pending.get(value.requestId)
      if (!task) return
      pending.delete(value.requestId)
      if (value.ok) task.resolve(value.result)
      else task.reject(messageError(value.error))
      return
    }
    if (value.kind === 'state') {
      let next: MobileConnectionState
      try { next = sanitizeConnectionState(value.state) } catch { return }
      connectionState = next
      for (const listener of [...stateListeners]) listener(next)
      if (next.phase !== 'connected') {
        for (const [requestId, task] of pending) {
          if (!isPageMutation(task.method)) continue
          pending.delete(requestId)
          task.reject(new Error('connection changed before the operation completed; retry explicitly if needed'))
        }
        for (const streamId of subscribedStreams) {
          try { post({ v: 1, kind: 'stream-unsubscribe', sessionId: init.sessionId, streamId }) } catch {}
        }
        streamListeners.clear()
        subscribedStreams.clear()
      }
      return
    }
    if (value.kind === 'stream') {
      if (!Number.isSafeInteger(value.streamId) || typeof value.data !== 'string') return
      let bytes: Uint8Array
      try { bytes = decodeBase64(value.data) } catch { return }
      for (const listener of streamListeners.get(value.streamId as number) ?? []) listener(bytes)
    }
  })

  const bridge: MobilePageBridge = {
    init,
    get state() { return connectionState },
    call,
    onEvent() { throw new Error('page event subscriptions are unavailable') },
    onState(handler) {
      stateListeners.add(handler)
      handler(connectionState)
      return () => stateListeners.delete(handler)
    },
    onStream(streamId, handler) {
      if (closed || !init.grants.includes('terminal') || !Number.isSafeInteger(streamId) || streamId <= 0) throw new Error('page stream subscription is unavailable')
      if (!streamListeners.has(streamId) && streamListeners.size >= MAX_ACTIVE_STREAMS) throw new Error('page stream limit reached')
      const listeners = streamListeners.get(streamId) ?? new Set<(bytes: Uint8Array) => void>()
      listeners.add(handler)
      streamListeners.set(streamId, listeners)
      if (!subscribedStreams.has(streamId)) {
        subscribedStreams.add(streamId)
        try { post({ v: 1, kind: 'stream-subscribe', sessionId: init.sessionId, streamId }) } catch {
          subscribedStreams.delete(streamId)
          streamListeners.delete(streamId)
          throw new Error('page stream subscription could not be sent')
        }
      }
      return () => {
        const current = streamListeners.get(streamId)
        if (!current) return
        current.delete(handler)
        if (current.size === 0) {
          streamListeners.delete(streamId)
          subscribedStreams.delete(streamId)
          if (!closed) {
            try { post({ v: 1, kind: 'stream-unsubscribe', sessionId: init.sessionId, streamId }) } catch {}
          }
        }
      }
    },
    storage,
    native,
    async navigate(route) {
      validateRoute(route)
      await request<void>('navigate', { route }, 'navigate')
    },
    report(state) {
      validatePageReport(state)
      post({ v: 1, kind: 'report', sessionId: init.sessionId, state })
    },
    close() {
      if (closed) return
      closed = true
      unsubscribe()
      for (const task of pending.values()) task.reject(new Error('page bridge closed'))
      pending.clear()
      stateListeners.clear()
      streamListeners.clear()
      subscribedStreams.clear()
    }
  }
  return bridge
}
