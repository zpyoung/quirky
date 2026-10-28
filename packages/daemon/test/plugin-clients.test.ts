import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION, RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './plugins/fixtures'
import { startHarness, type Harness } from './helpers'

let harness: Harness | null = null
afterEach(async () => {
  await harness?.cleanup()
  harness = null
  removeTempDirs()
})

const LOOSE = { type: 'object', additionalProperties: true }
const PLUGIN_ID = 'acme.mobile'

type RpcMessage = { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }
type TestDaemon = { client: QuirkyClient; marker: string; nextId: number; logs: string[] }

function pluginSource(marker: string, failSend?: 'text' | 'binary'): string {
  const sendTextBody = failSend === 'text' ? "throw new Error('private-text-send-secret')" : 'sent.push(text)'
  const sendBinaryBody = failSend === 'binary' ? "throw new Error('private-binary-send-secret')" : 'binaries.push(Array.from(bytes))'
  return `
    const sent = []
    const binaries = []
    const checks = []
    let denied = ''
    let mutations = 0
    let admitted
    admitted = context.clients.accept({
      role: 'mobile',
      deviceId: 'paired-device-1',
      name: 'Trusted Phone',
      authorize(method, params) {
        checks.push({ method, params: JSON.parse(JSON.stringify(params)) })
        if (method === denied) throw new Error('private-auth-secret')
      },
      sendText(text) { ${sendTextBody} },
      sendBinary(bytes) { ${sendBinaryBody} },
      close() {
        appendFileSync(${JSON.stringify(marker)}, 'transport-close\\n')
        admitted.disconnect()
      }
    })

    context.provide('method:${PLUGIN_ID}/tunnel', async (params) => {
      const start = sent.length
      await admitted.receive(JSON.stringify(params.request))
      return sent.slice(start).map((text) => JSON.parse(text))
    })
    context.provide('method:${PLUGIN_ID}/identity', (_params, caller) => caller)
    context.provide('method:${PLUGIN_ID}/increment', () => ++mutations)
    context.provide('method:${PLUGIN_ID}/danger', () => {
      appendFileSync(${JSON.stringify(marker)}, 'danger-executed\\n')
      return 'danger ran'
    })
    context.provide('method:${PLUGIN_ID}/setDenied', (params) => {
      denied = params.method
      return true
    })
    context.provide('method:${PLUGIN_ID}/state', () => ({
      checks: [...checks],
      mutations,
      binaries: [...binaries],
      messages: sent.map((text) => JSON.parse(text))
    }))
    context.provide('method:${PLUGIN_ID}/publish', (params) => context.emit('ping', params.data))
    context.provide('method:${PLUGIN_ID}/open', (_params, caller) => {
      const stream = caller.connection.openStream()
      stream.onClose(() => appendFileSync(${JSON.stringify(marker)}, 'stream-close\\n'))
      stream.send(new Uint8Array([3, 1, 4]))
      return { streamId: stream.streamId }
    })
    context.provide('method:${PLUGIN_ID}/disconnect', () => {
      admitted.disconnect()
      admitted.disconnect()
      return true
    })
  `
}

async function startMobilePlugin(failSend?: 'text' | 'binary'): Promise<TestDaemon> {
  const root = makeTempDir('qd-mobile-clients-')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const marker = join(root, 'marker.log')
  writeModulePlugin(
    join(home, 'plugins'),
    marker,
    {
      id: PLUGIN_ID,
      activation: 'startup',
      contributes: {
        event: [{ id: 'ping' }],
        method: [
          { id: 'tunnel', params: LOOSE },
          { id: 'identity', params: LOOSE, readOnly: true },
          { id: 'increment', params: LOOSE },
          { id: 'danger', params: LOOSE, destructive: true, confirm: 'Run dangerous work?' },
          { id: 'setDenied', params: LOOSE },
          { id: 'state', params: LOOSE, readOnly: true },
          { id: 'publish', params: LOOSE },
          { id: 'open', params: LOOSE, readOnly: true, connection: true },
          { id: 'disconnect', params: LOOSE }
        ]
      }
    },
    { activate: pluginSource(marker, failSend) }
  )
  const logs: string[] = []
  harness = await startHarness({ home, builtinPluginsDir: null, log: (message) => logs.push(message) })
  return { client: await harness.connect(), marker, nextId: 0, logs }
}

async function mobileCall(
  daemon: TestDaemon,
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Promise<RpcMessage> {
  const nested = (await daemon.client.callAny(`${PLUGIN_ID}/tunnel`, {
    request: { jsonrpc: '2.0', id: ++daemon.nextId, method, params, ...extra }
  })) as RpcMessage[]
  return nested[0]!
}

type StatusClient = { role: string; name?: string }

function isStatusClient(value: unknown): value is StatusClient {
  return value !== null && typeof value === 'object' && 'role' in value && typeof value.role === 'string' &&
    (!('name' in value) || typeof value.name === 'string')
}

function statusClients(value: unknown): StatusClient[] {
  if (value === null || typeof value !== 'object' || !('clients' in value) ||
    !Array.isArray(value.clients) || !value.clients.every(isStatusClient)) {
    throw new Error('status response did not contain clients')
  }
  return value.clients
}

describe('PluginContext.clients.accept', () => {
  test('routes mobile JSON-RPC through kernel and plugin handlers with immutable caller identity and real streams', async () => {
    const daemon = await startMobilePlugin()

    const beforeHello = await mobileCall(daemon, `${PLUGIN_ID}/identity`)
    expect(beforeHello.result).toEqual({ role: 'mobile', name: 'Trusted Phone', deviceId: 'paired-device-1' })

    const hello = await mobileCall(daemon, 'client.hello', {
      role: 'mobile',
      protocolVersion: PROTOCOL_VERSION,
      name: 'untrusted name',
    })
    expect(hello).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSION } })
    const escalation = await mobileCall(daemon, 'client.hello', {
      role: 'ui',
      protocolVersion: PROTOCOL_VERSION,
      name: 'spoofed UI',
    })
    expect(escalation).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSION } })

    const identity = await mobileCall(daemon, `${PLUGIN_ID}/identity`, {
      role: 'ui',
      name: 'spoofed caller',
      deviceId: 'spoofed-device'
    })
    expect(identity.result).toEqual({ role: 'mobile', name: 'Trusted Phone', deviceId: 'paired-device-1' })

    await mobileCall(daemon, 'events.subscribe')
    await daemon.client.callAny(`${PLUGIN_ID}/publish`, { data: { alive: true } })
    const subscribed = (await daemon.client.callAny(`${PLUGIN_ID}/state`, {})) as { messages: RpcMessage[] }
    expect(subscribed.messages.some((message) => message.method === 'event')).toBe(true)

    const status = await mobileCall(daemon, 'status.get')
    expect(statusClients(status.result)).toContainEqual({ role: 'mobile', name: 'Trusted Phone' })

    const opened = await mobileCall(daemon, `${PLUGIN_ID}/open`)
    expect(opened.result).toMatchObject({ streamId: expect.any(Number) })
    const streamed = (await daemon.client.callAny(`${PLUGIN_ID}/state`, {})) as { binaries: number[][] }
    expect(streamed.binaries).toHaveLength(1)
    expect(streamed.binaries[0]).toEqual(expect.arrayContaining([3, 1, 4]))

    await daemon.client.callAny(`${PLUGIN_ID}/disconnect`, {})
    const disconnected = await daemon.client.callAny('status.get', {})
    expect(statusClients(disconnected).some((client) => client.role === 'mobile')).toBe(false)
    expect(readMarker(daemon.marker).filter((line) => line === 'stream-close')).toHaveLength(1)
    expect(readMarker(daemon.marker).filter((line) => line === 'transport-close')).toHaveLength(0)
  })

  test('re-authorizes before idempotency, confirmation, or method lookup and hides authorization errors', async () => {
    const daemon = await startMobilePlugin()

    expect(await mobileCall(daemon, `${PLUGIN_ID}/increment`, {}, { requestId: 'same-request' })).toMatchObject({ result: 1 })
    await daemon.client.callAny(`${PLUGIN_ID}/setDenied`, { method: `${PLUGIN_ID}/increment` })
    const cachedRetry = await mobileCall(daemon, `${PLUGIN_ID}/increment`, {}, { requestId: 'same-request' })
    expect(cachedRetry).toMatchObject({ error: { code: RpcErrorCode.Unauthorized, message: 'not authorized' } })
    expect(JSON.stringify(cachedRetry)).not.toContain('private-auth-secret')

    await daemon.client.callAny(`${PLUGIN_ID}/setDenied`, { method: `${PLUGIN_ID}/danger` })
    const confirmationAttempt = await mobileCall(daemon, `${PLUGIN_ID}/danger`)
    expect(confirmationAttempt).toMatchObject({ error: { code: RpcErrorCode.Unauthorized, message: 'not authorized' } })
    expect(JSON.stringify(confirmationAttempt)).not.toContain('private-auth-secret')

    await daemon.client.callAny(`${PLUGIN_ID}/setDenied`, { method: 'method:not.registered/secret' })
    const unresolved = await mobileCall(daemon, 'method:not.registered/secret')
    expect(unresolved).toMatchObject({ error: { code: RpcErrorCode.Unauthorized, message: 'not authorized' } })
    expect(JSON.stringify(unresolved)).not.toContain('private-auth-secret')

    const state = (await daemon.client.callAny(`${PLUGIN_ID}/state`, {})) as {
      checks: { method: string; params: Record<string, unknown> }[]
      mutations: number
    }
    expect(state.mutations).toBe(1)
    expect(state.checks.filter((check) => check.method === `${PLUGIN_ID}/increment`)).toHaveLength(2)
    expect(state.checks.find((check) => check.method === `${PLUGIN_ID}/danger`)?.params).toEqual({})
    expect(readMarker(daemon.marker)).not.toContain('danger-executed')
  })

  test('closes transport and streams exactly once on plugin revoke and activation failure', async () => {
    const daemon = await startMobilePlugin()
    await mobileCall(daemon, `${PLUGIN_ID}/open`)
    const beforeRevoke = await daemon.client.callAny('status.get', {})
    expect(statusClients(beforeRevoke).some((client) => client.role === 'mobile')).toBe(true)

    await daemon.client.callAny('plugin.disable', { id: PLUGIN_ID })
    await daemon.client.callAny('plugin.disable', { id: PLUGIN_ID })
    expect(readMarker(daemon.marker).filter((line) => line === 'transport-close')).toHaveLength(1)
    expect(readMarker(daemon.marker).filter((line) => line === 'stream-close')).toHaveLength(1)
    const afterRevoke = await daemon.client.callAny('status.get', {})
    expect(statusClients(afterRevoke).some((client) => client.role === 'mobile')).toBe(false)

    const root = makeTempDir('qd-mobile-failure-')
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const marker = join(root, 'failure.log')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.failedmobile', activation: 'startup' },
      {
        activate: `
          context.clients.accept({
            role: 'mobile', deviceId: 'failed-device', name: 'Failed phone',
            authorize() {}, sendText() {}, sendBinary() {},
            close() { appendFileSync(${JSON.stringify(marker)}, 'failure-transport-close\\n') }
          })
          throw new Error('activation failed after admission')
        `
      }
    )
    const failedHarness = await startHarness({ home, builtinPluginsDir: null })
    try {
      const failedClient = await failedHarness.connect()
      const failedStatus = await failedClient.callAny('status.get', {})
      expect(statusClients(failedStatus).some((client) => client.role === 'mobile')).toBe(false)
      expect(readMarker(marker).filter((line) => line === 'failure-transport-close')).toHaveLength(1)
    } finally {
      await failedHarness.cleanup()
    }
  })
  test('disconnects when the text send callback throws without exposing the callback error', async () => {
    const daemon = await startMobilePlugin('text')
    await mobileCall(daemon, 'status.get')

    const status = await daemon.client.callAny('status.get', {})
    expect(statusClients(status).some((client) => client.role === 'mobile')).toBe(false)
    expect(readMarker(daemon.marker).filter((line) => line === 'transport-close')).toHaveLength(1)
    expect(daemon.logs.filter((line) => /admitted client \d+ send callback failed; disconnecting/.test(line))).toHaveLength(1)
    expect(daemon.logs.join('\n')).not.toContain('private-text-send-secret')
  })

  test('closes binary streams and transport when the binary send callback throws', async () => {
    const daemon = await startMobilePlugin('binary')
    await mobileCall(daemon, `${PLUGIN_ID}/open`)

    const status = await daemon.client.callAny('status.get', {})
    expect(statusClients(status).some((client) => client.role === 'mobile')).toBe(false)
    expect(readMarker(daemon.marker).filter((line) => line === 'stream-close')).toHaveLength(1)
    expect(readMarker(daemon.marker).filter((line) => line === 'transport-close')).toHaveLength(1)
    expect(daemon.logs.filter((line) => /admitted client \d+ send callback failed; disconnecting/.test(line))).toHaveLength(1)
    expect(daemon.logs.join('\n')).not.toContain('private-binary-send-secret')
  })
})
