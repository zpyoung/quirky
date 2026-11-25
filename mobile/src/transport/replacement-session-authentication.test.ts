import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReplacementAuthenticationTimeoutError,
  waitForAuthenticated
} from './replacement-session-authentication'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

class FakeSession implements RpcClient {
  readonly sendRequest = vi.fn()
  readonly subscribe = vi.fn(() => () => {})
  readonly updateTerminalSubscriptionViewport = vi.fn()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn()
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  constructor(private state: ConnectionState = 'connecting') {}
  getState = () => this.state
  getReconnectAttempt = () => 0
  getLastConnectedAt = () => null
  onStateChange = (listener: (state: ConnectionState) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

// Why: fake timers are active, so "still pending" is decided on the microtask queue.
async function settle<T>(
  promise: Promise<T>
): Promise<{ status: 'pending' | 'settled'; error?: Error }> {
  let outcome: { status: 'pending' | 'settled'; error?: Error } = { status: 'pending' }
  void promise.then(
    () => (outcome = { status: 'settled' }),
    (error: Error) => (outcome = { status: 'settled', error })
  )
  await Promise.resolve()
  await Promise.resolve()
  return outcome
}

describe('waitForAuthenticated', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects after the bound when the session never authenticates', async () => {
    const session = new FakeSession()
    const waiting = waitForAuthenticated(session, 12_000)
    waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(11_999)
    expect((await settle(waiting)).status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await settle(waiting)
    expect(outcome.error).toBeInstanceOf(ReplacementAuthenticationTimeoutError)
    expect(outcome.error?.message).toBe('replacement session authentication timed out')
  })

  it('stops its timer once the wait has settled', async () => {
    const session = new FakeSession()
    const waiting = waitForAuthenticated(session, 12_000)
    session.setState('disconnected')
    await expect(waiting).rejects.toThrow('replacement session disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })
})
