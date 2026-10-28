import { afterEach, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { MobileTestClient } from '../../quirky.mobile/test/support/client'
import { type Harness } from '../../../packages/daemon/test/helpers'
import { fakeAgents, resetFakeAgents } from './fakes/quirky.agents/main'
import { call, SESSION_PLUGINS, startPluginHarness } from './support'

let harness: Harness | undefined
let phone: MobileTestClient | undefined
let previousPort: string | undefined
let savedEnvironment = false

afterEach(async () => {
  await phone?.close()
  phone = undefined
  await harness?.cleanup()
  harness = undefined
  resetFakeAgents()
  if (savedEnvironment) {
    if (previousPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousPort
  }
  savedEnvironment = false
})

test('encrypted mobile session consumers omit launch metadata while local clients keep it', async () => {
  previousPort = process.env.QUIRKY_MOBILE_PORT
  savedEnvironment = true
  process.env.QUIRKY_MOBILE_PORT = '0'
  resetFakeAgents()
  // A synthetic sensitive argument makes leakage observable without using real credentials or CLIs.
  const sensitive = 'isolated-mobile-launch-credential'
  fakeAgents().args = `--credential ${sensitive}`
  harness = await startPluginHarness({ real: [...SESSION_PLUGINS.real, 'quirky.mobile'], fakes: SESSION_PLUGINS.fakes })
  const local = await harness.connect('cli')
  const pairing = await call<{ pairingUrl: string; endpoint: string }>(local, 'quirky.mobile/pair', { address: '127.0.0.1' })
  const offer = JSON.parse(Buffer.from(new URL(pairing.pairingUrl).searchParams.get('code')!, 'base64url').toString())
  phone = MobileTestClient.connect(pairing.endpoint, offer.publicKeyB64, offer.deviceToken)
  await phone.authenticated

  const created = await phone.call('quirky.session/create', { worktree: 'floating', agent: 'claude' }) as Session
  expect(Object.hasOwn(created, 'launch')).toBe(false)
  const privateRecord = await call<Session>(local, 'quirky.session/get', { session: created.id })
  expect(privateRecord.launch?.args).toContain(sensitive)

  const read = await phone.call('quirky.session/get', { session: created.id }) as Session
  const listed = await phone.call('quirky.session/list', {}) as Session[]
  const renamed = await phone.call('quirky.session/setName', { session: created.id, name: 'phone-private' }) as Session
  const restored = await phone.call('quirky.session/restore', { session: created.id }) as Session
  await call(local, 'quirky.session/setProviderSession', { session: created.id, id: 'isolated-provider-session' })
  const resumed = await phone.call('quirky.session/resume', { session: created.id }) as Session
  for (const result of [read, ...listed, renamed, restored, resumed]) {
    expect(Object.hasOwn(result, 'launch')).toBe(false)
    expect(JSON.stringify(result)).not.toContain(sensitive)
  }
  const localResumed = await call<Session>(local, 'quirky.session/get', { session: resumed.id })
  expect(localResumed.launch?.args).toContain(sensitive)
  expect((await call<Session[]>(local, 'quirky.session/list', {})).find(session => session.id === created.id)?.launch?.args).toContain(sensitive)
}, 20_000)
