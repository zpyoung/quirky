import {
  UI_TOOL_SLOTS,
  type UiModel,
  type UiSlotEntry,
  type UiToolEntry,
  type UiToolHue,
  type UiToolLayout,
  type UiToolPlacement,
  type UiToolSlot
} from '@quirky/protocol'

const WORKTREES = 'sidebar-section:quirky.worktree/worktrees'
const CHANGES = 'panel:quirky.git/source-control'
const FILES = 'panel:quirky.editor/explorer'
const EDITOR_SIDEBAR = 'sidebar-section:quirky.editor/explorer'
const SOURCE_CONTROL_ACTIVITY = 'activity-item:quirky.sidebar-extras/source-control'
const TASKS = 'sidebar-section:quirky.tasks/tasks'
const REMOTE_WORKSPACES = 'sidebar-section:quirky.worktree/remote-workspaces'
const AGENT_ACTIVITY = 'sidebar-section:quirky.agent-status/activity'
const AGENT_DASHBOARD = 'sidebar-section:quirky.agent-status/dashboard'
const HEIMDALL = 'sidebar-section:quirky.heimdall/navigation'
const AUTOMATIONS = 'sidebar-section:quirky.automations/automations'
const MOBILE = 'sidebar-section:quirky.mobile/mobile'
const REVIEWS = 'view:quirky.reviews/review'
const LEDGER = 'panel:quirky.ledger/ledger'
const LEDGER_SIDEBAR = 'sidebar-section:quirky.ledger/ledger'
const TASKS_VIEW = 'view:quirky.tasks/tasks'
const HEIMDALL_VIEW = 'view:quirky.heimdall/fleet'
const AUTOMATIONS_VIEW = 'view:quirky.automations/automations'
const MOBILE_VIEW = 'view:quirky.mobile/page'

const FALLBACK_SLOT: UiToolSlot = 'right-bottom'
const DEFAULT_SIZES: UiToolLayout['sizes'] = {
  left: 280,
  right: 320,
  bottom: 240,
  leftSplit: 0.5,
  rightSplit: 0.5,
  bottomSplit: 0.5
}
const SIZE_BOUNDS: Record<keyof UiToolLayout['sizes'], readonly [number, number]> = {
  left: [160, 1200],
  right: [160, 1200],
  bottom: [100, 1000],
  leftSplit: [0.15, 0.85],
  rightSplit: [0.15, 0.85],
  bottomSplit: [0.15, 0.85]
}
export const TOOL_SIZE_FIELDS = ['left', 'right', 'bottom', 'leftSplit', 'rightSplit', 'bottomSplit'] as const satisfies readonly (keyof UiToolLayout['sizes'])[]
const SIZE_KEYS = TOOL_SIZE_FIELDS

type ToolSource = UiSlotEntry & { hue?: UiToolHue }

const RULES: {
  id: string
  body?: string
  aliases?: string[]
  title: string
  icon: string
  hue: UiToolHue
  defaultSlot: UiToolSlot
}[] = [
  { id: WORKTREES, title: 'Worktrees', icon: 'git-branch', hue: 'blue', defaultSlot: 'left-top' },
  { id: REMOTE_WORKSPACES, title: 'Remote workspaces', icon: 'hard-drives', hue: 'slate', defaultSlot: FALLBACK_SLOT },
  { id: AGENT_ACTIVITY, title: 'Activity', icon: 'pulse', hue: 'coral', defaultSlot: FALLBACK_SLOT },
  { id: AGENT_DASHBOARD, title: 'Agent Dashboard', icon: 'gauge', hue: 'mint', defaultSlot: FALLBACK_SLOT },
  { id: CHANGES, title: 'Changes', icon: 'git-diff', hue: 'azure', defaultSlot: 'right-top', aliases: [SOURCE_CONTROL_ACTIVITY] },
  { id: FILES, title: 'Files', icon: 'folders', hue: 'sand', defaultSlot: 'right-top', aliases: [EDITOR_SIDEBAR] },
  { id: 'panel:quirky.reviews/checks', title: 'Checks', icon: 'check-circle', hue: 'mint', defaultSlot: 'right-top' },
  { id: 'panel:quirky.ask/questions', title: 'Ask', icon: 'chat-circle-dots', hue: 'lilac', defaultSlot: 'right-top' },
  { id: REVIEWS, title: 'Reviews', icon: 'git-pull-request', hue: 'rose', defaultSlot: 'right-top' },
  { id: 'panel:quirky.session-info/info', title: 'Session info', icon: 'info', hue: 'slate', defaultSlot: 'right-bottom' },
  { id: 'panel:quirky.vault/history', title: 'Vault', icon: 'vault', hue: 'sand', defaultSlot: 'right-bottom' },
  { id: TASKS, body: TASKS_VIEW, title: 'Tasks', icon: 'list-checks', hue: 'teal', defaultSlot: 'left-bottom' },
  { id: HEIMDALL, body: HEIMDALL_VIEW, title: 'Heimdall', icon: 'robot', hue: 'coral', defaultSlot: 'left-bottom' },
  { id: AUTOMATIONS, body: AUTOMATIONS_VIEW, title: 'Automations', icon: 'flow-arrow', hue: 'magenta', defaultSlot: 'left-bottom' },
  { id: MOBILE, body: MOBILE_VIEW, title: 'Mobile', icon: 'device-mobile', hue: 'slate', defaultSlot: 'left-bottom' },
  { id: LEDGER, title: 'Ledger', icon: 'book-open-text', hue: 'tan', defaultSlot: 'bottom-left', aliases: [LEDGER_SIDEBAR] },
  { id: 'panel:quirky.terminal/sessions', title: 'Terminal sessions', icon: 'terminal-window', hue: 'cyan', defaultSlot: 'bottom-left' },
  { id: 'panel:quirky.terminal/quick-commands', title: 'Quick commands', icon: 'command', hue: 'plum', defaultSlot: 'bottom-left' }
]
const TOOL_ORDER = [
  WORKTREES,
  'host:inbox',
  TASKS,
  HEIMDALL,
  AUTOMATIONS,
  MOBILE,
  CHANGES,
  FILES,
  'panel:quirky.reviews/checks',
  'panel:quirky.ask/questions',
  REVIEWS,
  'panel:quirky.session-info/info',
  'panel:quirky.vault/history',
  LEDGER,
  'panel:quirky.terminal/sessions',
  'panel:quirky.terminal/quick-commands'
] as const
const RULE_ORDER = new Map<string, number>(TOOL_ORDER.map((id, index) => [id, index]))

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isToolSlot(value: unknown): value is UiToolSlot {
  return typeof value === 'string' && (UI_TOOL_SLOTS as readonly string[]).includes(value)
}

function isToolPlacement(value: unknown): value is UiToolPlacement {
  return value === 'overflow' || isToolSlot(value)
}

function isSize(key: keyof UiToolLayout['sizes'], value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const [minimum, maximum] = SIZE_BOUNDS[key]
  return value >= minimum && value <= maximum
}

function bodyEntries(model: Pick<UiModel, 'panels' | 'sidebarSections' | 'activityItems' | 'views'>): Map<string, ToolSource> {
  return new Map([...model.panels, ...model.sidebarSections, ...model.activityItems, ...model.views].map((entry) => [entry.id, entry]))
}

/** Projects effective registration points into tools while retaining their original code IDs as aliases. */
export function projectTools(model: Pick<UiModel, 'panels' | 'sidebarSections' | 'activityItems' | 'views'>): UiToolEntry[] {
  const entries = bodyEntries(model)
  const tools: UiToolEntry[] = [{
    id: 'host:inbox',
    title: 'Inbox',
    icon: 'tray',
    hue: 'violet',
    defaultSlot: 'left-bottom',
    contributionId: null,
    aliases: []
  }]
  const consumed = new Set<string>()

  for (const rule of RULES) {
    const source = entries.get(rule.id)
    const bodyId = rule.body ?? rule.id
    const body = entries.get(bodyId)
    if (rule.body !== undefined && source) consumed.add(rule.id)
    if (!source || !body || source.module === null || body.module === null) continue
    const aliases = [rule.id, bodyId, ...(rule.aliases ?? [])].filter((id, index, all) =>
      entries.has(id) && all.indexOf(id) === index
    )
    for (const id of aliases) consumed.add(id)
    tools.push({
      id: rule.id,
      title: rule.title,
      icon: source.icon ?? body.icon ?? rule.icon,
      hue: source.hue ?? body.hue ?? rule.hue,
      defaultSlot: source.defaultSlot ?? body.defaultSlot ?? rule.defaultSlot,
      contributionId: body.id,
      aliases
    })
  }

  const remaining: ToolSource[] = [...model.panels, ...model.sidebarSections, ...model.activityItems]
  for (const entry of remaining) {
    if (consumed.has(entry.id) || entry.module === null) continue
    consumed.add(entry.id)
    tools.push({
      id: entry.id,
      title: entry.title,
      icon: entry.icon ?? (entry.kind === 'activity-item' ? 'pulse' : entry.kind === 'sidebar-section' ? 'sidebar' : 'squares-four'),
      hue: entry.hue ?? 'slate',
      defaultSlot: entry.defaultSlot ?? FALLBACK_SLOT,
      contributionId: entry.id,
      aliases: [entry.id]
    })
  }

  return tools.sort((a, b) => {
    const aRank = RULE_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const bRank = RULE_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return aRank - bRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

function emptyOpen(): UiToolLayout['open'] {
  return {
    'left-top': null,
    'left-bottom': null,
    'right-top': null,
    'right-bottom': null,
    'bottom-left': null,
    'bottom-right': null
  }
}

function baseLayout(tools: UiToolEntry[]): UiToolLayout {
  return {
    placements: Object.fromEntries(tools.map((tool) => [tool.id, tool.defaultSlot])),
    order: tools.map((tool) => tool.id),
    open: emptyOpen(),
    sizes: { ...DEFAULT_SIZES }
  }
}

/** First launch defaults; no unavailable built-in tools are synthesized. */
export function freshToolLayout(tools: UiToolEntry[]): UiToolLayout {
  const layout = baseLayout(tools)
  const worktrees = tools.find(({ id }) => id === WORKTREES)
  const changes = tools.find(({ id }) => id === CHANGES)
  if (worktrees) layout.open[worktrees.defaultSlot] = worktrees.id
  if (changes) layout.open[changes.defaultSlot] = changes.id
  return layout
}

/** Validates stored tool state against the current effective projection, or deliberately migrates the prior panel/sidebar layout. */
export function resolveToolLayout(
  tools: UiToolEntry[],
  stored: unknown,
  options: { hasStoredTools: boolean; hasStoredLayout: boolean; sidebar: boolean; panel: string | null }
): UiToolLayout {
  const current = baseLayout(tools)
  if (!options.hasStoredLayout) return freshToolLayout(tools)

  if (!options.hasStoredTools) {
    if (options.sidebar) {
      const worktrees = tools.find(({ id }) => id === WORKTREES)
      if (worktrees) current.open[worktrees.defaultSlot] = worktrees.id
    }
    if (options.panel !== null) {
      const panelTool = tools.find((tool) => tool.contributionId === options.panel || tool.aliases.includes(options.panel!))
      if (panelTool) current.open[panelTool.defaultSlot] = panelTool.id
    }
    return current
  }

  const saved = isRecord(stored) ? stored : {}
  const savedPlacements = isRecord(saved.placements) ? saved.placements : {}
  for (const tool of tools) {
    const placement = savedPlacements[tool.id]
    if (isToolPlacement(placement)) current.placements[tool.id] = placement
  }

  const savedOrder = Array.isArray(saved.order) ? saved.order : []
  const seenOrder = new Set<string>()
  current.order = []
  for (const id of savedOrder) {
    if (typeof id !== 'string' || !Object.hasOwn(current.placements, id) || seenOrder.has(id)) continue
    seenOrder.add(id)
    current.order.push(id)
  }
  for (const tool of tools) {
    if (seenOrder.has(tool.id)) continue
    seenOrder.add(tool.id)
    current.order.push(tool.id)
  }

  const savedOpen = isRecord(saved.open) ? saved.open : {}
  const opened = new Set<string>()
  for (const slot of UI_TOOL_SLOTS) {
    const id = savedOpen[slot]
    if (typeof id !== 'string' || opened.has(id) || current.placements[id] !== slot) continue
    current.open[slot] = id
    opened.add(id)
  }

  const savedSizes = isRecord(saved.sizes) ? saved.sizes : {}
  for (const key of SIZE_KEYS) {
    const value = savedSizes[key]
    if (isSize(key, value)) current.sizes[key] = value
  }
  return current
}


export function validToolSize(key: keyof UiToolLayout['sizes'], value: unknown): value is number {
  return isSize(key, value)
}
