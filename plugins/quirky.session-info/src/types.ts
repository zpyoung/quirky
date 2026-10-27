export type SectionId = 'identity' | 'usage' | 'liveActivity' | 'context' | 'filesTouched' | 'hooksAndMcp'

export type PanelState = {
  session: string | null
  pane: string | null
  workspace: string | null
  openSections: SectionId[]
  info: SessionInfo | null
}

export type SessionInfo = {
  identity: Identity
  liveActivity: LiveActivity
  usage?: Usage
  context?: Context
  filesTouched?: FilesTouched
  hooksAndMcp?: Inspection
}

export type Identity = {
  agent: string
  sessionId: string
  providerSessionId: string | null
  model?: string
  pane: string | null
  paneTitle?: string
  worktreeId: string
  cwd: string
  startedAt: number
  updatedAt: number
  transcriptPath?: string
  version?: string
  outputStyle?: string
  branch?: string
}

export type LiveActivity = {
  state: string
  label: string
  toolName?: string
  toolInput?: string
  subagentCount: number
  startedAt: number
  updatedAt: number
}

export type Usage = {
  status: 'waiting' | 'ready'
  freshness?: 'fresh' | 'refreshing' | 'stale'
  totalTokens?: number
  turnCount?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  updatedAt?: number
  error?: string
}

export type Context = {
  status: 'waiting' | 'ready'
  usedPercentage?: number
  remainingPercentage?: number
  window?: number
  used?: number
  remaining?: number
  estimated?: boolean
  updatedAt?: number
  planWindows?: { fiveHour?: PlanWindow; sevenDay?: PlanWindow }
}

export type PlanWindow = { usedPercentage: number; resetsAt: number }

export type FilesTouched = { added?: number; removed?: number; updatedAt: number }

export type Inspection = {
  hooks?: { state: string; detail?: string }
  statusline?: { state: 'managed' | 'chained' | 'available' | 'drifted' | 'disabled' | 'error'; detail?: string }
  mcp: { name: string; transport: string; state: 'enabled' | 'disabled' | 'invalid' }[]
  updatedAt: number
  error?: string
}
