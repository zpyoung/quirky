import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindOrchestrationSubmissionPreflight } from '../../../../fork-heimdall/orchestration/submission-preflight'
import { RuntimeHeimdallOrchestrationAdapter } from '../../../../fork-heimdall/orchestration/orchestration-adapter'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
} from '../../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import type { WatcherEnrollment } from '../../../../../shared/fork-heimdall/watcher-types'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { OrchestrationDb } from '../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../orchestration/environment-transport'
import { getOrchestrationPeerCapabilityCache } from '../../../orchestration/orchestration-peer-capability-cache'
import { RpcDispatcher } from '../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { createFederationWorkerStartRequest } from '../orchestration/federation/federation-request.test-support'

const REJECTION = {
  status: 'rejected' as const,
  code: 'heimdall_submission_rejected',
  reason: 'Correct the watcher report before resubmitting this active Dispatch.'
}
const ACCEPTED = { status: 'accepted' as const }
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function enrollmentForRun(runId: string): WatcherEnrollment {
  return {
    watcherId: 'watcher-legacy-federated',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'repo-1::/repo',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: {
      handle: 'term_coord',
      paneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    },
    orchestrationRunId: runId,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

describe('Heimdall federated submission preflight', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: QuirkyRuntimeService
  let workerRuntime: QuirkyRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let failNextAcknowledgmentBeforeDelivery: boolean
  let workerCapabilities: string[]
  let statusRuntimeEpoch: string | undefined

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new QuirkyRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    failNextAcknowledgmentBeforeDelivery = false
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    statusRuntimeEpoch = undefined

    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              ...workerRuntime.getStatus(),
              capabilities: workerCapabilities,
              runtimeId: statusRuntimeEpoch ?? workerRuntime.getRuntimeId()
            },
            _meta: { runtimeId: statusRuntimeEpoch ?? workerRuntime.getRuntimeId() }
          }
        }
        if (method === 'orchestration.federationAck' && failNextAcknowledgmentBeforeDelivery) {
          failNextAcknowledgmentBeforeDelivery = false
          throw new Error('connection lost before acknowledgment')
        }
        return await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        })
      }
    }
    homeRuntime = new QuirkyRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })

    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    vi.spyOn(workerRuntime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(workerRuntime, 'showRepo').mockResolvedValue({
      id: 'windows-repo',
      path: '/repo',
      displayName: 'windows-repo',
      badgeColor: '#000000',
      addedAt: 0,
      kind: 'git'
    })
    vi.spyOn(workerRuntime, 'createManagedWorktree').mockResolvedValue({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of Worktree; only the id/repoId fields this suite reads are populated.
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' } as never,
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'start-immediately',
        state: 'running'
      }
    })
    vi.spyOn(workerRuntime, 'listTerminals').mockResolvedValue({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of RuntimeTerminalSummary; only handle/title, which this suite reads, are populated.
      terminals: [{ handle: 'term_windows_worker', title: 'Codex' }] as never,
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(workerRuntime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockReturnValue(WORKER_PANE)
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockReturnValue(
      'windows_runtime:pty:1'
    )
    vi.spyOn(workerRuntime, 'getTerminalOrchestrationCliCommand').mockReturnValue('quirky')
    vi.spyOn(workerRuntime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_windows_worker',
      accepted: true,
      bytesWritten: 1
    })
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    workerRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  it('preserves a rejected replay and settles only the corrected new submission', async () => {
    const run = homeDb.createRun({
      objective: 'Federated watcher work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = homeDb.createTask({ spec: 'Produce a remote watcher report', runId: run.id })
    await homeDispatcher.dispatch(createFederationWorkerStartRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()

    const dispatch = homeDb.getDispatchContext(task.id)
    if (!dispatch) {
      throw new Error('Federated fixture did not create a Dispatch')
    }
    const preflight = vi.fn().mockResolvedValueOnce(REJECTION).mockResolvedValue(ACCEPTED)
    bindOrchestrationSubmissionPreflight(homeRuntime, preflight)

    const submit = (requestId: string): Promise<RuntimeRpcResponse<unknown>> =>
      workerDispatcher.dispatch({
        id: `rpc_${requestId}`,
        authToken: 'worker-local-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: requestId,
        method: 'orchestration.send',
        params: {
          from: 'term_windows_worker',
          subject: 'Remote watcher work complete',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded'
          })
        }
      })

    const rejected = submit('remote_watcher_report_rejected')
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    const rejectedRelay = workerDb.listPendingFederationRelay(dispatch.id, 'to_home')[0]
    if (!rejectedRelay) {
      throw new Error('Federated fixture did not queue the rejected relay')
    }
    failNextAcknowledgmentBeforeDelivery = true

    await expect(homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)).rejects.toThrow(
      'connection lost before acknowledgment'
    )
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
    expect(homeDb.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toEqual([
      expect.objectContaining({
        message_id: rejectedRelay.message_id,
        sequence: rejectedRelay.sequence
      })
    ])

    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)
    await expect(rejected).resolves.toMatchObject({
      ok: true,
      result: {
        lifecycle: {
          action: 'rejected',
          code: REJECTION.code,
          reason: expect.any(String),
          authority: 'run_home'
        }
      }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
    expect(homeDb.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(0)
    const accepted = submit('remote_watcher_report_corrected')
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    const acceptedRelay = workerDb.listPendingFederationRelay(dispatch.id, 'to_home')[0]
    if (!acceptedRelay) {
      throw new Error('Federated fixture did not queue the corrected relay')
    }
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

    await expect(accepted).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed', authority: 'run_home' } }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('completed')
    expect(homeDb.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('succeeded')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(0)
    expect(preflight).toHaveBeenCalledTimes(2)
    expect(JSON.parse(homeDb.getTask(task.id)?.result ?? 'null')).toMatchObject({
      provenance: 'worker_report',
      outcome: 'succeeded',
      messageId: acceptedRelay.message_id,
      body: '',
      reportPath: null,
      filesModified: []
    })
    expect(homeDb.getAttemptObservationFacts(dispatch.id)).toEqual([
      expect.objectContaining({
        id: `worker_report:${acceptedRelay.message_id}`,
        dispatchId: dispatch.id,
        taskId: task.id,
        authorityId: `run_home:${run.id}`,
        facet: 'worker_report',
        payload: {
          status: 'accepted',
          outcome: 'succeeded',
          reportId: `worker_report:${acceptedRelay.message_id}`
        }
      })
    ])
  })

  it('does not promise corrective resend from a capability answer for a superseded peer epoch', async () => {
    const run = homeDb.createRun({
      objective: 'Epoch-fenced federated watcher work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = homeDb.createTask({ spec: 'Produce an epoch-fenced report', runId: run.id })
    await homeDispatcher.dispatch(createFederationWorkerStartRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)
    if (!dispatch) {
      throw new Error('Federated fixture did not create a Dispatch')
    }
    const preflight = vi.fn().mockResolvedValue(REJECTION)
    bindOrchestrationSubmissionPreflight(homeRuntime, preflight)
    const sent = workerDispatcher.dispatch({
      id: 'rpc_epoch_fenced_rejected_report',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'epoch_fenced_rejected_report',
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Epoch-fenced report',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    statusRuntimeEpoch = 'superseded-worker-runtime-epoch'
    getOrchestrationPeerCapabilityCache(homeRuntime).observeEpoch(
      'windows_peer_fingerprint',
      statusRuntimeEpoch
    )

    await expect(homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)).rejects.toThrow(
      'changed runtime epoch'
    )
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
    expect(homeDb.getInbox(100)).toHaveLength(0)
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)

    statusRuntimeEpoch = undefined
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

    await expect(sent).resolves.toMatchObject({
      ok: true,
      result: {
        lifecycle: {
          action: 'rejected',
          code: REJECTION.code,
          authority: 'run_home'
        }
      }
    })
    expect(preflight).toHaveBeenCalledTimes(2)
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
  })

  it.each([1, 2] as const)(
    'terminally fails a rejected protocol v%s report instead of promising an impossible same-Dispatch resend',
    async (protocolVersion) => {
      workerCapabilities = workerCapabilities.filter(
        (capability) =>
          capability !== ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY &&
          (protocolVersion === 2 ||
            capability !== ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY)
      )
      const run = homeDb.createRun({
        objective: 'Legacy federated watcher work',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const task = homeDb.createTask({
        spec: 'Produce a legacy remote watcher report',
        runId: run.id
      })
      await homeDispatcher.dispatch(createFederationWorkerStartRequest(task.id))
      homeRuntime.stopOrchestrationFederationRelay()
      const dispatch = homeDb.getDispatchContext(task.id)
      if (!dispatch) {
        throw new Error('Federated fixture did not create a Dispatch')
      }
      expect(homeDb.getFederatedDispatch(dispatch.id)?.protocol_version).toBe(protocolVersion)
      const preflight = vi.fn().mockResolvedValue(REJECTION)
      bindOrchestrationSubmissionPreflight(homeRuntime, preflight)

      const sent = await workerDispatcher.dispatch({
        id: `rpc_legacy_protocol_${protocolVersion}_rejected_report`,
        authToken: 'worker-local-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: `legacy_protocol_${protocolVersion}_rejected_report`,
        method: 'orchestration.send',
        params: {
          from: 'term_windows_worker',
          subject: 'Legacy remote watcher work complete',
          body: 'The worker claimed success before Run-home validation.',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded',
            reportPath: '.quirky/heimdall/report.json',
            filesModified: ['src/legacy.ts'],
            additiveFutureField: { schema: 4 }
          })
        }
      })
      const [relay] = workerDb.listPendingFederationRelay(dispatch.id, 'to_home')
      if (!relay) {
        throw new Error('Legacy worker did not queue its terminal report')
      }

      expect(sent).toMatchObject({
        ok: true,
        result: {
          lifecycle: { action: 'completed', authority: 'worker_server_legacy' }
        }
      })
      expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
      expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('succeeded')

      await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)
      const result: Record<string, unknown> = JSON.parse(homeDb.getTask(task.id)?.result ?? 'null')
      const imported = homeDb.getMessageById(relay.message_id)

      expect(homeDb.getTask(task.id)?.status).toBe('failed')
      expect(homeDb.getDispatchContextById(dispatch.id)?.status).toBe('failed')
      expect(result).toMatchObject({
        provenance: 'worker_report_rejected',
        outcome: 'failed',
        reportedOutcome: 'succeeded',
        messageId: relay.message_id,
        body: 'The worker claimed success before Run-home validation.',
        reportPath: '.quirky/heimdall/report.json',
        filesModified: ['src/legacy.ts'],
        preflightRejection: {
          code: REJECTION.code,
          reason: REJECTION.reason,
          correctiveResendAvailable: false
        },
        correction: { kind: 'fresh_dispatch_required_after_operator_review' }
      })
      expect(imported).toMatchObject({
        type: 'worker_done',
        subject: expect.stringContaining('Rejected worker_done')
      })
      expect(JSON.parse(imported?.payload ?? 'null')).toMatchObject({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        additiveFutureField: { schema: 4 },
        _quirkyLifecycleRejection: {
          code: REJECTION.code,
          reason: expect.stringContaining('No same-Dispatch correction is available'),
          originalReason: REJECTION.reason,
          originalBody: 'The worker claimed success before Run-home validation.'
        }
      })
      expect(homeDb.getAttemptObservationFacts(dispatch.id)).toEqual([
        expect.objectContaining({
          id: `worker_report:${relay.message_id}`,
          dispatchId: dispatch.id,
          authorityId: `run_home:${run.id}`,
          authorityClock: 'home',
          facet: 'worker_report',
          homeReceivedAt: Date.parse(imported?.created_at ?? ''),
          payload: {
            status: 'rejected',
            reason: REJECTION.reason,
            reportId: `worker_report:${relay.message_id}`
          }
        })
      ])
      const adapter = new RuntimeHeimdallOrchestrationAdapter(homeRuntime, {
        persistOrchestrationRunId: async () => undefined
      })
      const recovered = await adapter.readAuthoritativeWorkerReport(
        enrollmentForRun(run.id),
        dispatch.id
      )
      expect(recovered).toMatchObject({
        eventId: `orchestration-mail:${relay.message_id}`,
        payload: {
          type: 'worker_done',
          payload: {
            dispatchId: dispatch.id,
            taskId: task.id,
            outcome: 'failed',
            reportPath: '.quirky/heimdall/report.json',
            filesModified: ['src/legacy.ts'],
            reportRejection: {
              code: REJECTION.code,
              reason: REJECTION.reason
            },
            result: {
              body: 'The worker claimed success before Run-home validation.',
              reportRejection: {
                code: REJECTION.code,
                reason: REJECTION.reason
              }
            }
          }
        }
      })
      expect(recovered).not.toHaveProperty('source')
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(0)
      await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)
      expect(preflight).toHaveBeenCalledTimes(1)
      expect(homeDb.getTask(task.id)?.result).toBe(JSON.stringify(result))
    }
  )
})
