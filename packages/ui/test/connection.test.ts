import { afterEach, expect, test } from 'bun:test'
import { encodeTerminalOutput } from '@quirky/protocol'
import { Connection } from '../src/connection'
import { Store } from '../src/store'
import { startMockDaemon } from './mock-daemon'

const stops: (() => void)[] = []
afterEach(() => {
  while (stops.length) stops.pop()!()
})

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(10)
  }
}

function connect(url: string) {
  const parsed = new URL(url)
  const store = new Store()
  const connection = new Connection(store, { hash: parsed.hash, host: parsed.host }, { initialDelayMs: 10 })
  connection.start()
  stops.push(() => connection.stop())
  return { store, connection, parsed }
}

test('reports an unreachable daemon after repeated failures and reconnects when it returns', async () => {
  const first = startMockDaemon()
  const { store, parsed } = connect(first.url)
  await until(() => store.getState().connection === 'connected')

  first.stop()
  await until(() => store.getState().connection === 'unreachable')

  const second = startMockDaemon(Number(parsed.port))
  stops.push(second.stop)
  await until(() => store.getState().connection === 'connected')
  expect(store.getState().epoch).toBe(2)
})

test('keeps retrying without the unreachable banner while /health answers', async () => {
  const daemon = startMockDaemon()
  stops.push(daemon.stop)
  const { store } = connect(daemon.url.replace('mock-token', 'wrong-token'))
  await Bun.sleep(400)
  expect(store.getState().connection).toBe('reconnecting')
})

test('callAny reaches the daemon and rejects when not connected', async () => {
  const daemon = startMockDaemon()
  stops.push(daemon.stop)
  const { store, connection } = connect(daemon.url)
  await expect(connection.callAny('ui.state', {})).rejects.toThrow('Not connected')
  await until(() => store.getState().connection === 'connected')
  const state = (await connection.callAny('ui.state', {})) as { layout: { sidebar: boolean } }
  expect(state.layout.sidebar).toBe(true)
})

test('onConnected runs after each connect, with the store already saying connected', async () => {
  const daemon = startMockDaemon()
  stops.push(daemon.stop)
  const { store, connection } = connect(daemon.url)
  const seen: string[] = []
  connection.onConnected(() => seen.push(store.getState().connection))
  await until(() => seen.length === 1)
  expect(seen).toEqual(['connected'])
})

test('onStatus reports each change between connected and not, once per change', async () => {
  const first = startMockDaemon()
  const { connection, store, parsed } = connect(first.url)
  const seen: string[] = []
  connection.onStatus((status) => seen.push(status))
  await until(() => store.getState().connection === 'connected')
  expect(seen).toEqual(['connected'])

  first.stop()
  await until(() => store.getState().connection === 'unreachable')
  expect(seen).toEqual(['connected', 'reconnecting'])

  const second = startMockDaemon(Number(parsed.port))
  stops.push(second.stop)
  await until(() => seen.length === 3)
  expect(seen).toEqual(['connected', 'reconnecting', 'connected'])
})

test('onStream receives the binary frames of its stream until it unsubscribes, and needs a connection', async () => {
  const daemon = startMockDaemon()
  stops.push(daemon.stop)
  const { store, connection } = connect(daemon.url)
  expect(() => connection.onStream(5, () => {})).toThrow('Not connected')
  await until(() => store.getState().connection === 'connected')

  const frames: number[][] = []
  const stop = connection.onStream(5, (bytes) => frames.push([...bytes]))
  const deliver = (streamId: number, bytes: number[]) =>
    (connection.client as unknown as { handleMessage(data: unknown): void }).handleMessage(
      encodeTerminalOutput(streamId, new Uint8Array(bytes))
    )
  deliver(5, [104, 105])
  deliver(6, [1])
  expect(frames).toEqual([[104, 105]])

  stop()
  deliver(5, [33])
  expect(frames).toEqual([[104, 105]])
})

test('onEvent receives every event as well as the store, and a throwing listener harms neither', () => {
  const store = new Store()
  const connection = new Connection(store, { hash: '', host: 'x' })
  const received: string[] = []
  connection.onEvent(() => {
    throw new Error('listener bug')
  })
  const stop = connection.onEvent((event) => received.push(event.type))
  const emit = (event: unknown) => (connection as unknown as { handleEvent(e: unknown): void }).handleEvent(event)

  emit({ type: 'notify', title: 'hi', body: 'there', open: { view: 'view:acme.x/page' } })
  emit({ type: 'plugin.changed' })
  expect(received).toEqual(['notify', 'plugin.changed'])
  expect(store.getState().toasts.map((t) => t.title)).toEqual(['hi'])
  expect(store.getState().toasts[0]!.open).toEqual({ view: 'view:acme.x/page' })

  stop()
  emit({ type: 'plugin.changed' })
  expect(received).toHaveLength(2)
})
