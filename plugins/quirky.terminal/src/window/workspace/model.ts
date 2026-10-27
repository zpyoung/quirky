import type { AgentDisplayState, AgentStatusSummary, Session, SessionStatus, UiPluginContext } from '@quirky/protocol'
import { displayTitle, recentOrder } from '../../layout/titles'
import { findGroup, groupsInOrder, paneLeaves } from '../../layout/tree'
import type { Rect } from '../../layout/tree'
import { isTerminalTab } from '../../layout/types'
import type { Group, GroupNode, GroupSplit, PaneLeaf, Tab, TerminalTab, Workspace } from '../../layout/types'
import type { PaneReport } from '../pane/TerminalPaneView'

export const STRUCTURED_VIEW_ID = 'view:quirky.session/structured'

/** The settings the workspace reads beyond what a pane does. */
export type WorkspaceSettings = PaneSettings & {
  'divider-thickness': number
  'confirm-close-running': boolean
  'confirm-close-pinned': boolean
  'ctrl-tab-order': 'mru' | 'sequential'
}

const WORKSPACE_DEFAULTS = {
  'divider-thickness': 3,
  'confirm-close-running': true,
  'confirm-close-pinned': true,
  'ctrl-tab-order': 'mru'
} as const

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = { ...DEFAULT_PANE_SETTINGS, ...WORKSPACE_DEFAULTS }

/**
 * Reads every setting the workspace uses. `overrides` (short names) win over the context's
 * values, since a `setting.changed` event can arrive before the window's own copy updates.
 */
export function readWorkspaceSettings(context: Pick<UiPluginContext, 'getSetting'>, overrides: Record<string, unknown> = {}): WorkspaceSettings {
  const settings: Record<string, unknown> = { ...readPaneSettings(context), ...WORKSPACE_DEFAULTS }
  for (const id of Object.keys(WORKSPACE_DEFAULTS)) {
    try {
      const value = context.getSetting(id)
      if (value !== undefined && value !== null) settings[id] = value
    } catch {
      // an unknown setting keeps its default
    }
  }
  for (const [id, value] of Object.entries(overrides)) if (id in settings) settings[id] = value
  return settings as WorkspaceSettings
}

/** The short name of a `setting:quirky.terminal/<name>` ID, or null for another plugin's setting. */
export function terminalSettingName(id: string): string | null {
  const match = /^(?:setting:)?quirky\.terminal\/(.+)$/.exec(id)
  return match ? match[1]! : null
}

export type DisplayStatus = Exclude<SessionStatus, 'starting'>

/** A starting session shows as running; every other status shows as itself. */
export function displayStatus(status: SessionStatus): DisplayStatus {
  return status === 'starting' ? 'running' : status
}

/** How long an unfinished state may go without evidence before the window stops vouching for it. */
export const STALE_AFTER_MS = 30 * 60 * 1000

export type WindowDisplay = { display: AgentDisplayState; label: string }

/**
 * What a tab draws for an agent-status summary at `now`: the summary's own display and label,
 * unless the state is unfinished and has had no evidence for 30 minutes. A restored-unconfirmed
 * summary never decays: only fresh evidence confirms it. Window code can't import plugin code, so
 * this is a copy of `quirky.session/src/window/status.ts`; keep the two in step.
 */
export function windowDisplay(summary: AgentStatusSummary, now: number, sessionRunning: boolean): WindowDisplay {
  if (summary.state !== 'done' && !summary.restoredUnconfirmed && now - summary.evidenceAt > STALE_AFTER_MS) {
    return sessionRunning ? { display: 'unverifiable', label: 'No recent update' } : { display: 'idle', label: 'Idle' }
  }
  return { display: summary.display, label: summary.label }
}

const RING_STATES: AgentDisplayState[] = ['working', 'waiting', 'permission']

/** The whole-number percent (progress is already 0-100) a ring shows, or null when the state keeps its own glyph. */
export function ringPercent(summary: AgentStatusSummary, display: AgentDisplayState): number | null {
  if (summary.progress === null || !Number.isFinite(summary.progress) || !RING_STATES.includes(display)) return null
  return Math.round(Math.min(100, Math.max(0, summary.progress)))
}

export type TabLocation = { group: Group; tab: Tab }
export type PaneLocation = { group: Group; tab: TerminalTab; leaf: PaneLeaf }

export function locateTab(ws: Workspace, tabId: string): TabLocation | null {
  for (const group of groupsInOrder(ws.root)) {
    const tab = group.tabs.find((candidate) => candidate.id === tabId)
    if (tab) return { group, tab }
  }
  return null
}

export function locatePane(ws: Workspace, paneId: string): PaneLocation | null {
  for (const group of groupsInOrder(ws.root)) {
    for (const tab of group.tabs) {
      if (!isTerminalTab(tab)) continue
      const leaf = paneLeaves(tab.root).find((candidate) => candidate.id === paneId)
      if (leaf) return { group, tab, leaf }
    }
  }
  return null
}

export function locateSession(ws: Workspace, sessionId: string): PaneLocation | null {
  for (const group of groupsInOrder(ws.root)) {
    for (const tab of group.tabs) {
      if (!isTerminalTab(tab)) continue
      const leaf = paneLeaves(tab.root).find((candidate) => candidate.session === sessionId)
      if (leaf) return { group, tab, leaf }
    }
  }
  return null
}

export function activeTabOf(group: Group): Tab | null {
  return group.tabs.find((tab) => tab.id === group.activeTab) ?? group.tabs[0] ?? null
}

/** The active tab of the workspace's active group. */
export function focusedTabOf(ws: Workspace): TabLocation | null {
  const group = findGroup(ws.root, ws.activeGroup) ?? groupsInOrder(ws.root)[0]
  const tab = group ? activeTabOf(group) : null
  return group && tab ? { group, tab } : null
}

/** The pane that has keyboard focus in the workspace: the active pane of the active tab of the active group. */
export function focusedPaneOf(ws: Workspace): PaneLocation | null {
  const at = focusedTabOf(ws)
  if (!at || !isTerminalTab(at.tab)) return null
  const leaf = paneLeaves(at.tab.root).find((candidate) => candidate.id === at.tab.activePane) ?? paneLeaves(at.tab.root)[0]
  return leaf ? { ...at, tab: at.tab, leaf } : null
}

/** The panes a window mounts: each group's active terminal tab, or only its expanded pane. */
export function mountedPanes(ws: Workspace): PaneLocation[] {
  const mounted: PaneLocation[] = []
  for (const group of groupsInOrder(ws.root)) {
    const tab = activeTabOf(group)
    if (!tab || !isTerminalTab(tab)) continue
    for (const leaf of paneLeaves(tab.root)) {
      if (tab.expandedPane === null || tab.expandedPane === leaf.id) mounted.push({ group, tab, leaf })
    }
  }
  return mounted
}

/** What a `ui.state` report lists for each pane of every tab, in visual order. `display` and `label` are present for a pane whose session has an agent-status summary. */
export type TabReport = {
  session: string
  title: string
  agent: string
  status: DisplayStatus
  tab: string
  group: string
  pane: string
  display?: AgentDisplayState
  label?: string
}

export function tabsReport(ws: Workspace, sessions: Readonly<Record<string, Session>>, now: number = Date.now()): TabReport[] {
  const rows: TabReport[] = []
  for (const group of groupsInOrder(ws.root)) {
    for (const tab of group.tabs) {
      if (!isTerminalTab(tab)) continue
      for (const leaf of paneLeaves(tab.root)) {
        const session = sessions[leaf.session]
        rows.push({
          session: leaf.session,
          title: displayTitle(tab),
          agent: session?.agent ?? 'shell',
          status: session ? displayStatus(session.status) : 'running',
          tab: tab.id,
          group: group.id,
          pane: leaf.id,
          ...(session?.agentStatus ? windowDisplay(session.agentStatus, now, session.status !== 'exited') : {})
        })
      }
    }
  }
  return rows
}

export type PaneStateReport = {
  pane: string
  session: string
  cols: number
  rows: number
  fontSize: number
  webgl: boolean
  search: PaneReport['search']
  exitOverlay: boolean
}

export function panesReport(ws: Workspace, states: Readonly<Record<string, PaneReport>>, fontSize: number): PaneStateReport[] {
  return mountedPanes(ws).map(({ leaf }) => {
    const state = states[leaf.id]
    return {
      pane: leaf.id,
      session: leaf.session,
      cols: state?.cols ?? 0,
      rows: state?.rows ?? 0,
      fontSize: state?.fontSize ?? fontSize,
      webgl: state?.webgl ?? false,
      search: state?.search ?? null,
      exitOverlay: leaf.exit !== null
    }
  })
}

/** Whether a `describeClose` question names an agent and no plain command. */
export function isAgentQuestion(question: string): boolean {
  const lines = question.split('\n').filter((line) => line.trim() !== '')
  return lines.length > 0 && lines.every((line) => line.startsWith('Stop agent '))
}

/** Tab IDs in the order the Ctrl+Tab list shows them. */
export function switcherOrder(group: Group, order: 'mru' | 'sequential'): string[] {
  return order === 'sequential' ? group.tabs.map((tab) => tab.id) : recentOrder(group.tabs, group.recent)
}

/** Pane IDs in a stable order, so a re-ordered tree never re-orders the DOM. */
export function byPaneId<T extends { id: string }>(items: readonly T[]): T[] {
  const number = (id: string) => Number(id.replace(/^\D+/, '')) || 0
  return [...items].sort((a, b) => number(a.id) - number(b.id) || a.id.localeCompare(b.id))
}

/** `n` px rounded to whole pixels so panes tile without gaps. */
export const px = (n: number) => Math.round(n)

/** Whether an RPC error carries `code`. */
export function hasCode(error: unknown, code: number): boolean {
  return (error as { code?: number } | null)?.code === code
}

export type GroupRect = Rect & { group: Group }
export type GroupDividerRect = Rect & { split: GroupSplit; area: Rect }

/**
 * Lays the group tree out in a `width` x `height` area: one rectangle per group and one per
 * divider, with each divider `dividerPx` thick between its two sides. `area` of a divider is the
 * whole rectangle its split divides, for turning a pointer position into a ratio.
 */
export function groupRects(root: GroupNode, width: number, height: number, dividerPx: number): { groups: GroupRect[]; dividers: GroupDividerRect[] } {
  const groups: GroupRect[] = []
  const dividers: GroupDividerRect[] = []

  const walk = (node: GroupNode, area: Rect) => {
    if (node.kind === 'group') {
      groups.push({ group: node, ...area })
      return
    }
    if (node.direction === 'right') {
      const first = Math.max(0, area.width - dividerPx) * node.ratio
      dividers.push({ split: node, x: area.x + first, y: area.y, width: dividerPx, height: area.height, area })
      walk(node.first, { ...area, width: first })
      walk(node.second, { ...area, x: area.x + first + dividerPx, width: Math.max(0, area.width - first - dividerPx) })
    } else {
      const first = Math.max(0, area.height - dividerPx) * node.ratio
      dividers.push({ split: node, x: area.x, y: area.y + first, width: area.width, height: dividerPx, area })
      walk(node.first, { ...area, height: first })
      walk(node.second, { ...area, y: area.y + first + dividerPx, height: Math.max(0, area.height - first - dividerPx) })
    }
  }

  walk(root, { x: 0, y: 0, width, height })
  return { groups, dividers }
}
