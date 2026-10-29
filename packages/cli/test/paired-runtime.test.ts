import { afterEach, expect, test } from 'bun:test'
import { PLUGIN_API_VERSION, type ApiDescription } from '@quirky/protocol'
import { addSavedRuntimeTarget, listSavedRuntimeTargets } from '@quirky/protocol/node'
import type { MobileSocket } from '@quirky/protocol/paired-client'
import { makeTestPeer, DEVICE_ID, DEVICE_TOKEN } from '../../../apps/mobile/test/transport-peer'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const cleanups: (() => void)[] = []
afterEach(() => { for (const stop of cleanups.splice(0)) stop() })

type PeerData = { peer: MobileSocket | null }
function setup() {
  const local = new FakeDaemon().start()
  cleanups.push(() => local.stop())
  const description: ApiDescription = {
    schemaVersion: 2, daemonVersion: 'paired-fixture', protocolVersion: 1, pluginApiVersion: PLUGIN_API_VERSION,
    methods: [
      { name: 'quirky.worktree/list', plugin: 'quirky.worktree', readOnly: true, params: { type: 'object', properties: {}, additionalProperties: false }, result: { type: 'array', items: { type: 'object' } } },
      { name: 'quirky.worktree/resolve', plugin: 'quirky.worktree', readOnly: true, params: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }, result: { type: 'object' } }
    ], events: [], uiCommands: [], cli: { groups: [{ plugin: 'quirky.worktree', words: 'worktree', aliases: [] }], commands: [] }
  }
  const remote = makeTestPeer({ onRequest(method) {
    if (method === 'quirky.mobile/api') return description
    if (method === 'quirky.worktree/list') return [{ id: 'remote-owned-workspace' }]
    throw new Error(`Unexpected remote method ${method}`)
  } })
  const server = Bun.serve<PeerData>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request, { data: { peer: null } }) ? undefined : new Response('upgrade required', { status: 400 }) },
    websocket: {
      open(socket) {
        const peer = new remote.WebSocket('ws://owned-peer')
        socket.data.peer = peer
        peer.onmessage = (event) => { if (typeof event.data === 'string') socket.send(event.data) }
        peer.onclose = () => socket.close()
      },
      message(socket, value) { socket.data.peer?.send(typeof value === 'string' ? value : value.toString()) },
      close(socket) { const peer = socket.data.peer; socket.data.peer = null; peer?.close() }
    }
  })
  cleanups.unshift(() => server.stop(true))
  const endpoint = `ws://127.0.0.1:${server.port}`
  const pairingCode = Buffer.from(JSON.stringify({ v: 2, endpoint, deviceToken: DEVICE_TOKEN, publicKeyB64: remote.publicKeyB64, pairedDeviceId: DEVICE_ID, scope: 'mobile' })).toString('base64url')
  return { local, remote, pairingCode, endpoint }
}

test('one-off and saved selections use the encrypted target, never the available local daemon or ambient local identities', async () => {
  const { local, pairingCode, endpoint } = setup()
  const first = await runCli(['--pairing-code', pairingCode, 'api', 'call', 'quirky.worktree/list', '--json'], { home: local.home, env: { QUIRKY_RUNTIME: 'missing-ambient', QUIRKY_SESSION_ID: 'local-session', QUIRKY_WORKTREE_ID: 'local-workspace' } })
  expect(first.code).toBe(0)
  expect(JSON.parse(first.stdout)).toEqual([{ id: 'remote-owned-workspace' }])
  const saved = addSavedRuntimeTarget(local.home, 'Owned peer', pairingCode)
  const second = await runCli(['--runtime', saved.id, 'api', 'call', 'quirky.worktree/list', '--json'], { home: local.home, env: { QUIRKY_PAIRING_CODE: 'invalid-ambient-offer' } })
  expect(second.code).toBe(0)
  expect(JSON.parse(second.stdout)).toEqual([{ id: 'remote-owned-workspace' }])
  expect(listSavedRuntimeTargets(local.home)[0]!.lastUsedAt).not.toBeNull()
  expect(local.connections).toBe(0)
  expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(DEVICE_TOKEN)
}, 20_000)

test('missing saved targets and local current shortcuts fail without executing on the local daemon or remote owner', async () => {
  const { local, remote, pairingCode } = setup()
  const missing = await runCli(['--runtime', 'missing', 'status', '--json'], { home: local.home })
  expect(missing.code).toBe(1)
  expect(JSON.parse(missing.stdout).error.data.runtime.name).toBe('missing')
  const shortcut = await runCli(['--pairing-code', pairingCode, 'api', 'call', 'quirky.worktree/resolve', '--selector', 'current', '--json'], { home: local.home })
  expect(shortcut.code).toBe(1)
  expect(JSON.parse(shortcut.stdout).error.reason).toBe('local-selector-on-remote')
  expect(remote.requests.some((request) => request.method === 'quirky.worktree/resolve')).toBe(false)
  expect(local.connections).toBe(0)
}, 20_000)
