import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QuirkyRuntimeService } from '../runtime/quirky-runtime'

// Why: getAskServices() resolves the electron app lazily via require('electron'), so outside a
// real Electron process require('electron') just returns the binary's path string — stub the
// module's own require.cache entry, since vi.mock only intercepts the ESM import graph.
const require = createRequire(import.meta.url)
const electronModulePath = require.resolve('electron')
const mockElectronApp = { userDataPath: '' }

require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { getPath: () => mockElectronApp.userDataPath } }
} as unknown as NodeJS.Module

describe('QuirkyRuntimeService.getAskServices', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quirky-ask-runtime-'))
    mockElectronApp.userDataPath = root
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('delegates to the same memoized service bundle across calls', () => {
    const runtime = new QuirkyRuntimeService()

    const services = runtime.getAskServices()
    expect(runtime.getAskServices()).toBe(services)
  })

  it('gives each runtime instance its own service bundle', () => {
    const a = new QuirkyRuntimeService()
    const b = new QuirkyRuntimeService()

    expect(a.getAskServices()).not.toBe(b.getAskServices())
  })
})
