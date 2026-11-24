/**
 * The signed manifest a relay-hosted SSH target's state is exported as.
 *
 * Reads only: the catalog rows the target owns and the dormant state that references them, copied
 * out of the profile-state store. The source keeps every row; retiring it happens only after the
 * destination has verified and imported this exact manifest.
 */
import { randomUUID } from 'node:crypto'
import {
  MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES,
  QUIRKYD_MIGRATION_MANIFEST_VERSION,
  parseQuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import type {
  QuirkydMigrationCatalogPayload,
  QuirkydMigrationDormantStatePayload,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { SshTarget } from '../../shared/ssh-types'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../shared/remote-runtime-memory-limits'
import type { Store } from '../persistence'
import { collectQuirkydMigrationSourceCatalog } from '../persistence/migrating-quirkyd-catalog/quirkyd-source-catalog'
import { computeQuirkydMigrationManifestSha256 } from '../quirkyd/quirkyd-migration-manifest-digest'
import {
  IDENTITY_QUIRKYD_MIGRATION_PATH_REWRITER,
  rewriteQuirkydMigrationPayloadPaths,
  type QuirkydMigrationPathRewriter
} from './quirkyd-migration-path-rewrite'

export type QuirkydMigrationExportStore = Pick<
  Store,
  | 'collectQuirkydMigrationSourceDormantState'
  | 'getFolderWorkspaces'
  | 'getProjectGroups'
  | 'getRepos'
> & {
  /** Groups the server's record wins for: still read for row ownership, never exported. */
  serverOwnedProjectGroupIds?: ReadonlySet<string>
}

export type QuirkydMigrationManifestExportOptions = {
  migrationId?: string
  now?: () => Date
  destinationEnvironmentId?: string
  /** Only these rows: a re-export of what earlier migrations of the host already moved. */
  onlyCatalog?: QuirkydMigrationCatalogIds
  /** Maps source paths to destination paths before signing; identity for an SSH host. */
  rewrite?: QuirkydMigrationPathRewriter
}

export function createQuirkydMigrationManifest(
  store: QuirkydMigrationExportStore,
  target: SshTarget,
  options: QuirkydMigrationManifestExportOptions = {}
): QuirkydMigrationManifest {
  const rewrite = options.rewrite ?? IDENTITY_QUIRKYD_MIGRATION_PATH_REWRITER
  const collected = restrictCatalog(
    collectQuirkydMigrationSourceCatalog(store, target),
    options.onlyCatalog
  )
  const serverOwned = store.serverOwnedProjectGroupIds
  const sourcePayload = serverOwned
    ? {
        ...collected,
        projectGroups: collected.projectGroups.filter((group) => !serverOwned.has(group.id))
      }
    : collected
  const source = {
    sshTargetId: target.id,
    sshTargetGeneration: target.generation ?? null,
    targetLabel: target.label
  }
  const dormantState = store.collectQuirkydMigrationSourceDormantState(
    source,
    sourcePayload,
    options.destinationEnvironmentId
  )
  // After collection: dormant state is selected by the source's own paths and ids.
  const payload = rewriteQuirkydMigrationPayloadPaths(
    { ...sourcePayload, ...(hasDormantState(dormantState) ? { dormantState } : {}) },
    rewrite
  )
  const unsigned = {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: options.migrationId ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    source,
    payload,
    ...(options.destinationEnvironmentId
      ? { destinationEnvironmentId: options.destinationEnvironmentId }
      : {})
  }
  try {
    return parseQuirkydMigrationManifest({
      ...unsigned,
      manifestSha256: computeQuirkydMigrationManifestSha256(unsigned)
    })
  } catch (error) {
    if (error instanceof Error && error.message === QUIRKYD_MIGRATION_MANIFEST_TOO_LARGE) {
      throw new Error(describeOversizedQuirkydMigrationPayload(payload))
    }
    throw error
  }
}

const QUIRKYD_MIGRATION_MANIFEST_TOO_LARGE = 'quirkyd_migration_manifest_too_large'

// Request id, device token, method name and JSON framing around the params.
const REQUEST_ENVELOPE_RESERVE_BYTES = 1024
/** The largest catalog-request params that still fit the host's sealed inbound frame. */
export const QUIRKYD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES =
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES - REQUEST_ENVELOPE_RESERVE_BYTES

/**
 * Throws the user-facing refusal when a catalog request would overflow the host's sealed frame;
 * the host would answer by closing the socket. Every request carries the whole manifest, so a
 * fence must not be taken on one that fails this: its stage, state and abort would all refuse.
 */
export function assertQuirkydMigrationRequestFits(params: {
  manifest: QuirkydMigrationManifest
}): void {
  if (!quirkydMigrationRequestFits(params)) {
    throw new Error(
      describeOversizedQuirkydMigrationPayload(
        params.manifest.payload,
        QUIRKYD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
      )
    )
  }
}

export function quirkydMigrationRequestFits(params: {
  manifest: QuirkydMigrationManifest
}): boolean {
  return (
    Buffer.byteLength(JSON.stringify(params), 'utf8') <=
    QUIRKYD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
  )
}

/** The bare code told users nothing (#30126): name the largest parts and what to trim. */
export function describeOversizedQuirkydMigrationPayload(
  payload: QuirkydMigrationCatalogPayload,
  limitBytes = MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES
): string {
  const dormant = payload.dormantState
  const parts: [string, unknown][] = [
    ['projects', payload.repositories],
    ['folder workspaces', payload.folderWorkspaces],
    ['project groups', payload.projectGroups],
    ['saved tabs and panes', dormant?.workspaceSession],
    ['saved terminal history', dormant?.terminalScrollbackSnapshots],
    ['saved workspace details', dormant?.worktreeMeta],
    ['workspace history', [dormant?.worktreeLineage, dormant?.workspaceLineage]],
    ['sparse checkout presets', dormant?.sparsePresets],
    [
      'retired workspace names',
      [dormant?.retiredWorktreeNames, dormant?.retiredWorktreeNamespaces]
    ],
    ['automations', [dormant?.automations, dormant?.automationRuns]],
    ['sidebar and browser settings', dormant?.clientState]
  ]
  const largest = parts
    .map(([words, value]) => ({
      words,
      bytes: new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3)
    .map(({ words, bytes }) => `${words} (${formatKib(bytes)})`)
  return (
    `This SSH host's saved state is too large to move to its Quirky server (limit ` +
    `${formatKib(limitBytes)}). Largest parts: ${largest.join(', ')}. ` +
    `Close tabs you no longer need or remove unused projects for this host, then reconnect. ` +
    `(${QUIRKYD_MIGRATION_MANIFEST_TOO_LARGE})`
  )
}

function formatKib(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`
}

export type QuirkydMigrationCatalogIds = {
  repositoryIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  projectGroupIds: ReadonlySet<string>
}

export function quirkydMigrationCatalogIds(
  payloads: readonly QuirkydMigrationCatalogPayload[]
): QuirkydMigrationCatalogIds {
  return {
    repositoryIds: new Set(payloads.flatMap((p) => p.repositories.map((row) => row.id))),
    folderWorkspaceIds: new Set(payloads.flatMap((p) => p.folderWorkspaces.map((row) => row.id))),
    projectGroupIds: new Set(payloads.flatMap((p) => p.projectGroups.map((row) => row.id)))
  }
}

function restrictCatalog(
  payload: QuirkydMigrationCatalogPayload,
  ids: QuirkydMigrationCatalogIds | undefined
): QuirkydMigrationCatalogPayload {
  if (!ids) {
    return payload
  }
  return {
    repositories: payload.repositories.filter((row) => ids.repositoryIds.has(row.id)),
    folderWorkspaces: payload.folderWorkspaces.filter((row) => ids.folderWorkspaceIds.has(row.id)),
    projectGroups: payload.projectGroups.filter((row) => ids.projectGroupIds.has(row.id))
  }
}

function hasDormantState(state: QuirkydMigrationDormantStatePayload): boolean {
  return (
    state.worktreeMeta.length > 0 ||
    state.worktreeLineage.length > 0 ||
    state.workspaceLineage.length > 0 ||
    state.sparsePresets.length > 0 ||
    state.retiredWorktreeNames.length > 0 ||
    state.retiredWorktreeNamespaces.length > 0 ||
    state.workspaceSession !== undefined ||
    (state.terminalScrollbackSnapshots?.length ?? 0) > 0 ||
    (state.automations?.length ?? 0) > 0 ||
    (state.automationRuns?.length ?? 0) > 0 ||
    (state.clientState !== undefined && Object.keys(state.clientState).length > 0)
  )
}
