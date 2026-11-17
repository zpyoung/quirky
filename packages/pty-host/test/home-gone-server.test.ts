import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { PtyClient } from '../src/client'
import type { BindOps, OwnershipLoss } from '../src/ownership'
import { startPtyServer } from '../src/server'
import { onCleanup, runCleanups, scopeForHome, startHost, tempHome, waitFor } from './helpers'

afterEach(runCleanups)

const params = { sessionId: 's1', argv: ['/bin/sh', '-c', '/bin/sleep 600 & wait'], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 }


async function hello(path: string, token: string) {
  const client = await PtyClient.connect(path)
  onCleanup(() => client.close())
  await client.hello(token)
  return client
}

describe('server ownership', () => {
  test('stopping an old server leaves the replacement home and live session unchanged', async () => {
    const home = tempHome()
    const a = startHost({ home, ownershipCheckMs: 60_000 })
    await a.server.manager.create({ ...params, env: scopeForHome(home).env })
    fs.rmSync(home, { recursive: true })
    fs.mkdirSync(home, { mode: 0o700 })
    const b = startHost({ home, ownershipCheckMs: 60_000 })
    await b.server.manager.create({ ...params, env: scopeForHome(home).env })
    const paths = ['pty.pid', 'pty.token', 'sessions/s1/meta.json']
    const before = paths.map(p => fs.readFileSync(join(home, p), 'utf8'))
    const socketInode = fs.lstatSync(b.server.socketPath, { bigint: true }).ino
    await a.server.stop()
    expect(fs.lstatSync(b.server.socketPath, { bigint: true }).ino).toBe(socketInode)
    expect(paths.map(p => fs.readFileSync(join(home, p), 'utf8'))).toEqual(before)
    const client = await hello(b.server.socketPath, b.server.token)
    expect((await client.request('list', {}))[0]?.state).toBe('running')
  }, 30_000)

  test('a home replaced during socket-loss shutdown receives no final writes', async () => {
    const home = tempHome()
    const orphaned: Array<{ loss: OwnershipLoss; error?: unknown }> = []
    const host = startHost({ home, ownershipCheckMs: 20, onOrphaned: (loss, error) => orphaned.push({ loss, error }) })
    await host.server.manager.create({ ...params, argv: ['/bin/sh', '-c', "trap '' HUP; echo ready; exec /bin/sleep 600"], env: scopeForHome(home).env })
    await waitFor(async () => (await host.server.manager.read('s1', 10)).lines.includes('ready'))
    fs.rmSync(host.server.socketPath)
    await waitFor(async () => {
      try { await host.server.manager.create({ ...params, sessionId: 's2' }); return false }
      catch (error) { return String(error).includes('Terminal host is shutting down') }
    })
    expect(orphaned).toHaveLength(0)
    fs.rmSync(home, { recursive: true })
    fs.mkdirSync(join(home, 'sessions/s1'), { recursive: true, mode: 0o700 })
    const metaPath = join(home, 'sessions/s1/meta.json')
    fs.writeFileSync(metaPath, 'replacement sentinel')
    await waitFor(() => orphaned.length === 1, 12_000)
    expect(orphaned[0]?.loss.reason).toBe('socket-gone')
    expect(orphaned[0]?.error).toBeUndefined()
    expect(fs.readFileSync(metaPath, 'utf8')).toBe('replacement sentinel')
    expect(fs.readdirSync(home)).toEqual(['sessions'])
    expect(fs.readdirSync(join(home, 'sessions'))).toEqual(['s1'])
    expect(fs.readdirSync(join(home, 'sessions/s1'))).toEqual(['meta.json'])
  }, 30_000)

  test('explicit stop does not report orphaning', async () => {
    let calls = 0
    const { home, server } = startHost({ ownershipCheckMs: 20, onOrphaned: () => calls++ })
    await server.stop()
    // the real watchdog must stay quiet after its listener has been closed.
    await Bun.sleep(200)
    expect(calls).toBe(0)
    expect(fs.existsSync(server.socketPath)).toBe(false)
    expect(fs.existsSync(join(home, 'pty.pid'))).toBe(false)
  })

  test('shutdown request reports shutdown once and never orphaning', async () => {
    let shutdowns = 0
    let orphans = 0
    const { server, connect } = startHost({ ownershipCheckMs: 20, onShutdown: () => shutdowns++, onOrphaned: () => orphans++ })
    const client = await connect()
    expect(await client.request('shutdown', {})).toEqual({})
    await waitFor(() => shutdowns === 1)
    // this checks the live watchdog after protocol shutdown, not a mocked clock.
    await Bun.sleep(200)
    expect(shutdowns).toBe(1)
    expect(orphans).toBe(0)
    expect(fs.existsSync(server.socketPath)).toBe(false)
  })

  test('persistent startup inspection failure preserves and reports its unreferenced listener', async () => {
    const home = tempHome()
    const originalError = Object.assign(new Error('original publication failure'), { code: 'EXDEV' })
    const inspectionError = Object.assign(new Error('persistent socket inspection failure'), { code: 'EIO' })
    let failInspection = false
    let privateDir = ''
    let privatePath = ''
    let stopCalls = 0
    let unrefCalls = 0
    let managerOptionReads = 0
    let releaseListener: (() => void) | undefined
    const log = spyOn(console, 'error').mockImplementation(() => {})
    onCleanup(() => log.mockRestore())
    const intervals = spyOn(globalThis, 'setInterval')
    onCleanup(() => intervals.mockRestore())
    const listen = Bun.listen
    const capturedListen = spyOn(Bun, 'listen').mockImplementation(((options: Parameters<typeof Bun.listen>[0]) => {
      const listener = listen(options)
      const stop = listener.stop.bind(listener)
      let stopped = false
      releaseListener = () => {
        failInspection = false
        if (!stopped) {
          stop(true)
          stopped = true
        }
      }
      onCleanup(releaseListener)
      const stopSpy = spyOn(listener, 'stop').mockImplementation(closeActive => {
        stopCalls++
        stop(closeActive)
        stopped = true
      })
      onCleanup(() => stopSpy.mockRestore())
      const unref = listener.unref.bind(listener)
      const unrefSpy = spyOn(listener, 'unref').mockImplementation(() => {
        unrefCalls++
        return unref()
      })
      onCleanup(() => unrefSpy.mockRestore())
      return listener
    }) as typeof Bun.listen)
    onCleanup(() => capturedListen.mockRestore())
    const ops: BindOps = {
      ...fs,
      mkdtempSync: ((prefix: string) => {
        privateDir = fs.mkdtempSync(prefix)
        onCleanup(() => fs.rmSync(privateDir, { recursive: true, force: true }))
        privatePath = join(privateDir, 's')
        return privateDir
      }) as BindOps['mkdtempSync'],
      lstatSync: ((candidate: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
        if (failInspection && String(candidate) === privatePath) throw inspectionError
        return fs.lstatSync(candidate, options)
      }) as BindOps['lstatSync'],
      renameSync() {
        failInspection = true
        throw originalError
      }
    }
    let thrown: unknown
    try {
      const server = startPtyServer({
        home,
        socketBindingOps: ops,
        get processRunner() {
          managerOptionReads++
          return undefined
        }
      })
      onCleanup(() => server.stop())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(originalError)
    expect(managerOptionReads).toBe(0)
    expect(intervals).not.toHaveBeenCalled()
    expect(stopCalls).toBe(0)
    expect(unrefCalls).toBe(1)
    expect(fs.existsSync(privateDir)).toBe(true)
    expect(fs.existsSync(privatePath)).toBe(true)
    expect(fs.existsSync(join(home, 'pty.pid'))).toBe(false)
    expect(log.mock.calls.flat().some(value => String(value).includes(privateDir))).toBe(true)
    expect(log.mock.calls.flat().some(value => value === originalError || String(value).includes(originalError.message))).toBe(true)
    expect(releaseListener).toBeDefined()
    releaseListener!()
    fs.rmdirSync(privateDir)
    expect(fs.existsSync(privatePath)).toBe(false)
    expect(fs.readdirSync(home).filter(entry => entry.startsWith('.p'))).toEqual([])
    capturedListen.mockRestore()
    intervals.mockRestore()
    log.mockRestore()
    const next = startHost({ home })
    await hello(next.server.socketPath, next.server.token)
  }, 30_000)

  for (const failure of ['chmod', 'directory claim', 'rename', 'public claim', 'nonempty public directory'] as const) {
    test(`failed publication cleans startup resources: ${failure}`, async () => {
      const home = tempHome()
      let fired = false
      let privatePath = ''
      const injected = Object.assign(new Error('publication failure'), { code: failure === 'chmod' ? 'EPERM' : failure === 'rename' ? 'EXDEV' : 'EIO' })
      const ops: BindOps = {
        mkdtempSync: ((...args: Parameters<typeof fs.mkdtempSync>) => {
          const result = fs.mkdtempSync(...args)
          privatePath = join(String(result), 's')
          return result
        }) as typeof fs.mkdtempSync,
        chmodSync: ((path, mode) => {
          if (!fired && failure === 'chmod' && String(path).endsWith('/s')) { fired = true; throw injected }
          fs.chmodSync(path, mode)
        }) as typeof fs.chmodSync,
        lstatSync: ((path: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
          if (!fired && ((failure === 'directory claim' && String(path).startsWith(join(home, '.p')) && !String(path).endsWith('/s')) || (failure === 'public claim' && String(path) === join(home, 'pty.sock')))) { fired = true; throw injected }
          return fs.lstatSync(path, options)
        }) as typeof fs.lstatSync,
        renameSync: ((from, to) => {
          if (!fired && failure === 'rename') { fired = true; throw injected }
          fs.renameSync(from, to)
        }) as typeof fs.renameSync
      }
      if (failure === 'nonempty public directory') {
        fs.mkdirSync(join(home, 'pty.sock'))
        fs.writeFileSync(join(home, 'pty.sock/keep'), 'keep')
      }
      expect(() => {
        const server = startPtyServer({ home, socketBindingOps: ops })
        onCleanup(() => server.stop())
      }).toThrow(failure === 'nonempty public directory' ? undefined : injected.message)
      expect(fs.readdirSync(home).filter(p => p.startsWith('.p'))).toEqual([])
      expect(fs.existsSync(privatePath)).toBe(false)
      expect(fs.existsSync(join(home, 'pty.pid'))).toBe(false)
      await expect(Bun.connect({ unix: privatePath, socket: { data() {} } }).then(socket => {
        onCleanup(() => socket.terminate())
        return socket
      })).rejects.toBeDefined()
      if (failure === 'nonempty public directory') fs.rmSync(join(home, 'pty.sock'), { recursive: true })
      const next = startHost({ home })
      await hello(next.server.socketPath, next.server.token)
    })
  }
})
