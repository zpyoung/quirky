import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ServingModule from '../../managed-server/lifecycle/quirkyd-managed-serving'
import type { ManagedQuirkydStartListener } from '../../managed-server/lifecycle/quirkyd-managed-serving'
import type { SshTarget } from '../../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const startListener: { current: ManagedQuirkydStartListener | null } = { current: null }
  const environments: Record<string, Record<string, unknown>> = {}
  const reads: Record<string, number> = {}
  return {
    environments,
    reads,
    ensureTunnel: vi.fn(async () => {}),
    rebuildTunnel: vi.fn(async () => {}),
    verify: vi.fn(),
    restoreUpdate: vi.fn(() => null),
    redeploy: vi.fn(async () => true),
    forgetVerdict: vi.fn(),
    startListener
  }
})

vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userData: string, id: string) => {
    const environment = mocks.environments[id]
    if (!environment) {
      return { id, quirkydDeployment: { sshTargetId: 'ssh-1' } }
    }
    mocks.reads[id] = (mocks.reads[id] ?? 0) + 1
    // A fresh object per read, so a test can tell the re-read after bring-up from the first.
    return { ...environment, read: mocks.reads[id] }
  }
}))
vi.mock('../../ssh/managed-server-update-deps', () => ({ managedServerUpdateDeps: () => ({}) }))
vi.mock('../../managed-server/lifecycle/quirkyd-managed-tunnel', () => ({
  ensureQuirkydManagedTunnel: mocks.ensureTunnel,
  rebuildQuirkydManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('../../managed-server/lifecycle/quirkyd-managed-serving-verify', () => ({
  verifyQuirkydManagedServing: mocks.verify
}))
vi.mock('../../managed-server/lifecycle/quirkyd-managed-update-on-restore', () => ({
  updateManagedQuirkydOnRestore: mocks.restoreUpdate,
  redeployStoppedManagedQuirkyd: mocks.redeploy
}))
vi.mock('../../ssh/ssh-host-server-status', () => ({ setSshHostServerStatus: vi.fn() }))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => null }))
vi.mock('../ssh/ssh-ipc-context', () => ({
  connectionManager: null,
  getCurrentMainWindow: () => null
}))
vi.mock('../ssh/ssh-renderer-broadcast', () => ({ broadcastSshState: vi.fn() }))
vi.mock('../ssh/ssh-host-launch-session-note', () => ({
  forgetLaunchSessionVerdict: mocks.forgetVerdict
}))
vi.mock('../../managed-server/lifecycle/quirkyd-managed-serving', async (importOriginal) => ({
  ...(await importOriginal<typeof ServingModule>()),
  setManagedQuirkydStartListener: (listener: ManagedQuirkydStartListener | null) => {
    mocks.startListener.current = listener
  }
}))

import { MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL } from '../../managed-server/lifecycle/quirkyd-managed-serving'
import {
  installManagedQuirkydStartStatus,
  resolveManagedRuntimeEnvironment
} from './runtime-environment-managed-tunnel'

describe('resolving a managed runtime for a call', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redeploys, before the call, a server another desktop stopped mid-session', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).toHaveBeenCalledWith('env-1', expect.any(Function))
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
    // The forward is rebuilt for the port the redeployed server bound, not reused.
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('forgets a cached ended launch session once this client redeployed the server', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.forgetVerdict).toHaveBeenCalledWith('ssh-1')
    expect(mocks.forgetVerdict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rebuildTunnel.mock.invocationCallOrder[0]
    )
  })

  it('keeps the verdict when the redeploy did not start a server', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL
    })
    mocks.redeploy.mockResolvedValueOnce(false)
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.forgetVerdict).not.toHaveBeenCalled()
  })

  it('leaves a serving server to the once-per-session update check', async () => {
    mocks.verify.mockResolvedValue({ state: 'serving' })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('env-1', expect.any(Function))
  })
})

describe('resolving a runtime for a call', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const id of Object.keys(mocks.reads)) {
      delete mocks.reads[id]
    }
    mocks.environments = { 'paired-1': { id: 'paired-1' } }
    mocks.verify.mockResolvedValue({ state: 'serving' })
  })

  it('runs the managed tunnel path for a paired server too', async () => {
    await expect(resolveManagedRuntimeEnvironment('/u', 'paired-1')).resolves.toEqual({
      id: 'paired-1',
      read: 2
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.verify).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('paired-1', expect.any(Function))
  })
})

describe('a managed server start shown on the status line', () => {
  const target: SshTarget = { id: 'ssh-1', label: 'mac', host: 'mac', port: 22, username: 'u' }

  beforeEach(() => {
    vi.clearAllMocks()
    installManagedQuirkydStartStatus()
  })

  it('forgets a cached ended launch session once this client started the server', async () => {
    mocks.startListener.current?.settled(target, 'env-1', { state: 'started', boundPort: 1 })
    await vi.waitFor(() => expect(mocks.forgetVerdict).toHaveBeenCalledWith('ssh-1'))
  })

  it('keeps the verdict when no start happened', async () => {
    mocks.startListener.current?.settled(target, 'env-1', { state: 'unverifiable', detail: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.forgetVerdict).not.toHaveBeenCalled()
  })
})
