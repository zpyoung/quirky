import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { PtyClient } from '../src/pty-client'
import { createPtyApi } from '../src/plugins/pty-api'
import { startFakePtyHost, type FakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome, waitFor } from './helpers'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

async function harness(options: { writeAcceptedTimeoutMs?: number } = {}) {
  const home = makeTempHome('qpa-')
  const host = startFakePtyHost(home)
  cleanups.push(() => host.stop())
  const client = new PtyClient({ home, hostEntry: '/does/not/exist', log: () => {}, ...options })
  cleanups.push(() => client.close())
  await client.connect()
  const api = createPtyApi(client, 'receipt-test').api
  await api.spawn('receipt-session', { argv: ['/bin/cat'], cwd: home, env: {}, cols: 80, rows: 24 })
  return { api, client, host }
}

function isReceiptRequest(host: FakePtyHost) {
  return host.requests.some((request) => request.type === 'writeAccepted')
}

describe('PluginPty.writeAccepted', () => {
  test('fans out exactly once only after the host acknowledges all bytes', async () => {
    const { api, client, host } = await harness()
    const other = createPtyApi(client, 'other-plugin').api
    const gate = deferred()
    host.setWriteAcceptedHandler(() => gate.promise)
    const seenA: Array<[string, string]> = []
    const seenB: Array<[string, string]> = []
    api.onInput((sessionId, data) => seenA.push([sessionId, data]))
    other.onInput((sessionId, data) => seenB.push([sessionId, data]))

    const accepted = api.writeAccepted('receipt-session', new TextEncoder().encode('accepted once'))
    await waitFor(() => isReceiptRequest(host), 1000)
    expect(seenA).toEqual([])
    expect(seenB).toEqual([])
    expect(host.inputs).toEqual([])

    gate.resolve()
    await accepted
    expect(seenA).toEqual([['receipt-session', 'accepted once']])
    expect(seenB).toEqual(seenA)
    expect(host.inputs).toEqual([{ sessionId: 'receipt-session', text: 'accepted once' }])
  })

  test('preserves host certainty and partial-byte evidence without input fanout', async () => {
    const { api, host } = await harness()
    const seen: string[] = []
    api.onInput((_sessionId, data) => seen.push(data))
    host.setWriteAcceptedHandler(async () => {
      throw Object.assign(new Error('child accepted only a prefix'), {
        code: 'PTY_WRITE_UNCERTAIN',
        acceptedBytes: 4
      })
    })

    await expect(api.writeAccepted('receipt-session', 'partial')).rejects.toMatchObject({
      message: 'child accepted only a prefix',
      code: 'PTY_WRITE_UNCERTAIN',
      acceptedBytes: 4
    })
    expect(seen).toEqual([])
    expect(host.inputs).toEqual([])
  })

  test('maps a post-dispatch connection loss to unknown acceptance without fanout', async () => {
    const { api, host } = await harness()
    const gate = deferred()
    const seen: string[] = []
    host.setWriteAcceptedHandler(() => gate.promise)
    api.onInput((_sessionId, data) => seen.push(data))

    const accepted = api.writeAccepted('receipt-session', 'maybe')
    await waitFor(() => isReceiptRequest(host), 1000)
    host.dropConnections()

    await expect(accepted).rejects.toMatchObject({ code: 'PTY_WRITE_UNCERTAIN', acceptedBytes: null })
    expect(seen).toEqual([])
  })

  test('maps a dispatched request timeout to unknown acceptance without fanout', async () => {
    const { api, host } = await harness({ writeAcceptedTimeoutMs: 250 })
    const gate = deferred()
    const seen: string[] = []
    host.setWriteAcceptedHandler(() => gate.promise)
    api.onInput((_sessionId, data) => seen.push(data))

    const accepted = api.writeAccepted('receipt-session', 'timeout')
    await waitFor(() => isReceiptRequest(host), 1000)

    await expect(accepted).rejects.toMatchObject({ code: 'PTY_WRITE_UNCERTAIN', acceptedBytes: null })
    expect(seen).toEqual([])
  })

  test('rejects before dispatch when the host cannot be connected', async () => {
    const home = makeTempHome('qpa-offline-')
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const client = new PtyClient({
      home,
      hostEntry: '/does/not/exist',
      connectTimeoutMs: 100,
      log: () => {}
    })
    cleanups.push(() => client.close())
    const api = createPtyApi(client, 'offline-receipt-test').api
    const seen: string[] = []
    api.onInput((_sessionId, data) => seen.push(data))

    await expect(api.writeAccepted('offline-session', 'not sent')).rejects.toMatchObject({
      code: 'PTY_WRITE_REJECTED',
      acceptedBytes: 0
    })
    expect(seen).toEqual([])
  })

  test('rejects a write through a revoked PluginPty before dispatch', async () => {
    const { client, host } = await harness()
    const revoked = createPtyApi(client, 'revoked-receipt-test')
    revoked.revoke()

    await expect(revoked.api.writeAccepted('receipt-session', 'not sent')).rejects.toMatchObject({
      code: 'PTY_WRITE_REJECTED',
      acceptedBytes: 0
    })
    expect(host.requests.some((request) => request.type === 'writeAccepted')).toBe(false)
  })
})
