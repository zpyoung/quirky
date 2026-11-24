import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveQuirkyAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveQuirkyAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/quirky-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveQuirkyAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('quirky cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveQuirkyAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('starts a foreground headless server through `serve`', async () => {
    serveQuirkyAppMock.mockResolvedValue(0)
    process.env.QUIRKY_ENVIRONMENT = 'stale-env'

    await main(
      ['serve', '--json', '--port', '6768', '--pairing-address', '100.64.1.20', '--no-pairing'],
      '/tmp/repo'
    )

    expect(serveQuirkyAppMock).toHaveBeenCalledWith({
      json: true,
      port: '6768',
      pairingAddress: '100.64.1.20',
      noPairing: true,
      mobilePairing: false,
      grantDesktopControl: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it.skipIf(process.platform === 'win32')(
    'turns on supervision only for an explicit --supervise, and never with --recipe-json',
    async () => {
      serveQuirkyAppMock.mockResolvedValue(0)

      await main(['serve', '--supervise', '--no-pairing'], '/tmp/repo')
      expect(serveQuirkyAppMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ supervise: true, noPairing: true })
      )

      await main(['serve', '--no-pairing'], '/tmp/repo')
      expect(serveQuirkyAppMock.mock.lastCall?.[0]).not.toHaveProperty('supervise')

      serveQuirkyAppMock.mockClear()
      await main(
        ['serve', '--supervise', '--recipe-json', '--project-root', '/workspace/repo'],
        '/tmp/repo'
      )
      expect(serveQuirkyAppMock).not.toHaveBeenCalled()
    }
  )

  it('forwards the pairing-time desktop-control grant', async () => {
    serveQuirkyAppMock.mockResolvedValue(0)

    await main(['serve', '--grant-desktop-control'], '/tmp/repo')

    expect(serveQuirkyAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ grantDesktopControl: true, mobilePairing: false })
    )
  })

  it('starts a foreground headless server with mobile pairing enabled', async () => {
    serveQuirkyAppMock.mockResolvedValue(0)

    await main(
      ['serve', '--pairing-address', '100.64.1.20', '--mobile-pairing', '--json'],
      '/tmp/repo'
    )

    expect(serveQuirkyAppMock).toHaveBeenCalledWith({
      json: true,
      port: null,
      pairingAddress: '100.64.1.20',
      noPairing: false,
      mobilePairing: true,
      grantDesktopControl: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it('starts a recipe JSON headless server for VM recipes', async () => {
    serveQuirkyAppMock.mockResolvedValue(0)

    await main(
      [
        'serve',
        '--pairing-address',
        'wss://sandbox.example.com',
        '--project-root',
        '/workspace/repo',
        '--recipe-json'
      ],
      '/tmp/repo'
    )

    expect(serveQuirkyAppMock).toHaveBeenCalledWith({
      json: false,
      port: null,
      pairingAddress: 'wss://sandbox.example.com',
      noPairing: false,
      mobilePairing: false,
      grantDesktopControl: false,
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
  })

  it('rejects recipe JSON output without a project root', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--recipe-json'], '/tmp/repo')

    expect(serveQuirkyAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Recipe JSON output requires --project-root.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects recipe JSON output with mobile pairing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['serve', '--recipe-json', '--project-root', '/workspace/repo', '--mobile-pairing'],
      '/tmp/repo'
    )

    expect(serveQuirkyAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects contradictory serve pairing flags', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--mobile-pairing', '--no-pairing', '--json'], '/tmp/repo')

    expect(serveQuirkyAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --mobile-pairing or --no-pairing, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects invalid serve ports before launching the app', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--port', 'not-a-port', '--json'], '/tmp/repo')

    expect(serveQuirkyAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Invalid --port value: not-a-port'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects value-less serve ports before launching the app', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--port', '--json'], '/tmp/repo')

    expect(serveQuirkyAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --port.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
