import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  bindOwnedSocket,
  claimHome,
  type BindOps,
  type OwnedListener,
  type OwnedSocket
} from '../src/ownership'
import { onCleanup, runCleanups, tempHome } from './helpers'

afterEach(runCleanups)

type TrackedListener = OwnedListener & { stopCalls: number; unrefCalls: number }

function listenOn(path: string): TrackedListener {
  const server = Bun.listen({ unix: path, socket: { data() {} } })
  let stopped = false
  const listener: TrackedListener = {
    stopCalls: 0,
    unrefCalls: 0,
    stop(closeActive) {
      if (stopped) return
      server.stop(closeActive)
      stopped = true
      listener.stopCalls++
    },
    unref() {
      listener.unrefCalls++
      return server.unref()
    }
  }
  onCleanup(() => listener.stop(true))
  return listener
}

function bind(path: string, ops?: BindOps): OwnedSocket<TrackedListener> {
  const owned = bindOwnedSocket(path, listenOn, ops)
  onCleanup(() => owned.close())
  return owned
}

async function connect(path: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data() {} } })
    onCleanup(() => socket.end())
    return true
  } catch {
    return false
  }
}

function injectedError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

function injectedOps(
  socketPath: string,
  point: 'chmod' | 'claim-dir' | 'rename' | 'claim-published',
  capture: { privateDir?: string; error?: NodeJS.ErrnoException }
): BindOps {
  const original = injectedError(`injected ${point}`, point === 'rename' ? 'EXDEV' : point === 'chmod' ? 'EPERM' : 'EIO')
  capture.error = original
  let failed = false
  return {
    ...fs,
    mkdtempSync(prefix) {
      capture.privateDir = fs.mkdtempSync(prefix)
      return capture.privateDir
    },
    chmodSync(path, mode) {
      if (point === 'chmod' && !failed && String(path) === join(capture.privateDir!, 's')) {
        failed = true
        throw original
      }
      return fs.chmodSync(path, mode)
    },
    lstatSync: ((path: unknown, options?: unknown) => {
      const value = String(path)
      if (point === 'claim-dir' && !failed && value === capture.privateDir) {
        failed = true
        throw original
      }
      if (point === 'claim-published' && !failed && value === socketPath) {
        failed = true
        throw original
      }
      return fs.lstatSync(path as fs.PathLike, options as never)
    }) as BindOps['lstatSync'],
    renameSync(from, to) {
      if (point === 'rename' && !failed) {
        failed = true
        throw original
      }
      return fs.renameSync(from, to)
    }
  }
}

describe('ownership', () => {
  test('claims a deleted home as gone and keeps the loss sticky', () => {
    const home = tempHome()
    const claim = claimHome(home)

    fs.rmSync(home, { recursive: true, force: true })
    expect(claim.check()).toEqual({ reason: 'home-gone', path: home })

    fs.mkdirSync(home, { mode: 0o700 })
    expect(claim.check()).toEqual({ reason: 'home-gone', path: home })
  })

  test('detects a recreated home by bigint filesystem identity', () => {
    const home = tempHome()
    const moved = `${home}.moved`
    onCleanup(() => fs.rmSync(moved, { recursive: true, force: true }))
    const claim = claimHome(home)

    fs.renameSync(home, moved)
    fs.mkdirSync(home, { mode: 0o700 })

    expect(claim.check()).toEqual({ reason: 'home-replaced', path: home })
  })

  test('detects a renamed home as gone', () => {
    const home = tempHome()
    const moved = `${home}.moved`
    onCleanup(() => fs.rmSync(moved, { recursive: true, force: true }))
    const claim = claimHome(home)

    fs.renameSync(home, moved)

    expect(claim.check()).toEqual({ reason: 'home-gone', path: home })
  })

  test('follows a home symlink and detects when its target becomes dangling', () => {
    const home = tempHome()
    const target = tempHome()
    fs.rmSync(home, { recursive: true, force: true })
    fs.symlinkSync(target, home, 'dir')
    const claim = claimHome(home)

    fs.rmSync(target, { recursive: true, force: true })

    expect(claim.check()).toEqual({ reason: 'home-gone', path: home })
  })

  test('treats an inconclusive permission error as no ownership loss', () => {
    const parent = tempHome()
    const home = join(parent, 'home')
    fs.mkdirSync(home, { mode: 0o700 })
    const claim = claimHome(home)
    const parentMode = fs.statSync(parent).mode & 0o777
    onCleanup(() => fs.chmodSync(parent, parentMode))

    fs.chmodSync(parent, 0o000)
    expect(claim.check()).toBeNull()
  })

  test('reports a deleted public socket', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)

    fs.unlinkSync(path)

    expect(owned.check()).toEqual({ reason: 'socket-gone', path })
  })

  test('reports a decoy socket at the public path as replaced', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)
    fs.unlinkSync(path)
    listenOn(path)
    const decoyIdentity = fs.lstatSync(path, { bigint: true })

    expect(owned.check()).toEqual({ reason: 'socket-replaced', path })
    expect(fs.lstatSync(path, { bigint: true }).ino).toBe(decoyIdentity.ino)
  })

  test('reports a directory at the public socket path as replaced', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)
    fs.unlinkSync(path)
    fs.mkdirSync(path)

    expect(owned.check()).toEqual({ reason: 'socket-replaced', path })
    expect(owned.close().socketRemoved).toBe(false)
    expect(fs.statSync(path).isDirectory()).toBe(true)
  })

  test('close leaves a decoy listener at the public path intact', async () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)
    fs.unlinkSync(path)
    listenOn(path)
    const decoyIdentity = fs.lstatSync(path, { bigint: true })

    expect(owned.close()).toEqual({ listenerStopped: true, socketRemoved: false })
    expect(fs.lstatSync(path, { bigint: true }).ino).toBe(decoyIdentity.ino)
    expect(await connect(path)).toBe(true)
  })

  test('publishes a mode-0600 socket from an empty mode-0700 private directory', async () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)

    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.statSync(owned.privateDir).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(owned.privateDir)).toEqual([])
    expect(await connect(path)).toBe(true)
  })

  test('atomically replaces a stale public file', async () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    fs.writeFileSync(path, 'stale socket')
    const owned = bind(path)

    expect(fs.lstatSync(path).isSocket()).toBe(true)
    expect(await connect(path)).toBe(true)
  })

  test('closing an older binding preserves a later binding at the same public path', async () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const first = bind(path)
    const second = bind(path)
    const secondIdentity = fs.lstatSync(path, { bigint: true })

    expect(first.close()).toEqual({ listenerStopped: true, socketRemoved: false })
    expect(fs.lstatSync(path, { bigint: true }).ino).toBe(secondIdentity.ino)
    expect(await connect(path)).toBe(true)
  })

  test('scenario 20a leaves a decoy at the retired flat private socket name', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)
    const flatPath = join(home, `.pty${process.pid}`)
    listenOn(flatPath)
    const identity = fs.lstatSync(flatPath, { bigint: true })

    expect(owned.close().listenerStopped).toBe(true)
    expect(fs.lstatSync(flatPath, { bigint: true }).ino).toBe(identity.ino)
  })

  test('scenario 20b refuses a recreated private directory and can retry after it is removed', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)
    onCleanup(() => {
      try {
        fs.rmdirSync(owned.privateDir)
      } catch {}
      owned.close()
    })
    const originalListener = owned.listener
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(home, { mode: 0o700 })
    fs.mkdirSync(owned.privateDir, { mode: 0o700 })
    listenOn(join(owned.privateDir, 's'))
    const identity = fs.lstatSync(join(owned.privateDir, 's'), { bigint: true })

    expect(owned.close()).toEqual({ listenerStopped: false, socketRemoved: false })
    expect(originalListener.stopCalls).toBe(0)
    expect(originalListener.unrefCalls).toBe(1)
    expect(fs.lstatSync(join(owned.privateDir, 's'), { bigint: true }).ino).toBe(identity.ino)
  })

  test('scenario 20c safely stops after the home and private directory disappear', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)

    fs.rmSync(home, { recursive: true, force: true })

    expect(owned.close()).toEqual({ listenerStopped: true, socketRemoved: false })
    expect(fs.existsSync(owned.privateDir)).toBe(false)
  })

  test('scenario 20d refuses a decoy in its owned private directory, then retries safely', async () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const owned = bind(path)
    onCleanup(() => {
      try {
        fs.rmdirSync(owned.privateDir)
      } catch {}
      owned.close()
    })
    const privateSocket = join(owned.privateDir, 's')
    const decoy = listenOn(privateSocket)
    const decoyIdentity = fs.lstatSync(privateSocket, { bigint: true })

    expect(owned.close()).toEqual({ listenerStopped: false, socketRemoved: true })
    expect(owned.listener.stopCalls).toBe(0)
    expect(owned.listener.unrefCalls).toBe(1)
    expect(fs.lstatSync(privateSocket, { bigint: true }).ino).toBe(decoyIdentity.ino)
    expect(await connect(privateSocket)).toBe(true)

    decoy.stop(true)
    fs.rmdirSync(owned.privateDir)
    expect(owned.close().listenerStopped).toBe(true)
    expect(owned.listener.stopCalls).toBe(1)
  })

  test('scenario 21 cleans up each one-shot publication failure and allows a fresh bind', async () => {
    const points: Array<Parameters<typeof injectedOps>[1]> = ['chmod', 'claim-dir', 'rename', 'claim-published']
    for (const point of points) {
      const home = tempHome()
      const path = join(home, 'pty.sock')
      const capture: { privateDir?: string; error?: NodeJS.ErrnoException } = {}
      const ops = injectedOps(path, point, capture)
      let thrown: unknown
      try {
        bindOwnedSocket(path, listenOn, ops)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(capture.error)
      expect(fs.readdirSync(home).filter((entry) => entry.startsWith('.p'))).toEqual([])
      expect(await connect(join(capture.privateDir!, 's'))).toBe(false)

      const fresh = bind(path)
      expect(await connect(path)).toBe(true)
      expect(fresh.listener.stopCalls).toBe(0)
    }
  })

  test('scenario 21 preserves and reports paths when cleanup inspection keeps failing', () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    const capture: { privateDir?: string } = {}
    const originalError = injectedError('original publication failure', 'EXDEV')
    const inspectionError = injectedError('persistent private socket inspection failure', 'EIO')
    let failInspection = false
    let listener: TrackedListener | undefined
    let privatePath = ''
    const log = spyOn(console, 'error').mockImplementation(() => {})
    onCleanup(() => log.mockRestore())
    const ops: BindOps = {
      ...fs,
      mkdtempSync(prefix) {
        capture.privateDir = fs.mkdtempSync(prefix)
        privatePath = join(capture.privateDir, 's')
        return capture.privateDir
      },
      lstatSync: ((candidate: unknown, options?: unknown) => {
        if (failInspection && String(candidate) === privatePath) throw inspectionError
        return fs.lstatSync(candidate as fs.PathLike, options as never)
      }) as BindOps['lstatSync'],
      renameSync() {
        failInspection = true
        throw originalError
      }
    }
    expect(() =>
      bindOwnedSocket(
        path,
        (privateSocket) => {
          listener = listenOn(privateSocket)
          onCleanup(() => {
            failInspection = false
            if (listener && listener.stopCalls === 0) listener.stop(true)
          })
          return listener
        },
        ops
      )
    ).toThrow('original publication failure')
    
    expect(listener?.stopCalls).toBe(0)
    expect(listener?.unrefCalls).toBe(1)
    expect(fs.existsSync(capture.privateDir!)).toBe(true)
    expect(fs.existsSync(privatePath)).toBe(true)
    expect(log.mock.calls.flat().some((value) => String(value).includes(capture.privateDir!))).toBe(true)
    expect(log.mock.calls.flat().some((value) => value === originalError || String(value).includes(originalError.message))).toBe(true)
    failInspection = false
    listener!.stop(true)
    fs.rmdirSync(capture.privateDir!)
  })

  test('scenario 21 leaves an unreplaceable public directory alone, then allows a fresh bind', async () => {
    const home = tempHome()
    const path = join(home, 'pty.sock')
    let privatePath = ''
    fs.mkdirSync(path)
    fs.writeFileSync(join(path, 'keep'), 'not empty')

    expect(() =>
      bindOwnedSocket(
        path,
        (candidate) => {
          privatePath = candidate
          return listenOn(candidate)
        }
      )
    ).toThrow()
    expect(fs.readFileSync(join(path, 'keep'), 'utf8')).toBe('not empty')
    expect(fs.readdirSync(home).filter((entry) => entry.startsWith('.p'))).toEqual([])
    expect(await connect(privatePath)).toBe(false)

    fs.rmSync(path, { recursive: true, force: true })
    const fresh = bind(path)
    expect(await connect(path)).toBe(true)
    expect(fresh.listener.stopCalls).toBe(0)
  })
})
