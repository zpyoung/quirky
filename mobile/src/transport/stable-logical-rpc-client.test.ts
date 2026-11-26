import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import {
  createStableLogicalRpcClient,
  LogicalClientCutoverError
} from './stable-logical-rpc-client'

class FakeSession implements RpcClient {
  readonly sendRequest =
    vi.fn<
      (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<RpcResponse>
    >()
  readonly subscribe = vi.fn<RpcClient['subscribe']>()
  readonly updateTerminalSubscriptionViewport =
    vi.fn<RpcClient['updateTerminalSubscriptionViewport']>()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn()
  private state: ConnectionState
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly streamListeners = new Set<(result: unknown) => void>()

  constructor(state: ConnectionState) {
    this.state = state
    this.subscribe.mockImplementation((_method, _params, listener) => {
      this.streamListeners.add(listener)
      return () => this.streamListeners.delete(listener)
    })
  }

  getState = (): ConnectionState => this.state
  getReconnectAttempt = (): number => 0
  getLastConnectedAt = (): number | null => null
  onStateChange = (listener: (state: ConnectionState) => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  emitStream(value: unknown): void {
    for (const listener of this.streamListeners) {
      listener(value)
    }
  }
}

function success(value: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result: value, _meta: { runtimeId: 'runtime-1' } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('stable logical RPC client', () => {
  it('advertises source-default support on worktree catalog requests', async () => {
    const session = new FakeSession('connected')
    session.sendRequest.mockResolvedValue(success([]))
    const client = createStableLogicalRpcClient(session, 'lan')

    await client.sendRequest('worktree.ps', { limit: 10_000 })
    await client.sendRequest('status.get')

    expect(session.sendRequest).toHaveBeenNthCalledWith(
      1,
      'worktree.ps',
      { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true },
      undefined
    )
    expect(session.sendRequest).toHaveBeenNthCalledWith(2, 'status.get', undefined, undefined)
  })

  it('makes before break, rejects in-flight work, and replays subscriptions', async () => {
    const oldSession = new FakeSession('connected')
    const nextSession = new FakeSession('connecting')
    const pending = deferred<RpcResponse>()
    oldSession.sendRequest.mockReturnValue(pending.promise)
    oldSession.close.mockImplementation(() => pending.reject(new Error('Client closed')))
    nextSession.sendRequest.mockResolvedValue(success('next'))
    const client = createStableLogicalRpcClient(oldSession, 'lan')
    const stream = vi.fn()
    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, stream)
    const request = client.sendRequest('worktree.create', { name: 'new' })

    const migrating = client.migrateTo(nextSession, 'tailscale')
    expect(oldSession.close).not.toHaveBeenCalled()
    expect(nextSession.subscribe).not.toHaveBeenCalled()
    nextSession.setState('connected')
    await migrating

    await expect(request).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(nextSession.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 'term-1' },
      expect.any(Function),
      undefined
    )
    expect(oldSession.close).toHaveBeenCalledOnce()
    expect(client.getActivePath()).toBe('tailscale')
    expect(client.getGeneration()).toBe(2)
    oldSession.emitStream('stale')
    nextSession.emitStream('current')
    expect(stream).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledWith('current')
    pending.resolve(success('late'))
  })

  it('keeps replies that commit before cutover and carries viewport state into replay', async () => {
    const oldSession = new FakeSession('connected')
    const nextSession = new FakeSession('connected')
    oldSession.sendRequest.mockResolvedValue(success('old'))
    const client = createStableLogicalRpcClient(oldSession, 'lan')
    client.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', viewport: { cols: 80, rows: 24 } },
      vi.fn()
    )
    client.updateTerminalSubscriptionViewport('term-1', { cols: 120, rows: 40 })

    await expect(client.sendRequest('status.get')).resolves.toEqual(success('old'))
    await client.migrateTo(nextSession, 'tailscale')
    expect(nextSession.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 'term-1', viewport: { cols: 120, rows: 40 } },
      expect.any(Function),
      undefined
    )
  })

  it('preserves delivery ambiguity without replaying a mutation after replacement', async () => {
    const session = new FakeSession('connected')
    const replacement = new FakeSession('connected')
    const inFlight = deferred<RpcResponse>()
    session.sendRequest.mockReturnValue(inFlight.promise)
    // Mirror the real physical contract: close() rejects post-write pendings
    // with a delivery-unknown-marked error.
    const closeError = markRpcDeliveryUnknown(new Error('Client closed'))
    session.close.mockImplementation(() => inFlight.reject(closeError))
    const client = createStableLogicalRpcClient(session, 'tailscale')
    const request = client.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })

    await client.migrateTo(replacement, 'lan')

    await expect(request).rejects.toBeInstanceOf(LogicalClientCutoverError)
    await expect(request.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
    expect(replacement.sendRequest).not.toHaveBeenCalled()
    replacement.sendRequest.mockResolvedValue(success('next'))
    await expect(client.sendRequest('status.get')).resolves.toEqual(success('next'))
  })

  it('lets the physical close settle in-flight requests on close, keeping pre-write failures definite', async () => {
    const session = new FakeSession('connected')
    const inFlight = deferred<RpcResponse>()
    session.sendRequest.mockReturnValue(inFlight.promise)
    // A request still waiting for connect never wrote its frame — the physical
    // layer rejects it unmarked and that must survive the logical close.
    const preWriteError = new Error('Connection closed')
    session.close.mockImplementation(() => inFlight.reject(preWriteError))
    const client = createStableLogicalRpcClient(session, 'lan')
    const request = client.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })

    client.close()

    await expect(request).rejects.toBe(preWriteError)
    await expect(request.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(
      false
    )
  })

  it('preserves a committed response when logical close wins the callback race', async () => {
    const session = new FakeSession('connected')
    const inFlight = deferred<RpcResponse>()
    session.sendRequest.mockReturnValue(inFlight.promise)
    const client = createStableLogicalRpcClient(session, 'lan')
    const request = client.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })

    inFlight.resolve(success('accepted'))
    client.close()

    await expect(request).resolves.toEqual(success('accepted'))
  })

  it('never downgrades a live session while a make-before-break replacement dials', async () => {
    const oldSession = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(oldSession, 'tailscale')
    const states: ConnectionState[] = []
    client.onStateChange((next) => states.push(next))

    const migrating = client.migrateTo(replacement, 'tailscale')
    replacement.setState('connecting')
    replacement.setState('handshaking')

    expect(client.getState()).toBe('connected')

    replacement.setState('connected')
    await migrating

    expect(states).toEqual(['connected'])
  })

  it('closes a replacement that fails authentication and preserves the active session', async () => {
    const oldSession = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(oldSession, 'lan')
    const migrating = client.migrateTo(replacement, 'tailscale')
    replacement.setState('auth-failed')

    await expect(migrating).rejects.toThrow(/auth-failed/)
    expect(replacement.close).toHaveBeenCalledOnce()
    expect(oldSession.close).not.toHaveBeenCalled()
    expect(client.getActivePath()).toBe('lan')
    expect(client.getGeneration()).toBe(1)
  })
})

describe('stable logical RPC client subscription fencing', () => {
  /** A physical session with an inert disposer, so only the logical guard can fence a late event. */
  function leakySession() {
    const session = new FakeSession('connected')
    const listeners = new Set<(result: unknown) => void>()
    session.subscribe.mockImplementation((_method, _params, listener) => {
      listeners.add(listener)
      return () => {}
    })
    return {
      session,
      emit(value: unknown): void {
        for (const listener of listeners) {
          listener(value)
        }
      }
    }
  }

  it('delivers a stream event to a live subscription', () => {
    const physical = leakySession()
    const client = createStableLogicalRpcClient(physical.session, 'lan')
    const listener = vi.fn()
    client.subscribe('notifications.subscribe', { includeDesktopSuppressed: true }, listener)

    physical.emit({ type: 'ready', subscriptionId: 'sub-1' })

    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'ready', subscriptionId: 'sub-1' })
  })

  it('drops a stream event that lands after the caller unsubscribed', () => {
    const physical = leakySession()
    const client = createStableLogicalRpcClient(physical.session, 'lan')
    const listener = vi.fn()
    const unsubscribe = client.subscribe(
      'notifications.subscribe',
      { includeDesktopSuppressed: true },
      listener
    )

    unsubscribe()
    physical.emit({ type: 'ready', subscriptionId: 'sub-1' })

    expect(listener).not.toHaveBeenCalled()
  })
})
