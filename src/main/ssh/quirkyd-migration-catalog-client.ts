import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import {
  parseQuirkydMigrationCatalogAbortResult,
  parseQuirkydMigrationCatalogState
} from '../../shared/quirkyd-migration/quirkyd-migration-catalog-state'
import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  parseQuirkydMigrationSnapshotChunkResult,
  type QuirkydMigrationSnapshotChunkRequest,
  type QuirkydMigrationSnapshotChunkResult
} from '../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import {
  findUnsupportedMigrationBlobKind,
  quirkydMigrationBlobKindUnsupportedBlocker,
  parseQuirkydMigrationBlobChunkResult,
  type QuirkydMigrationBlobChunkRequest,
  type QuirkydMigrationBlobChunkResult,
  type QuirkydMigrationBlobDescriptor
} from '../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/quirkyd-runtime-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import { assertQuirkydMigrationRequestFits } from './quirkyd-migration-manifest-export'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { requiredQuirkydMigrationSourceCapability } from '../../shared/quirkyd-migration/quirkyd-migration-source-kind'
import type { QuirkydServerRepository } from './quirkyd-migration-repository-link'

type QuirkydCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

/**
 * A destination that does not offer catalog migration: an older quirkyd without the capability or
 * the method. This is a definite refusal; any other failure, including a lost answer, is not, and
 * the caller re-reads the catalog state before deciding anything.
 */
export const QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED = 'quirkyd_migration_destination_unsupported'
/** An older destination would strip automations' extra agent arguments, so the move is refused. */
export const QUIRKYD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED =
  'quirkyd_migration_destination_extra_agent_args_unsupported:Update Quirky on this host to use extra arguments.'
/** The destination does not parse this manifest's source kind; nothing was sent, so nothing staged. */
export const QUIRKYD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED =
  'quirkyd_migration_destination_source_kind_unsupported:Update Quirky on this host to move this project to it.'

export type CatalogRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  expectedRuntimeId?: string
}

const METHOD_BY_OPERATION: Record<QuirkydCatalogMigrationOperation, string> = {
  abort: 'quirkyd.migration.abortCatalog',
  commit: 'quirkyd.migration.commitCatalog',
  stage: 'quirkyd.migration.stageCatalog',
  state: 'quirkyd.migration.catalogState'
}

export function stageRemoteQuirkydMigrationCatalog(
  pairingCode: string,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<QuirkydMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

/** `expectedBlobs` names what was moved so the destination refuses a commit missing any. */
export async function commitRemoteQuirkydMigrationCatalog(
  pairingCode: string,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions & {
    expectedBlobs?: readonly QuirkydMigrationBlobDescriptor[]
  } = {}
): Promise<QuirkydMigrationCatalogState> {
  const result = await request(pairingCode, 'commit', manifest, options, options.expectedBlobs)
  return parseQuirkydMigrationCatalogState(result, manifest)
}

export function readRemoteQuirkydMigrationCatalogState(
  pairingCode: string,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<QuirkydMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteQuirkydMigrationCatalog(
  pairingCode: string,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<QuirkydMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  const parsed = parseQuirkydMigrationCatalogAbortResult(result, manifest)
  // Older hosts flush real aborts, but their already-absent responses prove no persistence.
  if (parsed.state === 'absent' && !parsed.aborted && parsed.durableAbsent !== true) {
    throw new Error('quirkyd_migration_abort_durability_unverifiable:destination_update_required')
  }
  return parsed
}

export async function stageRemoteQuirkydMigrationSnapshotChunk(
  pairingCode: string,
  request: QuirkydMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<QuirkydMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('quirkyd_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'quirkyd.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`quirkyd_migration_snapshot_failed:${response.error.message}`)
  }
  return parseQuirkydMigrationSnapshotChunkResult(response.result, request)
}

export async function stageRemoteQuirkydMigrationBlobChunk(
  pairingCode: string,
  request: QuirkydMigrationBlobChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<QuirkydMigrationBlobChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('quirkyd_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'quirkyd.migration.stageBlobChunk',
    request,
    options,
    false,
    null,
    // Per request: a downgraded destination must refuse the kind, never stage what it can't install.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind([request.blob], capabilities)
      if (unsupported) {
        throw new Error(quirkydMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`quirkyd_migration_blob_failed:${response.error.message}`)
  }
  return parseQuirkydMigrationBlobChunkResult(response.result, request)
}

/** One `*.list` read of the server's own rows, through the same migration preflight. */
export async function listServerRows(
  pairingCode: string,
  method: string,
  rows: string,
  options: CatalogRequestOptions
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('quirkyd_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(pairing, method, undefined, options)
  if (!response.ok) {
    throw new Error(`quirkyd_migration_${rows}_failed:${response.error.message}`)
  }
  return response.result
}

// Every quirkyd's repo.list returns stored rows whole, so a row without host fields is its own.
const ServerRepositoriesSchema = z.object({
  repos: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      connectionId: z.string().nullish(),
      executionHostId: z.string().nullish(),
      projectGroupId: z.string().nullish()
    })
  )
})

/** The projects the destination already holds, with the host each one's files are on. */
export async function listRemoteQuirkydRepositories(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<QuirkydServerRepository[]> {
  const result = await listServerRows(pairingCode, 'repo.list', 'repositories', options)
  return ServerRepositoriesSchema.parse(result).repos.map(
    ({ id, path, connectionId, executionHostId, projectGroupId }) => ({
      id,
      path,
      ...(connectionId != null ? { connectionId } : {}),
      ...(executionHostId != null ? { executionHostId } : {}),
      ...(projectGroupId != null ? { projectGroupId } : {})
    })
  )
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<QuirkydCatalogMigrationOperation, 'abort'>,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions
): Promise<QuirkydMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseQuirkydMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: QuirkydCatalogMigrationOperation,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions,
  expectedBlobs: readonly QuirkydMigrationBlobDescriptor[] = []
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('quirkyd_migration_pairing_code_invalid')
  }
  // Only with blobs: SSH and blob-free moves keep sending exactly `{ manifest }`.
  const params = expectedBlobs.length > 0 ? { manifest, expectedBlobs } : { manifest }
  // A manifest under the validation cap can still overflow the host's sealed frame (more so with
  // expectedBlobs); the host would answer by closing the socket, so refuse before sending.
  assertQuirkydMigrationRequestFits(params)
  const carriesExtraAgentArgs =
    (operation === 'stage' || operation === 'commit') &&
    (manifest.payload.dormantState?.automations ?? []).some((automation) =>
      hasExtraAgentArgs(automation.extraAgentArgs)
    )
  const response = await sendSupportedMigrationRequest(
    pairing,
    METHOD_BY_OPERATION[operation],
    params,
    options,
    carriesExtraAgentArgs,
    // Every operation: an older destination would parse a non-SSH source as malformed or as SSH.
    requiredQuirkydMigrationSourceCapability(manifest.source),
    // A destination without the blob channel would strip the field and commit unchecked.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind(expectedBlobs, capabilities)
      if (unsupported) {
        throw new Error(quirkydMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`quirkyd_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
}

export async function sendSupportedMigrationRequest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  method: string,
  params: unknown,
  options: CatalogRequestOptions,
  requiresExtraAgentArgs = false,
  requiredSourceCapability: string | null = null,
  assertCapabilities: (capabilities: readonly string[]) => void = () => {}
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    pairedRuntimeConnectionFromOffer(pairing),
    method,
    params,
    options.timeoutMs ?? 15_000,
    (status) => {
      if (!status.ok) {
        throw new Error(`quirkyd_migration_status_failed:${status.error.message}`)
      }
      if (
        options.expectedRuntimeId !== undefined &&
        status._meta?.runtimeId !== options.expectedRuntimeId
      ) {
        throw new Error('quirkyd_migration_destination_runtime_mismatch')
      }
      if (!status.result.capabilities?.includes(QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY)) {
        throw new Error(QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED)
      }
      if (
        requiresExtraAgentArgs &&
        !status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
      ) {
        throw new Error(QUIRKYD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED)
      }
      if (
        requiredSourceCapability !== null &&
        !status.result.capabilities?.includes(requiredSourceCapability)
      ) {
        throw new Error(QUIRKYD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED)
      }
      assertCapabilities(status.result.capabilities ?? [])
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    options.signal
  )
  if (!response.ok && response.error.code === 'method_not_found') {
    throw new Error(QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('quirkyd_migration_destination_runtime_mismatch')
  }
  return response
}
