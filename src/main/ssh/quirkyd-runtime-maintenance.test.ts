import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { QUIRKYD_UPDATE_ADMISSION_FENCE_MS } from '../../shared/quirkyd-terminal-census'
import { recordManagedQuirkydMigration } from '../../shared/runtime-environment-managed-quirkyd-store'
import { quirkydMigrationCutoverFixture } from './quirkyd-migration-cutover-fixture'
import { writeQuirkydMigrationSourceCutover } from './quirkyd-migration-cutover-journal'
import {
  createManagedLifecycleHarness,
  MANAGED_PREVIOUS_VERSION,
  MANAGED_VERSION,
  managedReadiness
} from '../managed-server/lifecycle/quirkyd-managed-lifecycle-test-fixture'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    resolveContext: vi.fn(),
    census: vi.fn(),
    deploy: vi.fn(),
    rollback: vi.fn(),
    recover: vi.fn(),
    probe: vi.fn(),
    buildHash: vi.fn(),
    ensureTunnel: vi.fn(),
    rebuildTunnel: vi.fn(),
    wake: vi.fn(),
    pendingMigration: vi.fn()
  }
})

vi.mock('./targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: async () => ({}) }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('../managed-server/install/quirkyd-remote-context', () => ({
  resolveQuirkydRemoteContext: mocks.resolveContext
}))
vi.mock('./quirkyd-terminal-census-client', () => ({ collectManagedTerminalCensus: mocks.census }))
vi.mock('./quirkyd-remote-deploy', () => ({ deployQuirkyd: mocks.deploy }))
vi.mock('../managed-server/install/quirkyd-remote-rollback', () => ({
  rollbackQuirkyd: mocks.rollback
}))
vi.mock('../managed-server/activation/quirkyd-activation-recovery', () => ({
  recoverInterruptedQuirkydActivation: mocks.recover
}))
vi.mock('./quirkyd-active-readiness', () => ({ probeActiveQuirkydReadiness: mocks.probe }))
vi.mock('../managed-server/install/quirkyd-remote-build-hash', () => ({
  readRemoteQuirkydBuildHash: mocks.buildHash
}))
vi.mock('../quirkyd/quirkyd-artifact-materializer', () => ({
  materializeQuirkydArtifact: async () => '/local/quirkyd'
}))
vi.mock('./quirkyd-local-build-hash', () => ({ computeLocalQuirkydBuildHash: () => 'local-hash' }))
vi.mock('../managed-server/lifecycle/quirkyd-managed-tunnel', () => ({
  ensureQuirkydManagedTunnel: mocks.ensureTunnel,
  rebuildQuirkydManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('../managed-server/lifecycle/quirkyd-managed-wake', () => ({
  wakeStoppedManagedQuirkyd: mocks.wake
}))
vi.mock('../managed-server/lifecycle/quirkyd-managed-migration-status', () => ({
  findIncompleteManagedQuirkydMigration: mocks.pendingMigration
}))
vi.mock('../managed-server/activation/quirkyd-activation-transaction-store', () => ({
  readQuirkydActivationTransaction: async () => null
}))

const { getManagedQuirkydRuntimeStatus } =
  await import('../managed-server/lifecycle/quirkyd-runtime-status')
const {
  recoverManagedQuirkydEnvironment,
  rollbackManagedQuirkydEnvironment,
  updateManagedQuirkydEnvironment
} = await import('./quirkyd-runtime-maintenance')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
let harness: ReturnType<typeof createManagedLifecycleHarness>

beforeEach(() => {
  vi.resetAllMocks()
  harness = createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.resolveContext.mockImplementation(async () => harness.context())
  mocks.census.mockResolvedValue(idle)
  mocks.probe.mockResolvedValue(managedReadiness())
  mocks.buildHash.mockResolvedValue('previous-hash')
  mocks.recover.mockResolvedValue({ outcome: 'none' })
  mocks.wake.mockResolvedValue({ outcome: 'serving' })
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('updateManagedQuirkydEnvironment', () => {
  it('defers over live or unverifiable terminals and reports the deferral in status', async () => {
    mocks.census.mockResolvedValue({ ...idle, liveSessions: null })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.3.0+new',
      code: 'quirkyd_update_terminal_census_unavailable',
      reason: 'The terminal daemon did not answer a session count.'
    })
    const result = await updateManagedQuirkydEnvironment(harness.userDataPath, {
      selector: 'Managed'
    })
    expect(result).toMatchObject({ outcome: 'deferred', forceable: false })
    expect(mocks.deploy.mock.calls[0]?.[0]).toMatchObject({
      census: { liveSessions: null },
      port: 6_768,
      nodePath: ''
    })
    const status = await getManagedQuirkydRuntimeStatus(harness.userDataPath, 'Managed')
    expect(status.deferredUpdate).toMatchObject({
      candidateVersion: '0.3.0+new',
      code: 'quirkyd_update_terminal_census_unavailable'
    })
    expect(status.terminals.liveSessions).toBeNull()
  })

  it('clears the deferral once an update goes through and keeps an unchanged pairing as is', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.3.0+new',
      code: 'quirkyd_update_terminals_running',
      reason: 'busy'
    })
    await updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-and-activated',
      fullVersion: '0.3.0+new'
    })
    const result = await updateManagedQuirkydEnvironment(harness.userDataPath, {
      selector: 'Managed',
      force: true
    })
    expect(result).toMatchObject({ outcome: 'updated', activeVersion: '0.3.0+new' })
    expect(mocks.probe).toHaveBeenCalledWith(expect.anything(), {
      buildHash: 'local-hash',
      fullVersion: '0.3.0+new'
    })
    const [environment] = listEnvironments(harness.userDataPath)
    expect(environment?.pairingRevision).toBe(harness.environment.pairingRevision)
    expect(environment?.quirkydDeployment).toEqual(harness.environment.quirkydDeployment)
    const status = await getManagedQuirkydRuntimeStatus(harness.userDataPath, 'Managed')
    expect(status.deferredUpdate).toBeNull()
  })

  it('hands the deploy a recount that counts again, so a terminal opened during the upload counts', async () => {
    const opened = { ...idle, liveSessions: 1, inProcessSessions: 1 }
    mocks.census.mockResolvedValueOnce(idle).mockResolvedValue(opened)
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    await updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    const deployed = mocks.deploy.mock.calls[0]?.[0]
    expect(deployed?.recountCensus).toBeTypeOf('function')
    await expect(deployed!.recountCensus()).resolves.toEqual(opened)
    // Only the last count closes the server's terminal admission; the first precedes the upload.
    expect(mocks.census.mock.calls.map((call) => call[4])).toEqual([
      { releaseFinishedAutomationTerminals: true },
      {
        releaseFinishedAutomationTerminals: true,
        closeAdmissionForMs: QUIRKYD_UPDATE_ADMISSION_FENCE_MS
      }
    ])
    await deployed!.releaseIncumbentAdmission()
    expect(mocks.census.mock.calls[2]?.[4]).toEqual({ closeAdmissionForMs: 0 })
  })

  it('forwards anew after an activation, since the new slot may bind another port', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    await updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith(harness.userDataPath, 'environment-1')
  })

  it('still reports the activation when the new forward cannot be built yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    mocks.rebuildTunnel.mockRejectedValueOnce(new Error('ssh connect failed'))
    await expect(
      updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'updated', activeVersion: 'v3' })
  })

  it('re-pairs through the same tunnel, keeping the deployment link, when the offer changed', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    mocks.probe.mockResolvedValueOnce(managedReadiness('rotated-token'))
    await updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    const [environment] = listEnvironments(harness.userDataPath)
    expect(environment?.endpoints[0]?.deviceToken).toBe('rotated-token')
    expect(environment?.quirkydDeployment).toEqual(harness.environment.quirkydDeployment)
  })
})

describe('updateManagedQuirkydEnvironment on a host already running this build', () => {
  beforeEach(() => {
    mocks.deploy.mockResolvedValue({ outcome: 'already-active', fullVersion: MANAGED_VERSION })
  })

  it('starts a slot proven stopped and forwards to the port it bound', async () => {
    mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: managedReadiness() })
    await expect(
      updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'already-current', activeVersion: MANAGED_VERSION })
    expect(mocks.wake.mock.calls[0]?.[0]).toMatchObject({ port: 6_768 })
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith(harness.userDataPath, 'environment-1')
  })

  it.each(['serving', 'unverifiable', 'fenced'] as const)(
    'leaves a %s slot alone and keeps the tunnel',
    async (outcome) => {
      mocks.wake.mockResolvedValueOnce({ outcome })
      await updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
      expect(mocks.rebuildTunnel).not.toHaveBeenCalled()
    }
  )

  it('does not wake after an activation, which launched the new slot itself', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    await updateManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    expect(mocks.wake).not.toHaveBeenCalled()
  })
})

describe('rollbackManagedQuirkydEnvironment', () => {
  it.each([
    [{ ...idle, liveSessions: 2 }, 'quirkyd_rollback_terminals_running'],
    [{ ...idle, liveSessions: null }, 'quirkyd_rollback_census_unavailable']
  ])('refuses while terminals run or cannot be counted: %j', async (census, code) => {
    mocks.census.mockResolvedValue(census)
    await expect(
      rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('refuses with no previous version without contacting the slot', async () => {
    mocks.resolveContext.mockImplementation(async () => harness.context({ previous: null }))
    await expect(
      rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'quirkyd_rollback_no_target' })
    expect(mocks.census).not.toHaveBeenCalled()
  })

  it('refuses while a migration into the server is unfinished', async () => {
    mocks.pendingMigration.mockReturnValueOnce({ migrationId: 'm-1', phase: 'destination-staged' })
    await expect(
      rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'quirkyd_rollback_migration_in_progress' })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('refuses a rollback to a snapshot older than the migrated catalog, not a newer one', async () => {
    // The harness's active version activated 2026-01-01.
    recordManagedQuirkydMigration(harness.userDataPath, 'environment-1', '2026-02-01T00:00:00.000Z')
    await expect(
      rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'quirkyd_rollback_crosses_migration' })
    expect(mocks.rollback).not.toHaveBeenCalled()
    mocks.resolveContext.mockImplementation(async () =>
      harness.context({ activatedAt: '2026-03-01T00:00:00.000Z' })
    )
    mocks.rollback.mockResolvedValueOnce({ outcome: 'refused', code: 'x', reason: 'y' })
    await rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    expect(mocks.rollback).toHaveBeenCalledOnce()
  })

  it('refuses a rollback across a retained delta move that predates the mark', async () => {
    // A delta finished by an earlier build left no mark; its retained journal still counts.
    writeQuirkydMigrationSourceCutover(harness.userDataPath, {
      ...quirkydMigrationCutoverFixture('delta-1', 'ssh-1', { environmentId: 'environment-1' }),
      startedAt: '2026-02-01T00:00:00.000Z',
      phase: 'destination-committed',
      sourceRetainedAt: '2026-02-01T00:00:00.000Z'
    })
    await expect(
      rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'quirkyd_rollback_crosses_migration' })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('rolls back against the installed bytes of the previous slot', async () => {
    mocks.rollback.mockResolvedValueOnce({
      outcome: 'rolled-back',
      target: MANAGED_PREVIOUS_VERSION,
      discarded: [MANAGED_VERSION],
      verdict: { decision: 'activate', coverage: 'pty-spawn', warnings: [] }
    })
    await expect(
      rollbackManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'rolled-back', activeVersion: MANAGED_PREVIOUS_VERSION })
    expect(mocks.rollback.mock.calls[0]?.[0]).toMatchObject({ targetBuildHash: 'previous-hash' })
    expect(mocks.probe).toHaveBeenCalledWith(expect.anything(), {
      buildHash: 'previous-hash',
      fullVersion: MANAGED_PREVIOUS_VERSION
    })
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith(harness.userDataPath, 'environment-1')
  })
})

describe('recoverManagedQuirkydEnvironment', () => {
  it('passes a refusal through and leaves the server linked', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'quirkyd_recovery_unverifiable',
      reason: 'host fenced'
    })
    await expect(
      recoverManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(listEnvironments(harness.userDataPath)).toHaveLength(1)
  })

  it('forwards anew once a serving slot is restored, which may have bound another port', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: MANAGED_VERSION,
      readiness: managedReadiness()
    })
    await expect(
      recoverManagedQuirkydEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'recovered', activeVersion: MANAGED_VERSION })
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith(harness.userDataPath, 'environment-1')
  })
})
