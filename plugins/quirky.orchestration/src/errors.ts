import type { PluginContext, PluginErrorKind } from '@quirky/protocol'

export type OrchestrationReason =
  | 'run_required'
  | 'run_not_found'
  | 'consumer_fenced'
  | 'task_not_found'
  | 'task_not_startable'
  | 'lifecycle_conflict'
  | 'lifecycle_not_found'
  | 'dispatch_not_found'
  | 'dispatch_inactive'
  | 'dispatch_run_mismatch'
  | 'nested_worker_depth_exceeded'
  | 'worker_identity_changed'
  | 'sender_not_assignee'
  | 'invalid_payload'
  | 'stale_dispatch'
  | 'inactive_dispatch'
  | 'unknown_task'
  | 'unknown_dispatch'
  | 'task_dispatch_mismatch'
  | 'missing_task_id'
  | 'missing_dispatch_id'
  | 'invalid_outcome'
  | 'terminal_not_found'
  | 'recipient_ambiguous'
  | 'recipient_run_mismatch'
  | 'question_not_found'
  | 'answer_conflict'
  | 'stale_delivery'
  | 'waiter_exists'
  | 'request_mismatch'
  | 'request_ambiguous'
  | 'operation_unknown'
  | 'mutation_ledger_full'
  | 'gate_not_found'
  | 'invalid_argument'
  | 'identity_unavailable'
  | 'worker_port_unavailable'
  | 'terminal_is_coordinator'
  | 'inject_rejected'
  | 'cursor_invalid'
  | 'no_active_sender_terminal'
  | 'recipient_unreachable'
  | 'peer_invalid_endpoint'
  | 'peer_tls_required'
  | 'peer_invalid_response'
  | 'peer_invalid_call'
  | 'peer_plugin_only'
  | 'peer_invalid_listener'
  | 'peer_invalid_credential'
  | 'peer_listener_failed'
  | 'peer_listener_unavailable'
  | 'peer_invalid_pairing'
  | 'peer_pin_mismatch'
  | 'peer_auth_failed'
  | 'peer_unavailable'
  | 'peer_not_found'
  | 'peer_revision_mismatch'
  | 'peer_incarnation_changed'
  | 'peer_method_forbidden'
  | 'peer_request_id_required'
  | 'peer_operator_required'
  | 'peer_credential_reuse'
  | 'peer_unpaired'
  | 'peer_capability_missing'

const notFoundReasons: Partial<Record<OrchestrationReason, true>> = {
  run_not_found: true,
  task_not_found: true,
  dispatch_not_found: true,
  question_not_found: true,
  terminal_not_found: true,
  unknown_task: true,
  unknown_dispatch: true,
  gate_not_found: true,
  peer_not_found: true
}

const invalidReasons: Partial<Record<OrchestrationReason, true>> = {
  invalid_argument: true,
  request_ambiguous: true,
  invalid_payload: true,
  missing_task_id: true,
  missing_dispatch_id: true,
  invalid_outcome: true,
  cursor_invalid: true,
  inject_rejected: true,
  peer_invalid_endpoint: true,
  peer_tls_required: true,
  peer_invalid_response: true,
  peer_invalid_call: true,
  peer_invalid_listener: true,
  peer_invalid_credential: true,
  peer_invalid_pairing: true,
  peer_request_id_required: true
}

/** Preserve a stable orchestration reason in RPC error data as well as actionable text. */
export function orchestrationError(
  context: PluginContext,
  reason: OrchestrationReason,
  message: string,
  data: Record<string, unknown> = {}
): Error {
  const kind: PluginErrorKind = notFoundReasons[reason] ? 'not-found' : invalidReasons[reason] ? 'invalid-params' : 'conflict'
  const error = context.error(kind, `${reason}: ${message}`)
  Object.assign(error, { data: { reason, ...data } })
  return error
}

export function fail(context: PluginContext, reason: OrchestrationReason, message: string, data?: Record<string, unknown>): never {
  throw orchestrationError(context, reason, message, data)
}
