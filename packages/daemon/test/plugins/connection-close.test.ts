import { afterEach, expect, test } from 'bun:test'
import { QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'
import { startHarness, type Harness } from '../helpers'

const pluginId = 'quirky.connection-test'
const manifest = {
  id: pluginId,
  name: 'Connection lifecycle test fixture',
  version: '0.1.0',
  main: 'main.ts',
  contributes: {
    method: [
      {
        id: 'watch',
        connection: true,
        readOnly: true,
        params: { type: 'object' },
        result: { type: 'object', properties: { registered: { type: 'boolean' } }, required: ['registered'] }
      }
    ],
    event: [{ id: 'closed', data: { type: 'object', properties: { transport: { type: 'string' } }, required: ['transport'] } }]
  }
}
const main = `export function activate(context) {
  context.provide('method:' + context.pluginId + '/watch', (_params, caller) => {
    const connection = caller.role === 'plugin' ? undefined : caller.connection
    if (!connection) throw new Error('connection required')
    const transport = connection.transport
    connection.onClose(() => context.emit('closed', { transport }))
    return { registered: true }
  })
}
`

let harness: Harness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
  removeTempDirs()
})

test('CallerConnection.onClose runs on WebSocket and Unix socket disconnects without opening a binary stream', async () => {
  const plugins = makeTempDir('connection-close-')
  writePlugin(plugins, manifest, { 'main.ts': main })
  harness = await startHarness({ builtinPluginsDir: plugins })
  const observer = await harness.connectWithEvents('ui')

  const websocket = await harness.connect('ui')
  expect(await websocket.callAny(`${pluginId}/watch`, {})).toEqual({ registered: true })
  const websocketClosed = waitForCloseEvent(observer.client, observer.events, 'websocket')
  websocket.close()
  await websocketClosed

  const socketPath = harness.runtime.socket
  if (socketPath === undefined) throw new Error('daemon did not publish its Unix socket path')
  const socket = await QuirkyClient.connectSocket(socketPath, {
    role: 'ui',
    token: harness.runtime.token
  })
  harness.clients.push(socket)
  expect(await socket.callAny(`${pluginId}/watch`, {})).toEqual({ registered: true })
  const socketClosed = waitForCloseEvent(observer.client, observer.events, 'socket')
  socket.close()
  await socketClosed

  expect(observer.events.filter((event) => isCloseEvent(event, 'websocket') || isCloseEvent(event, 'socket'))).toHaveLength(2)
})

function waitForCloseEvent(
  client: QuirkyClient,
  events: QuirkyEvent[],
  transport: 'websocket' | 'socket'
): Promise<void> {
  if (events.some((event) => isCloseEvent(event, transport))) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = client.onEvent((event) => {
      if (isCloseEvent(event, transport)) {
        unsubscribe()
        resolve()
      }
    })
  })
}

function isCloseEvent(event: QuirkyEvent, transport: 'websocket' | 'socket'): boolean {
  if (event.type !== `${pluginId}/closed` || !('data' in event)) return false
  const data = event.data
  return typeof data === 'object' && data !== null && 'transport' in data && data.transport === transport
}
