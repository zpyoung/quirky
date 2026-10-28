import type { PluginContext, PluginStore, RuntimePeer, StoreMigration } from '@quirky/protocol'
import type { DispatchId, ResetMode, RunId, TaskId } from '../contracts'
import type { FederationBinding, FederationPeerPrincipal } from './contracts'
import { fail } from '../errors'

export const federationMigrations: StoreMigration[] = [
  `CREATE TABLE federation_bindings (
    id TEXT PRIMARY KEY,
    side TEXT NOT NULL CHECK (side IN ('home', 'host')),
    home_run_id TEXT NOT NULL,
    home_task_id TEXT NOT NULL,
    home_dispatch_id TEXT NOT NULL,
    host_run_id TEXT,
    host_task_id TEXT,
    host_dispatch_id TEXT,
    peer_json TEXT NOT NULL,
    peer_incarnation TEXT NOT NULL,
    session_id TEXT,
    process_incarnation TEXT,
    process_runtime_epoch TEXT,
    state TEXT NOT NULL CHECK (state IN ('attaching', 'active', 'settled', 'unknown')),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (side, home_dispatch_id),
    UNIQUE (side, host_dispatch_id)
  );
  CREATE INDEX federation_bindings_home_dispatch ON federation_bindings(side, home_dispatch_id);
  CREATE INDEX federation_bindings_host_dispatch ON federation_bindings(side, host_dispatch_id);
  CREATE INDEX federation_bindings_state ON federation_bindings(side, state, updated_at);`,
]

type BindingDbRow = {
  id: string
  side: FederationBinding['side']
  home_run_id: string
  home_task_id: string
  home_dispatch_id: string
  host_run_id: string | null
  host_task_id: string | null
  host_dispatch_id: string | null
  peer_json: string
  peer_incarnation: string
  session_id: string | null
  process_incarnation: string | null
  process_runtime_epoch: string | null
  state: FederationBinding['state']
  request_id: string
  request_hash: string
  created_at: string
  updated_at: string
}

const json = (value: unknown): string => {
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error('Federation binding data must be JSON serializable')
  return result
}
const now = (): string => new Date().toISOString()

function bindingOf(row: BindingDbRow): FederationBinding {
  return {
    id: row.id,
    side: row.side,
    homeRunId: row.home_run_id as RunId,
    homeTaskId: row.home_task_id as TaskId,
    homeDispatchId: row.home_dispatch_id as DispatchId,
    hostRunId: row.host_run_id as RunId | null,
    hostTaskId: row.host_task_id as TaskId | null,
    hostDispatchId: row.host_dispatch_id as DispatchId | null,
    peer: JSON.parse(row.peer_json) as RuntimePeer,
    peerIncarnation: row.peer_incarnation,
    sessionId: row.session_id,
    processIncarnation: row.process_incarnation,
    processRuntimeEpoch: row.process_runtime_epoch,
    state: row.state,
  }
}

/** Durable paired-execution identities in the orchestration PluginStore. */
export class FederationBindingStore {
  constructor(private readonly context: PluginContext, private readonly store: PluginStore) {}

  create(binding: FederationBinding, requestId: string, requestHash: string): FederationBinding {
    const existing = this.get(binding.id)
    if (existing) {
      const row = this.rowById(binding.id)
      if (!row || row.side !== binding.side || row.request_id !== requestId || row.request_hash !== requestHash) {
        fail(this.context, 'request_mismatch', `Federation binding ${binding.id} was already accepted with different input.`, { bindingId: binding.id })
      }
      return existing
    }
    const at = now()
    try {
      this.store.run(
        `INSERT INTO federation_bindings (
          id, side, home_run_id, home_task_id, home_dispatch_id, host_run_id, host_task_id, host_dispatch_id,
          peer_json, peer_incarnation, session_id, process_incarnation, process_runtime_epoch,
          state, request_id, request_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        binding.id, binding.side, binding.homeRunId, binding.homeTaskId, binding.homeDispatchId,
        binding.hostRunId, binding.hostTaskId, binding.hostDispatchId, json(binding.peer), binding.peerIncarnation,
        binding.sessionId, binding.processIncarnation, binding.processRuntimeEpoch, binding.state,
        requestId, requestHash, at, at,
      )
    } catch (cause) {
      const raced = this.get(binding.id) ?? this.home(binding.homeDispatchId)
      if (raced && raced.id === binding.id && raced.side === binding.side) return raced
      fail(this.context, 'lifecycle_conflict', 'A federation binding already exists for this worker dispatch.', {
        bindingId: binding.id,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
    return binding
  }

  get(bindingId: string): FederationBinding | null {
    const row = this.rowById(bindingId)
    return row ? bindingOf(row) : null
  }

  home(dispatchId: DispatchId): FederationBinding | null {
    const row = this.store.get<BindingDbRow>(
      `SELECT * FROM federation_bindings WHERE side = 'home' AND home_dispatch_id = ?`,
      dispatchId,
    )
    return row ? bindingOf(row) : null
  }

  homeByRequest(runId: RunId, requestId: string): FederationBinding | null {
    const row = this.store.get<BindingDbRow>(
      `SELECT * FROM federation_bindings WHERE side = 'home' AND home_run_id = ? AND request_id = ?`,
      runId,
      requestId,
    )
    return row ? bindingOf(row) : null
  }

  requestMatches(bindingId: string, requestId: string, requestHash: string): boolean {
    const row = this.store.get<{ request_id: string; request_hash: string }>(
      `SELECT request_id, request_hash FROM federation_bindings WHERE id = ?`,
      bindingId,
    )
    return row?.request_id === requestId && row.request_hash === requestHash
  }

  host(dispatchId: DispatchId): FederationBinding | null {
    const row = this.store.get<BindingDbRow>(
      `SELECT * FROM federation_bindings WHERE side = 'host' AND host_dispatch_id = ?`,
      dispatchId,
    )
    return row ? bindingOf(row) : null
  }

  forHomeDispatch(dispatchId: DispatchId): FederationBinding | null {
    const row = this.store.get<BindingDbRow>(
      `SELECT * FROM federation_bindings WHERE side = 'host' AND home_dispatch_id = ?`,
      dispatchId,
    )
    return row ? bindingOf(row) : null
  }


  bindings(side?: FederationBinding['side']): readonly FederationBinding[] {
    const rows = side === undefined
      ? this.store.all<BindingDbRow>('SELECT * FROM federation_bindings ORDER BY created_at, id')
      : this.store.all<BindingDbRow>('SELECT * FROM federation_bindings WHERE side = ? ORDER BY created_at, id', side)
    return rows.map(bindingOf)
  }

  setHostReceipt(
    bindingId: string,
    receipt: { runId: RunId; taskId: TaskId; dispatchId: DispatchId },
    side: FederationBinding['side'] = 'host',
  ): FederationBinding {
    const binding = this.require(bindingId, side)
    if ((binding.hostRunId !== null && binding.hostRunId !== receipt.runId) ||
      (binding.hostTaskId !== null && binding.hostTaskId !== receipt.taskId) ||
      (binding.hostDispatchId !== null && binding.hostDispatchId !== receipt.dispatchId)) {
      fail(this.context, 'request_mismatch', `Federation binding ${bindingId} already names a different host attachment.`, { bindingId })
    }
    this.store.run(
      `UPDATE federation_bindings SET host_run_id = ?, host_task_id = ?, host_dispatch_id = ?, updated_at = ? WHERE id = ? AND side = ?`,
      receipt.runId, receipt.taskId, receipt.dispatchId, now(), bindingId, side,
    )
    return this.require(bindingId, side)
  }

  setHostRun(bindingId: string, hostRunId: RunId): FederationBinding {
    const binding = this.require(bindingId, 'host')
    if (binding.hostRunId !== null && binding.hostRunId !== hostRunId) {
      fail(this.context, 'request_mismatch', `Federation binding ${bindingId} already names a different host Run.`, { bindingId })
    }
    this.store.run(
      `UPDATE federation_bindings SET host_run_id = ?, updated_at = ? WHERE id = ? AND side = 'host'`,
      hostRunId, now(), bindingId,
    )
    return this.require(bindingId, 'host')
  }

  attach(bindingId: string, side: FederationBinding['side'], receipt: {
    runId: RunId; taskId: TaskId; dispatchId: DispatchId; sessionId: string
    processIncarnation: string; processRuntimeEpoch: string
  }): FederationBinding {
    const binding = this.require(bindingId, side)
    if (side === 'host' && (binding.hostRunId !== receipt.runId || binding.hostTaskId !== receipt.taskId || binding.hostDispatchId !== receipt.dispatchId)) {
      fail(this.context, 'worker_identity_changed', `Federation binding ${bindingId} host receipt does not match the attached worker.`, { bindingId })
    }
    if (side === 'home' && (binding.hostRunId !== receipt.runId || binding.hostTaskId !== receipt.taskId || binding.hostDispatchId !== receipt.dispatchId)) {
      fail(this.context, 'worker_identity_changed', `Federation binding ${bindingId} home receipt does not match the attached host worker.`, { bindingId })
    }
    if (binding.sessionId !== null && (binding.sessionId !== receipt.sessionId || binding.processIncarnation !== receipt.processIncarnation || binding.processRuntimeEpoch !== receipt.processRuntimeEpoch)) {
      fail(this.context, 'worker_identity_changed', `Federation binding ${bindingId} has a different attached process identity.`, { bindingId })
    }
    this.store.run(
      `UPDATE federation_bindings SET session_id = ?, process_incarnation = ?, process_runtime_epoch = ?, state = 'active', updated_at = ? WHERE id = ? AND side = ?`,
      receipt.sessionId, receipt.processIncarnation, receipt.processRuntimeEpoch, now(), bindingId, side,
    )
    return this.require(bindingId, side)
  }

  setState(bindingId: string, side: FederationBinding['side'], state: FederationBinding['state']): void {
    this.require(bindingId, side)
    this.store.run(
      `UPDATE federation_bindings SET state = ?, updated_at = ? WHERE id = ? AND side = ?`,
      state, now(), bindingId, side,
    )
  }

  reset(mode: ResetMode): void {
    if (mode !== 'messages') this.store.exec('DELETE FROM federation_bindings')
  }

  assertPrincipal(binding: FederationBinding, principal: FederationPeerPrincipal): void {
    if (binding.peer.id !== principal.peerId || binding.peer.pairingRevision !== principal.pairingRevision ||
      binding.peer.fingerprint.replaceAll(':', '').toLowerCase() !== principal.fingerprint.replaceAll(':', '').toLowerCase() ||
      binding.peerIncarnation !== principal.incarnation) {
      fail(this.context, 'worker_identity_changed', `Authenticated peer does not match federation binding ${binding.id}.`, {
        bindingId: binding.id,
        peerId: principal.peerId,
      })
    }
    this.assertSavedPairing(binding)
  }

  assertSavedPairing(binding: FederationBinding): void {
    const row = this.store.get<{ peer_id: string; fingerprint: string; pairing_revision: number; last_incarnation: string | null }>(
      `SELECT peer_id, fingerprint, pairing_revision, last_incarnation FROM orchestration_peers WHERE peer_id = ?`,
      binding.peer.id,
    )
    if (!row || row.pairing_revision !== binding.peer.pairingRevision ||
      row.fingerprint.replaceAll(':', '').toLowerCase() !== binding.peer.fingerprint.replaceAll(':', '').toLowerCase() ||
      row.last_incarnation !== binding.peerIncarnation) {
      fail(this.context, 'peer_incarnation_changed', `Peer identity or incarnation changed for federation binding ${binding.id}.`, {
        bindingId: binding.id,
        peerId: binding.peer.id,
      })
    }
  }

  assertPersisted(binding: FederationBinding): FederationBinding {
    const current = this.require(binding.id, binding.side)
    if (current.homeRunId !== binding.homeRunId || current.homeTaskId !== binding.homeTaskId ||
      current.homeDispatchId !== binding.homeDispatchId || current.hostRunId !== binding.hostRunId ||
      current.hostTaskId !== binding.hostTaskId || current.hostDispatchId !== binding.hostDispatchId ||
      current.peer.id !== binding.peer.id || current.peer.pairingRevision !== binding.peer.pairingRevision ||
      current.peer.fingerprint.replaceAll(':', '').toLowerCase() !== binding.peer.fingerprint.replaceAll(':', '').toLowerCase() ||
      current.peerIncarnation !== binding.peerIncarnation || current.sessionId !== binding.sessionId ||
      current.processIncarnation !== binding.processIncarnation || current.processRuntimeEpoch !== binding.processRuntimeEpoch) {
      fail(this.context, 'worker_identity_changed', `Federation binding ${binding.id} changed after it was read.`, { bindingId: binding.id })
    }
    this.assertSavedPairing(current)
    return current
  }

  assertPeerIdentity(binding: FederationBinding): FederationBinding {
    const current = this.require(binding.id, binding.side)
    if (current.peer.id !== binding.peer.id || current.peer.pairingRevision !== binding.peer.pairingRevision ||
      current.peer.fingerprint.replaceAll(':', '').toLowerCase() !== binding.peer.fingerprint.replaceAll(':', '').toLowerCase() ||
      current.peerIncarnation !== binding.peerIncarnation) {
      fail(this.context, 'peer_incarnation_changed', `Paired identity changed for federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    this.assertSavedPairing(current)
    return current
  }

  private require(bindingId: string, side: FederationBinding['side']): FederationBinding {
    const row = this.store.get<BindingDbRow>(`SELECT * FROM federation_bindings WHERE id = ? AND side = ?`, bindingId, side)
    if (!row) fail(this.context, 'lifecycle_not_found', `Federation binding ${bindingId} does not exist on the ${side} side.`, { bindingId, side })
    return bindingOf(row)
  }

  private rowById(bindingId: string): BindingDbRow | null {
    return this.store.get<BindingDbRow>('SELECT * FROM federation_bindings WHERE id = ?', bindingId)
  }
}
