import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PtyClient } from '../src/client'
import { onCleanup, runCleanups, tempHome, waitFor } from './helpers'

afterEach(runCleanups)

const ENTRY = new URL('../src/main.ts', import.meta.url).pathname

function startProcess(home: string) {
  const proc = Bun.spawn([process.execPath, ENTRY], {
    env: { ...process.env, QUIRKY_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  onCleanup(() => {
    proc.kill('SIGKILL')
  })
  return proc
}

async function ready(home: string): Promise<{ client: PtyClient; token: string }> {
  const token = await waitFor(
    () => (existsSync(join(home, 'pty.sock')) && existsSync(join(home, 'pty.token')) ? readFileSync(join(home, 'pty.token'), 'utf8') : ''),
    10000,
    'host to listen'
  )
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await PtyClient.connect(join(home, 'pty.sock'))
      onCleanup(() => c.close())
      await c.hello(token)
      return { client: c, token }
    } catch (error) {
      if (attempt > 100) throw error
      await Bun.sleep(50)
    }
  }
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
    const { pid } = await client.request('create', {
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
    const { pid } = await client.request('create', {
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
    await client.request('create', {
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
})
