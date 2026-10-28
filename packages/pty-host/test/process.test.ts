import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { base64ToBytes, encodePtyJson, PTY_PROTOCOL_VERSION, PtyFrameDecoder } from '@quirky/protocol'
import { readSegments } from '../src/history/log'
import type { PtyClient } from '../src/client'
import { createScopedSession, ready, runCleanups, startProcess, tempHome, text, waitFor } from './helpers'

afterEach(runCleanups)

const SHELL_ENV = { PATH: '/usr/bin:/bin' }

function params(sessionId: string, argv: string[]) {
  return { sessionId, cwd: '/tmp', argv, env: SHELL_ENV, cols: 80, rows: 24 }
}

function collect(client: PtyClient, sessionId: string) {
  const parts: string[] = []
  client.onData((id, bytes) => {
    if (id === sessionId) parts.push(text(bytes))
  })
  return () => parts.join('')
}

/** Starts a host on `home` that replaces one killed earlier, and connects to it. */
async function restart(home: string) {
  const proc = startProcess(home)
  await waitFor(() => existsSync(join(home, 'pty.pid')) && readFileSync(join(home, 'pty.pid'), 'utf8') === String(proc.pid), 10000, 'new host pid')
  return { proc, ...(await ready(home)) }
}

describe('quirky-pty process', () => {
  test('creates the home with private files and serves requests', async () => {
    const home = tempHome()
    const proc = startProcess(home)
    const { client, token } = await ready(home)
    expect(statSync(join(home, 'pty.token')).mode & 0o777).toBe(0o600)
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(Number(readFileSync(join(home, 'pty.pid'), 'utf8'))).toBe(proc.pid)
    expect(await client.request('list', {})).toEqual([])
  })

  test('a second host on the same home exits 0 and leaves the first untouched', async () => {
    const home = tempHome()
    startProcess(home)
    const { client, token } = await ready(home)
    const first = await client.request('hello', { token, version: 1 })

    const second = startProcess(home)
    expect(await second.exited).toBe(0)
    expect(readFileSync(join(home, 'pty.token'), 'utf8')).toBe(token)
    expect(Number(readFileSync(join(home, 'pty.pid'), 'utf8'))).toBe(first.pid)
    expect(await client.request('list', {})).toEqual([])
  })

  test('replaces a stale socket and token left by a dead host', async () => {
    const home = tempHome()
    const first = startProcess(home)
    const old = await ready(home)
    first.kill('SIGKILL')
    await first.exited
    expect(existsSync(join(home, 'pty.sock'))).toBe(true)

    const second = startProcess(home)
    const fresh = await waitFor(
      () => {
        const token = readFileSync(join(home, 'pty.token'), 'utf8')
        return token !== old.token ? token : ''
      },
      10000,
      'new token'
    )
    const { client } = await ready(home)
    expect(await client.request('list', {})).toEqual([])
    expect(Number(readFileSync(join(home, 'pty.pid'), 'utf8'))).toBe(second.pid)
    expect(fresh).not.toBe(old.token)
  })

  test('replaces a regular file squatting on the socket path', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'pty.sock'), 'junk')
    startProcess(home)
    const { client } = await ready(home)
    expect(await client.request('list', {})).toEqual([])
  })

  test('shutdown kills sessions, answers, removes its files and exits 0', async () => {
    const home = tempHome()
    const proc = startProcess(home)
    const { client } = await ready(home)
    const { pid } = await createScopedSession(client, home, {
      sessionId: 'a',
      cwd: '/tmp',
      argv: ['/bin/cat'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    await client.request('shutdown', {})
    expect(await proc.exited).toBe(0)
    expect(existsSync(join(home, 'pty.sock'))).toBe(false)
    expect(existsSync(join(home, 'pty.pid'))).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('SIGTERM shuts down the same way', async () => {
    const home = tempHome()
    const proc = startProcess(home)
    const { client } = await ready(home)
    const { pid } = await createScopedSession(client, home, {
      sessionId: 'a',
      cwd: '/tmp',
      argv: ['/bin/cat'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
    expect(existsSync(join(home, 'pty.sock'))).toBe(false)
    expect(existsSync(join(home, 'pty.pid'))).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('keeps running after every client disconnects', async () => {
    const home = tempHome()
    const proc = startProcess(home)
    const { client } = await ready(home)
    await createScopedSession(client, home, {
      sessionId: 'a',
      cwd: '/tmp',
      argv: ['/bin/cat'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()
    await Bun.sleep(300)
    const again = await ready(home)
    const list = await again.client.request('list', {})
    expect(list.map((s) => s.sessionId)).toEqual(['a'])
    expect(proc.exitCode).toBeNull()
  })

  test('a session keeps its output when the client leaves, and a second client gets the replay', async () => {
    const home = tempHome()
    startProcess(home)
    const first = await ready(home)
    await createScopedSession(first.client, home, params('a', ['/bin/cat']))
    await first.client.request('subscribe', { sessionId: 'a' })
    const seen = collect(first.client, 'a')
    first.client.sendInput('a', new TextEncoder().encode('alpha\n'))
    await waitFor(() => seen().includes('alpha\r\nalpha'), 5000, 'echo')
    first.client.close()

    const second = await ready(home)
    const sub = await second.client.request('subscribe', { sessionId: 'a' })
    expect(sub.live).toBe(true)
    expect(text(base64ToBytes(sub.replay))).toContain('alpha')
    const live = collect(second.client, 'a')
    second.client.sendInput('a', new TextEncoder().encode('beta\n'))
    await waitFor(() => live().includes('beta'), 5000, 'output after reattach')
  })

  test('the subscribe response precedes the first DATA frame of a busy session', async () => {
    const home = tempHome()
    startProcess(home)
    const { client, token } = await ready(home)
    await createScopedSession(client, home, params('busy', ['/bin/sh', '-c', 'while :; do echo tick; done']))
    await waitFor(async () => {
      const { lines } = await client.request('read', { sessionId: 'busy', lines: 10 })
      return lines.some((line) => line.trim() === 'tick')
    }, 5000, 'busy PTY output')

    const order: string[] = []
    const decoder = new PtyFrameDecoder()
    const socket = await Bun.connect({
      unix: join(home, 'pty.sock'),
      socket: {
        data(_socket, chunk) {
          for (const frame of decoder.push(chunk)) {
            if (frame.kind === 'data') order.push('data')
            else order.push(`id:${(frame.message as { id: number }).id}`)
          }
        }
      }
    })
    try {
      socket.write(encodePtyJson({ id: 1, type: 'hello', token, version: PTY_PROTOCOL_VERSION }))
      socket.write(encodePtyJson({ id: 2, type: 'subscribe', sessionId: 'busy' }))
      await waitFor(() => order.filter((o) => o === 'data').length >= 5, 5000, 'data frames')
      expect(order.indexOf('id:2')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('id:2')).toBeLessThan(order.indexOf('data'))
    } finally {
      socket.end()
    }
  })

  test('a killed host leaves its sessions restorable as host-lost, and restore brings back their text', async () => {
    const home = tempHome()
    const first = startProcess(home)
    const one = await ready(home)
    await createScopedSession(one.client, home, params('s', ['/bin/sh', '-c', 'echo marker-before-crash; exec cat']))
    await waitFor(async () => (await one.client.request('read', { sessionId: 's', lines: 10 })).lines.join('\n').includes('marker-before-crash'), 5000, 'marker')
    const sessionDir = join(home, 'sessions', 's')
    await waitFor(() => {
      const metaPath = join(sessionDir, 'meta.json')
      const logPath = join(sessionDir, 'output.log')
      if (!existsSync(metaPath) || !existsSync(logPath)) return false
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { sessionId?: string; endedAt?: number | null }
      const output = readSegments(sessionDir).segments
        .flatMap((segment) => segment.records)
        .filter((record) => record.kind === 'output')
        .map((record) => text(record.bytes!))
        .join('')
      return meta.sessionId === 's' && meta.endedAt === null && output.includes('marker-before-crash')
    }, 5000, 'persisted session metadata and output')
    first.kill('SIGKILL')
    await first.exited

    const two = await restart(home)
    const [info] = await two.client.request('list', {})
    expect(info).toMatchObject({ sessionId: 's', state: 'restorable', exitCause: 'host-lost', alive: false })

    const restored = await createScopedSession(two.client, home, { ...params('s', ['/bin/cat']), restore: true })
    expect(restored.restored).toBe(true)
    const snap = await two.client.request('snapshot', { sessionId: 's' })
    expect(snap.ansi).toContain('marker-before-crash')
    const [after] = await two.client.request('list', {})
    expect(after).toMatchObject({ sessionId: 's', state: 'running', alive: true })
  })

  test('a host that was shut down leaves its sessions restorable as host-restart', async () => {
    const home = tempHome()
    const first = startProcess(home)
    const one = await ready(home)
    await createScopedSession(one.client, home, params('s', ['/bin/sh', '-c', 'echo marker-before-stop; exec cat']))
    await waitFor(async () => (await one.client.request('read', { sessionId: 's', lines: 10 })).lines.join('\n').includes('marker-before-stop'), 5000, 'marker')
    await one.client.request('shutdown', {})
    expect(await first.exited).toBe(0)

    const two = await restart(home)
    const [info] = await two.client.request('list', {})
    expect(info).toMatchObject({ sessionId: 's', state: 'restorable', exitCause: 'host-restart' })
    const sub = await two.client.request('subscribe', { sessionId: 's' })
    expect(sub.live).toBe(false)
    expect(text(base64ToBytes(sub.replay))).toContain('marker-before-stop')
  })
})
