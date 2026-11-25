// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetWindowsTerminalCapabilityReprobeForTests } from './windows-terminal-capability-reprobe'
import {
  getCachedWindowsTerminalCapabilities,
  getWindowsTerminalCapabilityOwnerKey,
  isWindowsTerminalCapabilityHost,
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests,
  selectWindowsTerminalCapabilitiesForOwner,
  useWindowsTerminalCapabilities
} from './windows-terminal-capabilities'

describe('Windows terminal capability host ownership', () => {
  it.each([
    {
      name: 'local Windows desktop while the platform probe loads',
      isWindowsRenderer: true,
      isWebClient: false,
      target: { kind: 'local' } as const,
      hostPlatform: null,
      expected: true
    },
    {
      name: 'Windows desktop attached to remote Linux',
      isWindowsRenderer: true,
      isWebClient: false,
      target: { kind: 'environment', environmentId: 'linux' } as const,
      hostPlatform: 'linux' as const,
      expected: false
    },
    {
      name: 'Windows browser paired to a Linux server',
      isWindowsRenderer: true,
      isWebClient: true,
      target: { kind: 'local' } as const,
      hostPlatform: 'linux' as const,
      expected: false
    },
    {
      name: 'non-Windows browser paired to a Windows server',
      isWindowsRenderer: false,
      isWebClient: true,
      target: { kind: 'local' } as const,
      hostPlatform: 'win32' as const,
      expected: true
    },
    {
      name: 'non-Windows desktop attached to remote Windows',
      isWindowsRenderer: false,
      isWebClient: false,
      target: { kind: 'environment', environmentId: 'windows' } as const,
      hostPlatform: 'win32' as const,
      expected: true
    }
  ])('$name', ({ expected, ...args }) => {
    expect(isWindowsTerminalCapabilityHost(args)).toBe(expected)
  })
})

function stubTerminalCapabilityApi(args: {
  wslAvailable: boolean
  pwshAvailable: boolean
  wslDistros?: string[]
  gitBashAvailable?: boolean
  hostPlatform?: NodeJS.Platform | null
}): {
  wslIsAvailable: ReturnType<typeof vi.fn>
  wslListDistros: ReturnType<typeof vi.fn>
  pwshIsAvailable: ReturnType<typeof vi.fn>
  isGitBashAvailable: ReturnType<typeof vi.fn>
  runtimeGetStatus: ReturnType<typeof vi.fn>
} {
  const wslIsAvailable = vi.fn().mockResolvedValue(args.wslAvailable)
  const wslListDistros = vi.fn().mockResolvedValue(args.wslDistros ?? [])
  const pwshIsAvailable = vi.fn().mockResolvedValue(args.pwshAvailable)
  const isGitBashAvailable = vi.fn().mockResolvedValue(args.gitBashAvailable ?? false)
  const runtimeGetStatus = vi.fn().mockResolvedValue({
    hostPlatform: 'hostPlatform' in args ? args.hostPlatform : 'win32'
  })

  vi.stubGlobal('window', {
    api: {
      wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
      pwsh: { isAvailable: pwshIsAvailable },
      gitBash: { isAvailable: isGitBashAvailable },
      runtime: { getStatus: runtimeGetStatus }
    }
  })

  return { wslIsAvailable, wslListDistros, pwshIsAvailable, isGitBashAvailable, runtimeGetStatus }
}

describe('windows terminal capabilities', () => {
  const hookRoots: Root[] = []

  afterEach(() => {
    for (const root of hookRoots.splice(0)) {
      act(() => root.unmount())
    }
    resetWindowsTerminalCapabilitiesForTests()
    resetWindowsTerminalCapabilityReprobeForTests()
    vi.unstubAllGlobals()
  })

  it('does not reuse capability cache between runtime owners', async () => {
    const isGitBashAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const runtimeGetStatus = vi
      .fn()
      .mockResolvedValueOnce({ hostPlatform: 'win32' })
      .mockResolvedValueOnce({ hostPlatform: 'linux' })
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: isGitBashAvailable },
        runtime: { getStatus: runtimeGetStatus }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-a' })
    ).resolves.toMatchObject({ gitBashAvailable: true, hostPlatform: 'win32' })
    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-b' })
    ).resolves.toMatchObject({ gitBashAvailable: false, hostPlatform: 'linux' })

    expect(getCachedWindowsTerminalCapabilities('runtime:host-a')).toMatchObject({
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    expect(getCachedWindowsTerminalCapabilities('runtime:host-b')).toMatchObject({
      gitBashAvailable: false,
      hostPlatform: 'linux'
    })
    expect(isGitBashAvailable).toHaveBeenCalledTimes(2)
    expect(runtimeGetStatus).toHaveBeenCalledTimes(2)
  })

  it('loads SSH Windows host capabilities through the SSH preflight bridge', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi.fn().mockResolvedValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({
        ownerKey: 'ssh:ssh-1',
        sshConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(detectRemoteWindowsTerminalCapabilities).toHaveBeenCalledWith({
      connectionId: 'ssh-1'
    })
    expect(getCachedWindowsTerminalCapabilities('ssh:ssh-1')).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32',
      isLoading: false
    })
  })

  it('derives the SSH owner cache key when callers omit ownerKey', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        wslAvailable: true,
        wslDistros: ['Ubuntu'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32'
      })
      .mockResolvedValueOnce({
        wslAvailable: true,
        wslDistros: ['Ubuntu', 'Debian'],
        pwshAvailable: true,
        gitBashAvailable: false,
        hostPlatform: 'win32'
      })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })

    const sshOwnerKey = getWindowsTerminalCapabilityOwnerKey(null, 'ssh-1')
    await expect(loadWindowsTerminalCapabilities({ sshConnectionId: 'ssh-1' })).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(getCachedWindowsTerminalCapabilities(sshOwnerKey)).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32',
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })

    await expect(
      loadWindowsTerminalCapabilities({
        force: true,
        target: { kind: 'local' },
        sshConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu', 'Debian'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(getCachedWindowsTerminalCapabilities(sshOwnerKey)).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu', 'Debian'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
  })

  it('loads runtime-owned SSH capabilities through runtime RPC with a scoped cache key', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi.fn()
    const runtimeEnvironmentCall = vi.fn(async (args: { selector: string; method: string }) => {
      const resultByMethod: Record<string, unknown> = {
        'status.get': {
          hostPlatform: 'linux',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2
        },
        'preflight.detectRemoteWindowsTerminalCapabilities': {
          wslAvailable: true,
          wslDistros: ['Ubuntu'],
          pwshAvailable: true,
          gitBashAvailable: false,
          hostPlatform: 'win32'
        }
      }
      return {
        id: args.method,
        ok: true,
        result: resultByMethod[args.method]
      }
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        },
        runtimeEnvironments: {
          call: runtimeEnvironmentCall
        }
      }
    })

    const ownerKey = getWindowsTerminalCapabilityOwnerKey('env-1', 'ssh-1')
    expect(ownerKey).toBe('runtime:env-1:ssh:ssh-1')

    await expect(
      loadWindowsTerminalCapabilities({
        target: { kind: 'environment', environmentId: 'env-1' },
        sshConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(detectRemoteWindowsTerminalCapabilities).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'preflight.detectRemoteWindowsTerminalCapabilities',
        params: { connectionId: 'ssh-1' }
      })
    )
    expect(getCachedWindowsTerminalCapabilities(ownerKey)).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities('ssh:ssh-1')).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })

  it('does not re-probe on parent rerenders with the same capability target', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi.fn().mockResolvedValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })

    function HookProbe(): null {
      useWindowsTerminalCapabilities(true, false, undefined, { kind: 'local' }, 'ssh-1')
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    hookRoots.push(root)

    await act(async () => {
      root.render(createElement(HookProbe))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(detectRemoteWindowsTerminalCapabilities).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(createElement(HookProbe))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(detectRemoteWindowsTerminalCapabilities).toHaveBeenCalledTimes(1)
  })

  it('bounds re-probes for a Windows host that keeps answering "no WSL"', async () => {
    vi.useFakeTimers()
    const { wslIsAvailable, pwshIsAvailable } = stubTerminalCapabilityApi({
      wslAvailable: false,
      pwshAvailable: false,
      wslDistros: []
    })

    function HookProbe(): null {
      useWindowsTerminalCapabilities(true)
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    hookRoots.push(root)

    try {
      await act(async () => {
        root.render(createElement(HookProbe))
        await Promise.resolve()
        await Promise.resolve()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60_000)
      })

      // The ceiling poll preserves install discovery while cutting the old 30s spawn rate.
      expect(wslIsAvailable.mock.calls.length).toBeLessThanOrEqual(10)
      expect(pwshIsAvailable.mock.calls.length).toBeLessThanOrEqual(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes expired runtime owner capability caches', async () => {
    stubTerminalCapabilityApi({
      wslAvailable: false,
      pwshAvailable: false,
      hostPlatform: 'linux'
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:old-host', now: 1_000 })
    expect(getCachedWindowsTerminalCapabilities('runtime:old-host')).toMatchObject({
      hostPlatform: 'linux'
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:new-host', now: 32_000 })

    expect(getCachedWindowsTerminalCapabilities('runtime:old-host')).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })

  it('bounds runtime owner capability caches by evicting the oldest owner', async () => {
    stubTerminalCapabilityApi({
      wslAvailable: false,
      pwshAvailable: false,
      hostPlatform: 'linux'
    })

    for (let i = 0; i < 33; i += 1) {
      await loadWindowsTerminalCapabilities({ ownerKey: `runtime:host-${i}`, now: 1_000 + i })
    }

    expect(getCachedWindowsTerminalCapabilities('runtime:host-0')).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities('runtime:host-32')).toMatchObject({
      hostPlatform: 'linux'
    })
  })

  it('does not select the previous owner capabilities while a new owner loads', async () => {
    const isGitBashAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: isGitBashAvailable },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-a' })
    const previousOwnerState = {
      ownerKey: 'runtime:host-a',
      capabilities: getCachedWindowsTerminalCapabilities('runtime:host-a')
    }

    expect(
      selectWindowsTerminalCapabilitiesForOwner(previousOwnerState, true, 'runtime:host-b')
    ).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })

  it('keeps Git Bash unavailable when the Git Bash path probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(false)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    const isGitBashAvailable = vi.fn().mockRejectedValue(new Error('git bash probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: isGitBashAvailable },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
  })
})
