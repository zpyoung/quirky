import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { serializeQuirkydMigrationValue } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { requireQuirkydMigrationSshSource } from '../../../shared/quirkyd-migration/quirkyd-migration-source-kind'
import { parsePersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { hostStableKey } from '../../../shared/automation-owner-key'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { QuirkydMigrationClientStatePayload } from '../../../shared/quirkyd-migration/quirkyd-migration-client-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  type ClientHostedBrowserCloseIntent
} from '../../../shared/client-hosted-browser-close-intent'
import {
  createQuirkydMigrationSourceScope,
  quirkydMigrationOwnerMatchesScope,
  unqualifyQuirkydMigrationOwnerKey
} from './quirkyd-source-scope'

/** On a copy of the profile only: the client state an earlier migration moved. */
export function subtractQuirkydMigrationClientState(
  state: PersistedState,
  manifest: QuirkydMigrationManifest
): void {
  const clientState = manifest.payload.dormantState?.clientState
  if (!clientState) {
    return
  }
  const source = manifest.source
  const scope = createQuirkydMigrationSourceScope({
    source,
    catalog: manifest.payload,
    repos: state.repos
  })
  if (clientState.mobileClientTabSelectionsByDeviceId) {
    for (const [deviceId, captured] of Object.entries(
      clientState.mobileClientTabSelectionsByDeviceId
    )) {
      const selections = state.mobileClientTabSelectionsByDeviceId?.[deviceId]
      if (!selections) {
        continue
      }
      for (const ownerKey of Object.keys(captured)) {
        delete selections[ownerKey]
      }
      if (Object.keys(selections).length === 0) {
        delete state.mobileClientTabSelectionsByDeviceId?.[deviceId]
      }
    }
  }
  const target = state.sshTargets.find(
    (entry) => entry.id === requireQuirkydMigrationSshSource(source).sshTargetId
  )
  if (target && clientState.savedPortForwards) {
    target.portForwards = structuredClone(clientState.savedPortForwards)
  }
  subtractCloseIntents(state, clientState.clientHostedBrowserCloseIntents ?? [], manifest)
  rewriteDesktopUiForDestination(state, manifest, scope)
}

function subtractCloseIntents(
  state: PersistedState,
  captured: readonly NonNullable<
    QuirkydMigrationClientStatePayload['clientHostedBrowserCloseIntents']
  >[number][],
  manifest: QuirkydMigrationManifest
): void {
  if (captured.length === 0) {
    return
  }
  const current = state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment ?? {}
  const next: Record<string, ClientHostedBrowserCloseIntent[]> = Object.fromEntries(
    Object.entries(current).map(([key, entries]) => [key, structuredClone(entries)])
  )
  const destinationEnvironmentId = manifest.destinationEnvironmentId
  if (!destinationEnvironmentId) {
    throw new Error('quirkyd_migration_source_close_intent_destination_invalid')
  }
  for (const intent of captured) {
    const expected = serializeQuirkydMigrationValue({
      browserPageId: intent.browserPageId,
      worktreeId: intent.worktreeId,
      closedAt: intent.closedAt
    })
    const samePage = (entry: ClientHostedBrowserCloseIntent): boolean =>
      entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    const sourceEntries = next[intent.sourceEnvironmentId] ?? []
    const sourceIndex = sourceEntries.findIndex(samePage)
    const destinationEntries = next[destinationEnvironmentId] ?? []
    const existing = destinationEntries.find(samePage)
    if (sourceIndex === -1) {
      // A retry after the moving write flushed: the identical intent already sits at the destination.
      if (existing && serializeQuirkydMigrationValue(existing) === expected) {
        continue
      }
      throw new Error('quirkyd_migration_source_close_intent_changed')
    }
    if (serializeQuirkydMigrationValue(sourceEntries[sourceIndex]) !== expected) {
      throw new Error('quirkyd_migration_source_close_intent_changed')
    }
    sourceEntries.splice(sourceIndex, 1)
    if (sourceEntries.length === 0) {
      delete next[intent.sourceEnvironmentId]
    } else {
      next[intent.sourceEnvironmentId] = sourceEntries
    }
    if (existing) {
      if (serializeQuirkydMigrationValue(existing) !== expected) {
        throw new Error('quirkyd_migration_close_intent_destination_conflict')
      }
      continue
    }
    if (destinationEntries.length >= MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS) {
      throw new Error('quirkyd_migration_close_intent_destination_capacity_exceeded')
    }
    destinationEntries.push({
      browserPageId: intent.browserPageId,
      worktreeId: intent.worktreeId,
      closedAt: intent.closedAt
    })
    next[destinationEnvironmentId] = destinationEntries
  }
  state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = next
}

function rewriteDesktopUiForDestination(
  state: PersistedState,
  manifest: QuirkydMigrationManifest,
  scope: ReturnType<typeof createQuirkydMigrationSourceScope>
): void {
  const route = manifest.payload.dormantState?.clientState?.uiRouting
  const destinationEnvironmentId = manifest.destinationEnvironmentId
  if (!route || !destinationEnvironmentId) {
    return
  }
  const destinationHostId = toRuntimeExecutionHostId(destinationEnvironmentId)
  if (
    route.lastActiveWorktreeId &&
    quirkydMigrationOwnerMatchesScope(state.ui.lastActiveWorktreeId, scope)
  ) {
    state.ui.lastActiveWorktreeId = composeWorktreeHostIdentity(
      destinationHostId,
      route.lastActiveWorktreeId
    )
  }
  if (route.workspaceHostScope === 'local' && state.ui.workspaceHostScope === scope.hostId) {
    state.ui.workspaceHostScope = destinationHostId
  }
  if (route.visibleWorkspaceHostIds?.includes('local') && state.ui.visibleWorkspaceHostIds) {
    state.ui.visibleWorkspaceHostIds = state.ui.visibleWorkspaceHostIds.map((hostId) =>
      hostId === scope.hostId ? destinationHostId : hostId
    )
  }
  if (route.workspaceHostOrder?.includes('local')) {
    state.ui.workspaceHostOrder = (state.ui.workspaceHostOrder ?? []).map((hostId) =>
      hostId === scope.hostId ? destinationHostId : hostId
    )
  }
  if (route.manualRepoOrder) {
    const repoIds = new Set(route.manualRepoOrder.map((entry) => entry.repoId))
    state.ui.manualRepoOrder = (state.ui.manualRepoOrder ?? []).map((entry) =>
      entry.hostId === scope.hostId && repoIds.has(entry.repoId)
        ? { ...entry, hostId: destinationHostId }
        : entry
    )
  }
  if (route.showDotfilesByWorktree) {
    const next = { ...state.ui.showDotfilesByWorktree }
    for (const [ownerKey, enabled] of Object.entries(next)) {
      if (quirkydMigrationOwnerMatchesScope(ownerKey, scope)) {
        delete next[ownerKey]
        next[`${destinationHostId}|${unqualifyQuirkydMigrationOwnerKey(ownerKey)}`] = enabled
      }
    }
    state.ui.showDotfilesByWorktree = next
  }
  if (route.automationHostFilter?.kind === 'host') {
    const current = parsePersistedAutomationHostFilter(state.ui.automationHostFilter)
    const sourceKey = hostStableKey({
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: scope.targetId }
    })
    if (current.kind === 'host' && hostStableKey(current.host) === sourceKey) {
      state.ui.automationHostFilter = structuredClone(route.automationHostFilter)
    }
  }
}
