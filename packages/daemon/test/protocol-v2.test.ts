import { afterEach, describe, expect, test } from 'bun:test'
import { PROTOCOL_VERSION, RPC_PATH, RpcError, RpcErrorCode } from '@quirky/protocol'
import { startHarness, type Harness } from './helpers'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

const V1_METHODS = [
  'settings.get',
  'settings.set',
  'repo.list',
  'repo.add',
  'repo.remove',
  'worktree.list',
  'worktree.create',
  'worktree.remove',
  'session.list',
  'session.create',
  'session.createStructured',
  'session.close',
  'terminal.attach',
  'terminal.detach',
  'terminal.write',
  'terminal.resize',
  'terminal.send',
  'terminal.read',
  'git.status',
  'git.diff',
  'git.stage',
  'git.unstage',
  'git.commit',
  'ask.create',
  'ask.wait',
  'ask.answer',
  'ask.cancel',
  'ask.list',
  'structured.messages',
  'structured.send'
]

/** Sends a `client.hello` claiming `protocolVersion` over a WebSocket and returns the daemon's reply. */
async function helloWith(harness: Harness, protocolVersion: number): Promise<any> {
  const socket = new WebSocket(`ws://127.0.0.1:${harness.runtime.port}${RPC_PATH}?token=${harness.runtime.token}`)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  const reply = new Promise<any>((resolve) =>
    socket.addEventListener('message', (event) => resolve(JSON.parse(event.data as string)), { once: true })
  )
  socket.send(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'client.hello', params: { role: 'cli', protocolVersion } })
  )
  const message = await reply
  socket.close()
  return message
}

describe('protocol version 2', () => {
  test('the daemon speaks version 2', () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })

  test('SC-19: a client claiming protocol 1 is refused with Conflict naming both versions', async () => {
    h = await startHarness()
    const message = await helloWith(h, 1)
    expect(message.error.code).toBe(RpcErrorCode.Conflict)
    expect(message.error.message).toContain('daemon speaks 2')
    expect(message.error.message).toContain('client 1')
  })

  test('SC-19: a client claiming protocol 2 is accepted', async () => {
    h = await startHarness()
    const message = await helloWith(h, 2)
    expect(message.result).toMatchObject({ protocolVersion: 2 })
  })

  test('SC-17: every v1 method name is MethodNotFound', async () => {
    h = await startHarness()
    const client = await h.connect()
    for (const method of V1_METHODS) {
      const error = (await client.callAny(method, {}).catch((e) => e)) as RpcError
      expect(error, method).toBeInstanceOf(RpcError)
      expect(error.code, method).toBe(RpcErrorCode.MethodNotFound)
    }
  })
})
