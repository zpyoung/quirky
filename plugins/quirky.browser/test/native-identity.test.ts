import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { nativePaneUserAgent } from '../src/preferences/native-identity'

const WEBKIT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

function fixture(identity: { mode: string; active: string }, engineUserAgent: string | null) {
  const calls: string[] = []
  const context = {
    call: async (method: string) => {
      calls.push(method)
      return { ...identity, restartRequired: identity.mode !== identity.active }
    },
    nativeBrowser: { defaultUserAgent: async () => engineUserAgent }
  } as unknown as UiPluginContext
  return { context, calls }
}

test('Cleaned strips app and embedding tokens from the system webview user agent', async () => {
  const { context, calls } = fixture({ mode: 'clean', active: 'clean' }, `${WEBKIT} Quirky/1.2.3 Electrobun/2.0.5`)
  expect(await nativePaneUserAgent(context)).toBe(WEBKIT)
  expect(calls).toEqual(['quirky.browser/identityGet'])
})

test('Native keeps the system webview user agent untouched', async () => {
  const { context } = fixture({ mode: 'native', active: 'native' }, `${WEBKIT} Quirky/1.2.3`)
  expect(await nativePaneUserAgent(context)).toBeUndefined()
})

test('a pending selection does not apply before the daemon restarts', async () => {
  const pendingNative = fixture({ mode: 'native', active: 'clean' }, `${WEBKIT} Quirky/1.2.3`)
  expect(await nativePaneUserAgent(pendingNative.context)).toBe(WEBKIT)

  const pendingClean = fixture({ mode: 'clean', active: 'native' }, `${WEBKIT} Quirky/1.2.3`)
  expect(await nativePaneUserAgent(pendingClean.context)).toBeUndefined()
})

test('a host without a user-agent override keeps the engine default rather than claiming Cleaned', async () => {
  const { context } = fixture({ mode: 'clean', active: 'clean' }, null)
  expect(await nativePaneUserAgent(context)).toBeUndefined()
})
