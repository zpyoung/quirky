import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { PluginContext, PluginStore, QuirkyEvent } from '@quirky/protocol'
import { isRecord } from './json'
import { inspectMcp, type McpInspectionResult } from './mcp-inspector'
import { scanClaudeUsage } from './usage-scanner'
import { claudeConfigDir, resolveClaudeSettings, statusLineIdentity, type EffectiveClaudeSettings, type SessionLaunchRecord, type SettingsResolutionInput } from './claude-settings'
import { writeStatuslineRunner } from './statusline-runner'
import type { Context, FilesTouched, Identity, Inspection, LiveActivity, PanelState, PlanWindow, SectionId, SessionInfo, Usage } from './types'

const MAX_SNAPSHOTS = 256
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
const MAX_PATH_LENGTH = 32_768
const MAX_PROVIDER_ID_LENGTH = 512
const MAX_ERROR_LENGTH = 500
const MAX_TOOL_INPUT_LENGTH = 500
const SECTIONS: readonly SectionId[] = ['identity', 'usage', 'liveActivity', 'context', 'filesTouched', 'hooksAndMcp']
const SECTION_SET: Record<SectionId, true> = { identity: true, usage: true, liveActivity: true, context: true, filesTouched: true, hooksAndMcp: true }
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const TELEMETRY_CONSENT_KEY = 'telemetry-consent'
const SECTIONS_KEY = 'open-sections'

export const SESSION_INFO_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`
]

type SessionRecord = {
  id: string
  kind: string
  agent: string
  worktreeId: string
  cwd: string
  title: string
  status: string
  createdAt: number
  lastActivityAt: number
  providerSession?: { id?: string; transcriptPath?: string | null } | null
  launch?: SessionLaunchRecord | null
  agentStatus?: { state?: string; display?: string; label?: string; detail?: string; stateStartedAt?: number; evidenceAt?: number } | null
}

type AgentStatusRow = {
  agent?: string
  state?: string
  display?: string
  label?: string
  model?: string
  toolName?: string
  toolInput?: string
  children?: { kind?: string; state?: string }[]
  lead?: { providerSession?: string | null }
  lastHookAt?: number | null
  sessionBoundary?: boolean
  stateStartedAt?: number
  evidenceAt?: number
}

type PaneLeaf = { kind: 'pane'; id: string; session: string; title: string | null }
type PaneSplit = { kind: 'split'; first: PaneNode; second: PaneNode }
type PaneNode = PaneLeaf | PaneSplit
type Tab = { id: string; defaultTitle: string; customTitle: string | null; liveTitle: string | null; root: PaneNode; activePane: string }
type Group = { kind: 'group'; id: string; tabs: Tab[]; activeTab: string | null }
type GroupSplit = { kind: 'split'; first: GroupNode; second: GroupNode }
type GroupNode = Group | GroupSplit
type Workspace = { id: string; root: GroupNode; activeGroup: string }
type UiState = { layout?: { view?: { id?: string } | null } }
type FocusLocation = { workspace: string; pane: string | null; paneTitle?: string }
type StatuslineCache = {
  context?: Context
  filesTouched?: FilesTouched
  model?: string
  version?: string
  outputStyle?: string
  cwd?: string
  branch?: string
  updatedAt?: number
}
type Snapshot = {
  key: string
  sessionId: string
  providerSessionId: string | null
  telemetry: StatuslineCache
  usage?: Usage
  transcriptContext?: Context
  transcriptModel?: string
  transcriptCwd?: string
  transcriptBranch?: string
  inspection?: Inspection
  scanGeneration: number
}
type Consent = { mode: 'disabled' } | { mode: 'consented'; identity: string }
type StatuslineChoice = {
  statusline: NonNullable<Inspection['statusline']>
  customCommand?: string
  identity?: string
  overlay: boolean
}
type ExtendedLaunchInput = {
  sessionId: string
  worktreeId: string
  repoId: string
  cwd: string
  agent: string
  env: Readonly<Record<string, string>>
  args: readonly string[]
  record?: SessionLaunchRecord | null
  model?: unknown
  options?: unknown
  extraArgs?: string
}



function validString(value: unknown, limit = MAX_PATH_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !CONTROL_CHARACTERS.test(value)
    ? value
    : undefined
}

function validCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function validPercentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined
}

function validWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
}

function sessionProviderId(session: SessionRecord): string | null {
  const id = session.providerSession?.id
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_PROVIDER_ID_LENGTH && !CONTROL_CHARACTERS.test(id) ? id : null
}

function sessionTranscriptPath(session: SessionRecord): string | undefined {
  const path = session.providerSession?.transcriptPath
  return validString(path, MAX_PATH_LENGTH)
}

function snapshotKey(sessionId: string, providerSessionId: string | null): string {
  return `${sessionId}\u0000${providerSessionId ?? ''}`
}

function walkGroup(node: GroupNode, visit: (group: Group) => Group | undefined): Group | undefined {
  if (node.kind === 'group') return visit(node)
  return walkGroup(node.first, visit) ?? walkGroup(node.second, visit)
}

function walkPanes(node: PaneNode, visit: (pane: PaneLeaf) => PaneLeaf | undefined): PaneLeaf | undefined {
  if (node.kind === 'pane') return visit(node)
  return walkPanes(node.first, visit) ?? walkPanes(node.second, visit)
}

function paneLocation(workspace: Workspace, pane: PaneLeaf, tab?: Tab): FocusLocation {
  const paneTitle = pane.title || tab?.customTitle || tab?.liveTitle || tab?.defaultTitle
  return { workspace: workspace.id, pane: pane.id, ...(paneTitle ? { paneTitle } : {}) }
}

function activePaneOf(workspace: Workspace): { pane: PaneLeaf; tab: Tab } | null {
  const group = walkGroup(workspace.root, (candidate) => candidate.id === workspace.activeGroup ? candidate : undefined)
  if (!group || !group.activeTab) return null
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTab)
  if (!tab) return null
  const pane = walkPanes(tab.root, (candidate) => candidate.id === tab.activePane ? candidate : undefined)
  return pane ? { pane, tab } : null
}

function findSessionPane(workspace: Workspace, sessionId: string): FocusLocation | null {
  let result: FocusLocation | null = null
  const visit = (node: GroupNode) => {
    if (node.kind === 'group') {
      for (const tab of node.tabs) {
        const pane = walkPanes(tab.root, (candidate) => candidate.session === sessionId ? candidate : undefined)
        if (pane) result = paneLocation(workspace, pane, tab)
      }
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(workspace.root)
  return result
}

const ACTIVITY_LABELS: Record<string, string> = {
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  idle: 'Idle',
  interrupted: 'Interrupted',
  monitoring: 'Monitoring',
  permission: 'Needs permission',
  running: 'Working',
  starting: 'Starting',
  unverifiable: 'Unverifiable',
  unconfirmed: 'Unconfirmed',
  waiting: 'Waiting',
  working: 'Working'
}

function userFacingStatus(state: string | undefined, display: string | undefined): { state: string; label: string } {
  const name = display || state || 'running'
  return { state: name, label: Object.hasOwn(ACTIVITY_LABELS, name) ? ACTIVITY_LABELS[name]! : name }
}

function localEnvironment(environment: Readonly<Record<string, string | null | undefined>> = {}): boolean {
  const env = { ...process.env, ...environment }
  return !['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'QUIRKY_REMOTE_HOST']
    .some((name) => validString(env[name]) !== undefined)
}

function localExecution(session: SessionRecord): boolean {
  return localEnvironment(session.launch?.env)
}

function localClaude(session: SessionRecord): boolean {
  return session.kind === 'terminal' && session.agent === 'claude' && localExecution(session)
}

function asStatuslineState(state: StatuslineChoice['statusline']['state'], detail?: string): NonNullable<Inspection['statusline']> {
  return { state, ...(detail ? { detail: detail.slice(0, MAX_ERROR_LENGTH) } : {}) }
}

function parsePlanWindow(value: unknown): PlanWindow | undefined {
  if (!isRecord(value)) return undefined
  const percentage = validPercentage(value.used_percentage)
  const resets = typeof value.resets_at === 'number' && Number.isFinite(value.resets_at) && value.resets_at >= 0
    ? value.resets_at * 1000
    : undefined
  if (percentage === undefined || resets === undefined || !Number.isFinite(resets)) return undefined
  return { usedPercentage: percentage, resetsAt: resets }
}

function parsePlanWindows(value: unknown): Context['planWindows'] {
  if (!isRecord(value)) return undefined
  const fiveHour = parsePlanWindow(value.five_hour)
  const sevenDay = parsePlanWindow(value.seven_day)
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
}

function applyContextWindow(previous: Context | undefined, value: unknown, now: number): Context | undefined {
  if (!isRecord(value)) return previous
  const usedPercentage = validPercentage(value.used_percentage)
  const remainingPercentage = validPercentage(value.remaining_percentage)
  const window = validWindow(value.context_window_size)
  if (usedPercentage === undefined && remainingPercentage === undefined && window === undefined) return previous
  const next: Context = { ...(previous ?? { status: 'ready' as const }), status: 'ready', updatedAt: now }
  if (usedPercentage !== undefined) next.usedPercentage = usedPercentage
  if (remainingPercentage !== undefined) next.remainingPercentage = remainingPercentage
  if (window !== undefined) next.window = window
  if (next.window !== undefined && next.usedPercentage !== undefined) next.used = Math.round(next.window * next.usedPercentage / 100)
  if (next.window !== undefined && next.remainingPercentage !== undefined) next.remaining = Math.round(next.window * next.remainingPercentage / 100)
  return next
}

function makeEmpty(openSections: SectionId[]): PanelState {
  return { session: null, pane: null, workspace: null, openSections, info: null }
}

export class SessionInfoService {
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly activeKeys = new Map<string, string>()
  private readonly unsubscribers: (() => void)[] = []
  private closed = false

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore
  ) {}

  start(): void {
    this.unsubscribers.push(this.context.subscribe((event) => this.onEvent(event)))
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.snapshots.clear()
    this.activeKeys.clear()
  }

  async get(params: Record<string, unknown>): Promise<PanelState> {
    const openSections = this.openSections()
    const focused = typeof params.session === 'string' ? null : await this.focusedSession()
    const session = typeof params.session === 'string' ? await this.requireSession(params.session) : focused?.session ?? null
    if (!session || session.kind !== 'terminal' || session.agent === 'shell') return makeEmpty(openSections)
    const location = typeof params.session === 'string' ? await this.locationForSession(session) : focused?.location ?? null
    const snapshot = this.snapshotFor(session)
    const info = await this.project(session, snapshot, location)
    return {
      session: session.id,
      pane: location?.pane ?? null,
      workspace: location?.workspace ?? session.worktreeId,
      openSections,
      info
    }

  }
  sections(params: Record<string, unknown>): { open: SectionId[] } {
    if (!Object.hasOwn(params, 'open')) return { open: this.openSections() }
    if (!Array.isArray(params.open) || params.open.some((id) => typeof id !== 'string' || !Object.hasOwn(SECTION_SET, id))) {
      throw this.context.error('invalid-params', `open must contain only ${SECTIONS.join(', ')}`)
    }
    const open = [...new Set(params.open as SectionId[])]
    try {
      this.store.run('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SECTIONS_KEY, JSON.stringify(open))
    } catch {
      // The UI may keep the requested open set for this window if durable storage is unavailable.
    }
    this.emitChanged(null)
    return { open }
  }

  async inspect(params: Record<string, unknown>): Promise<Inspection> {
    const session = typeof params.session === 'string' ? await this.requireSession(params.session) : await this.focusedSession().then((focused) => focused?.session ?? null)
    if (!session) throw this.context.error('not-found', 'no focused terminal agent session')
    const snapshot = this.snapshotFor(session)
    const [hooksResult, hookEvidenceResult, settingsResult, mcpResult] = await Promise.allSettled([
      localClaude(session) ? this.context.call('quirky.agent-status/hooksStatus', {}) : Promise.resolve(undefined),
      localClaude(session) ? this.context.call('quirky.agent-status/get', { session: session.id }) : Promise.resolve(undefined),
      localClaude(session) ? resolveClaudeSettings(this.context, await this.settingsInput(session)) : Promise.resolve(undefined),
      this.inspectWorkspaceMcp(session)
    ] as const)
    const errors: string[] = []
    let hooks: Inspection['hooks']
    let statusline: Inspection['statusline']
    let mcp: Inspection['mcp'] = []

    let hookEntry: Record<string, unknown> | undefined
    if (hooksResult.status === 'fulfilled' && Array.isArray(hooksResult.value)) {
      hookEntry = hooksResult.value.find((candidate) => isRecord(candidate) && candidate.agent === 'claude') as Record<string, unknown> | undefined
      if (hookEntry) hooks = { state: String(hookEntry.status ?? 'unknown'), ...(typeof hookEntry.message === 'string' ? { detail: hookEntry.message.slice(0, MAX_ERROR_LENGTH) } : {}) }
    } else if (hooksResult.status === 'rejected') {
      errors.push(`hooks: ${boundedError(hooksResult.reason)}`)
    }

    if (localClaude(session)) {
      const hookEvidence = hookEvidenceResult.status === 'fulfilled' && isRecord(hookEvidenceResult.value)
        ? hookEvidenceResult.value as AgentStatusRow
        : undefined
      const providerSessionId = sessionProviderId(session)
      const matchingHook = hookEvidence?.agent === 'claude' &&
        typeof hookEvidence.lastHookAt === 'number' &&
        Number.isFinite(hookEvidence.lastHookAt) &&
        providerSessionId !== null &&
        hookEvidence.lead?.providerSession === providerSessionId

      if (hookEvidenceResult.status === 'rejected') {
        const detail = boundedError(hookEvidenceResult.reason)
        hooks = { state: 'error', detail }
        errors.push(`hooks: ${detail}`)
      } else if (matchingHook) {
        hooks = { state: 'installed', detail: 'Claude hook activity was observed for this launch.' }
      } else if (hooksResult.status === 'rejected') {
        hooks = { state: 'error', detail: boundedError(hooksResult.reason) }
      } else if (!hooks || hooks.state === 'installed') {
        hooks = { state: 'waiting', detail: 'Waiting for a Claude hook event correlated with this launch.' }
      }
    }

    if (settingsResult.status === 'fulfilled' && settingsResult.value) {
      const resolution = settingsResult.value
      const choice = this.classifyStatusline(resolution)
      statusline = choice.statusline
      errors.push(...resolution.errors.map((error) => `statusline: ${error}`))
      if (resolution.errors.length > 0) statusline = asStatuslineState('error', resolution.errors.join('; '))
    } else if (settingsResult.status === 'rejected') {
      const detail = boundedError(settingsResult.reason)
      statusline = asStatuslineState('error', detail)
      errors.push(`statusline: ${detail}`)
    }

    if (mcpResult.status === 'fulfilled') {
      mcp = mcpResult.value.servers.map(({ name, transport, state }) => ({ name, transport, state }))
      errors.push(...mcpResult.value.errors.map((error) => `MCP: ${error}`))
    } else {
      errors.push(`MCP: ${boundedError(mcpResult.reason)}`)
    }

    const inspection: Inspection = {
      ...(hooks ? { hooks } : {}),
      ...(statusline ? { statusline } : {}),
      mcp,
      updatedAt: Date.now(),
      ...(errors.length > 0 ? { error: errors.join('; ').slice(0, MAX_ERROR_LENGTH) } : {})
    }
    if (this.isCurrent(snapshot)) snapshot.inspection = inspection
    this.emitChanged(session.id)
    await this.refreshUsage(session)
    return inspection
  }

  async telemetry(params: Record<string, unknown>): Promise<{ accepted: boolean }> {
    const sessionId = validString(params.session, MAX_PATH_LENGTH)
    if (!sessionId || !isRecord(params.payload)) throw this.context.error('invalid-params', 'session and payload are required')
    const session = await this.findSession(sessionId)
    if (!session || !localClaude(session)) return { accepted: false }
    return { accepted: this.ingestTelemetry(session, params.payload) }
  }

  async enableTelemetry(params: Record<string, unknown>): Promise<{ statusline: NonNullable<Inspection['statusline']>; nextLaunchEffect: string }> {
    const session = typeof params.session === 'string' ? await this.requireSession(params.session) : await this.focusedSession().then((focused) => focused?.session ?? null)
    if (!session || !localClaude(session)) throw this.context.error('not-found', 'no focused local Claude session')
    if (params.enabled !== undefined && typeof params.enabled !== 'boolean') throw this.context.error('invalid-params', 'enabled must be a boolean')
    const enabled = params.enabled !== false
    const resolution = await resolveClaudeSettings(this.context, await this.settingsInput(session))
    if (resolution.errors.length > 0) throw this.context.error('invalid-params', resolution.errors.join('; ').slice(0, MAX_ERROR_LENGTH))
    const choice = this.classifyStatusline(resolution)
    if (choice.statusline.state === 'error') throw this.context.error('invalid-params', choice.statusline.detail ?? 'Claude statusline configuration is invalid')
    if (!resolution.managed) {
      const identity = choice.identity
      if (!enabled) {
        this.setConsent({ mode: 'disabled' })
      } else if (choice.customCommand && identity) {
        this.setConsent({ mode: 'consented', identity })
      } else {
        this.clearConsent()
      }
    }
    const after = this.classifyStatusline(resolution)
    this.emitChanged(session.id)
    return {
      statusline: after.statusline,
      nextLaunchEffect: resolution.managed
        ? 'Claude managed policy controls the statusline; session telemetry cannot be applied.'
        : enabled
          ? 'Session telemetry will take effect on the next launch; running sessions are unchanged.'
          : 'Session telemetry will be disabled on the next launch; running sessions are unchanged.'
    }
  }

  async history(params: Record<string, unknown>): Promise<SessionRecord[]> {
    const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
    const sessions = (await this.context.call('quirky.session/list', {})) as SessionRecord[]
    if (!query) return sessions
    return sessions.filter((session) =>
      [session.id, session.title, session.providerSession?.id]
        .some((field) => typeof field === 'string' && field.toLowerCase().includes(query))
    )
  }

  async transcript(params: Record<string, unknown>): Promise<{ path: string; text: string }> {
    if (typeof params.session !== 'string' || params.session.length === 0) throw this.context.error('invalid-params', 'session is required')
    const session = await this.requireSession(params.session)
    if (!localExecution(session)) throw this.context.error('not-found', `session ${session.id} has no local transcript`)
    const path = sessionTranscriptPath(session)
    if (!path || !isAbsolute(path)) throw this.context.error('not-found', `session ${session.id} has no recorded local transcript`)
    let size: number
    try {
      size = (await stat(path)).size
    } catch (error) {
      throw this.context.error('not-found', `transcript is unavailable: ${boundedError(error)}`)
    }
    if (size > MAX_TRANSCRIPT_BYTES) throw this.context.error('not-found', `transcript exceeds the ${MAX_TRANSCRIPT_BYTES / (1024 * 1024)} MiB display limit`)
    const chunks: Buffer[] = []
    let bytesRead = 0
    let oversized = false
    try {
      for await (const chunk of createReadStream(path, { start: 0, end: MAX_TRANSCRIPT_BYTES, highWaterMark: 64 * 1024 })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (bytesRead + buffer.length > MAX_TRANSCRIPT_BYTES) {
          oversized = true
          break
        }
        chunks.push(buffer)
        bytesRead += buffer.length
      }
    } catch (error) {
      throw this.context.error('not-found', `transcript is unavailable: ${boundedError(error)}`)
    }
    if (oversized) throw this.context.error('not-found', `transcript exceeds the ${MAX_TRANSCRIPT_BYTES / (1024 * 1024)} MiB display limit`)
    const content = Buffer.concat(chunks, bytesRead)
    return { path, text: content.toString('utf8') }
  }

  async resumeCommand(params: Record<string, unknown>): Promise<{ command: string }> {
    if (typeof params.session !== 'string' || params.session.length === 0) throw this.context.error('invalid-params', 'session is required')
    const session = await this.requireSession(params.session)
    if (session.kind !== 'terminal' || session.agent === 'shell' || !session.launch) {
      throw this.context.error('conflict', `session ${session.id} does not have a resumable terminal launch`)
    }
    const providerSession = session.providerSession
    if (!sessionProviderId(session) || !providerSession) throw this.context.error('conflict', `session ${session.id} has no captured provider session`)
    const fork = params.fork === true
    const agentInfo = (await this.context.call('quirky.agents/get', { agent: session.agent })) as { resumable?: unknown; canFork?: unknown }
    if (agentInfo.resumable !== true) throw this.context.error('conflict', `agent ${session.agent} does not support resume`)
    if (fork && agentInfo.canFork !== true) throw this.context.error('conflict', `agent ${session.agent} does not support fork`)
    const plan = (await this.context.call('quirky.agents/prepareResume', {
      agent: session.agent,
      cwd: session.cwd,
      record: session.launch,
      providerSession,
      fork,
      hookArgs: [],
      hookEnv: {}
    })) as { command?: unknown }
    if (typeof plan.command !== 'string') throw this.context.error('conflict', 'agent resume planner did not return a command')
    return { command: plan.command }
  }

  async launchHook(raw: unknown): Promise<{ jsonArgs?: Record<string, Record<string, unknown>> } | void> {
    const launch = raw as ExtendedLaunchInput
    if (launch.agent !== 'claude' || !localEnvironment(launch.env)) return {}
    const resolution = await resolveClaudeSettings(this.context, {
      cwd: launch.cwd,
      workspaceRoot: await this.workspaceRoot(launch.worktreeId, launch.cwd),
      ...(launch.record ? { record: launch.record } : {}),
      env: launch.env,
      ...(launch.model === undefined ? {} : { model: launch.model }),
      ...(launch.options === undefined ? {} : { options: launch.options }),
      ...(launch.extraArgs === undefined ? {} : { extraArgs: launch.extraArgs })
    })
    if (resolution.errors.length > 0) throw this.context.error('invalid-params', resolution.errors.join('; ').slice(0, MAX_ERROR_LENGTH))
    const choice = this.classifyStatusline(resolution)
    if (!choice.overlay) return {}
    const customCommand = choice.customCommand ?? null
    const command = writeStatuslineRunner(this.context.dataDir, customCommand)
    const statusLine = {
      ...(resolution.statusLine ?? {}),
      type: resolution.statusLine?.type ?? 'command',
      command
    }
    return { jsonArgs: { '--settings': { statusLine } } }
  }

  onEvent(event: QuirkyEvent): void {
    if (this.closed) return
    if (event.type === 'hook.received') {
      if (event.agent === 'session-info-claude') {
        const payload = isRecord(event.payload) ? event.payload : null
        if (payload) void this.ingestHookTelemetry(event.sessionId, payload).catch(() => {})
      } else if (event.agent === 'claude') {
        void this.observeStop(event).catch(() => {})
      }
      return
    }

    if (event.type === 'quirky.session/removed') {
      const data = event.data as { sessionId?: unknown }
      if (typeof data?.sessionId === 'string') {
        this.clearSession(data.sessionId)
        this.emitChanged(data.sessionId)
      }
      return
    }
    if (event.type === 'quirky.session/changed') {
      const data = event.data as { session?: SessionRecord }
      const session = data?.session
      if (session?.id) {
        if (session.status === 'exited') this.clearSession(session.id)
        else if (this.activeKeys.has(session.id)) this.snapshotFor(session)
        this.emitChanged(session.id)
      }
      return
    }
    if (event.type === 'quirky.agent-status/changed') {
      const data = event.data as { sessionId?: unknown }
      if (typeof data?.sessionId === 'string') this.emitChanged(data.sessionId)
      return
    }
    if (event.type === 'ui.state.changed' || event.type === 'quirky.terminal/focusContextChanged' || event.type === 'quirky.terminal/layout' || event.type === 'quirky.terminal/floating') {
      this.emitChanged(null)
    }
  }

  private openSections(): SectionId[] {
    try {
      const row = this.store.get<{ value: string }>('SELECT value FROM preferences WHERE key = ?', SECTIONS_KEY)
      if (!row) return ['liveActivity']
      const parsed: unknown = JSON.parse(row.value)
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string' && Object.hasOwn(SECTION_SET, value))) return [...new Set(parsed as SectionId[])]
    } catch {
      // An unreadable preference falls back to the declared default without damaging the store.
    }
    return ['liveActivity']
  }

  private readConsent(): Consent | null {
    try {
      const row = this.store.get<{ value: string }>('SELECT value FROM preferences WHERE key = ?', TELEMETRY_CONSENT_KEY)
      if (!row) return null
      const parsed: unknown = JSON.parse(row.value)
      if (isRecord(parsed) && parsed.mode === 'disabled') return { mode: 'disabled' }
      if (isRecord(parsed) && parsed.mode === 'consented' && typeof parsed.identity === 'string') {
        return { mode: 'consented', identity: parsed.identity }
      }
    } catch {
      // A damaged preference is treated as no consent; it can never enable chaining.
    }
    return null
  }

  private setConsent(consent: Consent): void {
    this.store.run('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', TELEMETRY_CONSENT_KEY, JSON.stringify(consent))
  }

  private clearConsent(): void {
    this.store.run('DELETE FROM preferences WHERE key = ?', TELEMETRY_CONSENT_KEY)
  }

  private classifyStatusline(resolution: EffectiveClaudeSettings): StatuslineChoice {
    if (resolution.managed) {
      return { statusline: asStatuslineState('managed', 'Claude managed policy controls the statusline.'), overlay: false }
    }
    const statusLine = resolution.statusLine ?? {}
    if (Object.hasOwn(statusLine, 'command') && typeof statusLine.command !== 'string') {
      return { statusline: asStatuslineState('error', 'The configured statusLine.command is not a string.'), overlay: false }
    }
    const customCommand = typeof statusLine.command === 'string' && statusLine.command.trim() !== '' ? statusLine.command : undefined
    const consent = this.readConsent()
    if (consent?.mode === 'disabled') {
      return { statusline: asStatuslineState('disabled', 'Session telemetry is disabled; the existing statusline is unchanged.'), ...(customCommand ? { customCommand, identity: statusLineIdentity(statusLine) } : {}), overlay: false }
    }
    if (customCommand) {
      const identity = statusLineIdentity(statusLine)
      if (consent?.mode === 'consented' && consent.identity === identity) {
        return { statusline: asStatuslineState('chained', 'The consented custom statusline will be preserved.'), customCommand, identity, overlay: true }
      }
      if (consent?.mode === 'consented') {
        return { statusline: asStatuslineState('drifted', 'The custom statusline changed; enable telemetry again to consent to the current command.'), customCommand, identity, overlay: false }
      }
      return { statusline: asStatuslineState('available', 'Custom statusline detected; enable telemetry to chain it.'), customCommand, identity, overlay: false }
    }
    return { statusline: asStatuslineState('managed', 'Session telemetry is managed by Quirky.'), overlay: true }
  }

  private async settingsInput(session: SessionRecord): Promise<SettingsResolutionInput> {
    return {
      cwd: session.cwd,
      workspaceRoot: await this.workspaceRoot(session.worktreeId, session.cwd),
      ...(session.launch ? { record: session.launch } : {}),
      env: session.launch?.env
    }
  }

  private async workspaceRoot(worktreeId: string, fallback: string): Promise<string> {
    if (!worktreeId || worktreeId === 'floating') return fallback
    try {
      const worktree = (await this.context.call('quirky.worktree/resolve', { selector: `id:${worktreeId}` })) as { path?: unknown }
      return typeof worktree.path === 'string' && worktree.path.length > 0 ? worktree.path : fallback
    } catch {
      return fallback
    }
  }

  private async inspectWorkspaceMcp(session: SessionRecord): Promise<McpInspectionResult> {
    const cwd = await this.workspaceRoot(session.worktreeId, session.cwd)
    const configDir = await claudeConfigDir(this.context, { cwd: session.cwd, workspaceRoot: cwd, record: session.launch, env: session.launch?.env })
    return inspectMcp({ cwd, configDir })
  }

  private async focusedSession(): Promise<{ session: SessionRecord; location: FocusLocation } | null> {
    try {
      const focus = (await this.context.call('quirky.terminal/focusContext', {})) as { workspace?: unknown }
      if (typeof focus.workspace !== 'string' || focus.workspace.length === 0) return null
      if (focus.workspace === 'floating') {
        const floating = (await this.context.call('quirky.terminal/floating', {})) as { enabled?: unknown; open?: unknown }
        if (floating.enabled !== true || floating.open !== true) return null
      } else {
        const ui = (await this.context.call('ui.state', {})) as UiState
        if (ui.layout?.view?.id !== 'view:quirky.session/worktree') return null
      }
      const workspace = await this.loadWorkspace(focus.workspace)
      const selected = workspace ? activePaneOf(workspace) : null
      if (!workspace || !selected) return null
      const session = await this.findSession(selected.pane.session)
      if (!session || session.kind !== 'terminal' || session.agent === 'shell') return null
      return { session, location: paneLocation(workspace, selected.pane, selected.tab) }
    } catch {
      return null
    }
  }

  private async loadWorkspace(workspaceId: string): Promise<Workspace | null> {
    try {
      const result = (await this.context.call('quirky.terminal/workspace', { workspace: workspaceId })) as { workspace?: unknown }
      return isRecord(result.workspace) ? result.workspace as unknown as Workspace : null
    } catch {
      return null
    }
  }

  private async locationForSession(session: SessionRecord): Promise<FocusLocation | null> {
    for (const id of new Set([session.worktreeId, 'floating'])) {
      if (!id) continue
      const workspace = await this.loadWorkspace(id)
      const location = workspace ? findSessionPane(workspace, session.id) : null
      if (location) return location
    }
    return null
  }

  private async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.findSession(sessionId)
    if (!session) throw this.context.error('not-found', `session ${sessionId} not found`)
    return session
  }

  private async findSession(sessionId: string): Promise<SessionRecord | null> {
    try {
      return (await this.context.call('quirky.session/get', { session: sessionId })) as SessionRecord
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === -32004) return null
      throw error
    }
  }

  private snapshotFor(session: SessionRecord): Snapshot {
    const providerSessionId = sessionProviderId(session)
    const key = snapshotKey(session.id, providerSessionId)
    const currentKey = this.activeKeys.get(session.id)
    if (currentKey && currentKey !== key) {
      this.snapshots.delete(currentKey)
      this.activeKeys.delete(session.id)
    }
    let snapshot = this.snapshots.get(key)
    if (!snapshot) {
      snapshot = { key, sessionId: session.id, providerSessionId, telemetry: {}, scanGeneration: 0 }
      this.snapshots.set(key, snapshot)
    }
    this.activeKeys.set(session.id, key)
    this.touch(snapshot)
    return snapshot
  }

  private touch(snapshot: Snapshot): void {
    if (this.snapshots.get(snapshot.key) === snapshot) {
      this.snapshots.delete(snapshot.key)
      this.snapshots.set(snapshot.key, snapshot)
    }
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined
      if (oldest === undefined) break
      const removed = this.snapshots.get(oldest)
      this.snapshots.delete(oldest)
      if (removed && this.activeKeys.get(removed.sessionId) === oldest) this.activeKeys.delete(removed.sessionId)
    }
  }

  private isCurrent(snapshot: Snapshot, generation?: number): boolean {
    return !this.closed && this.snapshots.get(snapshot.key) === snapshot && this.activeKeys.get(snapshot.sessionId) === snapshot.key &&
      (generation === undefined || snapshot.scanGeneration === generation)
  }

  private clearSession(sessionId: string): void {
    const key = this.activeKeys.get(sessionId)
    if (key) this.snapshots.delete(key)
    this.activeKeys.delete(sessionId)
  }
  private emitChanged(sessionId: string | null): void {
    if (this.closed) return
    try {
      this.context.emit('changed', { sessionId })
    } catch {
      // A disconnected listener must not interrupt session or status delivery.
    }
  }

  private async project(session: SessionRecord, snapshot: Snapshot, location: FocusLocation | null): Promise<SessionInfo> {
    let row: AgentStatusRow | null = null
    try {
      row = (await this.context.call('quirky.agent-status/get', { session: session.id })) as AgentStatusRow | null
    } catch {
      row = null
    }
    const updatedAt = Math.max(session.lastActivityAt, typeof row?.evidenceAt === 'number' ? row.evidenceAt : 0, snapshot.telemetry.updatedAt ?? 0)
    const activity = userFacingStatus(row?.state ?? session.status, row?.display ?? session.agentStatus?.display)
    const telemetryModel = validString(snapshot.telemetry.model, 512)
    const statusModel = validString(row?.model, 512)
    const transcriptModel = validString(snapshot.transcriptModel, 512)
    const model = telemetryModel ?? statusModel ?? transcriptModel
    const branch = validString(snapshot.telemetry.branch, 512) ?? validString(snapshot.transcriptBranch, 512)
    const transcriptPath = localExecution(session) ? sessionTranscriptPath(session) : undefined
    const toolName = validString(row?.toolName, 200)
    const identity: Identity = {
      agent: session.agent,
      sessionId: session.id,
      providerSessionId: sessionProviderId(session),
      pane: location?.pane ?? null,
      ...(location?.paneTitle ? { paneTitle: location.paneTitle } : {}),
      worktreeId: session.worktreeId,
      cwd: snapshot.telemetry.cwd ?? snapshot.transcriptCwd ?? session.cwd,
      startedAt: session.createdAt,
      updatedAt,
      ...(model ? { model } : {}),
      ...(snapshot.telemetry.version ? { version: snapshot.telemetry.version } : {}),
      ...(snapshot.telemetry.outputStyle ? { outputStyle: snapshot.telemetry.outputStyle } : {}),
      ...(branch ? { branch } : {}),
      ...(transcriptPath ? { transcriptPath } : {})
    }
    const activeToolInput = typeof row?.toolInput === 'string' ? row.toolInput.slice(0, MAX_TOOL_INPUT_LENGTH) : undefined
    const liveActivity: LiveActivity = {
      state: activity.state,
      label: row?.label ?? session.agentStatus?.label ?? activity.label,
      subagentCount: Array.isArray(row?.children) ? row.children.filter((child) => child.kind === 'agent' && child.state !== 'done').length : 0,
      startedAt: typeof row?.stateStartedAt === 'number' ? row.stateStartedAt : session.createdAt,
      updatedAt: typeof row?.evidenceAt === 'number' ? row.evidenceAt : session.lastActivityAt,
      ...(toolName ? { toolName } : {}),
      ...(activeToolInput ? { toolInput: activeToolInput } : {})
    }

    const info: SessionInfo = { identity, liveActivity }
    if (localClaude(session)) {
      info.usage = snapshot.usage ?? { status: 'waiting' }
      const context = snapshot.telemetry.context ?? snapshot.transcriptContext
      info.context = context ?? { status: 'waiting' }
      if (snapshot.telemetry.filesTouched) info.filesTouched = snapshot.telemetry.filesTouched
    }
    if (snapshot.inspection) info.hooksAndMcp = snapshot.inspection
    return info
  }

  private async ingestHookTelemetry(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    const session = await this.findSession(sessionId)
    if (!session) return
    this.ingestTelemetry(session, payload)
  }

  private ingestTelemetry(session: SessionRecord, payload: Record<string, unknown>): boolean {
    if (this.closed || !localClaude(session) || session.status === 'exited') return false
    const providerSessionId = sessionProviderId(session)
    const postedId = validString(payload.session_id, MAX_PROVIDER_ID_LENGTH)
    if (!providerSessionId || postedId !== providerSessionId) return false

    const snapshot = this.snapshotFor(session)
    const now = Date.now()
    const next = { ...snapshot.telemetry }
    let changed = false
    const model = isRecord(payload.model) ? validString(payload.model.display_name, 512) : undefined
    const version = validString(payload.version, 128)
    const outputStyle = isRecord(payload.output_style) ? validString(payload.output_style.name, 256) : undefined
    const cwd = validString(payload.cwd, MAX_PATH_LENGTH)
    const branch = validString(payload.git_branch, 512) ?? validString(payload.branch, 512)
    if (model !== undefined) { next.model = model; changed = true }
    if (version !== undefined) { next.version = version; changed = true }
    if (outputStyle !== undefined) { next.outputStyle = outputStyle; changed = true }
    if (cwd !== undefined) { next.cwd = cwd; changed = true }
    if (branch !== undefined) { next.branch = branch; changed = true }

    const context = applyContextWindow(next.context, payload.context_window, now)
    if (context !== next.context) { next.context = context; changed = true }
    if (isRecord(payload.rate_limits)) {
      const windows = parsePlanWindows(payload.rate_limits)
      const nextContext: Context = { ...(next.context ?? { status: 'ready' as const }), status: 'ready', updatedAt: now }
      if (windows && Object.keys(windows).length > 0) nextContext.planWindows = windows
      else delete nextContext.planWindows
      next.context = nextContext
      changed = true
    }

    if (isRecord(payload.cost)) {
      const added = validCount(payload.cost.total_lines_added)
      const removed = validCount(payload.cost.total_lines_removed)
      if (added !== undefined || removed !== undefined) {
        next.filesTouched = {
          ...(next.filesTouched ?? { updatedAt: now }),
          ...(added === undefined ? {} : { added }),
          ...(removed === undefined ? {} : { removed }),
          updatedAt: now
        }
        changed = true
      }
    }

    if (!changed) return false
    next.updatedAt = now
    snapshot.telemetry = next
    this.touch(snapshot)
    this.emitChanged(session.id)
    return true
  }

  private async observeStop(event: Extract<QuirkyEvent, { type: 'hook.received' }>): Promise<void> {
    const payload = isRecord(event.payload) ? event.payload : null
    if (this.closed || !payload || payload.sessionBoundary === true) return
    const subagentId = payload.agent_id ?? payload.agentId
    if (typeof subagentId === 'string' && subagentId.length > 0) return
    const eventName = validString(payload.hook_event_name, 64) ?? validString(event.event, 64)
    if (eventName !== 'Stop') return
    const eventInfo = event as unknown as { connectionId?: unknown }
    if (eventInfo.connectionId !== undefined && eventInfo.connectionId !== null) return
    const session = await this.findSession(event.sessionId)
    if (!session || !localClaude(session) || session.status === 'exited') return
    const providerSessionId = sessionProviderId(session)
    if (!providerSessionId || validString(payload.session_id, MAX_PROVIDER_ID_LENGTH) !== providerSessionId) return
    const transcriptPath = sessionTranscriptPath(session)
    if (!transcriptPath || !isAbsolute(transcriptPath)) return

    let status: AgentStatusRow | null = null
    try {
      status = (await this.context.call('quirky.agent-status/get', { session: session.id })) as AgentStatusRow | null
    } catch {
      status = null
    }
    if (status?.agent !== undefined && status.agent !== 'claude') return
    if (status?.sessionBoundary === true || status?.lead?.providerSession && status.lead.providerSession !== providerSessionId) return
    await this.refreshUsage(session, transcriptPath)
  }

  private async refreshUsage(session: SessionRecord, recordedPath = sessionTranscriptPath(session)): Promise<void> {
    if (this.closed || !localClaude(session) || session.status === 'exited') return
    const providerSessionId = sessionProviderId(session)
    if (!providerSessionId || !recordedPath || !isAbsolute(recordedPath)) return
    const snapshot = this.snapshotFor(session)
    const generation = ++snapshot.scanGeneration
    const existing = snapshot.usage
    snapshot.usage = {
      ...(existing ?? { status: 'waiting' as const }),
      freshness: 'refreshing',
      updatedAt: Date.now()
    }
    this.emitChanged(session.id)

    try {
      const result = await scanClaudeUsage(recordedPath, providerSessionId)
      if (!this.isCurrent(snapshot, generation)) return
      const latest = await this.findSession(session.id)
      if (!latest || sessionProviderId(latest) !== providerSessionId || latest.status === 'exited') return
      const hasUsage = result.turnCount > 0 || result.input !== undefined || result.output !== undefined || result.cacheRead !== undefined || result.cacheWrite !== undefined || result.total !== undefined
      if (hasUsage) {
        snapshot.usage = {
          status: 'ready',
          freshness: 'fresh',
          ...(result.total === undefined ? {} : { totalTokens: result.total }),
          turnCount: result.turnCount,
          ...(result.input === undefined ? {} : { input: result.input }),
          ...(result.output === undefined ? {} : { output: result.output }),
          ...(result.cacheRead === undefined ? {} : { cacheRead: result.cacheRead }),
          ...(result.cacheWrite === undefined ? {} : { cacheWrite: result.cacheWrite }),
          updatedAt: Date.now()
        }
      } else if (!existing || existing.status !== 'ready') {
        snapshot.usage = { status: 'waiting', freshness: 'fresh', updatedAt: Date.now() }
      } else {
        snapshot.usage = { ...existing, freshness: 'fresh', updatedAt: Date.now() }
      }
      if (result.context && !snapshot.telemetry.context) {
        snapshot.transcriptContext = { status: 'ready', ...result.context, updatedAt: Date.now() }
      }
      if (result.model !== undefined) snapshot.transcriptModel = result.model
      if (result.cwd !== undefined) snapshot.transcriptCwd = result.cwd
      if (result.gitBranch !== undefined) snapshot.transcriptBranch = result.gitBranch
      this.emitChanged(session.id)
    } catch (error) {
      if (!this.isCurrent(snapshot, generation)) return
      const message = boundedError(error)
      snapshot.usage = {
        ...(existing ?? { status: 'waiting' as const }),
        freshness: 'stale',
        updatedAt: Date.now(),
        error: message
      }
      this.emitChanged(session.id)
    }
  }

}
