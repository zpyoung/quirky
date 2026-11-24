import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  clear(): void {
    this.values.clear()
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installBrowserGlobals(): { window: Window & typeof globalThis; storage: MemoryStorage } {
  const storage = new MemoryStorage()
  const windowStub = {
    localStorage: storage,
    location: { protocol: 'http:', reload: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  } as unknown as Window & typeof globalThis
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('navigator', { userAgent: 'Linux', hardwareConcurrency: 8 })
  return { window: windowStub, storage }
}

function writeRuntimeEnvironment(storage: Storage): void {
  storage.setItem(
    'quirky.web.runtimeEnvironment.v1',
    JSON.stringify({
      id: 'web-env-1',
      name: 'Test runtime',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      preferredEndpointId: 'ws-web-env-1',
      endpoints: [
        {
          id: 'ws-web-env-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:1234',
          deviceToken: 'token',
          publicKeyB64: 'public-key'
        }
      ]
    })
  )
}

describe('web native-chat relay preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../../../web/web-runtime-client')
  })

  it('forwards object-form pagination reads to the paired runtime', async () => {
    const calls: { method: string; params: unknown }[] = []
    vi.doMock('../../../web/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          return Promise.resolve({
            id: 'read-1',
            ok: true,
            result: { messages: [], hasMore: true, beforeOffset: 4096 },
            _meta: { runtimeId: 'runtime-1' }
          })
        }
        close(): void {}
      }
    }))

    const globals = installBrowserGlobals()
    writeRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('../../../web/web-preload-api')
    installWebPreloadApi()
    const args = {
      agent: 'claude' as const,
      sessionId: 'session-1',
      limit: 50,
      transcriptPath: '/remote/transcript.jsonl',
      beforeOffset: 8192
    }

    const readSession = globals.window.api.nativeChat.readSession as unknown as (
      input: typeof args
    ) => Promise<unknown>
    await expect(readSession(args)).resolves.toEqual({
      messages: [],
      hasMore: true,
      beforeOffset: 4096
    })
    expect(calls).toContainEqual({ method: 'nativeChat.readSession', params: args })
  })
})
