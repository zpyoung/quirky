import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'
import { bindQuirkydIdleShutdown, beginQuirkydIdleExit } from './quirkyd-managed-idle-exit-host'
import { installQuirkydManagedIdleExit } from './quirkyd-managed-idle-exit'
import type * as ManagedIdleExit from './quirkyd-managed-idle-exit'
import type * as DaemonProviderState from '../daemon/daemon-provider-state'
import { retireQuirkydDaemonIfIdle } from './quirkyd-daemon-retirement'
import { discardQuirkydIdleStopRecord } from './quirkyd-idle-stop-record'
import { restartDaemon } from '../daemon/daemon-provider-restart'

const { hasLoadedProviders } = vi.hoisted(() => ({ hasLoadedProviders: vi.fn(() => false) }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders })
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: () => ({ listProcesses: async () => [] })
}))
vi.mock('../daemon/daemon-init', () => ({ getDaemonEndpointFacts: () => null }))
vi.mock('./quirkyd-daemon-retirement', () => ({
  countLiveQuirkydDaemonSessions: vi.fn(async () => 0),
  retireQuirkydDaemonIfIdle: vi.fn()
}))
vi.mock('../daemon/daemon-provider-state', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonProviderState>()),
  getCurrentDaemonPid: () => 4242
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: vi.fn(async () => ({})) }))
vi.mock('./quirkyd-idle-stop-record', () => ({
  consumeQuirkydIdleStopRecord: vi.fn(() => null),
  discardQuirkydIdleStopRecord: vi.fn(),
  writeQuirkydIdleStopRecord: vi.fn()
}))
vi.mock('./quirkyd-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installQuirkydManagedIdleExit: vi.fn(() => () => {})
}))

beforeEach(() => {
  vi.clearAllMocks()
  hasLoadedProviders.mockReturnValue(false)
  vi.stubEnv(QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV, 'test-fence')
})

afterEach(() => vi.unstubAllEnvs())

it.each(['provider', 'client', 'request', 'recent request'])(
  'rechecks a returning %s after daemon retirement before requesting an idle shutdown',
  async (returning) => {
    const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
    const retire = Promise.withResolvers<{ retirement: string; reason: null }>()
    vi.mocked(retireQuirkydDaemonIfIdle).mockImplementationOnce(async () => ({
      ...(await retire.promise),
      retirement: 'retired',
      liveSessions: 0
    }))
    const shutdown = vi.fn(() => true)
    bindQuirkydIdleShutdown(shutdown)
    await beginQuirkydIdleExit('test-profile').start({
      rpc: {
        readClientActivity: () => activity
      },
      agentStates: () => [],
      hasStagedMigration: () => false,
      automationsBusy: () => false,
      registerCleanup: () => {}
    })
    const installed = vi.mocked(installQuirkydManagedIdleExit).mock.calls.at(-1)?.[0]
    if (!installed) {
      throw new Error('idle monitor was not installed')
    }
    const stopping = installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
    hasLoadedProviders.mockReturnValue(returning === 'provider')
    activity.openConnections = returning === 'client' ? 1 : 0
    activity.requestsInFlight = returning === 'request' ? 1 : 0
    activity.lastRequestAt = returning === 'recent request' ? 1 : 0
    retire.resolve({ retirement: 'retired', reason: null })

    expect(await stopping).toBe(false)
    expect(shutdown).not.toHaveBeenCalled()
    expect(discardQuirkydIdleStopRecord).toHaveBeenCalledWith('test-profile')
    // The retired daemon is replaced so the server that stays can still open terminals.
    expect(restartDaemon).toHaveBeenCalledOnce()
  }
)
