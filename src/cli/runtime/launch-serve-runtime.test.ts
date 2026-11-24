import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ServeQuirkydLaunch from './serve-quirkyd-launch'

const { spawnMock, resolveLocalServeRuntimeMock, serveWithQuirkydMock, refuseIfProfileServedMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
    resolveLocalServeRuntimeMock: vi.fn(),
    serveWithQuirkydMock: vi.fn(),
    refuseIfProfileServedMock: vi.fn()
  }))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
// Why: these cover host selection; the pre-exec profile check would read this machine's own profile.
vi.mock('./serve-electron-preflight', () => ({
  preflightElectronServe: () => null,
  recordElectronServeStartupAbort: vi.fn(),
  refuseIfProfileServed: refuseIfProfileServedMock
}))
vi.mock('./serve-quirkyd-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof ServeQuirkydLaunch>()),
  resolveLocalServeRuntime: resolveLocalServeRuntimeMock,
  serveWithQuirkyd: serveWithQuirkydMock
}))

import { serveQuirkyApp } from './launch'
import { speechRecognizerPackageName } from '../../shared/speech-recognizer-package'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

/** Electron serve that exits cleanly once spawned, whenever selection gets to spawning it. */
function electronChild(): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess()
    setTimeout(() => child.emit('exit', 0, null), 0)
    return child
  })
}

describe('quirky serve host selection', () => {
  let stderr: string[]

  beforeEach(() => {
    spawnMock.mockReset()
    resolveLocalServeRuntimeMock.mockReset()
    serveWithQuirkydMock.mockReset()
    process.env.QUIRKY_APP_EXECUTABLE = '/opt/quirky/quirky-ide'
    stderr = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.QUIRKY_APP_EXECUTABLE
    delete process.env.QUIRKY_SERVE_RUNTIME
    delete process.env.QUIRKY_USER_DATA_PATH
    delete process.env.QUIRKY_DEV_USER_DATA_PATH
    delete process.env.QUIRKY_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('checks for a live peer before quirkyd only when supervised, so the brake never counts it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-serve-quirkyd-supervise-'))
    try {
      process.env.QUIRKY_APP_EXECUTABLE = join(root, 'quirky')
      await writeFile(process.env.QUIRKY_APP_EXECUTABLE, '')
      process.env.QUIRKY_USER_DATA_PATH = join(root, 'profile')
      const selection = {
        kind: 'quirkyd',
        runtime: '/node',
        entry: '/slot/quirkyd.js',
        version: '1'
      }
      resolveLocalServeRuntimeMock.mockResolvedValue(selection)
      serveWithQuirkydMock.mockResolvedValue(0)

      refuseIfProfileServedMock.mockReturnValue(null)
      await expect(serveQuirkyApp({})).resolves.toBe(0)
      expect(refuseIfProfileServedMock).not.toHaveBeenCalled()

      refuseIfProfileServedMock.mockImplementation(async () => {
        setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 20)
        return 3
      })
      serveWithQuirkydMock.mockClear()
      await expect(serveQuirkyApp({ supervise: true })).resolves.toBe(0)
      expect(serveWithQuirkydMock).not.toHaveBeenCalled()
      expect(stderr.join('')).toContain('Another Quirky serves this profile')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // #30100: the slot carries no browser client, so quirkyd must be handed the app's.
  it("serves on quirkyd by default, handing it the app's browser client", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'quirky-serve-quirkyd-web-'))
    try {
      await mkdir(join(appRoot, 'out', 'web'), { recursive: true })
      await writeFile(join(appRoot, 'out', 'web', 'web-index.html'), '<html></html>')
      const recognizer = speechRecognizerPackageName(process.platform, process.arch)
      await mkdir(join(appRoot, 'node_modules', recognizer), { recursive: true })
      await writeFile(join(appRoot, 'node_modules', recognizer, 'sherpa-onnx.node'), '')
      process.env.QUIRKY_SERVE_SUPERVISOR_APP_ROOT = appRoot
      const selection = {
        kind: 'quirkyd',
        runtime: '/node',
        entry: '/slot/quirkyd.js',
        version: '1'
      }
      resolveLocalServeRuntimeMock.mockResolvedValue(selection)
      serveWithQuirkydMock.mockResolvedValue(0)

      await expect(serveQuirkyApp({ json: true })).resolves.toBe(0)
      expect(serveWithQuirkydMock).toHaveBeenCalledWith(
        selection,
        { json: true },
        expect.any(String),
        expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }),
        join(appRoot, 'out', 'web'),
        // #31174: and the app's speech recognizer.
        process.platform === 'win32' ? undefined : join(appRoot, 'node_modules', recognizer)
      )
      expect(spawnMock).not.toHaveBeenCalled()
      expect(stderr.join('')).toContain('[serve] running on quirkyd 1')
    } finally {
      delete process.env.QUIRKY_SERVE_SUPERVISOR_APP_ROOT
      await rm(appRoot, { recursive: true, force: true })
    }
  })

  it('falls back to Electron and prints why when quirkyd cannot serve', async () => {
    resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'no template' })
    electronChild()

    await expect(serveQuirkyApp({ json: true })).resolves.toBe(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/opt/quirky/quirky-ide',
      expect.arrayContaining(['--serve', '--serve-json']),
      expect.any(Object)
    )
    expect(stderr.join('')).toContain('[serve] using Electron serve: no template')
  })

  it('keeps Electron without asking quirkyd when QUIRKY_SERVE_RUNTIME=electron', async () => {
    process.env.QUIRKY_SERVE_RUNTIME = 'electron'
    electronChild()

    await expect(serveQuirkyApp({ json: true })).resolves.toBe(0)
    expect(resolveLocalServeRuntimeMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(stderr.join('')).not.toContain('[serve]')
  })

  describe('serves the profile it selected on', () => {
    function electronSpawn(): { args: string[]; env: NodeJS.ProcessEnv } {
      const [, args, options] = spawnMock.mock.calls[0]
      return { args, env: options.env }
    }

    it('starts the Electron fallback on QUIRKY_USER_DATA_PATH, not the default profile', async () => {
      const profile = resolve('/isolated/profile-r')
      process.env.QUIRKY_USER_DATA_PATH = profile
      resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'ssh targets' })
      electronChild()

      await expect(serveQuirkyApp({ json: true })).resolves.toBe(0)
      expect(resolveLocalServeRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userDataPath: profile })
      )
      const child = electronSpawn()
      expect(child.args).toContain(`--user-data-dir=${profile}`)
      expect(child.env).toMatchObject({
        QUIRKY_USER_DATA_PATH: profile,
        QUIRKY_SERVE_USER_DATA_PATH: profile
      })
    })

    it('pins the opt-out Electron serve to the same profile', async () => {
      const profile = resolve('/isolated/profile-e')
      process.env.QUIRKY_USER_DATA_PATH = profile
      process.env.QUIRKY_SERVE_RUNTIME = 'electron'
      electronChild()

      await expect(serveQuirkyApp({ json: true })).resolves.toBe(0)
      expect(electronSpawn().args).toContain(`--user-data-dir=${profile}`)
    })

    it('hands quirkyd the absolute profile the selector read', async () => {
      process.env.QUIRKY_USER_DATA_PATH = join('relative', 'profile')
      const selection = {
        kind: 'quirkyd',
        runtime: '/node',
        entry: '/slot/quirkyd.js',
        version: '1'
      }
      resolveLocalServeRuntimeMock.mockResolvedValue(selection)
      serveWithQuirkydMock.mockResolvedValue(0)

      await expect(serveQuirkyApp({})).resolves.toBe(0)
      const profile = resolve('relative', 'profile')
      expect(resolveLocalServeRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userDataPath: profile })
      )
      expect(serveWithQuirkydMock.mock.calls[0]?.slice(0, 4)).toEqual([
        selection,
        {},
        profile,
        expect.any(Object)
      ])
    })

    it('uses QUIRKY_DEV_USER_DATA_PATH for both the selector and a dev Electron child', async () => {
      const profile = resolve('/isolated/dev-profile')
      delete process.env.QUIRKY_USER_DATA_PATH
      process.env.QUIRKY_DEV_USER_DATA_PATH = profile
      process.env.QUIRKY_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
      resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'dev' })
      electronChild()

      await expect(serveQuirkyApp({ json: true })).resolves.toBe(0)
      expect(resolveLocalServeRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userDataPath: profile })
      )
      // A dev build ignores --user-data-dir and reads this instead.
      expect(electronSpawn().env).toMatchObject({
        QUIRKY_DEV_USER_DATA_PATH: profile,
        QUIRKY_SERVE_USER_DATA_PATH: profile
      })
    })
  })
})
