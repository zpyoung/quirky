import { afterEach, expect, test } from 'bun:test'
import { startHarness, builtinsDir, type Harness } from '../../../packages/daemon/test/helpers'
import { MobileTestClient } from './support/client'

let harness: Harness | undefined
let phone: MobileTestClient | undefined
const saved = process.env.QUIRKY_MOBILE_PORT

afterEach(async () => {
  await phone?.close()
  phone = undefined
  await harness?.cleanup()
  harness = undefined
  if (saved === undefined) delete process.env.QUIRKY_MOBILE_PORT
  else process.env.QUIRKY_MOBILE_PORT = saved
})

test('paired phone notification polling is scoped, replayable and closed by revocation', async () => {
  process.env.QUIRKY_MOBILE_PORT = '0'
  harness = await startHarness({ builtinPluginsDir: builtinsDir() })
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
  const consumed = await phone.call('quirky.mobile/notificationPoll', { after: replay.cursor, epoch: first.epoch, waitMs: 0 }) as { notifications: unknown[] }
  expect(consumed.notifications).toEqual([])
  const waiting = phone.call('quirky.mobile/notificationPoll', { after: replay.cursor, epoch: first.epoch, waitMs: 25000 })
    .then(() => ({ resolved: true }), error => ({ error }))
  await expect(phone.call('quirky.mobile/notificationPoll', { waitMs: 0 })).rejects.toThrow('pending')
  await local.callAny('quirky.mobile/revoke', { deviceId: offer.deviceId })
  expect(await waiting).toMatchObject({ error: expect.any(Error) })
}, 30000)
