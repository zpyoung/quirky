import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))

import { startHeimdall } from './registration'
import {
  requireHeimdallKernel,
  requireHeimdallTransport
} from '../runtime/rpc/methods/fork-heimdall/kernel-binding'

function unopenedStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large Store class; only the two methods startHeimdall's isolation path calls are relevant here.
  return {
    getProfileStorageDirectory: () => {
      throw new Error('startup opened profile storage')
    },
    getRepo: () => {
      throw new Error('startup read a repository')
    }
  } as unknown as Store
}

afterEach(() => vi.useRealTimers())

describe('Heimdall startup isolation', () => {
  it('binds a partial runtime without opening profile storage or scheduling work', () => {
    vi.useFakeTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: empty double of the large QuirkyRuntimeService class; startHeimdall's isolation path under test never calls into it.
    const runtime = {} as QuirkyRuntimeService
    const kernel = startHeimdall(runtime, unopenedStore(), false)
    expect(requireHeimdallKernel(runtime)).toBe(kernel)
    expect(vi.getTimerCount()).toBe(0)
    kernel?.stopForShutdown()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('binds a lazy serve-mode owner without opening storage or scheduling work', () => {
    vi.useFakeTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: empty double of the large QuirkyRuntimeService class; startHeimdall's isolation path under test never calls into it.
    const runtime = {} as QuirkyRuntimeService
    const kernel = startHeimdall(runtime, unopenedStore(), true)
    expect(requireHeimdallKernel(runtime)).toBe(kernel)
    expect(requireHeimdallTransport(runtime)).toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
    kernel.stopForShutdown()
  })
})
