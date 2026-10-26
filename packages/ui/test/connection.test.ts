import { afterEach, expect, test } from 'bun:test'
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
  expect(store.getState().worktrees.length).toBeGreaterThan(0)
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
  await expect(connection.callAny('repo.list', {})).rejects.toThrow('Not connected')
  await until(() => store.getState().connection === 'connected')
  const repos = (await connection.callAny('repo.list', {})) as { id: string }[]
  expect(repos.map((r) => r.id)).toEqual(['r1'])
})

test('onConnected runs after each connect once the snapshot is in the store', async () => {
  const daemon = startMockDaemon()
  stops.push(daemon.stop)
  const { store, connection } = connect(daemon.url)
  const seen: boolean[] = []
  connection.onConnected(() => seen.push(store.getState().loaded))
  await until(() => seen.length === 1)
  expect(seen).toEqual([true])
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

  emit({ type: 'notify', title: 'hi', body: 'there' })
  emit({ type: 'plugin.changed' })
  expect(received).toEqual(['notify', 'plugin.changed'])
  expect(store.getState().toasts.map((t) => t.title)).toEqual(['hi'])

  stop()
  emit({ type: 'plugin.changed' })
  expect(received).toHaveLength(2)
})
