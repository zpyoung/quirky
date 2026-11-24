import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'
import {
  QUIRKYD_COMPILE_CACHE_DIRNAME,
  enableManagedQuirkydCompileCache,
  quirkydCompileCacheEnv
} from './quirkyd-compile-cache'

const managed = {
  [QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.quirky-remote/.fence'
}

describe('managed quirkyd compile cache', () => {
  it('caches inside a managed slot, where slot GC removes it with the slot', () => {
    const enableCompileCache = vi.fn()
    enableManagedQuirkydCompileCache('/home/u/.quirky-remote/quirkyd-1+ab', managed, {
      enableCompileCache
    })
    expect(enableCompileCache).toHaveBeenCalledWith(
      join('/home/u/.quirky-remote/quirkyd-1+ab', QUIRKYD_COMPILE_CACHE_DIRNAME)
    )
  })

  it('never writes into a slot no client manages, such as a packaged app', () => {
    const enableCompileCache = vi.fn()
    enableManagedQuirkydCompileCache('/Applications/Quirky.app/quirkyd', {}, { enableCompileCache })
    expect(enableCompileCache).not.toHaveBeenCalled()
  })

  it('starts as before on a runtime without the API or with an unwritable slot', () => {
    expect(() => enableManagedQuirkydCompileCache('/slot', managed, {})).not.toThrow()
    const enableCompileCache = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect(() =>
      enableManagedQuirkydCompileCache('/slot', managed, { enableCompileCache })
    ).not.toThrow()
  })

  it('hands the preflight child the slot cache only when this process enabled one', () => {
    const enabled = { getCompileCacheDir: () => '/slot/x/v24' }
    expect(quirkydCompileCacheEnv('/slot', enabled, managed)).toEqual({
      NODE_COMPILE_CACHE: join('/slot', QUIRKYD_COMPILE_CACHE_DIRNAME)
    })
    expect(
      quirkydCompileCacheEnv('/slot', { getCompileCacheDir: () => undefined }, managed)
    ).toEqual({})
    expect(quirkydCompileCacheEnv('/slot', {}, managed)).toEqual({})
    // Regression: an unmanaged quirkyd's own NODE_COMPILE_CACHE stays where the operator put it.
    expect(quirkydCompileCacheEnv('/slot', enabled, {})).toEqual({})
  })
})
