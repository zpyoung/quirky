import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import { waitForAuthenticated } from './replacement-session-authentication'
import { projectMobileRpcRequestParams } from './mobile-rpc-request-projection'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

export type MobileConnectionPath = 'lan' | 'tailscale'

export class LogicalClientCutoverError extends Error {
  constructor(cause?: unknown) {
    super('RPC interrupted by connection migration', { cause })
    if (isRpcDeliveryUnknown(cause)) {
      markRpcDeliveryUnknown(this)
    }
  }
}

// Why: instanceof can miss across bundle copies, so also match by message.
export function isLogicalClientCutoverError(error: unknown): boolean {
  return (
    error instanceof LogicalClientCutoverError ||
    (error instanceof Error && error.message === 'RPC interrupted by connection migration')
  )
}

type SubscriptionRecord = {
  method: string
  params: unknown
  listener: (result: unknown) => void
  options?: Parameters<RpcClient['subscribe']>[3]
  disposePhysical: (() => void) | null
  cancelled: boolean
}

export type StableLogicalRpcClient = RpcClient & {
  migrateTo(
    session: RpcClient,
    path: MobileConnectionPath,
    timeoutMs?: number,
    // Checked after the replacement authenticates, before the swap — lets a racing
    // caller withdraw when another path won while this dial was in flight.
    shouldAbort?: () => boolean
  ): Promise<void>
  getActivePath(): MobileConnectionPath
  getGeneration(): number
}

export function createStableLogicalRpcClient(
  initialSession: RpcClient,
  initialPath: MobileConnectionPath
): StableLogicalRpcClient {
  let activeSession = initialSession
  let activePath = initialPath
  let generation = 1
  let closed = false
  let nextSubscriptionId = 0
  let activeStateUnsubscribe: (() => void) | null = null
  const subscriptions = new Map<number, SubscriptionRecord>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state = initialSession.getState()

  bindActiveState(initialSession, generation)

  const logical: StableLogicalRpcClient = {
    sendRequest(method, params, options) {
      if (closed) {
        return Promise.reject(new Error('Client closed'))
      }
      const requestGeneration = generation
      const session = activeSession
      return new Promise<RpcResponse>((resolve, reject) => {
        void session
          .sendRequest(method, projectMobileRpcRequestParams(method, params), options)
          .then(
            (response) => {
              // A correlated response is definitive even if close/cutover won the
              // callback race after the physical promise had already settled.
              resolve(response)
            },
            (error: unknown) => {
              // Why: the retiring physical session settles this, so keep its error as the
              // cause — it is the only evidence of whether the frame reached the wire.
              reject(
                requestGeneration !== generation ? new LogicalClientCutoverError(error) : error
              )
            }
          )
      })
    },

    subscribe(method, params, listener, options) {
      if (closed) {
        return () => {}
      }
      const id = ++nextSubscriptionId
      const record: SubscriptionRecord = {
        method,
        params,
        listener,
        options,
        disposePhysical: null,
        cancelled: false
      }
      subscriptions.set(id, record)
      attachSubscription(record, activeSession, generation)
      return () => {
        if (record.cancelled) {
          return
        }
        record.cancelled = true
        record.disposePhysical?.()
        record.disposePhysical = null
        subscriptions.delete(id)
      }
    },

    updateTerminalSubscriptionViewport(terminal, viewport) {
      for (const record of subscriptions.values()) {
        if (
          record.params &&
          typeof record.params === 'object' &&
          'terminal' in record.params &&
          record.params.terminal === terminal
        ) {
          record.params = { ...record.params, viewport }
        }
      }
      activeSession.updateTerminalSubscriptionViewport(terminal, viewport)
    },

    getState: () => state,
    getReconnectAttempt: () => activeSession.getReconnectAttempt(),
    getLastConnectedAt: () => activeSession.getLastConnectedAt(),
    getLastInboundAt: () => activeSession.getLastInboundAt?.() ?? null,
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    notifyForeground: (reason) => activeSession.notifyForeground(reason),
    close() {
      if (closed) {
        return
      }
      closed = true
      activeStateUnsubscribe?.()
      activeStateUnsubscribe = null
      for (const record of subscriptions.values()) {
        record.disposePhysical?.()
      }
      subscriptions.clear()
      // Why: let the physical close settle in-flight requests — it knows which
      // frames were written and marks those delivery-unknown; a blanket local
      // reject would erase that distinction.
      activeSession.close()
      publishState('disconnected')
    },

    async migrateTo(nextSession, path, timeoutMs = 12_000, shouldAbort) {
      if (closed) {
        nextSession.close()
        throw new Error('Client closed')
      }
      try {
        await waitForAuthenticated(nextSession, timeoutMs)
        if (closed) {
          throw new Error('Client closed')
        }
        // Why: cutting over anyway would close a live winner and strand the user
        // on the slower path (the happy-eyeballs race is first-authenticated-wins).
        if (shouldAbort?.()) {
          throw new Error('migration superseded')
        }
      } catch (error) {
        nextSession.close()
        throw error
      }
      const previous = activeSession
      const previousStateUnsubscribe = activeStateUnsubscribe
      const nextGeneration = generation + 1

      // Why: replay on the authenticated replacement before closing the old
      // session, but fence callbacks until the generation becomes current.
      for (const record of subscriptions.values()) {
        const disposePrevious = record.disposePhysical
        attachSubscription(record, nextSession, nextGeneration)
        disposePrevious?.()
      }
      generation = nextGeneration
      activeSession = nextSession
      activePath = path
      previousStateUnsubscribe?.()
      bindActiveState(nextSession, nextGeneration)
      state = nextSession.getState()
      for (const listener of stateListeners) {
        listener(state)
      }
      // Only the physical sender knows whether a pending request reached the wire.
      previous.close()
    },

    getActivePath: () => activePath,
    getGeneration: () => generation
  }

  return logical

  function attachSubscription(
    record: SubscriptionRecord,
    session: RpcClient,
    subscriptionGeneration: number
  ): void {
    record.disposePhysical = session.subscribe(
      record.method,
      record.params,
      (result) => {
        if (!closed && !record.cancelled && generation === subscriptionGeneration) {
          record.listener(result)
        }
      },
      record.options
    )
  }

  function bindActiveState(session: RpcClient, sessionGeneration: number): void {
    activeStateUnsubscribe = session.onStateChange((next) => {
      if (!closed && generation === sessionGeneration && session === activeSession) {
        publishState(next)
      }
    })
  }

  function publishState(next: ConnectionState): void {
    if (state === next) {
      return
    }
    state = next
    for (const listener of stateListeners) {
      listener(next)
    }
  }
}
