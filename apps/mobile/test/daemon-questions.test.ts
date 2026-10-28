import { afterEach, expect, test } from 'bun:test'
import { builtinsDir, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { createMobileRuntime } from '../src/native/runtime'
import type { MobileRuntime } from '../src/contracts'

let harness: Harness | undefined
let app: MobileRuntime | undefined
let oldPort: string | undefined
let savedPort = false

afterEach(async () => {
  app?.dispose()
  app = undefined
  await harness?.cleanup()
  harness = undefined
  if (savedPort) {
    if (oldPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = oldPort
  }
  savedPort = false
})

test('the production phone client answers a real ask whose question ID is role', async () => {
  oldPort = process.env.QUIRKY_MOBILE_PORT
  savedPort = true
  process.env.QUIRKY_MOBILE_PORT = '0'
  harness = await startHarness({ builtinPluginsDir: builtinsDir() })
  const local = await harness.connect('cli')
  const pairing = await local.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
  const metadata = new Map<string, string>()
  const tokens = new Map<string, string>()
  app = createMobileRuntime({
    storage: {
      get: async (key) => metadata.get(key) ?? null,
      set: async (key, value) => { metadata.set(key, value) },
      remove: async (key) => { metadata.delete(key) }
    },
    secrets: {
      read: async (id) => tokens.has(id) ? { kind: 'available', token: tokens.get(id)! } : { kind: 'missing' },
      write: async (id, token) => { tokens.set(id, token) },
      remove: async (id) => { tokens.delete(id) }
    },
    native: {
      clipboardRead: async () => { throw new Error('clipboard not requested by this scenario') },
      clipboardWrite: async () => { throw new Error('clipboard not requested by this scenario') },
      openExternal: async () => { throw new Error('link not requested by this scenario') },
      haptic: async () => { throw new Error('haptic not requested by this scenario') },
      notificationPermission: async () => 'unavailable',
      openSystemSettings: async () => { throw new Error('settings not requested by this scenario') }
    }
  })
  app.setForeground(true)
  const host = await app.pair(pairing.pairingUrl)
  const phone = await app.getRpc(host.id)
  const { askId } = await local.callAny('quirky.ask/create', {
    spec: { questions: [{ id: 'role', type: 'text', question: 'Which role should review this change?' }] }
  }) as { askId: string }
  await phone.call('quirky.ask/answer', { askId, answers: { role: { value: 'reviewer', source: 'input' } } })
  const result = await local.callAny('quirky.ask/wait', { askId, timeoutMs: 0 }) as { status: string; answers: unknown }
  expect(result.status).toBe('answered')
  expect(result.answers).toEqual({ role: { value: 'reviewer', source: 'input' } })
}, 20_000)
