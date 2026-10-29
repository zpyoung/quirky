import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { registerPreferencesUi } from '../src/preferences-ui'

for (const available of [false, true]) {
  test(`native clear completion unavailable (${available ? 'native host' : 'web client'}) never consumes a confirmed claim or invokes storage deletion`, async () => {
    const handlers = new Map<string, unknown>()
    let claims = 0
    let clears = 0
    // This fixture runs only the registered command; no React root, webview, or native Session is mounted.
    const context = {
      provide: (id: string, implementation: unknown) => handlers.set(id, implementation),
      call: async () => { claims += 1; return { partition: 'persist:quirky-browser-default' } },
      nativeBrowser: {
        available,
        clearPartitionAvailable: false,
        mount: () => { throw new Error('Native mount must not run in this fixture') },
        clearPartition: async () => { clears += 1 }
      }
    } as unknown as UiPluginContext
    registerPreferencesUi(context)
    const provided = handlers.get('command:quirky.browser/profileClearNative')
    if (typeof provided !== 'function') throw new Error('Native clear command was not registered')
    await expect(provided({ request: 'owned-confirmed-request' })).rejects.toThrow()
    expect(claims).toBe(0)
    expect(clears).toBe(0)
  })
}

test('a host that confirms native removal claims the confirmed request once and clears its partition', async () => {
  const handlers = new Map<string, unknown>()
  const claims: unknown[] = []
  const clears: string[] = []
  const context = {
    provide: (id: string, implementation: unknown) => handlers.set(id, implementation),
    call: async (method: string, params: unknown) => {
      claims.push({ method, params })
      return { partition: 'persist:quirky-browser-default' }
    },
    nativeBrowser: {
      available: true,
      clearPartitionAvailable: true,
      mount: () => { throw new Error('Native mount must not run in this fixture') },
      clearPartition: async (partition: string) => { clears.push(partition) }
    }
  } as unknown as UiPluginContext
  registerPreferencesUi(context)
  const provided = handlers.get('command:quirky.browser/profileClearNative') as (args: unknown) => Promise<unknown>

  await expect(provided({ request: 'owned-confirmed-request' })).resolves.toEqual({ cleared: true })
  expect(claims).toEqual([{ method: 'quirky.browser/profileClearNativeClaim', params: { request: 'owned-confirmed-request' } }])
  expect(clears).toEqual(['persist:quirky-browser-default'])
})

test('a native removal failure after the claim rejects without reporting success', async () => {
  const handlers = new Map<string, unknown>()
  let claims = 0
  const context = {
    provide: (id: string, implementation: unknown) => handlers.set(id, implementation),
    call: async () => { claims += 1; return { partition: 'persist:quirky-browser-default' } },
    nativeBrowser: {
      available: true,
      clearPartitionAvailable: true,
      mount: () => { throw new Error('Native mount must not run in this fixture') },
      clearPartition: async () => { throw new Error('Native website-data removal did not complete (failed: timeout)') }
    }
  } as unknown as UiPluginContext
  registerPreferencesUi(context)
  const provided = handlers.get('command:quirky.browser/profileClearNative') as (args: unknown) => Promise<unknown>

  await expect(provided({ request: 'owned-confirmed-request' })).rejects.toThrow(/did not complete/)
  expect(claims).toBe(1)
})
