import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { startDaemon } from '../src/daemon'
import { startFakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome, waitFor } from './helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './plugins/fixtures'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const FAKE_HOST_MAIN = join(import.meta.dir, 'fixtures', 'fake-pty-host.ts')

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeTempDirs()
})

describe('pty host startup', () => {
  test('spawns the host when nothing answers and works through it', async () => {
    const home = makeTempHome()
    writeModulePlugin(
      join(home, 'plugins'),
      join(makeTempDir(), 'marker.log'),
      {
        id: 'acme.pty',
        contributes: { method: [{ id: 'spawnAndList', params: { type: 'object' } }] }
      },
      {
        activate: `context.provide('method:acme.pty/spawnAndList', async () => {
          await context.pty.spawn('s_probe', { argv: ['sh'], cwd: '/tmp', env: {}, cols: 80, rows: 24 })
          return context.pty.list()
        })`
      }
    )
    const daemon = await startDaemon({
      home,
      port: 0,
      builtinPluginsDir: null,
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
    expect(statSync(join(home, 'logs', 'pty-host.log')).mode & 0o777).toBe(0o600)

    const listed = (await client.callAny('acme.pty/spawnAndList', {})) as { sessionId: string; alive: boolean }[]
    expect(listed).toEqual([expect.objectContaining({ sessionId: 's_probe', alive: true })])
    client.close()
  })

  test('still starts when the host cannot be started', async () => {
    const home = makeTempHome()
    const daemon = await startDaemon({
      home,
      port: 0,
      builtinPluginsDir: null,
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

  test('does not print the rpc token and points at runtime.json', async () => {
    const home = makeTempHome()
    const pty = startFakePtyHost(home)
    cleanups.push(() => pty.stop())
    const proc = Bun.spawn([process.execPath, MAIN], {
      env: {
        ...process.env,
        QUIRKY_HOME: home,
        QUIRKY_PORT: '0',
        QUIRKY_UI_DIR: join(home, 'none'),
        QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN
      },
      stdout: 'pipe',
      stderr: 'ignore'
    })
    cleanups.push(() => {
      proc.kill()
    })
    const info = await waitFor(() => readRuntime(home), 10000)
    proc.kill('SIGTERM')
    await proc.exited
    const output = await new Response(proc.stdout).text()
    expect(output).toContain(`http://127.0.0.1:${info.port}`)
    expect(output).toContain(join(home, 'runtime.json'))
    expect(output).not.toContain(info.token)
    expect(output).not.toContain(info.hookToken)
  })
})
