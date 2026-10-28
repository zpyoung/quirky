/** The ten tab colours, drawn as a dot before a tab's close control. */
export const TAB_COLORS = ['none', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'teal', 'gray'] as const
export type PresetTabColor = (typeof TAB_COLORS)[number]
export type TabColor = PresetTabColor | `#${string}`

export function isTabColor(value: unknown): value is TabColor {
  return typeof value === 'string' && ((TAB_COLORS as readonly string[]).includes(value) || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value))
}

/** Hex values for each colour except `none`. */
export const TAB_COLOR_HEX: Record<Exclude<PresetTabColor, 'none'>, string> = {
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  teal: '#14b8a6',
  gray: '#9ca3af'
}

export type SplitDirection = 'right' | 'down'
export type Edge = 'left' | 'right' | 'top' | 'bottom'

/** The workspace ID of the floating workspace; every other workspace ID is a worktree ID. */
export const FLOATING_WORKSPACE = 'floating'

/** How a pane's process ended, kept while the pane stays to show its output. */
export type PaneExit = { code: number | null; signal: string | null }

/** `typed` is set once the pane's session has received driving input, so the exit rule survives a daemon restart. */
export type PaneLeaf = { kind: 'pane'; id: string; session: string; title: string | null; exit: PaneExit | null; typed?: true }
export type PaneSplit = { kind: 'split'; id: string; direction: SplitDirection; ratio: number; first: PaneNode; second: PaneNode }
export type PaneNode = PaneLeaf | PaneSplit

export type TerminalTab = {
  /** Older terminal rows intentionally omit this discriminator. */
  kind?: never
  id: string
  defaultTitle: string
  customTitle: string | null
  /** The active pane's latest OSC title. */
  liveTitle: string | null
  color: TabColor
  pinned: boolean
  root: PaneNode
  activePane: string
  expandedPane: string | null
  createdAt: string
}

/** A public hosted view in the existing workspace strip, with no pane or session. */
export type ViewTab = {
  kind: 'view'
  id: string
  viewId: string
  key: string
  input?: Record<string, unknown>
  title: string
  color: TabColor
  pinned: boolean
  preview: boolean
  closeCommand?: string
  closeMethod?: string
  closeParams?: Record<string, unknown>
  /** Opts this hosted view into host-computed close context for its guard method. */
  closeContext?: boolean
  createdAt: string
}

export type Tab = TerminalTab | ViewTab

export const isViewTab = (tab: Tab): tab is ViewTab => tab.kind === 'view'
export const isTerminalTab = (tab: Tab): tab is TerminalTab => !isViewTab(tab)

export type Group = {
  kind: 'group'
  id: string
  tabs: Tab[]
  activeTab: string | null
  /** Tab IDs, most recently used first. */
  recent: string[]
  lastQuickCommand: string | null
}
export type GroupSplit = { kind: 'split'; id: string; direction: SplitDirection; ratio: number; first: GroupNode; second: GroupNode }
export type GroupNode = Group | GroupSplit

/** A tab remembered for `reopenTab`; reopening starts a fresh session from these fields. */
export type ClosedTab = { title: string | null; defaultTitle: string; color: TabColor; cwd: string; agent: string; closedAt: string }

/** The tab area of one worktree, or of the floating workspace; every change bumps `revision` by one. */
export type Workspace = {
  id: string
  revision: number
  root: GroupNode
  activeGroup: string
  /** At most ten, newest first. */
  closed: ClosedTab[]
}

export type FloatingBounds = { x: number; y: number; width: number; height: number }

export type FloatingState = {
  enabled: boolean
  open: boolean
  maximized: boolean
  /** Window-relative CSS px; null means the default placement. */
  bounds: FloatingBounds | null
  button: { x: number; y: number } | null
}

export type QuickCommand = {
  id: string
  label: string
  kind: 'terminal' | 'agent'
  agent: string | null
  command: string
  appendEnter: boolean
  scope: 'global' | 'repo'
  repo: string | null
}

export const MAX_CLOSED_TABS = 10
export const GROUP_RATIO_MIN = 0.15
export const GROUP_RATIO_MAX = 0.85
export const QUICK_COMMAND_LIMITS = { count: 40, label: 80, command: 4000, id: 80, repo: 200 } as const
export const TITLE_MAX = 200
export const FLOATING_DEFAULTS = { width: 920, height: 560, minWidth: 420, minHeight: 280, right: 24, bottom: 84, margin: 12 } as const
