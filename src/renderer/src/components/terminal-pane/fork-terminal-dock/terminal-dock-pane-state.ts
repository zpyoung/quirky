// Why: renderer-only UI preference (not synced settings), same rationale as
// column-widths.ts — a per-pane resize/toggle would be a noisy settings write.
import type { AgentType } from '../../../../../shared/agent-status-types'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import type { TerminalDockPaneState } from '../../../../../shared/fork-terminal-dock/terminal-dock-pane-state'
import {
  clampGutterRows,
  DEFAULT_GUTTER_ROWS,
  MAX_GUTTER_ROWS,
  MIN_GUTTER_ROWS
} from '../../../../../shared/fork-terminal-dock/terminal-dock-gutter-rows'

export { DEFAULT_GUTTER_ROWS, MAX_GUTTER_ROWS, MIN_GUTTER_ROWS }

const STORAGE_KEY = 'quirky.terminalDock.paneState.v1'

export const DEFAULT_TERMINAL_DOCK_PANE_STATE: TerminalDockPaneState = {
  docked: false,
  gutterRows: DEFAULT_GUTTER_ROWS
}

// Why: `lastAgent` never crosses into `TerminalDockPaneState` itself — that type also shapes
// the wire record published to the host (Tab.terminalDockByPaneKey), and this latch is a
// renderer-only affordance for surviving a remount, not host-synced dock state.
type StoredEntry = TerminalDockPaneState & { lastAgent?: string }
type StoredMap = Record<string, StoredEntry>

function isUnsafeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

function isValidStoredEntry(value: unknown): value is {
  docked: boolean
  gutterRows: number
  lastAgent?: unknown
  userUndocked?: unknown
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { docked?: unknown; gutterRows?: unknown }
  return typeof candidate.docked === 'boolean' && Number.isFinite(candidate.gutterRows)
}

function sanitizeStoredAgent(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function sanitizeStoredUserUndocked(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readStoredMap(): StoredMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return Object.create(null) as StoredMap
    }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Object.create(null) as StoredMap
    }
    // Why: a null-prototype map means `map['__proto__']` misses rather than
    // returning Object.prototype, so an unsafe key can't masquerade as data.
    const next: StoredMap = Object.create(null) as StoredMap
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isUnsafeObjectKey(key) || !isValidStoredEntry(value)) {
        continue
      }
      next[key] = {
        docked: value.docked,
        gutterRows: clampGutterRows(value.gutterRows),
        lastAgent: sanitizeStoredAgent(value.lastAgent),
        userUndocked: sanitizeStoredUserUndocked(value.userUndocked)
      }
    }
    return next
  } catch {
    return Object.create(null) as StoredMap
  }
}

// Why: whole-tab teardown historically never pruned its keys (see
// removeTerminalDockPaneKeys callers), so a long session can carry pre-existing
// dead entries; capping on every write self-heals that backlog without needing
// to know which keys are still live.
export const MAX_STORED_PANE_ENTRIES = 500

function evictOldestEntries(map: StoredMap): void {
  const keys = Object.keys(map)
  const overflow = keys.length - MAX_STORED_PANE_ENTRIES
  if (overflow <= 0) {
    return
  }
  for (const key of keys.slice(0, overflow)) {
    delete map[key]
  }
}

function writeStoredMap(map: StoredMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — dock state just won't persist this session.
  }
}

/** Per-pane dock UI state; absent panes read as not docked at the default
 *  gutter height rather than throwing or requiring a caller-side default. */
export function readTerminalDockPaneState(paneKey: string): TerminalDockPaneState {
  if (isUnsafeObjectKey(paneKey)) {
    return DEFAULT_TERMINAL_DOCK_PANE_STATE
  }
  const entry = readStoredMap()[paneKey]
  return entry
    ? {
        docked: entry.docked,
        gutterRows: entry.gutterRows,
        ...(entry.userUndocked !== undefined ? { userUndocked: entry.userUndocked } : {})
      }
    : DEFAULT_TERMINAL_DOCK_PANE_STATE
}

/** The last TUI agent this pane was recognized as, validated against the known agent set —
 *  survives a renderer remount so a persisted-docked pane with no live status or launch/title
 *  evidence yet can still resolve which composer to render. */
export function readTerminalDockPaneAgent(paneKey: string): AgentType | null {
  if (isUnsafeObjectKey(paneKey)) {
    return null
  }
  const stored = readStoredMap()[paneKey]?.lastAgent
  return isTuiAgent(stored) ? stored : null
}

/** Write-through target alongside writeTerminalDockPaneState — kept separate since docked/
 *  gutterRows changes and agent-recognition events happen on independent triggers. */
export function writeTerminalDockPaneAgent(paneKey: string, agent: AgentType): void {
  if (isUnsafeObjectKey(paneKey)) {
    return
  }
  const map = readStoredMap()
  const existing = map[paneKey]
  delete map[paneKey]
  map[paneKey] = {
    docked: existing?.docked ?? DEFAULT_TERMINAL_DOCK_PANE_STATE.docked,
    gutterRows: existing?.gutterRows ?? DEFAULT_TERMINAL_DOCK_PANE_STATE.gutterRows,
    lastAgent: agent,
    userUndocked: existing?.userUndocked
  }
  evictOldestEntries(map)
  writeStoredMap(map)
}

/** Returns whether the user explicitly closed this pane's dock. */
export function readTerminalDockPaneUserUndocked(paneKey: string): boolean {
  if (isUnsafeObjectKey(paneKey)) {
    return false
  }
  return readStoredMap()[paneKey]?.userUndocked === true
}

/** Records or clears the user decision that suppresses automatic docking. */
export function writeTerminalDockPaneUserUndocked(paneKey: string, value: boolean): void {
  if (isUnsafeObjectKey(paneKey)) {
    return
  }
  const map = readStoredMap()
  const existing = map[paneKey]
  delete map[paneKey]
  map[paneKey] = {
    docked: existing?.docked ?? DEFAULT_TERMINAL_DOCK_PANE_STATE.docked,
    gutterRows: existing?.gutterRows ?? DEFAULT_TERMINAL_DOCK_PANE_STATE.gutterRows,
    lastAgent: existing?.lastAgent,
    userUndocked: value
  }
  evictOldestEntries(map)
  writeStoredMap(map)
}

export function writeTerminalDockPaneState(paneKey: string, state: TerminalDockPaneState): void {
  if (isUnsafeObjectKey(paneKey)) {
    return
  }
  const map = readStoredMap()
  const existing = map[paneKey]
  // delete-then-set moves an existing key to the newest end of insertion order, so a rewrite
  // of a live pane refreshes its recency instead of leaving it eligible for eviction.
  delete map[paneKey]
  map[paneKey] = {
    docked: state.docked,
    gutterRows: clampGutterRows(state.gutterRows),
    lastAgent: existing?.lastAgent,
    userUndocked: state.userUndocked ?? existing?.userUndocked
  }
  evictOldestEntries(map)
  writeStoredMap(map)
}

/** Moves every fallback entry keyed `oldTabId:<leaf>` to `newTabId:<leaf>`, e.g. when a
 *  provisional pane is handed off to its host-confirmed tab id — otherwise the entry stays
 *  under the retired id and is lost the moment that pane's teardown prunes it. A target key
 *  that already holds a value is left alone and the source entry is dropped: the target can
 *  only have been written under the pane's final identity, so it's never older. */
export function rekeyTerminalDockPaneKeys(oldTabId: string, newTabId: string): void {
  if (oldTabId === newTabId || isUnsafeObjectKey(oldTabId) || isUnsafeObjectKey(newTabId)) {
    return
  }
  const map = readStoredMap()
  const prefix = `${oldTabId}:`
  let changed = false
  for (const key of Object.keys(map)) {
    if (!key.startsWith(prefix)) {
      continue
    }
    const targetKey = `${newTabId}:${key.slice(prefix.length)}`
    if (!(targetKey in map)) {
      map[targetKey] = map[key]
    }
    delete map[key]
    changed = true
  }
  if (!changed) {
    return
  }
  evictOldestEntries(map)
  writeStoredMap(map)
}

/** Drops dock state for panes that no longer exist, e.g. after a split closes. */
export function removeTerminalDockPaneKeys(paneKeys: ReadonlySet<string>): void {
  if (paneKeys.size === 0) {
    return
  }
  const map = readStoredMap()
  let changed = false
  for (const key of paneKeys) {
    if (key in map) {
      delete map[key]
      changed = true
    }
  }
  if (changed) {
    writeStoredMap(map)
  }
}
