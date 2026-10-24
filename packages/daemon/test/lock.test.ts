import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDaemonAlive, readRuntime } from '@quirky/protocol/node'
import { acquireDaemonLock } from '../src/lock'
import { startFakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome, waitFor } from './helpers'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const FAKE_HOST_MAIN = join(import.meta.dir, 'fixtures', 'fake-pty-host.ts')

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function homeDir() {
  const home = makeTempHome('qd-lock-')
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'])
  await proc.exited
  return proc.pid
}

describe('acquireDaemonLock', () => {
  test('creates the lock with our pid and releases it', async () => {
    const home = homeDir()
    const lock = await acquireDaemonLock(home)
    expect(lock).not.toBeNull()
    expect(readFileSync(join(home, 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid))
    lock!.release()
    expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
  })

  test('takes over a lock whose pid is dead', async () => {
    const home = homeDir()
    writeFileSync(join(home, 'daemon.lock'), String(await deadPid()))
    const lock = await acquireDaemonLock(home)
    expect(lock).not.toBeNull()
    expect(readFileSync(join(home, 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid))
    lock!.release()
  })

  test('takes over an empty lock file', async () => {
    const home = homeDir()
    writeFileSync(join(home, 'daemon.lock'), '')
    expect(await acquireDaemonLock(home, { graceMs: 100 })).not.toBeNull()
  })

  test('takes over a live pid that never answers health once the wait runs out', async () => {
    const home = homeDir()
    const sleeper = Bun.spawn(['sleep', '30'])
    cleanups.push(() => sleeper.kill())
    writeFileSync(join(home, 'daemon.lock'), String(sleeper.pid))
    const started = Date.now()
    const lock = await acquireDaemonLock(home, { waitMs: 400 })
    expect(lock).not.toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  })

  test('returns null while a healthy daemon holds it', async () => {
    const home = homeDir()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ ok: true, pid: process.pid })
    })
    cleanups.push(() => server.stop(true))
    writeFileSync(join(home, 'daemon.lock'), String(process.pid))
    writeFileSync(
      join(home, 'runtime.json'),
      JSON.stringify({ pid: process.pid, port: server.port, token: 't', hookToken: 'h' })
    )
    expect(await acquireDaemonLock(home, { waitMs: 400 })).toBeNull()
    expect(readFileSync(join(home, 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid))
  })

  test('concurrent callers never both win', async () => {
    const home = homeDir()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ ok: true, pid: process.pid })
    })
    cleanups.push(() => server.stop(true))
    writeFileSync(
      join(home, 'runtime.json'),
      JSON.stringify({ pid: process.pid, port: server.port, token: 't', hookToken: 'h' })
    )
    writeFileSync(join(home, 'daemon.lock'), String(await deadPid()))
    const results = await Promise.all(Array.from({ length: 6 }, () => acquireDaemonLock(home, { waitMs: 5000 })))
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })
})

describe('two daemon processes started together', () => {
  test('exactly one keeps running and the other exits 0', async () => {
    const home = homeDir()
    const pty = startFakePtyHost(home)
    cleanups.push(() => pty.stop())
    const env = {
      ...process.env,
      QUIRKY_HOME: home,
      QUIRKY_PORT: '0',
      QUIRKY_UI_DIR: join(home, 'none'),
      QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN
    }
    const spawn = () => Bun.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
    const procs = [spawn(), spawn(), spawn()]
    cleanups.push(() => procs.forEach((p) => p.kill()))

    const info = await waitFor(() => readRuntime(home), 10000)
    const exits = await Promise.race([
      Promise.all(procs.filter((p) => p.pid !== info.pid).map((p) => p.exited)),
      Bun.sleep(8000).then(() => null)
    ])
    expect(exits).toEqual([0, 0])
    const survivors = procs.filter((p) => p.exitCode === null)
    expect(survivors.map((p) => p.pid)).toEqual([info.pid])
    expect(readRuntime(home)?.pid).toBe(info.pid)
    expect(await isDaemonAlive(readRuntime(home))).toBe(true)
    expect(readFileSync(join(home, 'daemon.lock'), 'utf8').trim()).toBe(String(info.pid))

    survivors[0]!.kill('SIGTERM')
    await survivors[0]!.exited
    expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
  })

  test('a daemon starts over a lock left by a killed one', async () => {
    const home = homeDir()
    const pty = startFakePtyHost(home)
    cleanups.push(() => pty.stop())
    writeFileSync(join(home, 'daemon.lock'), String(await deadPid()))
    const proc = Bun.spawn([process.execPath, MAIN], {
      env: {
        ...process.env,
        QUIRKY_HOME: home,
        QUIRKY_PORT: '0',
        QUIRKY_UI_DIR: join(home, 'none'),
        QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN
      },
      stdout: 'ignore',
      stderr: 'ignore'
    })
    cleanups.push(() => proc.kill())
    const info = await waitFor(() => readRuntime(home), 10000)
    expect(info.pid).toBe(proc.pid)
  })
})
