import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

// the transport assertion needs QuirkyClient's unix-socket connector; without it connectDaemon uses the WebSocket
const socketClientPresent = typeof (QuirkyClient as unknown as { connectSocket?: unknown }).connectSocket === 'function'

/** One newline-delimited exchange on the fake daemon's socket. */
async function exchange(path: string, lines: object[]): Promise<object[]> {
  const replies: object[] = []
  let buffer = ''
  let done!: () => void
  const closed = new Promise<void>((resolve) => (done = resolve))
  const socket = await Bun.connect({
    unix: path,
    socket: {
      open(s) {
        for (const line of lines) s.write(`${JSON.stringify(line)}\n`)
      },
      data(s, chunk) {
        buffer += chunk.toString()
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          replies.push(JSON.parse(buffer.slice(0, end)))
          buffer = buffer.slice(end + 1)
          if (replies.length === lines.length) s.end()
        }
      },
      close: done
    }
  })
  await Promise.race([closed, Bun.sleep(1000)])
  socket.end()
  return replies
}

describe('SC-1: the CLI reaches the daemon over the unix socket', () => {
  test('the identity goes in client.hello', async () => {
    const result = await runCli(['status'], {
      home: daemon.home,
      cwd: daemon.home,
      env: {
        QUIRKY_SESSION_ID: 'sess_9',
        QUIRKY_SESSION_TOKEN: 'session-secret',
        QUIRKY_WORKTREE_ID: 'wt_9'
      }
    })
    expect(result.code).toBe(0)
    const [hello] = daemon.methodCalls('client.hello')
    expect(hello).toMatchObject({
      role: 'cli',
      name: 'quirky',
      cwd: daemon.home,
      sessionId: 'sess_9',
      sessionToken: 'session-secret',
      worktreeId: 'wt_9'
    })
  })

  test.skipIf(!socketClientPresent)('every call goes over the socket named in runtime.json', async () => {
    const result = await runCli(['plugin', 'list'], { home: daemon.home })
    expect(result.code).toBe(0)
    expect(daemon.calls.map((call) => call.method)).toEqual(['client.hello', 'plugin.list'])
    expect(new Set(daemon.calls.map((call) => call.transport))).toEqual(new Set(['socket']))
    expect(daemon.socketConnections).toBe(1)
  })

  test('the fake socket requires the token in the first client.hello', async () => {
    const [refused] = await exchange(daemon.socketPath, [{ jsonrpc: '2.0', id: 1, method: 'status.get', params: {} }])
    expect(refused).toMatchObject({ error: { code: -32001 } })
    const [wrong] = await exchange(daemon.socketPath, [
      { jsonrpc: '2.0', id: 1, method: 'client.hello', params: { role: 'cli', protocolVersion: 2, token: 'nope' } }
    ])
    expect(wrong).toMatchObject({ error: { code: -32001 } })
    const [ok, status] = await exchange(daemon.socketPath, [
      { jsonrpc: '2.0', id: 1, method: 'client.hello', params: { role: 'cli', protocolVersion: 2, token: daemon.token } },
      { jsonrpc: '2.0', id: 2, method: 'status.get', params: {} }
    ])
    expect(ok).toMatchObject({ id: 1, result: { daemonVersion: '0.0.0-fake' } })
    expect(status).toMatchObject({ id: 2, result: { safeMode: false } })
  })
})
