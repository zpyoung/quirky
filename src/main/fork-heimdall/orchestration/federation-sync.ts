// Forked from src/main/runtime/orchestration/federation-sync.ts at 67fe1e14b61ed44b0c4e9d661bc66429917b0cc2.
import { z } from 'zod'
import type { FederationRuntime } from '../../runtime/orchestration/federation-runtime'
import type { FederatedLifecycleSettlement } from '../../runtime/orchestration/federation-lifecycle-settlement'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import {
  acquireFederationAckLease,
  getFederationAckedThrough,
  recordFederationAckCheckpoint
} from '../../runtime/orchestration/federation-ack-checkpoints'
import { bindCoordinatorMutationPayload } from '../../runtime/orchestration/dispatch-message-binding'
import { resolveFederatedLifecycleSettlementCapability } from '../../runtime/orchestration/federation-sync-capability'
import { getOrchestrationPeerCapabilityCache } from '../../runtime/orchestration/orchestration-peer-capability-cache'
import {
  parseFederatedLifecycle,
  parseRelayedMessage
} from '../../runtime/orchestration/federation-sync-message'
import { preflightFederatedHeimdallSubmission } from './submission-preflight'
export { parseRelayedMessage } from '../../runtime/orchestration/federation-sync-message'

const FEDERATION_PULL_PAGE_SIZE = 50
const MAX_FEDERATION_PULL_PAGES_PER_SYNC = 6

// Peer payloads are untrusted input: decode them so a malformed page fails as an
// orchestration error instead of a TypeError deep inside the import loop.
const PulledRelayPage = z
  .object({
    runtimeEpoch: z.string().min(1),
    items: z.array(
      z
        .object({
          dispatch_id: z.string(),
          direction: z.literal('to_home'),
          sequence: z.number(),
          message_id: z.string(),
          kind: z.string(),
          payload: z.string()
        })
        .passthrough()
    )
  })
  .passthrough()

export async function syncFederatedDispatch(
  runtime: FederationRuntime,
  dispatchId: string,
  isCurrent: () => boolean = () => true
): Promise<{ imported: number; acknowledgedThrough: number }> {
  return syncFederatedDispatchPages(
    runtime,
    dispatchId,
    MAX_FEDERATION_PULL_PAGES_PER_SYNC,
    isCurrent
  )
}

async function syncFederatedDispatchPages(
  runtime: FederationRuntime,
  dispatchId: string,
  remainingPages: number,
  isCurrent: () => boolean
): Promise<{ imported: number; acknowledgedThrough: number }> {
  if (!isCurrent()) {
    return { imported: 0, acknowledgedThrough: 0 }
  }
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!federated || !dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Dispatch ${dispatchId} was not found.`
    )
  }
  const currentServer = runtime.resolveOrchestrationWorkerServer(federated.environment_id)
  if (currentServer.peerFingerprint !== federated.peer_fingerprint) {
    throw new OrchestrationError(
      'peer_changed',
      `Saved environment ${federated.environment_name} now identifies a different Quirky server.`
    )
  }
  const ackLease = acquireFederationAckLease(runtime, dispatchId)
  const capability = await resolveFederatedLifecycleSettlementCapability(
    runtime,
    federated,
    currentServer.pairingRevision
  )
  const supportsLifecycleSettlement =
    federated.protocol_version >= ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION &&
    capability?.supported === true
  const shouldReplayUnacknowledged =
    supportsLifecycleSettlement ||
    (federated.protocol_version >= ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION &&
      (federated.to_home_acknowledged_sequence ?? 0) < federated.to_home_imported_sequence)

  const pulledResponse = await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationPull',
    {
      dispatchId,
      afterSequence: federated.to_home_imported_sequence,
      ...(shouldReplayUnacknowledged ? { replayUnacknowledged: true } : {}),
      limit: FEDERATION_PULL_PAGE_SIZE
    },
    15_000,
    undefined,
    { expectedEnvironmentPairingRevision: currentServer.pairingRevision }
  )
  const parsedPull = PulledRelayPage.safeParse(pulledResponse)
  if (!parsedPull.success) {
    throw new OrchestrationError(
      'invalid_runtime_response',
      `The execution host returned an invalid federation relay page for ${dispatchId}.`
    )
  }
  const pulled = parsedPull.data
  const supportsCorrectiveResend =
    supportsLifecycleSettlement && capability?.runtimeEpoch === pulled.runtimeEpoch
  if (!isCurrent()) {
    return { imported: 0, acknowledgedThrough: federated.to_home_imported_sequence }
  }
  let cursor =
    shouldReplayUnacknowledged && pulled.items.length > 0
      ? pulled.items[0].sequence - 1
      : federated.to_home_imported_sequence
  let imported = 0
  const settlements: { sequence: number; lifecycle: FederatedLifecycleSettlement }[] = []
  let lifecycleAcknowledgmentBarrier: number | undefined
  for (const item of pulled.items) {
    if (item.dispatch_id !== dispatchId || item.sequence !== cursor + 1) {
      throw new OrchestrationError(
        'operation_unknown',
        `Federated relay for ${dispatchId} is not contiguous after sequence ${cursor}.`
      )
    }
    const message = parseRelayedMessage(item.payload)
    const boundPayload = bindCoordinatorMutationPayload(message.type, message.payload, dispatchId)
    const parsedLifecycle = parseFederatedLifecycle(
      message,
      item.message_id,
      dispatchId,
      dispatch.task_id
    )
    const lifecycle = await preflightFederatedHeimdallSubmission({
      runtime,
      db,
      dispatch,
      itemSequence: item.sequence,
      importedSequence: federated.to_home_imported_sequence,
      message,
      boundPayload,
      lifecycle: parsedLifecycle,
      supportsCorrectiveResend
    })
    if (
      lifecycle.kind === 'terminal_rejection' &&
      federated.protocol_version >=
        ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION &&
      capability?.runtimeEpoch !== pulled.runtimeEpoch
    ) {
      // The report was rejected, but a capability answer from another process cannot decide whether
      // this exact execution peer can keep the Dispatch open for correction. Import nothing; the
      // next sync re-probes the epoch advertised by this pull before choosing corrective or terminal.
      getOrchestrationPeerCapabilityCache(runtime).observeEpoch(
        federated.peer_fingerprint,
        pulled.runtimeEpoch
      )
      throw new OrchestrationError(
        'operation_unknown',
        `The execution peer changed runtime epoch while Heimdall lifecycle settlement was negotiated for ${dispatchId}.`
      )
    }
    const stored = db.importFederatedRelayItem({
      dispatchId,
      sequence: item.sequence,
      message: {
        id: item.message_id,
        runId: dispatch.run_id,
        from: `dispatch:${dispatchId}`,
        to: `run:${dispatch.run_id}`,
        subject: message.subject,
        body: message.body,
        type: message.type,
        priority: message.priority,
        threadId: message.threadId ?? undefined,
        payload: boundPayload
      },
      lifecycle
    })
    if (stored.lifecycle && supportsCorrectiveResend) {
      settlements.push({
        sequence: item.sequence,
        lifecycle:
          stored.lifecycle.action === 'settled'
            ? {
                action: stored.lifecycle.outcome === 'succeeded' ? 'completed' : 'failed',
                authority: 'run_home'
              }
            : { ...stored.lifecycle, authority: 'run_home' }
      })
    }
    if (
      lifecycle.kind !== 'terminal_rejection' &&
      lifecycleAcknowledgmentBarrier === undefined &&
      federated.protocol_version >=
        ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION &&
      item.kind === 'worker_done' &&
      !supportsCorrectiveResend
    ) {
      lifecycleAcknowledgmentBarrier = item.sequence
    }
    // Protocol 1/2 peers settle their attachment as soon as they queue worker_done. A Heimdall
    // terminal_rejection therefore uses the legacy acknowledgment shape even for a persisted v3
    // row whose current peer definitively does not advertise home settlement.
    cursor = item.sequence
    if (stored.message.read === 0) {
      runtime.notifyMessageArrived(stored.message.to_handle, stored.message.type)
    }
    imported += stored.duplicate ? 0 : 1
  }

  const ackIdentity = {
    environmentId: federated.environment_id,
    peerFingerprint: federated.peer_fingerprint,
    remoteRuntimeEpoch: pulled.runtimeEpoch
  }
  const durableAcknowledgedThrough =
    federated.remote_runtime_epoch === pulled.runtimeEpoch
      ? (federated.to_home_acknowledged_sequence ?? 0)
      : 0
  const acknowledgmentCursor = lifecycleAcknowledgmentBarrier
    ? lifecycleAcknowledgmentBarrier - 1
    : cursor
  if (
    isCurrent() &&
    acknowledgmentCursor >
      Math.max(getFederationAckedThrough(ackLease, ackIdentity), durableAcknowledgedThrough)
  ) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: matches the identical, pre-existing cast on this same RPC call in the upstream file this module was forked from; callOrchestrationWorkerServer returns an untyped peer response.
    const delivered = (await runtime.callOrchestrationWorkerServer(
      federated.environment_id,
      'orchestration.federationAck',
      {
        dispatchId,
        throughSequence: acknowledgmentCursor,
        ...(settlements.length > 0 ? { settlements } : {})
      },
      15_000,
      { orchestrationRequestId: `relay_ack_${dispatchId}_${cursor}` },
      { expectedEnvironmentPairingRevision: currentServer.pairingRevision }
    )) as { acknowledgedThrough: number }
    const keepRelayEligible =
      pulled.items.length === FEDERATION_PULL_PAGE_SIZE && remainingPages === 1
    const locallyAcknowledgedThrough = keepRelayEligible
      ? Math.max(0, delivered.acknowledgedThrough - 1)
      : delivered.acknowledgedThrough
    db.recordFederatedHomeAcknowledgment({
      dispatchId,
      remoteRuntimeEpoch: pulled.runtimeEpoch,
      sequence: locallyAcknowledgedThrough
    })
    recordFederationAckCheckpoint(runtime, ackLease, {
      ...ackIdentity,
      throughSequence: locallyAcknowledgedThrough
    })
  }
  getOrchestrationPeerCapabilityCache(runtime).observeEpoch(
    federated.peer_fingerprint,
    pulled.runtimeEpoch
  )
  db.updateFederatedDispatchRuntimeEpoch(dispatchId, pulled.runtimeEpoch)
  const toWorker =
    db.getWorkerDispatch(dispatchId)?.state === 'ready'
      ? db.listPendingFederationRelay(dispatchId, 'to_worker')
      : []
  if (toWorker.length > 0) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: matches the identical, pre-existing cast on this same RPC call in the upstream file this module was forked from; callOrchestrationWorkerServer returns an untyped peer response.
    const delivered = (await runtime.callOrchestrationWorkerServer(
      federated.environment_id,
      'orchestration.federationImport',
      { dispatchId, items: toWorker },
      15_000,
      {
        orchestrationRequestId: `relay_import_${dispatchId}_${toWorker.at(-1)?.sequence ?? 0}`
      },
      { expectedEnvironmentPairingRevision: currentServer.pairingRevision }
    )) as { acknowledgedThrough: number }
    db.acknowledgeFederationRelay({
      dispatchId,
      direction: 'to_worker',
      throughSequence: delivered.acknowledgedThrough
    })
  }
  if (
    isCurrent() &&
    pulled.items.length === FEDERATION_PULL_PAGE_SIZE &&
    remainingPages > 1 &&
    lifecycleAcknowledgmentBarrier === undefined
  ) {
    const next = await syncFederatedDispatchPages(
      runtime,
      dispatchId,
      remainingPages - 1,
      isCurrent
    )
    return {
      imported: imported + next.imported,
      acknowledgedThrough: next.acknowledgedThrough
    }
  }
  return { imported, acknowledgedThrough: cursor }
}
