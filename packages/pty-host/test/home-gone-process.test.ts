import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { socketPath } from '@quirky/protocol/node'
import { PtyClient } from '../src/client'
import {
  createScopedSession,
  exitWithin,
  groupGone,
  homeOfSocketLength,
  longTempHome,
  onCleanup,
  ready,
  runCleanups,
  startProcess,
  tempHome
} from './helpers'

afterEach(runCleanups, 30_000)

describe('host process', () => {
  test('home deletion exits the host and kills its session group', async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)
    const session = await createScopedSession(client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()

    rmSync(home, { recursive: true, force: true })
    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(groupGone(session.pid)).toBe(true)
    // Wait through another ownership-check interval to ensure the host did not recreate its home.
    await Bun.sleep(1000)
    expect(existsSync(home)).toBe(false)
  }, 30_000)

  test('deleting a long home removes its fallback socket and session group', async () => {
    const home = longTempHome()
    const resolvedSocket = socketPath(home, 'pty.sock')
    expect(Buffer.byteLength(join(home, 'pty.sock'))).toBeGreaterThan(100)
    expect(resolvedSocket).not.toBe(join(home, 'pty.sock'))
    const host = startProcess(home)
    const { client } = await ready(home)
    const session = await createScopedSession(client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()

    rmSync(home, { recursive: true, force: true })
    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(groupGone(session.pid)).toBe(true)
    expect(existsSync(resolvedSocket)).toBe(false)
    // Wait through another ownership-check interval to ensure the host did not recreate its home.
    await Bun.sleep(1000)
    expect(existsSync(home)).toBe(false)
  }, 30_000)

  test('deleting a symlink target exits the host without recreating the target', async () => {
    const realHome = tempHome()
    const homeLink = tempHome()
    rmSync(homeLink, { recursive: true, force: true })
    symlinkSync(realHome, homeLink)
    const host = startProcess(homeLink)
    const { client } = await ready(homeLink)
    const session = await createScopedSession(client, homeLink, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()

    rmSync(realHome, { recursive: true, force: true })
    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(groupGone(session.pid)).toBe(true)
    // Wait through another ownership-check interval to ensure the host did not recreate its target.
    await Bun.sleep(1000)
    expect(existsSync(realHome)).toBe(false)
  }, 30_000)

  test('renaming the home away exits the host and kills its session group', async () => {
    const home = tempHome()
    const movedHome = `${home}.moved`
    onCleanup(() => rmSync(movedHome, { recursive: true, force: true }))
    const host = startProcess(home)
    const { client } = await ready(home)
    const session = await createScopedSession(client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()

    renameSync(home, movedHome)
    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(groupGone(session.pid)).toBe(true)
    // Wait through another ownership-check interval to ensure the original path stays absent.
    await Bun.sleep(1000)
    expect(existsSync(home)).toBe(false)
  }, 30_000)

  test('an old host exits without changing a replacement host or its session', async () => {
    const home = tempHome()
    const hostA = startProcess(home)
    const readyA = await ready(home)
    const sessionA = await createScopedSession(readyA.client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    readyA.client.close()

    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { mode: 0o700 })
    const hostB = startProcess(home)
    const readyB = await ready(home)
    await createScopedSession(readyB.client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    const socketInode = statSync(join(home, 'pty.sock')).ino
    const meta = readFileSync(join(home, 'sessions', 's1', 'meta.json'))
    const pidFile = readFileSync(join(home, 'pty.pid'), 'utf8')
    expect(Number(pidFile)).toBe(hostB.pid)

    expect(await exitWithin(hostA, 12_000)).toBe(0)
    expect(groupGone(sessionA.pid)).toBe(true)
    expect(statSync(join(home, 'pty.sock')).ino).toBe(socketInode)
    expect(readFileSync(join(home, 'sessions', 's1', 'meta.json'))).toEqual(meta)
    expect(readFileSync(join(home, 'pty.pid'), 'utf8')).toBe(pidFile)
    expect((await readyB.client.request('list', {})).find((session) => session.sessionId === 's1')?.state).toBe('running')
    expect(hostB.exitCode).toBeNull()
  }, 30_000)

  test('socket deletion exits the host and leaves a restorable session', async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)
    const session = await createScopedSession(client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()

    rmSync(join(home, 'pty.sock'))
    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(groupGone(session.pid)).toBe(true)
    expect(existsSync(join(home, 'pty.pid'))).toBe(false)
    const meta = JSON.parse(readFileSync(join(home, 'sessions', 's1', 'meta.json'), 'utf8')) as {
      exitCause: string
      restorable: boolean
    }
    expect(meta.exitCause).toBe('host-restart')
    expect(meta.restorable).toBe(true)

    const replacement = startProcess(home)
    const { client: replacementClient } = await ready(home)
    const sessions = await replacementClient.request('list', {})
    expect(sessions.find((entry) => entry.sessionId === 's1')?.state).toBe('restorable')
    expect(replacement.exitCode).toBeNull()
  }, 30_000)

  test('a socket replacement listener survives host exit', async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)
    const session = await createScopedSession(client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    const socket = join(home, 'pty.sock')
    client.close()

    rmSync(socket)
    const decoy = Bun.listen<undefined>({
      unix: socket,
      socket: { data(connection, bytes) { connection.write(bytes) } }
    })
    onCleanup(() => decoy.stop(true))
    const decoyInode = statSync(socket).ino

    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(groupGone(session.pid)).toBe(true)
    expect(statSync(socket).ino).toBe(decoyInode)
    const connection = await PtyClient.connect(socket)
    onCleanup(() => connection.close())
    expect(statSync(socket).ino).toBe(decoyInode)
  }, 30_000)

  test('a replaced socket directory survives signal shutdown', async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)
    const socket = join(home, 'pty.sock')
    client.close()

    rmSync(socket)
    mkdirSync(socket)
    if (host.exitCode === null) host.kill('SIGTERM')
    expect(await exitWithin(host, 12_000)).toBe(0)
    expect(statSync(socket).isDirectory()).toBe(true)
    expect(existsSync(join(home, 'pty.pid'))).toBe(false)
  }, 30_000)

  test('a disconnected daemon client leaves the host and session running', async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)
    const session = await createScopedSession(client, home, {
      sessionId: 's1',
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    client.close()

    // This wall-clock delay proves a detached host outlives its client; fake timers cannot replace it.
    await Bun.sleep(3500)
    expect(host.exitCode).toBeNull()
    expect(() => process.kill(session.pid, 0)).not.toThrow()
    const reconnected = await ready(home)
    expect((await reconnected.client.request('list', {})).find((entry) => entry.sessionId === 's1')?.state).toBe('running')
  }, 30_000)

  for (const bytes of [100, 101] as const) {
    test(`socket path at ${bytes} bytes uses and cleans up its owned paths`, async () => {
      const home = homeOfSocketLength(bytes)
      const resolvedSocket = socketPath(home, 'pty.sock')
      const directSocket = join(home, 'pty.sock')
      expect(Buffer.byteLength(directSocket)).toBe(bytes)
      expect(resolvedSocket === directSocket).toBe(bytes === 100)
      const socketDirectory = dirname(resolvedSocket)
      const before = readdirSync(socketDirectory).sort()
      const host = startProcess(home)
      const { client } = await ready(home)
      client.close()

      const privateDirs = readdirSync(socketDirectory).filter((entry) => entry.startsWith('.p') && !before.includes(entry))
      expect(privateDirs).toHaveLength(1)
      const privateDir = join(socketDirectory, privateDirs[0]!)
      expect(readdirSync(privateDir)).toEqual([])

      rmSync(resolvedSocket)
      expect(await exitWithin(host, 12_000)).toBe(0)
      expect(existsSync(resolvedSocket)).toBe(false)
      expect(existsSync(privateDir)).toBe(false)
      if (bytes === 101) expect(readdirSync(socketDirectory).sort()).toEqual(before)
    }, 30_000)
  }
})
