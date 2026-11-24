import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LocalCommandResolver from './command-path-resolver'
import type { ProcessSpec } from '@quirky/process-host/process-spec'

const {
  handleMock,
  execFileMock,
  execFileAsyncMock,
  runWslProcessMock,
  hydrateShellPathMock,
  mergePathSegmentsMock,
  resolveCliCommandsMock,
  isCommandOnLocalPathMock,
  listLocalCommandPathsMock,
  mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  runWslProcessMock: vi.fn(),
  hydrateShellPathMock: vi.fn(),
  mergePathSegmentsMock: vi.fn(),
  resolveCliCommandsMock: vi.fn(),
  isCommandOnLocalPathMock: vi.fn(),
  listLocalCommandPathsMock: vi.fn(),
  mergePersistedWindowsPathAsyncMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return {
    execFile: execFileWithPromisify,
    spawn: vi.fn()
  }
})

vi.mock('@quirky/process-host', () => ({
  runProcess: async (spec: ProcessSpec) => ({
    ...(await execFileAsyncMock(spec.program, spec.args, {
      encoding: 'utf-8',
      timeout: spec.timeoutMs,
      windowsHide: true,
      ...(spec.env ? { env: spec.env } : {})
    })),
    code: 0,
    timedOut: false
  })
}))

// WSL commands now route through the runner, not execFile('wsl.exe', ...).
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock,
  mergePathSegments: mergePathSegmentsMock
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommands: resolveCliCommandsMock
}))

// Why (#9297): local PATH resolution is now fs-based (no where/which spawn).
// These tests express "which commands are on PATH" via the where/which mock,
// so route the resolver through that same mock to preserve their intent.
vi.mock('./command-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalCommandResolver>()),
  isCommandOnLocalPath: isCommandOnLocalPathMock,
  listLocalCommandPaths: listLocalCommandPathsMock
}))

vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPath: mergePersistedWindowsPathMock
}))

import { _resetPreflightCache, runPreflightCheck } from '../preflight/agent-detection'
import { registerPreflightHandlers } from './preflight'
import { resetPreflightMocks, type HandlerMap } from './preflight-test-harness'

describe('preflight', () => {
  const originalPlatform = process.platform
  const handlers: HandlerMap = {}

  beforeEach(() => {
    resetPreflightMocks(
      {
        handleMock,
        execFileAsyncMock,
        runWslProcessMock,
        hydrateShellPathMock,
        mergePathSegmentsMock,
        resolveCliCommandsMock,
        isCommandOnLocalPathMock,
        listLocalCommandPathsMock,
        mergePersistedWindowsPathAsyncMock,
        mergePersistedWindowsPathMock
      },
      handlers
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  // Why: every preflight run probes (in order) `git --version`, `gh --version`,
  // `glab --version`, then in parallel `gh auth status` + `glab auth status` —
  // five execFile calls per cycle. Tests below provide values for all five.
  it('marks gh as authenticated when gh auth status exits successfully', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const status = await runPreflightCheck()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(4, 'gh', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, 'glab', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    })
  })

  it.each(['gh', 'glab'])('does not switch %s copies after authentication fails', async (cli) => {
    const first = `/test/first/${cli}`
    const second = `/test/second/${cli}`
    listLocalCommandPathsMock.mockImplementation(async (command: string) =>
      command === cli ? [first, second] : []
    )
    execFileAsyncMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === first && args[0] === 'auth') {
        throw Object.assign(new Error('not authenticated'), { code: 1, stderr: 'not logged in' })
      }
      return { stdout: 'fixture success', stderr: '' }
    })

    const status = await runPreflightCheck()

    expect(cli === 'gh' ? status.gh : status.glab).toEqual({
      installed: true,
      authenticated: false
    })
    expect(
      execFileAsyncMock.mock.calls.filter(([command]) => command === first).map(([, args]) => args)
    ).toEqual([['--version'], ['auth', 'status']])
    expect(execFileAsyncMock.mock.calls.some(([command]) => command === second)).toBe(false)
  })

  it('keeps older gh stderr success output from showing a false auth warning', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'Logged in to github.com account octocat\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: true })
  })

  // Why (#22975): these two cases key the spawn mock on (command, args) instead
  // of call order, because the fallback probes exactly which copy runs is the
  // behaviour under test — and `gh auth status` runs in parallel with
  // `glab auth status`, so a fixed sequence would not be the real one.
  it('authenticates the gh copy that actually ran, not the shim PATH chose', async () => {
    const shim = '/Users/octocat/.asdf/shims/gh'
    const working = '/opt/homebrew/bin/gh'
    const glabShim = '/Users/octocat/.asdf/shims/glab'
    const glabWorking = '/usr/local/bin/glab'
    const shims = new Set([shim, glabShim])
    listLocalCommandPathsMock.mockImplementation(async (command: string) => {
      if (command === 'gh') {
        return [shim, working]
      }
      return command === 'glab' ? [glabShim, glabWorking] : []
    })
    execFileAsyncMock.mockImplementation(async (command: string, args: string[]) => {
      if (shims.has(command)) {
        throw Object.assign(new Error('spawn failed'), { code: 126 })
      }
      const auth = args[0] === 'auth'
      if (command === working) {
        return { stdout: auth ? 'github.com\n  - Active account: true\n' : 'gh version 2.6.0\n' }
      }
      if (command === glabWorking) {
        return { stdout: auth ? 'Logged in to gitlab.com\n' : 'glab version 1.92.1\n' }
      }
      if (command === 'git') {
        return { stdout: 'git version 2.0.0\n' }
      }
      throw new Error(`unexpected command ${command}`)
    })

    const status = await runPreflightCheck()

    expect(status).toMatchObject({
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    })
    for (const [cli, copy] of [
      ['gh', working],
      ['glab', glabWorking]
    ]) {
      expect(execFileAsyncMock).toHaveBeenCalledWith(copy, ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true
      })
      expect(execFileAsyncMock).not.toHaveBeenCalledWith(cli, ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true
      })
    }
  })

  it('marks gh not installed when no copy PATH offers can run', async () => {
    const doomed = ['/Users/octocat/.asdf/shims/gh', '/Users/octocat/.local/bin/gh']
    listLocalCommandPathsMock.mockImplementation(async (command: string) =>
      command === 'gh' ? doomed : []
    )
    execFileAsyncMock.mockImplementation(async (command: string, args: string[]) => {
      if (doomed.includes(command)) {
        throw Object.assign(new Error('spawn failed'), { code: 126 })
      }
      if (command === 'git') {
        return { stdout: 'git version 2.0.0\n' }
      }
      if (command === 'glab') {
        return {
          stdout: args[0] === 'auth' ? 'Logged in to gitlab.com\n' : 'glab version 1.92.1\n'
        }
      }
      throw new Error(`unexpected command ${command}`)
    })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: false, authenticated: false })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(5)
  })

  it('marks glab as not installed when `glab --version` fails', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce(new Error('command not found: glab'))
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    const status = await runPreflightCheck()

    expect(status.glab).toEqual({ installed: false, authenticated: false })
    // Why: with glab uninstalled, glab auth status must not run — that
    // would surface a misleading "command not found" error in logs.
    expect(execFileAsyncMock).toHaveBeenCalledTimes(4)
  })

  it('marks glab as installed but unauthenticated when auth status fails', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitLab hosts.\n' })

    const status = await runPreflightCheck()

    expect(status.glab).toEqual({ installed: true, authenticated: false })
  })

  it('times out hung local preflight probes', async () => {
    vi.useFakeTimers()
    try {
      execFileAsyncMock.mockImplementation((command, args) => {
        if (command === 'git') {
          return Promise.resolve({ stdout: 'git version 2.0.0\n' })
        }
        if (command === 'gh' && Array.isArray(args) && args[0] === '--version') {
          return new Promise(() => {})
        }
        if (command === 'glab') {
          return Promise.reject(new Error('command not found: glab'))
        }
        throw new Error(`unexpected command ${String(command)}`)
      })

      const statusPromise = runPreflightCheck()
      let settled = false
      void statusPromise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await vi.advanceTimersByTimeAsync(5000)
      await Promise.resolve()

      expect(settled).toBe(true)
      await expect(statusPromise).resolves.toMatchObject({
        git: { installed: true },
        gh: { installed: false },
        glab: { installed: false }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out hung WSL preflight probes', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      execFileAsyncMock.mockImplementation((command) => {
        if (command === 'git') {
          return Promise.resolve({ stdout: 'git version 2.0.0\n' })
        }
        if (command === 'gh' || command === 'glab') {
          return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        }
        throw new Error(`unexpected command ${String(command)}`)
      })
      runWslProcessMock.mockImplementation(({ script }: { script: string }) => {
        if (script.includes("'gh' --version")) {
          return new Promise(() => {})
        }
        if (script.includes("'glab' --version")) {
          return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        }
        throw new Error(`unexpected WSL script ${script}`)
      })

      const statusPromise = runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      let settled = false
      void statusPromise.finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(5000)
      await Promise.resolve()

      expect(settled).toBe(true)
      await expect(statusPromise).resolves.toMatchObject({
        gh: { installed: false },
        glab: { installed: false }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-runs the probe when forced so updated gh auth state is visible without relaunch', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const firstStatus = await runPreflightCheck()
    const refreshedStatus = await runPreflightCheck(true)

    expect(firstStatus.gh).toEqual({ installed: true, authenticated: false })
    expect(refreshedStatus.gh).toEqual({ installed: true, authenticated: true })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(10)
  })

  it.each(['linux', 'darwin'])(
    'waits for the %s shell PATH before detecting and caching GitHub CLI status',
    async (platform) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      let finishHydration: ((result: { ok: true; segments: string[] }) => void) | undefined
      hydrateShellPathMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishHydration = resolve
          })
      )
      let merged = false
      mergePathSegmentsMock.mockImplementation(() => {
        merged = true
      })
      execFileAsyncMock.mockImplementation(async () => {
        if (!merged) {
          throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
        }
        return { stdout: 'version fixture', stderr: '' }
      })

      const check = runPreflightCheck()
      await Promise.resolve()
      expect(execFileAsyncMock).not.toHaveBeenCalled()
      expect(finishHydration).toBeDefined()
      finishHydration?.({ ok: true, segments: ['/home/user/.local/share/mise/shims'] })

      await expect(check).resolves.toMatchObject({ gh: { installed: true, authenticated: true } })
      await expect(runPreflightCheck()).resolves.toMatchObject({ gh: { installed: true } })
      expect(hydrateShellPathMock).toHaveBeenCalledOnce()
    }
  )

  it('refreshes the POSIX shell PATH on Re-check after a CLI install', async () => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    )
    await expect(runPreflightCheck()).resolves.toMatchObject({ gh: { installed: false } })
    hydrateShellPathMock.mockResolvedValue({ ok: true, segments: ['/new/cli/bin'] })
    mergePathSegmentsMock.mockImplementation(() => {
      execFileAsyncMock.mockResolvedValue({ stdout: 'version fixture', stderr: '' })
    })

    await expect(runPreflightCheck(true)).resolves.toMatchObject({ gh: { installed: true } })
    expect(hydrateShellPathMock).toHaveBeenLastCalledWith({ force: true })
    expect(mergePathSegmentsMock).toHaveBeenCalledWith(['/new/cli/bin'])
  })

  it('uses the inherited PATH when POSIX shell hydration fails', async () => {
    hydrateShellPathMock.mockResolvedValue({ ok: false, segments: [], failureReason: 'timeout' })
    execFileAsyncMock.mockResolvedValue({ stdout: 'version fixture', stderr: '' })

    await expect(runPreflightCheck()).resolves.toMatchObject({ gh: { installed: true } })
    expect(mergePathSegmentsMock).not.toHaveBeenCalled()
  })

  it('registers the preflight handler', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    registerPreflightHandlers()

    const status = await handlers['preflight:check']()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    })
  })

  it('lets the IPC handler bypass the session cache when forced', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    registerPreflightHandlers()

    const firstStatus = await handlers['preflight:check']()
    const refreshedStatus = await handlers['preflight:check'](null, { force: true })

    expect(firstStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: false },
      glab: { installed: true, authenticated: true }
    })
    expect(refreshedStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    })
  })
})
