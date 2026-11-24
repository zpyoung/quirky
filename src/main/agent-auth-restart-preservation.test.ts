import { afterEach, describe, expect, it, vi } from 'vitest'

import { preserveAgentAuthBeforeRestart } from './agent-auth-restart-preservation'

describe('preserveAgentAuthBeforeRestart', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('syncs Codex and flushes the store', async () => {
    const calls: string[] = []

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          calls.push('codex')
        })
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(async () => {
          calls.push('flush')
        })
      }
    })

    expect(calls).toEqual(['codex', 'flush'])
  })

  it('checkpoints admitted state without waiting for ongoing edits when auth services are missing', async () => {
    const flushPendingOrThrowAsync = vi.fn()

    await preserveAgentAuthBeforeRestart({ store: { flushPendingOrThrowAsync } })

    expect(flushPendingOrThrowAsync).toHaveBeenCalledExactlyOnceWith({
      drainToStableGeneration: false
    })
  })

  it('logs secret-free warnings and does not throw when sync fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flushPendingOrThrowAsync = vi.fn()

    await expect(
      preserveAgentAuthBeforeRestart({
        codexRuntimeHome: {
          syncForCurrentSelection: vi.fn(() => {
            throw new Error('codex-token-secret')
          })
        },
        store: { flushPendingOrThrowAsync }
      })
    ).resolves.toBeUndefined()

    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-secret')
  })

  it('bounds a store flush that never settles', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preservation = preserveAgentAuthBeforeRestart({
      store: { flushPendingOrThrowAsync: vi.fn(() => new Promise<void>(() => {})) }
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await preservation

    expect(warn).toHaveBeenCalledWith(
      '[agent-auth-restart] Store persistence exceeded 2000ms; continuing restart/update'
    )
  })
})
