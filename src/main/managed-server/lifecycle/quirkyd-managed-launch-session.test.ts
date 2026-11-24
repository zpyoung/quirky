import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const mocks = vi.hoisted(() => {
  const host: { current: RemoteHostPlatform | null } = { current: null }
  const active: { current: string | null } = { current: '1.0.0' }
  return {
    census: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn(),
    rebuild: vi.fn(async () => {}),
    exec: vi.fn(),
    retain: vi.fn(),
    host,
    active
  }
})

vi.mock('../../ssh/quirkyd-runtime-maintenance', () => ({
  withManagedQuirkydLifecycle: (
    _path: string,
    _selector: string,
    run: (managed: unknown) => Promise<unknown>
  ) => run({ environment: { id: 'env-1' }, deployment: { remotePort: 7777 } })
}))
vi.mock('./quirkyd-managed-runtime-context', () => ({
  requireManagedQuirkydEnvironment: () => ({
    environment: { id: 'env-1' },
    deployment: { remotePort: 7777 }
  }),
  resolveLinkedQuirkydContext: async () => ({
    host: mocks.host.current,
    connection: {},
    remoteHome: '/Users/dev',
    activationRecord: { active: mocks.active.current }
  }),
  requireManagedQuirkydInfrastructure: () => ({
    connectionManager: {
      getState: () => ({ status: 'connected' }),
      getConnection: () => ({})
    },
    targetStore: { getTarget: () => ({ id: 'ssh-1' }) }
  }),
  managedQuirkydSlot: () => ({
    host: mocks.host.current,
    remoteHome: '/Users/dev',
    userDataDir: '/Users/dev/.quirky'
  }),
  managedQuirkydInstallDir: () => '/Users/dev/.quirky-remote/quirkyd-1.0.0'
}))
vi.mock('../install/quirkyd-remote-context', () => ({
  resolveQuirkydRemoteContext: async () => ({
    host: mocks.host.current,
    connection: {},
    remoteHome: '/Users/dev',
    userDataDir: '/Users/dev/.quirky',
    activationRecord: { active: mocks.active.current }
  })
}))
vi.mock('../../ssh/quirkyd-ssh-host-transport', () => ({
  sshQuirkydHostTransport: (c: unknown) => c
}))
vi.mock('../activation/quirkyd-activation-lock', () => ({
  withQuirkydActivationLock: (_slot: unknown, run: (lock: unknown) => Promise<unknown>) =>
    run({ retain: mocks.retain })
}))
vi.mock('../activation/quirkyd-activation-record-store', () => ({
  readQuirkydActivationRecord: async () => ({ active: mocks.active.current })
}))
vi.mock('./quirkyd-managed-remote-stop', () => ({
  readRemoteQuirkydManagedStopTarget: async () => ({
    state: 'ready',
    context: { version: '1.0.0' }
  })
}))
vi.mock('./quirkyd-rollback-terminal-barrier', () => ({
  stopIncumbentBehindTerminalBarrier: mocks.stop
}))
vi.mock('./quirkyd-managed-wake', () => ({ wakeStoppedManagedQuirkyd: mocks.wake }))
vi.mock('./quirkyd-managed-tunnel', () => ({ rebuildQuirkydManagedTunnel: mocks.rebuild }))
vi.mock('../../ssh/quirkyd-terminal-census-client', () => ({
  collectManagedTerminalCensus: mocks.census
}))
vi.mock('../install/quirkyd-remote-runtime-control', () => ({
  execQuirkydRemote: mocks.exec
}))

const { readManagedQuirkydLaunchSshSession, restartManagedQuirkydEnvironment } =
  await import('./quirkyd-managed-launch-session')

const census = (liveSessions: number | null) => ({
  liveSessions,
  startedSinceActivation: liveSessions,
  daemonProtocolVersion: 1
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.host.current = getRemoteHostPlatform('darwin-arm64')
  mocks.active.current = '1.0.0'
  mocks.stop.mockResolvedValue({ state: 'retired' })
  mocks.exec.mockResolvedValue('')
  mocks.wake.mockResolvedValue({ outcome: 'started', readiness: {} })
})

describe('restartManagedQuirkydEnvironment', () => {
  it.each([2, null])(
    'never stops a server while terminals run or are uncounted (%s)',
    async (n) => {
      mocks.census.mockResolvedValue(census(n))
      await expect(restartManagedQuirkydEnvironment('/u', 'env-1')).resolves.toEqual({
        outcome: 'terminals-running',
        liveSessions: n
      })
      expect(mocks.stop).not.toHaveBeenCalled()
      expect(mocks.wake).not.toHaveBeenCalled()
    }
  )

  it('stops, starts from this session and follows the new port', async () => {
    mocks.census.mockResolvedValue(census(0))
    await expect(restartManagedQuirkydEnvironment('/u', 'env-1')).resolves.toEqual({
      outcome: 'restarted',
      environmentId: 'env-1'
    })
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('does not claim recovery when the restart’s own SSH session already ended', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.exec.mockImplementation(async (_slot: unknown, command: string) =>
      command.includes('sw_vers') ? 'EXITED\n' : ''
    )
    const result = await restartManagedQuirkydEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
  })

  it('keeps the fence when the stop may still be running', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    await restartManagedQuirkydEnvironment('/u', 'env-1')
    expect(mocks.retain).toHaveBeenCalledOnce()
  })

  it('leaves a server it could not prove stopped running', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    const result = await restartManagedQuirkydEnvironment('/u', 'env-1')
    expect(result).toEqual({ outcome: 'not-restarted', reason: 'still stopping' })
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('starts the server again but keeps the warning when the daemon was not retired', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unproven', reason: 'a terminal started' })
    const result = await restartManagedQuirkydEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledOnce()
  })
})

describe('readManagedQuirkydLaunchSshSession', () => {
  it('probes a macOS host’s active slot', async () => {
    mocks.exec.mockResolvedValue('EXITED\n')
    await expect(readManagedQuirkydLaunchSshSession('/u', 'env-1')).resolves.toBe('exited')
  })

  it('runs nothing on a Linux host', async () => {
    mocks.host.current = getRemoteHostPlatform('linux-x64')
    await expect(readManagedQuirkydLaunchSshSession('/u', 'env-1')).resolves.toBe('not-applicable')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
