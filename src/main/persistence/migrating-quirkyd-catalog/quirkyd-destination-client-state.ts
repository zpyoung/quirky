import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  QuirkydMigrationClientStatePayload,
  QuirkydMigrationUiRoutingState
} from '../../../shared/quirkyd-migration/quirkyd-migration-client-state'
import { serializeQuirkydMigrationValue } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'

export type PreparedQuirkydMigrationClientState = {
  incoming: QuirkydMigrationClientStatePayload | undefined
  mobileSelections: NonNullable<
    QuirkydMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  >
  uiRouting: QuirkydMigrationUiRoutingState | undefined
}

export function prepareQuirkydMigrationClientState(
  incoming: QuirkydMigrationClientStatePayload | undefined,
  state: PersistedState
): PreparedQuirkydMigrationClientState {
  const mobileSelections = prepareMobileSelections(
    incoming?.mobileClientTabSelectionsByDeviceId,
    state
  )
  const uiRouting = incoming?.uiRouting ? structuredClone(incoming.uiRouting) : undefined
  return {
    incoming,
    mobileSelections,
    uiRouting
  }
}

export function applyPreparedQuirkydMigrationClientState(
  prepared: PreparedQuirkydMigrationClientState,
  state: PersistedState
): void {
  if (Object.keys(prepared.mobileSelections).length > 0) {
    // Per workspace: a device's selections outside this import stay as they are.
    state.mobileClientTabSelectionsByDeviceId = { ...state.mobileClientTabSelectionsByDeviceId }
    for (const [deviceId, selections] of Object.entries(prepared.mobileSelections)) {
      state.mobileClientTabSelectionsByDeviceId[deviceId] = {
        ...state.mobileClientTabSelectionsByDeviceId[deviceId],
        ...selections
      }
    }
  }
  if (prepared.uiRouting) {
    applyUiRouting(prepared.uiRouting, state)
  }
}

function prepareMobileSelections(
  incoming: QuirkydMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId'],
  state: PersistedState
): NonNullable<QuirkydMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']> {
  const result: NonNullable<
    QuirkydMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  > = {}
  const current = state.mobileClientTabSelectionsByDeviceId ?? {}
  for (const [deviceId, selections] of Object.entries(incoming ?? {})) {
    for (const [worktreeId, selection] of Object.entries(selections)) {
      const existing = current[deviceId]?.[worktreeId]
      if (
        existing &&
        serializeQuirkydMigrationValue(existing) !== serializeQuirkydMigrationValue(selection)
      ) {
        throw new Error(`quirkyd_migration_client_state_conflict:mobile:${deviceId}:${worktreeId}`)
      }
      const deviceSelections = (result[deviceId] ??= {})
      deviceSelections[worktreeId] = structuredClone(selection)
    }
  }
  return result
}

type UiRoutingKey = keyof QuirkydMigrationUiRoutingState
type UiRoutingFieldMerge<K extends UiRoutingKey> =
  /** A filter of one desktop window (its hosts, its repos); the server keeps its own. Ignored here. */
  | 'desktop-only'
  /** Folds a moved value into this profile; the server's own value always stands. */
  | ((ui: PersistedState['ui'], value: NonNullable<QuirkydMigrationUiRoutingState[K]>) => void)

/**
 * Every moved sidebar field is per-window view state, so none may refuse a move: what the server
 * already shows stands, and the desktop's value fills only what the server never set.
 * Acknowledgements keep the later time. A new field
 * must pick its merge here; refusals belong to catalog and session identity, never to view state.
 */
export const QUIRKYD_MIGRATION_UI_ROUTING_MERGE: {
  readonly [K in UiRoutingKey]: UiRoutingFieldMerge<K>
} = {
  lastActiveRepoId: (ui, value) => {
    ui.lastActiveRepoId ??= value
  },
  lastActiveWorktreeId: (ui, value) => {
    ui.lastActiveWorktreeId ??= value
  },
  manualRepoOrder: (ui, value) => {
    if (!ui.manualRepoOrder?.length) {
      ui.manualRepoOrder = structuredClone(value)
    }
  },
  showDotfilesByWorktree: (ui, value) => {
    ui.showDotfilesByWorktree = { ...structuredClone(value), ...ui.showDotfilesByWorktree }
  },
  acknowledgedAgentsByPaneKey: (ui, value) => {
    // The later acknowledgement covers the earlier one, so a retry never revives an unread mark.
    const merged = { ...ui.acknowledgedAgentsByPaneKey }
    for (const [paneKey, at] of Object.entries(value)) {
      merged[paneKey] = Math.max(merged[paneKey] ?? 0, at)
    }
    ui.acknowledgedAgentsByPaneKey = merged
  },
  setupScriptPromptDismissedRepoIds: (ui, value) => {
    ui.setupScriptPromptDismissedRepoIds = [
      ...new Set([...(ui.setupScriptPromptDismissedRepoIds ?? []), ...value])
    ]
  },
  filterRepoIds: 'desktop-only',
  workspaceHostScope: 'desktop-only',
  visibleWorkspaceHostIds: 'desktop-only',
  workspaceHostOrder: 'desktop-only',
  automationHostFilter: 'desktop-only'
}

const UI_ROUTING_KEYS = Object.keys(QUIRKYD_MIGRATION_UI_ROUTING_MERGE).filter(isUiRoutingKey)

function isUiRoutingKey(key: string): key is UiRoutingKey {
  return Object.hasOwn(QUIRKYD_MIGRATION_UI_ROUTING_MERGE, key)
}

function applyUiRouting(route: QuirkydMigrationUiRoutingState, state: PersistedState): void {
  for (const key of UI_ROUTING_KEYS) {
    mergeUiRoutingField(key, route, state.ui)
  }
}

function mergeUiRoutingField<K extends UiRoutingKey>(
  key: K,
  route: QuirkydMigrationUiRoutingState,
  ui: PersistedState['ui']
): void {
  const merge = QUIRKYD_MIGRATION_UI_ROUTING_MERGE[key]
  const value = route[key]
  if (merge !== 'desktop-only' && value !== undefined && value !== null) {
    merge(ui, value)
  }
}
