import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import {
  ASK_CLI_TRANSPORT_RETRY_ATTEMPTS,
  ASK_CLI_TRANSPORT_RETRY_DELAY_MS,
  callWithTransportRetry
} from './ask-cli-transport-retry'

afterEach(() => {
  vi.useRealTimers()
})

describe('callWithTransportRetry', () => {
  it('returns the first successful attempt without retrying', async () => {
    const attempt = vi.fn().mockResolvedValue('ok')
    await expect(callWithTransportRetry(attempt)).resolves.toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('retries a bare transport failure and succeeds once the runtime is reachable again', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'socket closed'))
      .mockResolvedValueOnce('recovered')
    // Why: attach the assertion synchronously, before any timer advances, so the
    // rejection this loop swallows internally is never briefly unobserved.
    const assertion = expect(callWithTransportRetry(attempt)).resolves.toBe('recovered')
    await vi.runAllTimersAsync()
    await assertion
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('gives up after the bounded attempt count and surfaces the last transport error', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn()
      .mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'still down'))
    const assertion = expect(callWithTransportRetry(attempt)).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'still down'
    })
    await vi.runAllTimersAsync()
    await assertion
    expect(attempt).toHaveBeenCalledTimes(ASK_CLI_TRANSPORT_RETRY_ATTEMPTS)
  })

  it('never retries a server-returned RPC failure', async () => {
    const failure = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: { code: 'invalid_argument', message: 'bad spec' }
    })
    const attempt = vi.fn().mockRejectedValue(failure)
    await expect(callWithTransportRetry(attempt)).rejects.toBe(failure)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('never retries a non-runtime_unavailable RuntimeClientError', async () => {
    const attempt = vi.fn().mockRejectedValue(new RuntimeClientError('invalid_argument', 'nope'))
    await expect(callWithTransportRetry(attempt)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('backs off between retries by the documented delay', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'x'))
      .mockResolvedValueOnce('ok')
    const assertion = expect(callWithTransportRetry(attempt)).resolves.toBe('ok')
    await vi.runAllTimersAsync()
    await assertion
    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      ASK_CLI_TRANSPORT_RETRY_DELAY_MS
    )
  })
})
