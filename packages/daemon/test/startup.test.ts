import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { startDaemon } from '../src/daemon'
import { createFakeGit } from './fixtures/fake-git'
import { startFakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome, startHarness, waitFor, type Harness } from './helpers'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const FAKE_HOST_MAIN = join(import.meta.dir, 'fixtures', 'fake-pty-host.ts')

let h: Harness | null = null
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  await h?.cleanup()
  h = null
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('reconciliation', () => {
  test('marks sessions missing from the pty host or dead there as exited', async () => {
    const home = makeTempHome()
    const git = createFakeGit()
    git.addRepo('/fake/alpha')
    const pty = startFakePtyHost(home)
    cleanups.push(() => pty.stop())

    const first = await startDaemon({ home, port: 0, git, shell: '/bin/zsh', notifier: () => {}, uiDir: '/none' })
    const client = await QuirkyClient.connect(rpcUrl(first.runtime), { role: 'cli' })
    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    const [worktree] = await client.call('worktree.list', { repoId: repo.id })
    const alive = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    const gone = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    const dead = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    client.close()
    await first.stop()

    pty.sessions.delete(gone.id)
    const deadInfo = pty.sessions.get(dead.id)!
    deadInfo.info.alive = false
    deadInfo.info.exitCode = 9

    const second = await startDaemon({ home, port: 0, git, shell: '/bin/zsh', notifier: () => {}, uiDir: '/none' })
    cleanups.push(() => second.stop())
    const next = await QuirkyClient.connect(rpcUrl(second.runtime), { role: 'cli' })
    const sessions = await next.call('session.list', {})
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]))
    expect(byId[alive.id].status).toBe('running')
    expect(byId[gone.id]).toMatchObject({ status: 'exited', exitCode: null })
    expect(byId[dead.id]).toMatchObject({ status: 'exited', exitCode: 9 })
    next.close()
  })
})

describe('pty host startup', () => {
  test('spawns the host when nothing answers and works through it', async () => {
    const home = makeTempHome()
    const git = createFakeGit()
    git.addRepo('/fake/alpha')
    const daemon = await startDaemon({
      home,
      port: 0,
      git,
      shell: '/bin/zsh',
      notifier: () => {},
      uiDir: '/none',
      ptyHostEntry: FAKE_HOST_MAIN
    })
    cleanups.push(() => daemon.stop())
    const client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role: 'cli' })
    const status = await client.call('status.get', {})
    expect(status.ptyHost.alive).toBe(true)
    const hostPid = status.ptyHost.pid as number
    expect(hostPid).toBeGreaterThan(0)
    expect(hostPid).not.toBe(process.pid)
    cleanups.push(() => {
      try {
        process.kill(hostPid)
      } catch {
        return
      }
    })
    expect(existsSync(join(home, 'logs', 'pty-host.log'))).toBe(true)

    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    const [worktree] = await client.call('worktree.list', { repoId: repo.id })
    const session = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    expect(session.status).toBe('running')
    client.close()
  })

  test('still starts when the host cannot be started', async () => {
    const home = makeTempHome()
    const daemon = await startDaemon({
      home,
      port: 0,
      git: createFakeGit(),
      notifier: () => {},
      uiDir: '/none',
      ptyHostEntry: join(home, 'missing.ts'),
      ptyConnectTimeoutMs: 300,
      log: () => {}
    })
    cleanups.push(() => daemon.stop())
    const client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role: 'cli' })
    expect((await client.call('status.get', {})).ptyHost.alive).toBe(false)
    client.close()
  })
})

describe('single instance per home', () => {
  test('a second daemon on the same home exits 0 and leaves the first running', async () => {
    const home = makeTempHome()
    const pty = startFakePtyHost(home)
    cleanups.push(() => pty.stop())
    const env = {
      ...process.env,
      QUIRKY_HOME: home,
      QUIRKY_PORT: '0',
      QUIRKY_UI_DIR: join(home, 'none'),
      QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN
    }
    const first = Bun.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
    cleanups.push(() => {
      first.kill()
    })
    const info = await waitFor(() => readRuntime(home), 10000)
    expect(info.pid).toBe(first.pid)
    expect(await isDaemonAlive(info)).toBe(true)

    const second = Bun.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
    expect(await second.exited).toBe(0)
    expect(readRuntime(home)?.pid).toBe(first.pid)
    expect(await isDaemonAlive(readRuntime(home))).toBe(true)

    first.kill('SIGTERM')
    await first.exited
    expect(existsSync(join(home, 'runtime.json'))).toBe(false)
    expect(readFileSync(join(home, 'quirky.db')).length).toBeGreaterThan(0)
  })
})
