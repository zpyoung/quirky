import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from '../ipc/parcel-watcher-process-subscription'
import { PtySpawnHealthTimeoutError } from '../daemon/pty-subprocess/spawn-preflight'
import { preflightQuirkydNativeRuntime } from './quirkyd-runtime-native-preflight'

const fixture = vi.hoisted(() => ({
  temp: vi.fn(),
  pty: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  remove: vi.fn()
}))
vi.mock('../daemon/pty-subprocess/spawn-preflight', () => ({
  PTY_SPAWN_HEALTH_TIMEOUT_MS: 4_000,
  PtySpawnHealthTimeoutError: class extends Error {
    constructor(timeoutMs: number) {
      super(`PTY spawn health check timed out after ${timeoutMs}ms`)
    }
  },
  runPtySpawnHealthProbe: fixture.pty
}))
vi.mock('node:fs/promises', () => ({
  mkdtemp: fixture.temp,
  writeFile: fixture.write,
  rm: fixture.remove
}))
vi.mock('../ipc/parcel-watcher-process-supervisor', () => ({
  WatcherProcessSupervisor: class {
    subscribe = fixture.subscribe
    dispose = fixture.dispose
  }
}))

beforeEach(() => {
  vi.useFakeTimers()
  fixture.temp.mockResolvedValue('/temp/probe')
  fixture.pty.mockResolvedValue(undefined)
  fixture.unsubscribe.mockResolvedValue(undefined)
  fixture.remove.mockResolvedValue(undefined)
  fixture.subscribe.mockImplementation(
    async (directory: string, callback: WatcherProcessCallback) => {
      fixture.write.mockImplementation(async () =>
        callback(null, [{ path: join(directory, 'ready'), type: 'create' }])
      )
      return { unsubscribe: fixture.unsubscribe }
    }
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('bundled native readiness', () => {
  it('keeps runtime startup independent of PTY or watcher probe availability', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check timed out'))
    fixture.subscribe.mockRejectedValue(new Error('ENOSPC: watch limit reached'))
    await preflightQuirkydNativeRuntime({ nativeFeatures: false })
    expect(fixture.pty).not.toHaveBeenCalled()
    expect(fixture.subscribe).not.toHaveBeenCalled()
  })

  it('does not admit a failed PTY in explicit qualification', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check timed out'))
    await expect(preflightQuirkydNativeRuntime()).rejects.toThrow(
      'PTY spawn health check timed out'
    )
  })

  it('retries a timed-out PTY probe once with the normal budget', async () => {
    fixture.pty.mockRejectedValueOnce(new PtySpawnHealthTimeoutError(15_000))
    await preflightQuirkydNativeRuntime()
    expect(fixture.pty.mock.calls).toEqual([[4_000], [4_000]])
  })

  it('fails when the retry also times out', async () => {
    fixture.pty.mockRejectedValue(new PtySpawnHealthTimeoutError(4_000))
    await expect(preflightQuirkydNativeRuntime()).rejects.toThrow('timed out after 4000ms')
    expect(fixture.pty).toHaveBeenCalledTimes(2)
  })

  it('does not retry a PTY that spawned and failed', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check exited with code 1'))
    await expect(preflightQuirkydNativeRuntime()).rejects.toThrow('exited with code 1')
    expect(fixture.pty).toHaveBeenCalledOnce()
  })

  it('awaits actual watcher delivery and unsubscribe before disposing temporary state', async () => {
    await preflightQuirkydNativeRuntime()
    expect(fixture.pty).toHaveBeenCalledOnce()
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.remove).toHaveBeenCalledWith('/temp/probe', { recursive: true, force: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a subscribe blocked on capacity by the same readiness deadline', async () => {
    fixture.subscribe.mockImplementation(
      (
        _directory: string,
        _callback: WatcherProcessCallback,
        _options: unknown,
        hooks: WatcherProcessHooks
      ) =>
        new Promise((_resolve, reject) => {
          hooks.signal?.addEventListener('abort', () => reject(hooks.signal?.reason), {
            once: true
          })
        })
    )
    const readiness = preflightQuirkydNativeRuntime()
    const rejected = expect(readiness).rejects.toThrow('readiness timed out')
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up when native delivery fails before subscribe resolves', async () => {
    fixture.subscribe.mockImplementation(
      async (_directory: string, callback: WatcherProcessCallback) => {
        callback(new Error('native watcher failed'), [])
        return { unsubscribe: fixture.unsubscribe }
      }
    )
    await expect(preflightQuirkydNativeRuntime()).rejects.toThrow('native watcher failed')
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })

  it('still disposes temporary state when unsubscribe fails', async () => {
    fixture.unsubscribe.mockRejectedValue(new Error('watcher did not exit'))
    await expect(preflightQuirkydNativeRuntime()).rejects.toThrow('watcher did not exit')
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.remove).toHaveBeenCalledOnce()
  })
})
