import { afterEach, describe, expect, test } from 'bun:test'
import { bytesToBase64 } from '@quirky/protocol'
import { PtyClient as DaemonPtyClient } from '../../daemon/src/pty-client'
import { ShellReadyBarrier } from '../src/barrier'
import { concat, onCleanup, runCleanups, startHost, text, waitFor, type TestHost } from './helpers'

afterEach(runCleanups)

const encoder = new TextEncoder()
const sh = (script: string) => ['/bin/sh', '-c', script]

function createParams(home: string, sessionId: string, argv: string[], shellReady = false) {
  return {
    sessionId,
    cwd: home,
    argv,
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', HOME: home, QUIRKY_HOME: home },
    cols: 80,
    rows: 24,
    shellReady,
    shellReadyTimeoutMs: 5000
  }
}

async function connectDaemon(host: TestHost) {
  const client = new DaemonPtyClient({ home: host.home, hostEntry: '/does/not/need/to/exist', log: () => {} })
  const close = () => client.close()
  // The server cleanup is registered before the client; closing the client first avoids a reconnect.
  onCleanup(close)
  await client.connect()
  return client
}

function collect(client: DaemonPtyClient, sessionId: string) {
  const parts: Uint8Array[] = []
  client.onData((id, bytes) => {
    if (id === sessionId) parts.push(bytes.slice())
  })
  return () => text(concat(parts))
}

describe('acknowledged PTY input', () => {
  test('resolves only after a complete live-child write and the child consumes the input', async () => {
    const host = startHost()
    const client = await connectDaemon(host)
    const sessionId = 'receipt-live'
    await client.request(
      'create',
      createParams(host.home, sessionId, sh('IFS= read -r line; printf "child:%s\\n" "$line"; exec cat'))
    )
    const output = collect(client, sessionId)
    await client.request('subscribe', { sessionId, mode: 'raw' })

    await client.request('writeAccepted', { sessionId, bytes: bytesToBase64(encoder.encode('receipt-live-marker\n')) })

    await waitFor(() => output().includes('child:receipt-live-marker'), 5000, 'child to consume acknowledged input')
    expect(output().split('child:receipt-live-marker').length - 1).toBe(1)
  })

  test('rejects missing and exited sessions with a definite zero-byte receipt', async () => {
    const host = startHost()
    const client = await connectDaemon(host)

    await expect(
      client.request('writeAccepted', { sessionId: 'missing-receipt-session', bytes: bytesToBase64(encoder.encode('x')) })
    ).rejects.toMatchObject({ code: 'PTY_WRITE_REJECTED', acceptedBytes: 0 })

    await client.request('create', createParams(host.home, 'exited-receipt-session', sh('exit 0')))
    await waitFor(() => !host.server.manager.isAlive('exited-receipt-session'), 5000, 'child to exit')
    await expect(
      client.request('writeAccepted', { sessionId: 'exited-receipt-session', bytes: bytesToBase64(encoder.encode('x')) })
    ).rejects.toMatchObject({ code: 'PTY_WRITE_REJECTED', acceptedBytes: 0 })
  })

  test('holds an acknowledged write behind the ready barrier until child delivery', async () => {
    const host = startHost({ shellReadyTimeoutMs: 5000 })
    const client = await connectDaemon(host)
    const sessionId = 'receipt-barrier'
    // The child-process delay ensures the receipt reaches a still-pending barrier before its ready marker.
    await client.request(
      'create',
      createParams(
        host.home,
        sessionId,
        sh("sleep 1; printf '\\033]777;quirky-shell-ready\\007'; IFS= read -r line; printf 'child:%s\\n' \"$line\"; exec cat"),
        true
      )
    )
    const output = collect(client, sessionId)
    await client.request('subscribe', { sessionId, mode: 'raw' })

    let settled = false
    const receipt = client
      .request('writeAccepted', { sessionId, bytes: bytesToBase64(encoder.encode('barrier-marker\n')) })
      .then((result) => {
        settled = true
        return result
      })

    const snapshot = await client.request('snapshot', { sessionId })
    expect(snapshot.shellState).toBe('pending')
    expect(settled).toBe(false)
    await waitFor(
      () => client.request('snapshot', { sessionId }).then(({ shellState }) => shellState === 'ready'),
      5000,
      'shell state to become ready'
    )
    expect(output()).not.toContain('quirky-shell-ready')
    await receipt
    await waitFor(() => output().includes('child:barrier-marker'), 5000, 'barrier input to reach child')
    expect(settled).toBe(true)
  })

  test('rejects a receipt that cannot fit in the ready-barrier queue without delivering a prefix', async () => {
    const host = startHost({ shellReadyTimeoutMs: 5000 })
    const client = await connectDaemon(host)
    const sessionId = 'receipt-dropped'
    await client.request('create', createParams(host.home, sessionId, sh('sleep 5; exec cat'), true))
    const output = collect(client, sessionId)
    await client.request('subscribe', { sessionId, mode: 'raw' })
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(0x78)

    await expect(client.request('writeAccepted', { sessionId, bytes: bytesToBase64(bytes) })).rejects.toMatchObject({
      code: 'PTY_WRITE_REJECTED',
      acceptedBytes: 0
    })
    expect(output()).not.toContain('x'.repeat(128))
  })

  test('preserves the known partial child-write count as uncertain', async () => {
    const barrier = new ShellReadyBarrier({
      enabled: false,
      timeoutMs: 1000,
      deliver: (bytes) => bytes.length - 2
    })

    await expect(barrier.inputAccepted(encoder.encode('partial-write'))).rejects.toMatchObject({
      code: 'PTY_WRITE_UNCERTAIN',
      acceptedBytes: encoder.encode('partial-write').length - 2
    })
    barrier.dispose()
  })

  test('disposal of a queued acknowledged write is a definite drop', async () => {
    const barrier = new ShellReadyBarrier({ enabled: true, timeoutMs: 10000, deliver: () => {} })
    const receipt = barrier.inputAccepted(encoder.encode('held'))
    barrier.dispose()

    await expect(receipt).rejects.toMatchObject({ code: 'PTY_WRITE_REJECTED', acceptedBytes: 0 })
  })
})
