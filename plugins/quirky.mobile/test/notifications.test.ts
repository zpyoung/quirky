import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startHarness, builtinsDir, makeHomeWithoutAutoHooks, type Harness } from '../../../packages/daemon/test/helpers'
import { MobileTestClient } from './support/client'

let harness: Harness | undefined
let phone: MobileTestClient | undefined
let fixtureHome: string | undefined
let environment: Map<string, string | undefined> | undefined
const ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'QUIRKY_MOBILE_PORT', 'QUIRKY_MOBILE_HOST', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const

afterEach(async () => {
  await phone?.close()
  phone = undefined
  await harness?.cleanup()
  harness = undefined
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true })
  fixtureHome = undefined
  for (const [key, value] of environment ?? []) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  environment = undefined
})

test('paired phone notification polling is scoped, replayable and closed by revocation', async () => {
  environment = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  fixtureHome = makeHomeWithoutAutoHooks('quirky-phone-notifications-')
  const userHome = join(fixtureHome, 'user-home')
  mkdirSync(userHome, { recursive: true })
  Object.assign(process.env, { HOME: userHome, QUIRKY_HOME: fixtureHome, QUIRKY_MOBILE_PORT: '0', CODEX_HOME: join(userHome, '.codex'), CLAUDE_CONFIG_DIR: join(userHome, '.claude') })
  delete process.env.QUIRKY_MOBILE_HOST
  harness = await startHarness({ home: fixtureHome, builtinPluginsDir: builtinsDir() })
  const local = await harness.connect('cli')
  const offer = await local.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string; endpoint: string; deviceId: string }
  const code = JSON.parse(Buffer.from(new URL(offer.pairingUrl).searchParams.get('code')!, 'base64url').toString())
  phone = MobileTestClient.connect(offer.endpoint, code.publicKeyB64, code.deviceToken)
  await phone.authenticated
  const first = await phone.call('quirky.mobile/notificationPoll', { waitMs: 0 }) as { epoch: string; cursor: number; notifications: unknown[] }
  expect(first.notifications).toEqual([])
  await expect(phone.call('quirky.mobile/notificationPoll', { waitMs: 0, deviceId: 'another-device' })).rejects.toMatchObject({ code: -32001 })
  await expect(phone.call('events.subscribe')).rejects.toMatchObject({ code: -32001 })
  expect(await phone.call('quirky.mobile/notificationTest')).toEqual({ sent: true })
  const replay = await phone.call('quirky.mobile/notificationPoll', { after: first.cursor, epoch: first.epoch, waitMs: 0 }) as { cursor: number; notifications: { title: string; id: string; seq: number }[] }
  expect(replay.notifications.map(row => row.title)).toEqual(['Quirky mobile test notification'])
  expect(replay.notifications[0]?.seq).toBe(first.cursor + 1)
  expect(replay.notifications[0]?.id).toBe(`${first.epoch}:${replay.cursor}`)
  expect(JSON.stringify(replay)).not.toContain(code.deviceToken)
  expect(await local.callAny('quirky.notifications/send', { title: 'Owned source event', body: 'Read this task result.' })).toMatchObject({ delivered: true })
  const sourceEvent = await phone.call('quirky.mobile/notificationPoll', { after: replay.cursor, epoch: first.epoch, waitMs: 3000, onlyWhenDesktopAway: false }) as { cursor: number; notifications: { title: string; body: string }[] }
  expect(sourceEvent.notifications.map(row => row.body)).toEqual(['Read this task result.'])
  const consumed = await phone.call('quirky.mobile/notificationPoll', { after: sourceEvent.cursor, epoch: first.epoch, waitMs: 0 }) as { notifications: unknown[] }
  expect(consumed.notifications).toEqual([])
  const waiting = phone.call('quirky.mobile/notificationPoll', { after: sourceEvent.cursor, epoch: first.epoch, waitMs: 25000, subscriptionId: 'first-page' })
    .then(() => ({ resolved: true }), error => ({ error }))
  await expect(phone.call('quirky.mobile/notificationPoll', { waitMs: 0 })).rejects.toThrow('pending')
  expect(await phone.call('quirky.mobile/notificationCancel', { subscriptionId: 'older-page' })).toEqual({ cancelled: false })
  expect(await phone.call('quirky.mobile/notificationCancel', { subscriptionId: 'first-page' })).toEqual({ cancelled: true })
  expect(await waiting).toMatchObject({ error: expect.any(Error) })
  const replacement = phone.call('quirky.mobile/notificationPoll', { after: sourceEvent.cursor, epoch: first.epoch, waitMs: 25000, subscriptionId: 'new-page' })
    .then(() => ({ resolved: true }), error => ({ error }))
  await expect(phone.call('quirky.mobile/notificationPoll', { waitMs: 0 })).rejects.toThrow('pending')
  await local.callAny('quirky.mobile/revoke', { deviceId: offer.deviceId })
  expect(await replacement).toMatchObject({ error: expect.any(Error) })
}, 30000)
