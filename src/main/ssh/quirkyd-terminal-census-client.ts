/**
 * Asks a managed quirkyd, through its tunnel, how many terminals its daemon runs. Every failure,
 * including an older host without the method, reads as an unverifiable census, never as zero.
 */
import { QUIRKYD_TERMINAL_CENSUS_RUNTIME_CAPABILITY } from '../../shared/quirkyd-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  QUIRKYD_TERMINAL_CENSUS_METHOD,
  QuirkydTerminalCensusSchema,
  type QuirkydTerminalCensus
} from '../../shared/quirkyd-terminal-census'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { QuirkydActivationRecord } from '../managed-server/activation/quirkyd-activation-record'
import { ensureQuirkydManagedTunnel } from '../managed-server/lifecycle/quirkyd-managed-tunnel'
import { verifyQuirkydManagedServing } from '../managed-server/lifecycle/quirkyd-managed-serving-verify'

export type QuirkydTerminalCensusRequestOptions = {
  releaseFinishedAutomationTerminals?: boolean
  /** Close the server's terminal admission this long before counting; 0 reopens it. */
  closeAdmissionForMs?: number
}

const UNVERIFIABLE: QuirkydTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

/**
 * The census through the server's ensured tunnel, after starting a server that idled out; a
 * tunnel that cannot open, or a server that cannot start, is unverifiable.
 */
export async function collectManagedTerminalCensus(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  record: QuirkydActivationRecord,
  timeoutMs = 15_000,
  options: QuirkydTerminalCensusRequestOptions = {}
): Promise<QuirkydTerminalCensus> {
  if (!record.active) {
    return { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  }
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE
  }
  try {
    // Why its answer, not `environment`: the tunnel may have re-paired, retiring that token.
    const current = await ensureQuirkydManagedTunnel(userDataPath, environment.id)
    // A server that idled out behind a forward still up is started first, or it never answers.
    await verifyQuirkydManagedServing(userDataPath, environment.id)
    return await requestQuirkydTerminalCensus(
      getPreferredPairedRuntimeConnection(current),
      activatedAt,
      timeoutMs,
      options
    )
  } catch {
    return UNVERIFIABLE
  }
}

/** The census over an already-open connection; any failure is unverifiable, never zero. */
export async function requestQuirkydTerminalCensus(
  connection: PairedRuntimeConnection,
  activatedAt: number,
  timeoutMs = 15_000,
  options: QuirkydTerminalCensusRequestOptions = {}
): Promise<QuirkydTerminalCensus> {
  try {
    const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
      connection,
      QUIRKYD_TERMINAL_CENSUS_METHOD,
      {
        activatedAt,
        ...(options.releaseFinishedAutomationTerminals
          ? { releaseFinishedAutomationTerminals: true }
          : {}),
        // Safe for any server: an older one drops the field, and its answer omits the fence.
        ...(options.closeAdmissionForMs === undefined
          ? {}
          : { closeAdmissionForMs: options.closeAdmissionForMs })
      },
      timeoutMs,
      (status) => {
        if (
          !status.ok ||
          !status.result.capabilities?.includes(QUIRKYD_TERMINAL_CENSUS_RUNTIME_CAPABILITY)
        ) {
          throw new Error('This host’s Quirky server does not report a terminal census.')
        }
      },
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    return response.ok ? QuirkydTerminalCensusSchema.parse(response.result) : UNVERIFIABLE
  } catch {
    return UNVERIFIABLE
  }
}
