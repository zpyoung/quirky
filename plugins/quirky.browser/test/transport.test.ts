import { expect, test } from 'bun:test'
import { CdpConnection } from '../src/runtime/cdp'

test('failed CDP connections release their WebSocket when explicitly closed', async () => {
  const peerClosed = Promise.withResolvers<void>()
  const failures: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, listener) {
      if (listener.upgrade(request)) return
      return new Response('WebSocket required', { status: 400 })
    },
    websocket: {
      message(peer) {
        peer.send(JSON.stringify({ method: 'Target.targetCreated', params: 'not-an-object' }))
      },
      close() { peerClosed.resolve() }
    }
  })
  let connection: CdpConnection | undefined
  try {
    connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`, (reason) => failures.push(reason))
    await expect(connection.send('Target.getTargets', {}, undefined, 500)).rejects.toBeInstanceOf(Error)
    expect(failures).toHaveLength(1)
    connection.close()
    const deadline = Promise.withResolvers<boolean>()
    // Real WebSocket close events need platform I/O; this timer only bounds a failure, never a success wait.
    const timeout = setTimeout(() => deadline.resolve(false), 1_000)
    try {
      expect(await Promise.race([peerClosed.promise.then(() => true), deadline.promise])).toBe(true)
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    connection?.close()
    server.stop(true)
  }
}, 5_000)
