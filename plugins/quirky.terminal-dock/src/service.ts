import { randomUUID } from 'node:crypto'
import { realpathSync, statSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { MethodHandler, PluginCaller, PluginContext, PtyFact, PtySessionInfo, Session } from '@quirky/protocol'
import { acquireAttachment } from './attachments'
import { pickItems } from './pickers'
import type { ProviderBridge } from './providers'
import { executePrompt } from './send'
import { agentForAlias, agentForManagedLaunch, agentForTitle, catalogFromListing, isCatalogAgent } from './recognition'
import type { AgentCatalog } from './recognition'
import { boundedHistory, defaultDockRecord, DockStore, recoverableAttachmentCount, recoverableTextLength } from './store'
import type { DockAttachment, DockOptions, DockQuestion, DockRecord, DockRecovery, DockState, PickerItem, SendResult } from './types'
import { MAX_ATTACHMENTS, MAX_RECOVERABLE_CHARS, MIN_GUTTER_ROWS, MAX_GUTTER_ROWS } from './types'

// Provider question/options adapters are narrower than the public dock catalog.
const PROVIDER_AGENTS: Record<string, true> = {
  claude: true,
  openclaude: true,
  codex: true,
  grok: true,
  omp: true,
  opencode: true,
  opencode2: true,
  zcode: true
}
const RECOVERY_WARNING = 'Send may not have completed. Check the terminal before retrying.'
const DEFAULT_OPTIONS: DockOptions = {
  model: null,
  effort: null,
  permission: null,
  choices: { model: [], effort: [], permission: [] },
  context: null,
  notice: null
}
const PROVIDER_READ_DEADLINE_MS = 1_500
const TERMINAL_CHECK_DEADLINE_MS = 1_200
const AGENT_CATALOG_REFRESH_MS = 30_000
const MAX_RECOGNITION_SESSIONS = 512

type PaneBinding = {
  pane: string
  tab: string
  workspace: string
  canonicalSession: Session
  session: Session
  status: StatusProjection
}
type StatusProjection = {
  agent?: string
  source?: string
  restoredUnconfirmed?: boolean
  evidenceAt?: number
  lead?: { ended?: boolean; providerSession?: string | null }
  programStatus?: { app?: string } | null
  state?: string
} | null
type TransportReport = { noTerminal: boolean; reason: string | null }
type HostReport = { pane: string; mounted: boolean; focused: boolean; transport?: string; updatedAt: number }
type ProviderCache = { session: string; agent: string; question: DockQuestion | null; options: DockOptions; readAt: number }
type CachedTitle = { title: string; source: 'fact' | 'list'; updatedAt: number }
type FreshEvidence = { source: 'hook' | 'program-app'; value: string; at: number; providerSession?: string }
type HookLeadIdentity = { agent: string; providerSession: string }
type QuestionOverlay = { id: string; collapsed: boolean; dismissed: boolean }
type HistoryBrowse = { index: number; savedDraft: string }
type DriverLease = { owner: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }
type Operation = {
  id: string
  binding: PaneBinding
  pane: string
  session: string
  kind: 'send' | 'control'
  phase: string
  controller: AbortController
  started: boolean
  settled: boolean
  restored: boolean
  snapshot?: DockRecovery
  run(operation: Operation): Promise<unknown>
  promise: Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
}
type SessionQueue = { active: Operation | null; pending: Operation[]; pumping: boolean }
type ProviderRead = { question: DockQuestion | null; options: DockOptions; prompts: string[] }
type AttachInput = { path?: string; name?: string; mime?: string; base64?: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const statusEnded = (status: StatusProjection) => status?.lead?.ended === true
const CLAUDE_HOOK_AGENTS: Record<string, true> = { claude: true, openclaude: true }
const HOOK_EVENT_KEYS = ['hook_event_name', 'hookEventName', 'hook_type', 'hookType', 'event']
const PROVIDER_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function providerSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  if (id === '' || id.length > 512 || id.startsWith('-') || PROVIDER_ID_CONTROL_CHARACTERS.test(id)) return undefined
  return id
}

function hookEventName(payload: Record<string, unknown>, fallbackEvent: unknown): string | undefined {
  for (const key of HOOK_EVENT_KEYS) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return typeof fallbackEvent === 'string' ? fallbackEvent : undefined
}

function sessionEndIdentity(agent: string, payload: unknown, fallbackEvent: unknown): HookLeadIdentity | null {
  if (!Object.hasOwn(CLAUDE_HOOK_AGENTS, agent) || !isObject(payload)) return null
  if (hookEventName(payload, fallbackEvent) !== 'SessionEnd' || (typeof payload.agent_id === 'string' && payload.agent_id.length > 0)) {
    return null
  }
  const providerSession = providerSessionId(payload.session_id)
  return providerSession ? { agent, providerSession } : null
}

function sameLeadIdentity(a: HookLeadIdentity, b: HookLeadIdentity): boolean {
  return a.agent === b.agent && a.providerSession === b.providerSession
}


function findPaneSession(value: unknown, pane: string): string | null {
  if (!isObject(value)) return null
  if (value.kind === 'pane' && value.id === pane && typeof value.session === 'string') return value.session
  if (Array.isArray(value.tabs)) {
    for (const tab of value.tabs) {
      const found = findPaneSession(tab, pane)
      if (found) return found
    }
  }
  if (isObject(value.root)) {
    const found = findPaneSession(value.root, pane)
    if (found) return found
  }
  if (isObject(value.first)) {
    const found = findPaneSession(value.first, pane)
    if (found) return found
  }
  if (isObject(value.second)) return findPaneSession(value.second, pane)
  return null
}

function combineText(parts: string[]): string {
  let text = ''
  for (const part of parts) {
    if (part.length === 0) continue
    text = text.length === 0 ? part : `${text}\n\n${part}`
  }
  return text
}

function prependUnique(values: string[], existing: string[]): string[] {
  const result: string[] = []
  for (const value of [...values, ...existing]) if (!result.includes(value)) result.push(value)
  return result
}

function optionsWithNotice(options: DockOptions, notice: string | null): DockOptions {
  return { ...options, choices: { ...options.choices }, notice }
}

function isQuestion(value: unknown): value is DockQuestion {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return false
  if (value.kind !== 'question' && value.kind !== 'permission') return false
  if (!Array.isArray(value.questions)) return false
  return value.questions.every((question) => {
    if (!isObject(question) || typeof question.prompt !== 'string' || typeof question.multiple !== 'boolean' || !Array.isArray(question.choices)) return false
    return question.choices.every((choice) => isObject(choice) && typeof choice.label === 'string' && typeof choice.value === 'string')
  })
}

function optionNotice(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Internal integration-fixture hooks; absent from normal plugin activation. */
export type DockServiceTestHooks = {
  beforeSubmit?(signal: AbortSignal): Promise<void>
}

/** Daemon-authoritative dock records and per-terminal acknowledged send queues. */
export class DockService {
  readonly methods: Record<string, MethodHandler>
  private readonly subscriptions: (() => void)[] = []
  private readonly reports = new Map<number, Map<string, HostReport>>()
  private readonly activeWindows = new Set<number>()
  private readonly passthroughOwners = new Map<number, Set<string>>()
  private readonly drivers = new Map<string, DriverLease>()
  private readonly providers = new Map<string, ProviderCache>()
  private readonly overlays = new Map<string, QuestionOverlay>()
  private readonly resolvedQuestions = new Map<string, Set<string>>()
  private readonly historyBrowse = new Map<string, HistoryBrowse>()
  private readonly statusStates = new Map<string, string>()
  private catalog: AgentCatalog = { byId: new Map(), aliasIds: new Map() }
  private catalogReadAt = 0
  private catalogRefresh: Promise<void> | null = null
  private readonly titles = new Map<string, CachedTitle>()
  private readonly manualAgents = new Map<string, string>()
  private readonly manualCandidates = new Map<string, string>()
  private readonly confirmedExits = new Map<string, number>()
  private readonly freshEvidence = new Map<string, FreshEvidence>()
  private readonly statusLeadIdentities = new Map<string, HookLeadIdentity | null>()
  private readonly sessionEndCandidates = new Map<string, HookLeadIdentity>()
  private readonly queues = new Map<string, SessionQueue>()
  private readonly sendOperations = new Map<string, Operation>()
  private readonly sendAdmissionTails = new Map<string, Promise<void>>()
  private mutationTail: Promise<void> = Promise.resolve()
  private recoveryPending = true
  private stopped = false
  private wasEnabled = false

  constructor(
    private readonly context: PluginContext,
    private readonly store: DockStore,
    private readonly bridge: ProviderBridge,
    private readonly testHooks: DockServiceTestHooks = {}
  ) {
    this.methods = {
      get: (params) => this.get(params),
      list: () => this.list(),
      set: (params, caller) => this.set(params, caller),
      report: (params, caller) => this.report(params, caller),
      history: (params) => this.history(params),
      pick: (params) => this.pick(params),
      attach: (params) => this.attach(params),
      removeAttachment: (params) => this.removeAttachment(params),
      send: (params) => this.send(params),
      cancel: (params) => this.cancel(params),
      interaction: (params) => this.interaction(params),
      options: (params) => this.options(params),
      driver: (params) => this.driver(params)
    }
  }

  async start(): Promise<void> {
    this.wasEnabled = this.enabled()
    this.subscriptions.push(this.context.subscribe((event) => this.onEvent(event)))
    this.subscriptions.push(this.context.pty.onFact((sessionId, fact) => this.onPtyFact(sessionId, fact)))
    this.subscriptions.push(this.context.pty.onExit((sessionId) => this.onSessionExit(sessionId)))
    this.subscriptions.push(this.context.pty.onReconnect(() => this.background(async () => {
      await this.refreshCatalog(true)
      await this.seedTerminalTitles()
      if (this.enabled()) await this.reconcileAll()
    })))
    await this.refreshCatalog(true)
    await this.seedTerminalTitles()
    if (!this.wasEnabled) return
    await this.ensureRecovered()
    await this.reconcileAll()
  }

  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    for (const operation of this.sendOperations.values()) operation.controller.abort()
    for (const queue of this.queues.values()) {
      for (const operation of queue.pending) {
        operation.controller.abort()
        if (!operation.settled) {
          operation.settled = true
          if (operation.kind === 'send') operation.resolve({ id: operation.id, outcome: 'cancelled', accepted: false } satisfies SendResult)
          else operation.reject(new Error('terminal dock stopped'))
        }
      }
      queue.pending.length = 0
      queue.active?.controller.abort()
    }
    for (const lease of this.drivers.values()) clearTimeout(lease.timer)
    this.drivers.clear()
    this.bridge.dispose()
  }

  private enabled(): boolean {
    return this.context.getSetting('enabled') === true
  }

  private autoOpen(): boolean {
    return this.context.getSetting('autoOpen') !== false
  }

  private async onEvent(event: { type: string }): Promise<void> {
    const detail = event as unknown as Record<string, unknown>
    if (event.type === 'hook.received') {
      if (typeof detail.sessionId === 'string' && typeof detail.agent === 'string') {
        this.observeHookReceived(detail.sessionId, detail.agent, detail)
      }
      return
    }
    if (event.type === 'quirky.agent-status/changed' && isObject(detail.data)) this.observeAgentStatusChange(detail.data)
    if (event.type === 'setting.changed' && detail.id === 'setting:quirky.terminal-dock/enabled') {
      const enabledNow = this.enabled()
      if (enabledNow === this.wasEnabled) return
      this.wasEnabled = enabledNow
      if (!enabledNow) {
        this.recoveryPending = true
        this.clearAllPassthrough()
        this.cancelForFeatureOff()
        for (const pane of this.store.all().map((record) => record.pane)) this.announce(pane)
      } else {
        this.recoveryPending = true
        await this.refreshCatalog(true)
        await this.seedTerminalTitles()
        await this.ensureRecovered()
        await this.reconcileAll()
      }
      return
    }
    if (event.type === 'ui.window.changed') {
      this.updateWindows(detail.windows)
      return
    }
    if (event.type === 'ui.report.changed') {
      this.announceAllMounted()
      return
    }
    if (event.type === 'quirky.agents/changed') {
      await this.refreshCatalog(true)
      if (this.enabled()) await this.reconcileAll()
      return
    }
    if (
      event.type === 'quirky.session/changed' || event.type === 'quirky.session/removed' ||
      event.type === 'quirky.terminal/layout' || event.type === 'quirky.terminal/floating' ||
      event.type === 'quirky.agent-status/changed'
    ) {
      if (this.enabled()) await this.reconcileAll()
    }
  }
  private observeHookReceived(sessionId: string, agent: string, detail: Record<string, unknown>): void {
    const payload = isObject(detail.payload) ? detail.payload : null
    const isClaudeHook = Object.hasOwn(CLAUDE_HOOK_AGENTS, agent)
    const isClaudeChild = isClaudeHook && typeof payload?.agent_id === 'string' && payload.agent_id.length > 0
    if (!isClaudeChild) {
      this.rememberFreshEvidence(
        sessionId,
        agent,
        'hook',
        isClaudeHook ? providerSessionId(payload?.session_id) : undefined
      )
    }
    if (isClaudeChild) return

    if (hookEventName(payload ?? {}, detail.event) !== 'SessionEnd') this.sessionEndCandidates.delete(sessionId)
    const candidate = sessionEndIdentity(agent, payload, detail.event)
    if (!candidate) return
    const current = this.statusLeadIdentities.get(sessionId)
    if (current && !sameLeadIdentity(candidate, current)) return
    this.sessionEndCandidates.set(sessionId, candidate)
    while (this.sessionEndCandidates.size > MAX_RECOGNITION_SESSIONS) {
      this.sessionEndCandidates.delete(this.sessionEndCandidates.keys().next().value as string)
    }
  }

  private rememberStatusLeadIdentity(sessionId: string, row: Record<string, unknown>): void {
    const lead = isObject(row.lead) ? row.lead : null
    const providerSession = providerSessionId(lead?.providerSession)
    if (row.sessionId !== sessionId || typeof row.agent !== 'string' || !providerSession) {
      this.rememberNoStatusLead(sessionId)
      this.sessionEndCandidates.delete(sessionId)
      return
    }
    const identity = { agent: row.agent, providerSession }
    this.statusLeadIdentities.delete(sessionId)
    this.statusLeadIdentities.set(sessionId, identity)
    const candidate = this.sessionEndCandidates.get(sessionId)
    if (candidate && !sameLeadIdentity(candidate, identity)) this.sessionEndCandidates.delete(sessionId)
    while (this.statusLeadIdentities.size > MAX_RECOGNITION_SESSIONS) {
      this.statusLeadIdentities.delete(this.statusLeadIdentities.keys().next().value as string)
    }
  }

  private rememberNoStatusLead(sessionId: string): void {
    this.statusLeadIdentities.delete(sessionId)
    this.statusLeadIdentities.set(sessionId, null)
    while (this.statusLeadIdentities.size > MAX_RECOGNITION_SESSIONS) {
      this.statusLeadIdentities.delete(this.statusLeadIdentities.keys().next().value as string)
    }
  }

  private observeAgentStatusChange(detail: Record<string, unknown>): void {
    const sessionId = detail.sessionId
    if (typeof sessionId !== 'string') return
    for (const cached of this.providers.values()) {
      if (cached.session === sessionId) cached.readAt = 0
    }
    if (isObject(detail.row)) {
      this.rememberStatusLeadIdentity(sessionId, detail.row)
      return
    }
    if (detail.row !== null) return
    const candidate = this.sessionEndCandidates.get(sessionId)
    const current = this.statusLeadIdentities.get(sessionId)
    if (candidate && current && sameLeadIdentity(candidate, current)) this.markConfirmedExit(sessionId)
    this.sessionEndCandidates.delete(sessionId)
    this.rememberNoStatusLead(sessionId)
  }

  private onPtyFact(sessionId: string, fact: PtyFact): void {
    if (fact.kind === 'title') {
      this.rememberTitle(sessionId, fact.title, 'fact')
      const agent = agentForTitle(fact.title, this.catalog)
      if (agent) {
        this.rememberManualCandidate(sessionId, agent)
        this.clearConfirmedExit(sessionId)
      }
      if (this.enabled()) this.background(() => this.reconcileAll())
      return
    }
    if (fact.kind === 'command-finished') {
      const agent = this.manualAgents.get(sessionId) ?? this.manualCandidates.get(sessionId)
      if (!agent || this.confirmedExits.has(sessionId)) return
      if (this.manualAgents.has(sessionId)) {
        this.markConfirmedExit(sessionId)
        if (this.enabled()) this.background(() => this.reconcileAll())
      } else {
        this.background(async () => {
          const session = await this.readCanonicalSession(sessionId)
          if (!session) return
          if (session.kind !== 'terminal' || session.agent !== 'shell') {
            this.manualCandidates.delete(sessionId)
            return
          }
          this.rememberManualAgent(session, agent)
          this.markConfirmedExit(sessionId)
          if (this.enabled()) await this.reconcileAll()
        })
      }
      return
    }
    if (fact.kind === 'program-status') {
      const fields = new Map<string, string>()
      for (const part of fact.body.split(':')) {
        const equals = part.indexOf('=')
        if (equals > 0) fields.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim())
      }
      const state = fields.get('state')
      const app = fields.get('app')
      const appAgent = app ? agentForAlias(app, this.catalog) : null
      if (app && state && state !== 'clear' && state !== 'done') {
        this.rememberFreshEvidence(sessionId, app, 'program-app')
        if (appAgent) this.rememberManualCandidate(sessionId, appAgent)
      }
      if (this.enabled()) this.background(() => this.reconcileAll())
    }
  }
  private async refreshCatalog(force = false): Promise<void> {
    if (this.stopped) return
    if (this.catalogRefresh) return this.catalogRefresh
    if (!force && Date.now() - this.catalogReadAt < AGENT_CATALOG_REFRESH_MS) return
    const refresh = (async () => {
      try {
        const value = await this.withDeadline(
          this.context.call('quirky.agents/list', { all: true }),
          PROVIDER_READ_DEADLINE_MS,
          'agent catalog lookup'
        )
        const catalog = catalogFromListing(value)
        if (catalog) this.catalog = catalog
      } catch {
        // Keep the last successful public catalog; a failed lookup cannot add an agent.
      } finally {
        this.catalogReadAt = Date.now()
      }
    })()
    this.catalogRefresh = refresh
    try {
      await refresh
    } finally {
      if (this.catalogRefresh === refresh) this.catalogRefresh = null
    }
  }

  private async seedTerminalTitles(): Promise<void> {
    if (this.stopped || !this.context.pty.connected) return
    try {
      const sessions = await this.withDeadline(this.context.pty.list(), TERMINAL_CHECK_DEADLINE_MS, 'terminal title seed')
      for (const session of sessions) {
        if (!this.confirmedExits.has(session.sessionId)) {
          const title = session.title ?? ''
          this.rememberTitle(session.sessionId, title, 'list')
          const agent = agentForTitle(title, this.catalog)
          if (agent) this.rememberManualCandidate(session.sessionId, agent)
        }
      }
    } catch {
      // Live title facts still populate the bounded cache when the PTY host is unavailable.
    }
  }

  private rememberTitle(sessionId: string, title: string, source: CachedTitle['source']): void {
    this.titles.delete(sessionId)
    this.titles.set(sessionId, { title, source, updatedAt: Date.now() })
    while (this.titles.size > MAX_RECOGNITION_SESSIONS) this.titles.delete(this.titles.keys().next().value as string)
  }

  private rememberManualAgent(session: Session, agent: string): void {
    if (session.kind !== 'terminal' || session.agent !== 'shell') return
    this.manualAgents.delete(session.id)
    this.manualAgents.set(session.id, agent)
    this.rememberManualCandidate(session.id, agent)
    while (this.manualAgents.size > MAX_RECOGNITION_SESSIONS) this.manualAgents.delete(this.manualAgents.keys().next().value as string)
  }

  private rememberManualCandidate(sessionId: string, agent: string): void {
    this.manualCandidates.delete(sessionId)
    this.manualCandidates.set(sessionId, agent)
    while (this.manualCandidates.size > MAX_RECOGNITION_SESSIONS) {
      this.manualCandidates.delete(this.manualCandidates.keys().next().value as string)
    }
  }
  private rememberFreshEvidence(
    sessionId: string,
    value: string,
    source: FreshEvidence['source'],
    providerSession?: string
  ): void {
    this.freshEvidence.delete(sessionId)
    this.freshEvidence.set(sessionId, {
      source,
      value,
      at: Date.now(),
      ...(providerSession ? { providerSession } : {})
    })
    while (this.freshEvidence.size > MAX_RECOGNITION_SESSIONS) {
      this.freshEvidence.delete(this.freshEvidence.keys().next().value as string)
    }
  }

  private clearConfirmedExit(sessionId: string): void {
    this.confirmedExits.delete(sessionId)
  }

  private markConfirmedExit(sessionId: string): void {
    if (!this.confirmedExits.has(sessionId)) {
      this.confirmedExits.set(sessionId, Date.now())
      while (this.confirmedExits.size > MAX_RECOGNITION_SESSIONS) {
        this.confirmedExits.delete(this.confirmedExits.keys().next().value as string)
      }
    }
    this.titles.delete(sessionId)
    this.manualAgents.delete(sessionId)
    this.manualCandidates.delete(sessionId)
    this.statusStates.delete(sessionId)
    this.rememberNoStatusLead(sessionId)
    this.sessionEndCandidates.delete(sessionId)
  }

  private liveStatusAgent(status: StatusProjection): string | null {
    if (!status || status.restoredUnconfirmed === true || status.lead?.ended !== false) return null
    if (status.source === 'hook' && typeof status.agent === 'string' && isCatalogAgent(status.agent, this.catalog)) {
      return status.agent
    }
    if (status.source !== 'hook' && status.source !== 'program-status' && status.source !== 'title') return null
    return agentForAlias(status.programStatus?.app, this.catalog)
  }

  private agentForSession(session: Session, pane: string, status: StatusProjection): string | null {
    if (session.kind !== 'terminal') return null
    if (session.status === 'exited') {
      this.markConfirmedExit(session.id)
      return null
    }
    const cachedTitle = this.titles.get(session.id)
    const factTitleAgent = cachedTitle?.source === 'fact' ? agentForTitle(cachedTitle.title, this.catalog) : null
    if (statusEnded(status)) {
      const freshEvidence = this.freshEvidence.get(session.id)
      const newerEvidence = freshEvidence && cachedTitle && freshEvidence.at >= cachedTitle.updatedAt
      if (
        factTitleAgent && !newerEvidence &&
        (typeof status?.evidenceAt !== 'number' || cachedTitle!.updatedAt > status.evidenceAt)
      ) {
        this.clearConfirmedExit(session.id)
        this.rememberManualAgent(session, factTitleAgent)
        return factTitleAgent
      }
      this.markConfirmedExit(session.id)
      return null
    }

    const liveAgent = this.liveStatusAgent(status)
    const confirmedAt = this.confirmedExits.get(session.id)
    if (confirmedAt !== undefined) {
      const fresh = this.freshEvidence.get(session.id)
      const freshAgent = fresh?.source === 'hook'
        ? (isCatalogAgent(fresh.value, this.catalog) ? fresh.value : null)
        : fresh?.source === 'program-app'
          ? agentForAlias(fresh.value, this.catalog)
          : null
      if (
        liveAgent && freshAgent === liveAgent && fresh &&
        (fresh.providerSession === undefined || status?.lead?.providerSession === fresh.providerSession) &&
        fresh.at > confirmedAt &&
        typeof status?.evidenceAt === 'number' && status.evidenceAt >= fresh.at
      ) {
        this.clearConfirmedExit(session.id)
        this.rememberManualAgent(session, liveAgent)
        return liveAgent
      }
      const freshTitle = cachedTitle?.source === 'fact' && cachedTitle.updatedAt >= confirmedAt ? factTitleAgent : null
      if (freshTitle) {
        this.clearConfirmedExit(session.id)
        this.rememberManualAgent(session, freshTitle)
        return freshTitle
      }
      return null
    }

    if (liveAgent) {
      this.rememberManualAgent(session, liveAgent)
      return liveAgent
    }

    const managedAgent = agentForManagedLaunch(session, this.catalog)
    if (managedAgent) return managedAgent

    const titleAgent = agentForTitle(this.titles.get(session.id)?.title, this.catalog)
    if (titleAgent) {
      this.rememberManualAgent(session, titleAgent)
      return titleAgent
    }

    const record = this.store.get(pane)
    return record?.session === session.id && record.docked && isCatalogAgent(record.agent ?? '', this.catalog)
      ? record.agent
      : null
  }


  private background(work: () => Promise<void>): void {
    void work().catch(() => this.context.log('terminal dock background reconciliation failed'))
  }

  private updateWindows(value: unknown): void {
    if (!Array.isArray(value)) return
    const present = new Set<number>()
    const focused = new Set<number>()
    for (const item of value) {
      if (!isObject(item) || typeof item.connId !== 'number') continue
      present.add(item.connId)
      if (item.focused === true) focused.add(item.connId)
    }
    for (const connection of this.reports.keys()) {
      if (present.has(connection)) continue
      this.reports.delete(connection)
      this.passthroughOwners.delete(connection)
    }
    this.activeWindows.clear()
    for (const connection of focused) this.activeWindows.add(connection)
    this.announceAllMounted()
  }

  private async resolveBinding(params: Record<string, unknown>): Promise<PaneBinding> {
    const hasPane = Object.hasOwn(params, 'pane')
    const hasSession = Object.hasOwn(params, 'session')
    if (hasPane && (typeof params.pane !== 'string' || params.pane.length === 0)) throw this.context.error('invalid-params', 'pane must be a nonempty pane ID')
    if (hasSession && (typeof params.session !== 'string' || params.session.length === 0)) throw this.context.error('invalid-params', 'session must be a nonempty session ID')
    const pane = hasPane ? (params.pane as string) : undefined
    const sessionHint = hasSession ? (params.session as string) : undefined
    if (!pane && !sessionHint) throw this.context.error('invalid-params', 'pass pane or session')

    const selector = pane ? { pane } : { session: sessionHint! }
    let location: { workspace?: unknown; tab?: unknown; pane?: unknown }
    try {
      const value = await this.withDeadline(this.context.call('quirky.terminal/paneOf', selector), TERMINAL_CHECK_DEADLINE_MS, 'pane lookup')
      if (!isObject(value)) throw new Error('pane lookup returned no binding')
      location = value as typeof location
    } catch {
      throw this.context.error('not-found', 'no terminal pane matches the requested selector')
    }
    if (typeof location.workspace !== 'string' || typeof location.tab !== 'string' || typeof location.pane !== 'string') {
      throw this.context.error('not-found', 'terminal pane binding is unavailable')
    }
    if (pane && location.pane !== pane) throw this.context.error('not-found', 'terminal pane no longer exists')

    let workspaceResult: { workspace?: unknown }
    try {
      const value = await this.withDeadline(this.context.call('quirky.terminal/workspace', { workspace: location.workspace }), TERMINAL_CHECK_DEADLINE_MS, 'workspace lookup')
      if (!isObject(value)) throw new Error('workspace lookup returned no state')
      workspaceResult = value as typeof workspaceResult
    } catch {
      throw this.context.error('not-found', 'terminal workspace is unavailable')
    }
    const sessionId = findPaneSession(workspaceResult.workspace, location.pane)
    if (!sessionId) throw this.context.error('not-found', 'terminal pane has no live session binding')
    if (sessionHint && sessionHint !== sessionId) throw this.context.error('invalid-params', 'pane and session selectors do not match')

    let session: Session
    try {
      session = (await this.withDeadline(this.context.call('quirky.session/get', { session: sessionId }), TERMINAL_CHECK_DEADLINE_MS, 'session lookup')) as Session
    } catch {
      throw this.context.error('not-found', 'terminal session is unavailable')
    }
    if (!isObject(session) || session.id !== sessionId) throw this.context.error('not-found', 'terminal session is unavailable')
    const canonicalSession = session
    let status: StatusProjection = null
    let effectiveSession = canonicalSession
    if (this.enabled()) {
      await this.refreshCatalog()
      status = await this.readStatus(canonicalSession)
      const agent = this.agentForSession(canonicalSession, location.pane as string, status)
      if (agent && agent !== canonicalSession.agent) effectiveSession = { ...canonicalSession, agent }
    }
    return {
      pane: location.pane,
      tab: location.tab,
      workspace: location.workspace,
      canonicalSession,
      session: effectiveSession,
      status
    }
  }

  private async readCanonicalSession(sessionId: string): Promise<Session | null> {
    try {
      const value = await this.withDeadline(
        this.context.call('quirky.session/get', { session: sessionId }),
        TERMINAL_CHECK_DEADLINE_MS,
        'session lookup'
      )
      return isObject(value) && value.id === sessionId ? value as Session : null
    } catch {
      return null
    }
  }

  private conflict(message: string, state: DockState): Error {
    const error = this.context.error('conflict', `${message}; current state: ${JSON.stringify(state)}`)
    Object.assign(error, { data: { state } })
    return error
  }

  private async readStatus(session: Session): Promise<StatusProjection> {
    try {
      const value = await this.withDeadline(
        this.context.call('quirky.agent-status/get', { session: session.id }),
        PROVIDER_READ_DEADLINE_MS,
        'agent status lookup'
      )
      if (isObject(value)) {
        if (!this.statusLeadIdentities.has(session.id)) this.rememberStatusLeadIdentity(session.id, value)
        return value as StatusProjection
      }
      return null
    } catch {
      return null
    }
  }

  private async reconcileBinding(binding: PaneBinding, status: StatusProjection): Promise<DockRecord> {
    const current = this.store.get(binding.pane)
    if (!this.enabled() && !current) return defaultDockRecord(binding.pane, binding.session.id, binding.tab)
    if (!current && !this.supported(binding.session)) return defaultDockRecord(binding.pane, binding.session.id, binding.tab)
    if (!this.enabled()) return current!
    if (status?.state) {
      const previous = this.statusStates.get(binding.session.id)
      if (previous === 'working' && (status.state === 'waiting' || status.state === 'blocked' || status.state === 'done')) {
        this.clearPanePassthrough(binding.pane)
      }
      this.statusStates.set(binding.session.id, status.state)
    }

    return this.mutate(() => {
      if (!this.enabled() || this.stopped) return this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
      let record = this.store.get(binding.pane)
      const isNew = record === null
      if (!record) record = defaultDockRecord(binding.pane, binding.session.id, binding.tab)
      let changed = isNew

      if (record.session !== binding.session.id) {
        record.session = binding.session.id
        record.tab = binding.tab
        record.docked = false
        record.agent = null
        record.autoOpenEvaluated = false
        record.providerPromptCount = 0
        this.providers.delete(binding.pane)
        this.overlays.delete(binding.pane)
        this.resolvedQuestions.delete(binding.pane)
        this.historyBrowse.delete(binding.pane)
        this.clearPanePassthrough(binding.pane)
        changed = true
      } else if (record.tab !== binding.tab) {
        record.tab = binding.tab
        changed = true
      }

      const supported = this.supported(binding.session)
      const ended = this.sessionEnded(binding, status)
      if (ended) {
        if (record.docked || record.agent !== null || record.autoOpenEvaluated) changed = true
        record.docked = false
        record.agent = null
        record.autoOpenEvaluated = false
        this.providers.delete(binding.pane)
        this.overlays.delete(binding.pane)
        this.resolvedQuestions.delete(binding.pane)
        this.clearPanePassthrough(binding.pane)
      } else if (!supported) {
        if (record.docked || record.agent !== null || !record.autoOpenEvaluated) changed = true
        record.docked = false
        record.agent = null
        record.autoOpenEvaluated = true
        this.providers.delete(binding.pane)
        this.overlays.delete(binding.pane)
        this.resolvedQuestions.delete(binding.pane)
        this.clearPanePassthrough(binding.pane)
      } else {
        if (!record.autoOpenEvaluated) {
          record.autoOpenEvaluated = true
          if (this.autoOpen() && !record.userUndocked) record.docked = true
          changed = true
        }
        if (record.docked && record.agent !== binding.session.agent) {
          record.agent = binding.session.agent
          this.providers.delete(binding.pane)
          this.overlays.delete(binding.pane)
          this.resolvedQuestions.delete(binding.pane)
          changed = true
        } else if (!record.docked && record.agent !== null) {
          record.agent = null
          changed = true
        }
      }

      if (!changed) return record
      record.revision++
      record.updatedAt = Date.now()
      this.store.put(record)
      return record
    })
  }

  private async ensureRecovered(): Promise<void> {
    if (!this.enabled() || !this.recoveryPending || this.stopped) return
    const removedUploads = await this.mutate(() => {
      if (!this.enabled() || this.stopped) return []
      const garbage: DockAttachment[] = []
      this.store.transaction(() => {
        for (const record of this.store.all()) {
          if (record.recovery.length === 0) continue
          const ordered = [...record.recovery].sort((a, b) => a.sequence - b.sequence)
          const textParts = ordered.map((snapshot) => snapshot.text)
          textParts.push(record.draft)
          const draft = combineText(textParts)
          const attachmentIds = prependUnique(ordered.flatMap((snapshot) => snapshot.attachments), record.draftAttachments)
          const acceptedPrompts = ordered.filter((snapshot) => snapshot.mayHaveWritten).map((snapshot) => snapshot.text)
          record.draft = draft
          record.draftAttachments = attachmentIds
          record.history = boundedHistory([...record.history, ...acceptedPrompts])
          record.recovery = []
          record.notice = RECOVERY_WARNING
          garbage.push(...this.collectUnreferencedMetadata(record))
          record.revision++
          record.updatedAt = Date.now()
          this.store.put(record)
        }
      })
      return garbage
    })
    if (!this.enabled() || this.stopped) return
    this.recoveryPending = false
    await this.deleteOwnedUploads(removedUploads)
  }

  private async reconcileAll(): Promise<void> {
    if (!this.enabled() || this.stopped) return
    await this.ensureRecovered()
    let sessions: Session[]
    try {
      sessions = (await this.withDeadline(this.context.call('quirky.session/list', {}), TERMINAL_CHECK_DEADLINE_MS, 'session list')) as Session[]
    } catch {
      return
    }
    if (!Array.isArray(sessions)) return
    const retained = new Set<string>()
    const tabByPane = new Map<string, string>()
    for (const session of sessions) {
      if (!session || session.kind !== 'terminal') continue
      try {
        const binding = await this.resolveBinding({ session: session.id })
        retained.add(binding.pane)
        tabByPane.set(binding.pane, binding.tab)
        await this.reconcileBinding(binding, binding.status)
      } catch {
        // A session not represented by a public live pane has no dock scope to retain.
      }
    }
    if (!this.enabled() || this.stopped) return
    const before = this.store.all()
    const pinned = this.mountedPanes()
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) return
      this.store.prune(retained, pinned, tabByPane)
    })
    if (!this.enabled() || this.stopped) return
    const remaining = new Set(this.store.all().map((record) => record.pane))
    const uploads = before.flatMap((record) => record.attachments.filter((attachment) => record.ownedAttachmentIds.includes(attachment.id) && !remaining.has(record.pane)))
    await this.deleteOwnedUploads(uploads)
    const activeSessions = new Set(sessions.filter((session) => session?.kind === 'terminal').map((session) => session.id))
    for (const sessionId of this.statusStates.keys()) if (!activeSessions.has(sessionId)) this.statusStates.delete(sessionId)
    for (const sessionId of this.titles.keys()) if (!activeSessions.has(sessionId)) this.titles.delete(sessionId)
    for (const sessionId of this.manualAgents.keys()) if (!activeSessions.has(sessionId)) this.manualAgents.delete(sessionId)
    for (const sessionId of this.manualCandidates.keys()) if (!activeSessions.has(sessionId)) this.manualCandidates.delete(sessionId)
    for (const sessionId of this.confirmedExits.keys()) if (!activeSessions.has(sessionId)) this.confirmedExits.delete(sessionId)
    for (const sessionId of this.freshEvidence.keys()) if (!activeSessions.has(sessionId)) this.freshEvidence.delete(sessionId)
    for (const sessionId of this.statusLeadIdentities.keys()) if (!activeSessions.has(sessionId)) this.statusLeadIdentities.delete(sessionId)
    for (const sessionId of this.sessionEndCandidates.keys()) if (!activeSessions.has(sessionId)) this.sessionEndCandidates.delete(sessionId)
    const knownPanes = new Set([
      ...this.providers.keys(),
      ...this.overlays.keys(),
      ...this.resolvedQuestions.keys(),
      ...this.historyBrowse.keys(),
      ...this.drivers.keys(),
      ...this.mountedPanes()
    ])
    for (const reports of this.reports.values()) {
      for (const report of reports.values()) knownPanes.add(report.pane)
    }
    for (const pane of knownPanes) {
      if (retained.has(pane)) continue
      this.providers.delete(pane)
      this.overlays.delete(pane)
      this.resolvedQuestions.delete(pane)
      this.historyBrowse.delete(pane)
      this.clearPanePassthrough(pane)
      this.releaseDriver(pane)
      for (const [connection, reports] of this.reports) {
        reports.delete(pane)
        this.passthroughOwners.get(connection)?.delete(pane)
        if (reports.size === 0) this.reports.delete(connection)
      }
    }
    for (const pane of retained) this.announce(pane)
  }

  private async get(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding(params)
    return this.stateForBinding(binding)
  }

  private async list(): Promise<{ panes: DockState[] }> {
    if (this.enabled()) await this.reconcileAll()
    const panes: DockState[] = []
    for (const record of this.store.all()) {
      try {
        const binding = await this.resolveBinding({ pane: record.pane })
        panes.push(await this.stateForBinding(binding, false))
      } catch {
        // Closed panes are pruned while enabled and omitted without cleanup writes while disabled.
      }
    }
    return { panes }
  }

  private async stateForBinding(binding: PaneBinding, reconcile = true): Promise<DockState> {
    if (this.enabled()) {
      await this.ensureRecovered()
      if (reconcile) await this.reconcileBinding(binding, binding.status)
    }
    if (this.enabled() && this.supported(binding.session) && binding.session.status !== 'exited') {
      await this.refreshProvider(binding)
    }
    const record = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
    const transport = await this.transportFor(binding)
    return this.stateFrom(binding, record, transport, binding.status)
  }

  private stateFrom(binding: PaneBinding, record: DockRecord, transport: TransportReport, status: StatusProjection): DockState {
    const enabled = this.enabled()
    const supported = this.supported(binding.session)
    const lease = this.activeDriver(binding.pane)
    const queue = this.queues.get(binding.session.id)
    const current = queue?.active?.kind === 'send' && queue.active.pane === binding.pane ? queue.active : null
    const queued = (queue?.pending ?? [])
      .filter((operation) => operation.kind === 'send' && operation.pane === binding.pane && !operation.settled)
      .map((operation) => ({ id: operation.id, phase: operation.phase }))
    const provider = this.providers.get(binding.pane)
    const question = provider?.session === binding.session.id && provider.agent === binding.session.agent
      ? this.questionFor(binding.pane, provider.question)
      : null
    const supportedLiveAgent = supported && !this.sessionEnded(binding, status)
    const mounted = enabled && record.docked && this.hasMountedReport(binding.pane)
    const passthrough = mounted && this.hasActivePassthrough(binding.pane)
    const state: DockState = {
      pane: binding.pane,
      session: binding.session.id,
      tab: binding.tab,
      revision: record.revision,
      enabled,
      supported,
      agent: supportedLiveAgent ? binding.session.agent : record.docked ? record.agent : null,
      docked: record.docked,
      userUndocked: record.userUndocked,
      gutterRows: record.gutterRows,
      mounted,
      passthrough,
      draft: record.draft,
      attachments: record.draftAttachments.flatMap((id) => {
        const attachment = record.attachments.find((candidate) => candidate.id === id)
        return attachment ? [attachment] : []
      }),
      disabledReason: this.reasonFor(binding, enabled, supported, transport, lease, status),
      activeSend: current ? { id: current.id, phase: current.phase } : null,
      queuedSends: queued,
      question,
      options: provider?.session === binding.session.id && provider.agent === binding.session.agent
        ? optionsWithNotice(provider.options, provider.options.notice)
        : this.emptyOptions(),
      notice: record.notice,
      ...(lease ? { driverOwner: lease.owner } : {})
    }
    return state
  }

  private reasonFor(binding: PaneBinding, enabled: boolean, supported: boolean, transport: TransportReport, lease: DriverLease | undefined, status: StatusProjection): string | null {
    if (binding.session.kind !== 'terminal' || this.sessionEnded(binding, status) || transport.noTerminal) return 'No terminal session'
    if (transport.reason) return transport.reason
    if (lease) return 'Mobile device is composing'
    if (!enabled) return 'Terminal dock is disabled'
    if (!supported) return 'This agent is not supported by Terminal Dock'
    return null
  }

  private async transportFor(binding: PaneBinding): Promise<TransportReport> {
    if (binding.session.kind !== 'terminal' || binding.session.status === 'exited') return { noTerminal: true, reason: null }
    if (!this.context.pty.connected) return { noTerminal: false, reason: 'Terminal is disconnected' }
    let sessions: PtySessionInfo[]
    try {
      sessions = await this.withDeadline(this.context.pty.list(), TERMINAL_CHECK_DEADLINE_MS, 'terminal session list')
    } catch {
      return { noTerminal: false, reason: this.reportReason(binding.pane) ?? 'Terminal is disconnected' }
    }
    const current = sessions.find((session) => session.sessionId === binding.session.id)
    if (current && !this.confirmedExits.has(current.sessionId)) {
      const title = current.title ?? ''
      this.rememberTitle(current.sessionId, title, 'list')
      const agent = agentForTitle(title, this.catalog)
      if (agent) this.rememberManualCandidate(current.sessionId, agent)
    }
    if (current?.state === 'exited') return { noTerminal: true, reason: null }
    if (current?.state === 'restorable') return { noTerminal: false, reason: 'Terminal is recovering' }
    if (!current || !current.alive) {
      if (binding.session.status === 'starting') return { noTerminal: false, reason: 'Terminal is connecting' }
      return { noTerminal: false, reason: this.reportReason(binding.pane) ?? 'Terminal is disconnected' }
    }
    const reported = this.reportReason(binding.pane)
    return { noTerminal: false, reason: reported === 'Terminal is connected' ? null : reported }
  }

  private reportReason(pane: string): string | null {
    const reports: { connection: number; report: HostReport }[] = []
    for (const [connection, panes] of this.reports) {
      const report = panes.get(pane)
      if (report) reports.push({ connection, report })
    }
    const focused = reports.filter(({ connection, report }) => this.activeWindows.has(connection) && report.focused)
    const candidates = focused.length > 0 ? focused : reports
    if (candidates.some(({ report }) => report.transport === 'connected')) return null
    const transport = candidates.find(({ report }) => report.transport)?.report.transport
    if (!transport || transport === 'connected') return null
    const reasons: Record<string, string> = {
      connecting: 'Terminal is connecting',
      reconnecting: 'Terminal is reconnecting',
      disconnected: 'Terminal is disconnected',
      offline: 'Terminal is offline'
    }
    return reasons[transport] ?? 'Terminal transport is unavailable'
  }

  private supported(session: Session): boolean {
    return session.kind === 'terminal' && isCatalogAgent(session.agent, this.catalog)
  }
  private sessionEnded(binding: PaneBinding, status: StatusProjection): boolean {
    if (binding.canonicalSession.status === 'exited' || this.confirmedExits.has(binding.session.id)) return true
    return statusEnded(status) && binding.session.agent === binding.canonicalSession.agent
  }


  private async set(params: Record<string, unknown>, caller: PluginCaller): Promise<DockState> {
    if (Object.hasOwn(params, 'passthrough') && caller.role !== 'ui') {
      const response = await this.context.call('ui.command.run', {
        id: 'command:quirky.terminal-dock/set',
        args: params
      }) as { result: DockState }
      return response.result
    }
    const binding = await this.resolveBinding({ pane: params.pane })
    await this.ensureRecovered()
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    const status = binding.status
    await this.reconcileBinding(binding, status)
    const callerConnection = this.connectionId(caller)
    const changesPassthrough = Object.hasOwn(params, 'passthrough')
    if (changesPassthrough) {
      if (!callerConnection) throw this.context.error('invalid-params', 'passthrough needs a client connection')
      if (params.passthrough === true) {
        const current = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
        const host = this.reports.get(callerConnection)?.get(binding.pane)
        const remainsDocked = params.docked === false ? false : current.docked || params.docked === true
        if (!host?.mounted || !host.focused || !this.activeWindows.has(callerConnection) || !remainsDocked) {
          throw this.context.error('invalid-params', 'passthrough requires the active mounted dock host')
        }
      }
    }
    let garbage: DockAttachment[] = []
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) throw this.context.error('invalid-params', 'Terminal dock is disabled')
      const current = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
      const replacesDraft = Object.hasOwn(params, 'draft') || Object.hasOwn(params, 'attachments')
      if (replacesDraft && params.revision !== current.revision) {
        const cached = this.stateFrom(binding, current, { noTerminal: false, reason: null }, status)
        throw this.conflict('dock revision conflict', cached)
      }
      if (params.docked === true && !this.supported(binding.session)) {
        throw this.context.error('invalid-params', 'Terminal Dock only opens for supported agent terminals')
      }
      if (params.docked === true && this.sessionEnded(binding, status)) {
        throw this.context.error('invalid-params', 'No terminal session')
      }
      if (Object.hasOwn(params, 'draft') && typeof params.draft !== 'string') throw this.context.error('invalid-params', 'draft must be a string')
      if (Object.hasOwn(params, 'gutterRows') && (!Number.isInteger(params.gutterRows) || (params.gutterRows as number) < MIN_GUTTER_ROWS || (params.gutterRows as number) > MAX_GUTTER_ROWS)) {
        throw this.context.error('invalid-params', `gutterRows must be between ${MIN_GUTTER_ROWS} and ${MAX_GUTTER_ROWS}`)
      }
      if (Object.hasOwn(params, 'attachments') && (!Array.isArray(params.attachments) || !params.attachments.every((id) => typeof id === 'string'))) {
        throw this.context.error('invalid-params', 'attachments must be an array of attachment IDs')
      }
      if (Object.hasOwn(params, 'passthrough') && typeof params.passthrough !== 'boolean') throw this.context.error('invalid-params', 'passthrough must be a boolean')

      if ((Object.hasOwn(params, 'draft') || Object.hasOwn(params, 'attachments')) && !this.supported(binding.session)) {
        throw this.context.error('invalid-params', 'drafts and attachments require a supported agent terminal')
      }
      const candidateDraft = Object.hasOwn(params, 'draft') ? (params.draft as string) : current.draft
      const candidateAttachmentIds = Object.hasOwn(params, 'attachments') ? (params.attachments as string[]) : current.draftAttachments
      if (new Set(candidateAttachmentIds).size !== candidateAttachmentIds.length) throw this.context.error('invalid-params', 'attachment IDs must be unique')
      for (const id of candidateAttachmentIds) {
        if (!current.attachments.some((attachment) => attachment.id === id)) throw this.context.error('invalid-params', `unknown attachment ${id}`)
      }
      if (recoverableTextLength(candidateDraft, current.recovery) > MAX_RECOVERABLE_CHARS) {
        throw this.context.error('invalid-params', 'recoverable-text-limit: current draft and queued sends exceed 200000 characters')
      }
      if (recoverableAttachmentCount(candidateAttachmentIds, current.recovery) > MAX_ATTACHMENTS) {
        throw this.context.error('invalid-params', `current and queued attachments exceed ${MAX_ATTACHMENTS}`)
      }

      let changed = false
      if (Object.hasOwn(params, 'docked') && typeof params.docked === 'boolean') {
        const userUndocked = !params.docked
        const agent = params.docked ? binding.session.agent : null
        if (current.docked !== params.docked || current.userUndocked !== userUndocked || current.agent !== agent || !current.autoOpenEvaluated) {
          current.docked = params.docked
          current.userUndocked = userUndocked
          current.autoOpenEvaluated = true
          current.agent = agent
          changed = true
          if (!params.docked) this.clearPanePassthrough(binding.pane)
        }
      }
      if (Object.hasOwn(params, 'gutterRows') && current.gutterRows !== params.gutterRows) {
        current.gutterRows = params.gutterRows as number
        changed = true
      }
      if (Object.hasOwn(params, 'draft') && current.draft !== candidateDraft) {
        current.draft = candidateDraft
        this.historyBrowse.delete(binding.pane)
        current.notice = null
        changed = true
      }
      if (Object.hasOwn(params, 'attachments') && current.draftAttachments.join('\0') !== candidateAttachmentIds.join('\0')) {
        current.draftAttachments = [...candidateAttachmentIds]
        changed = true
      }
      const metadataCount = current.attachments.length
      garbage = this.collectUnreferencedMetadata(current)
      if (changed || current.attachments.length !== metadataCount) {
        current.revision++
        current.updatedAt = Date.now()
        this.store.put(current)
      }
      return current
    })

    if (changesPassthrough && callerConnection && this.enabled()) {
      if (params.passthrough === true) {
        const owners = this.passthroughOwners.get(callerConnection) ?? new Set<string>()
        owners.add(binding.pane)
        this.passthroughOwners.set(callerConnection, owners)
      } else {
        this.passthroughOwners.get(callerConnection)?.delete(binding.pane)
      }
    }
    await this.deleteOwnedUploads(garbage)
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async report(params: Record<string, unknown>, caller: PluginCaller): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!('connection' in caller) || !caller.connection || caller.role !== 'ui') {
      throw this.context.error('invalid-params', 'report requires a connected UI window')
    }
    const connection = caller.connection.id
    if (typeof params.mounted !== 'boolean') throw this.context.error('invalid-params', 'mounted must be a boolean')
    if (params.focused !== undefined && typeof params.focused !== 'boolean') throw this.context.error('invalid-params', 'focused must be a boolean')
    const allowed = ['connected', 'connecting', 'reconnecting', 'disconnected', 'offline']
    if (params.transport !== undefined && (typeof params.transport !== 'string' || !allowed.includes(params.transport))) {
      throw this.context.error('invalid-params', 'invalid terminal transport state')
    }
    if (this.enabled()) {
      await this.ensureRecovered()
      await this.reconcileBinding(binding, binding.status)
    }
    const reports = this.reports.get(connection) ?? new Map<string, HostReport>()
    reports.set(binding.pane, {
      pane: binding.pane,
      mounted: params.mounted,
      focused: params.focused === true,
      ...(typeof params.transport === 'string' ? { transport: params.transport } : {}),
      updatedAt: Date.now()
    })
    this.reports.set(connection, reports)
    if (!params.mounted) this.passthroughOwners.get(connection)?.delete(binding.pane)
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async history(params: Record<string, unknown>): Promise<{ entries: string[]; state: DockState }> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    await this.ensureRecovered()
    await this.reconcileBinding(binding, binding.status)
    const direction = params.direction
    if (direction !== undefined && direction !== 'previous' && direction !== 'next') {
      throw this.context.error('invalid-params', 'history direction must be previous or next')
    }
    if (direction === undefined) {
      const record = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
      return { entries: [...record.history], state: await this.stateForBinding(binding, false) }
    }
    if (!this.supported(binding.session)) throw this.context.error('invalid-params', 'history requires a supported agent terminal')
    await this.refreshProvider(binding, true)
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) throw this.context.error('invalid-params', 'Terminal dock is disabled')
      const record = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
      if (record.history.length === 0) return
      let browse = this.historyBrowse.get(binding.pane)
      if (direction === 'previous') {
        if (!browse) browse = { index: record.history.length, savedDraft: record.draft }
        browse.index = Math.max(0, browse.index - 1)
        this.historyBrowse.set(binding.pane, browse)
        record.draft = record.history[browse.index] ?? browse.savedDraft
      } else {
        if (!browse) return
        browse.index = Math.min(record.history.length, browse.index + 1)
        if (browse.index >= record.history.length) {
          record.draft = browse.savedDraft
          this.historyBrowse.delete(binding.pane)
        } else {
          this.historyBrowse.set(binding.pane, browse)
          record.draft = record.history[browse.index]!
        }
      }
      if (recoverableTextLength(record.draft, record.recovery) > MAX_RECOVERABLE_CHARS) {
        throw this.context.error('invalid-params', 'recoverable-text-limit: history entry cannot be restored within the draft budget')
      }
      record.revision++
      record.updatedAt = Date.now()
      this.store.put(record)
    })
    this.announce(binding.pane)
    const record = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
    return { entries: [...record.history], state: await this.stateForBinding(binding, false) }
  }

  private async pick(params: Record<string, unknown>): Promise<{ items: PickerItem[]; truncated: boolean }> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    if (!this.supported(binding.session)) throw this.context.error('invalid-params', 'pickers require a supported agent terminal')
    const kind = params.kind
    if (kind !== 'slash' && kind !== 'file') throw this.context.error('invalid-params', 'picker kind must be slash or file')
    const query = typeof params.query === 'string' ? params.query : ''
    try {
      return await this.withDeadline(pickItems(this.context, binding.session, kind, query), PROVIDER_READ_DEADLINE_MS, 'picker lookup')
    } catch (error) {
      throw this.context.error('invalid-params', `picker unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async attach(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    if (!this.supported(binding.session)) throw this.context.error('invalid-params', 'attachments require a supported agent terminal')
    const path = typeof params.path === 'string' ? params.path : undefined
    const name = typeof params.name === 'string' ? params.name : undefined
    const mime = typeof params.mime === 'string' ? params.mime : undefined
    const base64 = typeof params.base64 === 'string' ? params.base64 : undefined
    if (path && (name !== undefined || base64 !== undefined)) throw this.context.error('invalid-params', 'pass a path or an uploaded name/base64 pair, not both')
    if (!path && (name === undefined || base64 === undefined)) throw this.context.error('invalid-params', 'attachment upload needs both name and base64')
    const input: AttachInput = { ...(path ? { path } : { name, base64 }), ...(mime ? { mime } : {}) }
    await this.ensureRecovered()
    await this.reconcileBinding(binding, binding.status)
    const current = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
    if (recoverableAttachmentCount(current.draftAttachments, current.recovery) >= MAX_ATTACHMENTS) {
      throw this.context.error('invalid-params', `current and queued attachments already use the ${MAX_ATTACHMENTS}-attachment limit`)
    }

    let attachment: DockAttachment
    try {
      attachment = await this.withDeadline(acquireAttachment(this.context, input), PROVIDER_READ_DEADLINE_MS, 'attachment acquisition')
    } catch (error) {
      throw this.context.error('invalid-params', `attachment acquisition failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    let garbage: DockAttachment[] = []
    try {
      await this.mutate(() => {
        if (!this.enabled() || this.stopped) throw this.context.error('invalid-params', 'Terminal dock is disabled')
        const record = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
        if (recoverableAttachmentCount(record.draftAttachments, record.recovery) >= MAX_ATTACHMENTS) {
          throw this.context.error('invalid-params', `current and queued attachments already use the ${MAX_ATTACHMENTS}-attachment limit`)
        }
        if (record.attachments.some((item) => item.id === attachment.id)) throw this.context.error('invalid-params', 'attachment ID already exists')
        record.attachments.push(attachment)
        record.draftAttachments.push(attachment.id)
        if (base64 !== undefined) record.ownedAttachmentIds.push(attachment.id)
        garbage = this.collectUnreferencedMetadata(record)
        record.revision++
        record.updatedAt = Date.now()
        this.store.put(record)
      })
    } catch (error) {
      if (base64 !== undefined) await this.deleteOwnedUploads([attachment])
      throw error
    }
    await this.deleteOwnedUploads(garbage)
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async removeAttachment(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    if (typeof params.attachment !== 'string' || params.attachment.length === 0) throw this.context.error('invalid-params', 'attachment ID is required')
    await this.ensureRecovered()
    let garbage: DockAttachment[] = []
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) throw this.context.error('invalid-params', 'Terminal dock is disabled')
      const record = this.store.get(binding.pane)
      if (!record) throw this.context.error('not-found', 'dock record not found')
      if (!record.draftAttachments.includes(params.attachment as string)) throw this.context.error('not-found', 'attachment is not attached to this draft')
      record.draftAttachments = record.draftAttachments.filter((id) => id !== params.attachment)
      garbage = this.collectUnreferencedMetadata(record)
      record.revision++
      record.updatedAt = Date.now()
      this.store.put(record)
    })
    await this.deleteOwnedUploads(garbage)
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async send(params: Record<string, unknown>): Promise<SendResult> {
    // Keep same-pane calls in arrival order while resolving each accepted session binding.
    const paneAdmissionKey = typeof params.pane === 'string' ? `pane:${params.pane}` : null
    const releasePaneAdmission = paneAdmissionKey
      ? await this.reserveSendAdmission(paneAdmissionKey)
      : () => {}
    let resultPromise: Promise<unknown>
    try {
      const binding = await this.resolveBinding({ pane: params.pane })
      const id = params.id === undefined ? randomUUID() : params.id
      if (typeof id !== 'string' || id.length === 0 || id.length > 160) throw this.context.error('invalid-params', 'send id must be a nonempty string of at most 160 characters')
      if (!this.enabled()) return { id, outcome: 'refused', accepted: false, reason: 'Terminal dock is disabled' }
      // Session admission keeps asynchronous preflight from reordering queue reservations.
      const releaseSessionAdmission = await this.reserveSendAdmission(`session:${binding.session.id}`)
      try {
        await this.ensureRecovered()
        const status = binding.status
        await this.reconcileBinding(binding, status)
        const refusal = await this.writeRefusal(binding, status)
        if (refusal) return { id, outcome: 'refused', accepted: false, reason: refusal }
        const provider = await this.refreshProvider(binding, true)
        if (provider.question) return { id, outcome: 'refused', accepted: false, reason: 'An agent question or permission request is awaiting an answer' }

        const textSupplied = Object.hasOwn(params, 'text')
        if (textSupplied && typeof params.text !== 'string') throw this.context.error('invalid-params', 'send text must be a string')
        let snapshot: DockRecovery | undefined
        let attachments: DockAttachment[] = []
        const prepared = await this.mutate(() => {
          const record = this.store.get(binding.pane) ?? defaultDockRecord(binding.pane, binding.session.id, binding.tab)
          if (this.wasUsedId(id)) throw this.context.error('invalid-params', `duplicate send ID ${id}`)
          if (!textSupplied && params.revision !== record.revision) {
            const state = this.stateFrom(binding, record, { noTerminal: false, reason: null }, null)
            throw this.conflict('dock revision conflict', state)
          }
          if (record.recovery.length >= 64) throw this.context.error('invalid-params', 'terminal dock send queue is full')
          const text = textSupplied ? (params.text as string) : record.draft
          const attachmentIds = textSupplied ? [] : [...record.draftAttachments]
          if (text.length === 0 && attachmentIds.length === 0) {
            return { refused: { id, outcome: 'refused', accepted: false, reason: 'Send requires text or an attachment' } satisfies SendResult }
          }
          const sequence = record.nextSequence++
          snapshot = { id, sequence, text, attachments: attachmentIds, mayHaveWritten: false, createdAt: Date.now() }
          const nextRecovery = [...record.recovery, snapshot]
          const nextDraft = textSupplied ? record.draft : ''
          const nextDraftAttachments = textSupplied ? record.draftAttachments : []
          if (recoverableTextLength(nextDraft, nextRecovery) > MAX_RECOVERABLE_CHARS) {
            throw this.context.error('invalid-params', 'recoverable-text-limit: enqueue would exceed the 200000-character combined recovery budget')
          }
          if (recoverableAttachmentCount(nextDraftAttachments, nextRecovery) > MAX_ATTACHMENTS) {
            throw this.context.error('invalid-params', `queued send would exceed the ${MAX_ATTACHMENTS}-attachment recovery budget`)
          }
          for (const attachmentId of attachmentIds) {
            const attachment = record.attachments.find((item) => item.id === attachmentId)
            if (!attachment) throw this.context.error('invalid-params', `attachment ${attachmentId} is no longer available`)
            attachments.push(attachment)
          }
          record.recovery = nextRecovery
          record.recentSendIds = [...record.recentSendIds.filter((existing) => existing !== id), id].slice(-200)
          if (!textSupplied) {
            record.draft = ''
            record.draftAttachments = []
            this.historyBrowse.delete(binding.pane)
          }
          record.notice = null
          record.revision++
          record.updatedAt = Date.now()
          this.store.put(record)
          return { queued: true }
        })
        if ('refused' in prepared && prepared.refused !== undefined) return prepared.refused
        if (!snapshot) throw this.context.error('conflict', 'send snapshot was not created')

        const operation = this.createOperation(id, binding, 'send', async (operation) => {
          const result = await executePrompt({
            context: this.context,
            session: binding.session,
            text: snapshot!.text,
            attachments,
            bridge: this.bridge,
            signal: operation.controller.signal,
            ensure: () => this.ensureWritable(binding, operation.controller.signal),
            phase: (phase) => {
              operation.phase = phase
              this.announce(binding.pane)
            },
            ...(this.testHooks.beforeSubmit ? { beforeSubmit: this.testHooks.beforeSubmit } : {}),
            bodyMayHaveBeenWritten: async () => {
              if (this.stopped || operation.controller.signal.aborted || !this.enabled() || operation.restored) {
                throw new Error('Terminal dock send stopped before body dispatch')
              }
              await this.mutate(() => {
                if (this.stopped || operation.controller.signal.aborted || !this.enabled() || operation.restored) return
                const record = this.store.get(binding.pane)
                const recovery = record?.recovery.find((item) => item.id === id)
                if (!record || !recovery || recovery.mayHaveWritten) return
                recovery.mayHaveWritten = true
                record.updatedAt = Date.now()
                this.store.put(record)
              })
            }
          }, id)
          return result
        }, snapshot)
        resultPromise = this.enqueue(operation)
      } finally {
        releaseSessionAdmission()
      }
    } finally {
      releasePaneAdmission()
    }
    const result = await resultPromise
    return result as SendResult
  }

  private async cancel(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (Object.hasOwn(params, 'send') && (typeof params.send !== 'string' || params.send.length === 0)) {
      throw this.context.error('invalid-params', 'send must be a nonempty operation ID')
    }
    if (Object.hasOwn(params, 'interrupt') && typeof params.interrupt !== 'boolean') {
      throw this.context.error('invalid-params', 'interrupt must be a boolean')
    }
    const sendId = params.send as string | undefined
    if (sendId) {
      const operation = this.sendOperations.get(sendId)
      if (!operation || operation.pane !== binding.pane) throw this.context.error('not-found', `no queued or active send ${sendId} for pane ${binding.pane}`)
      await this.cancelOperation(operation)
    } else {
      const operations = [...this.sendOperations.values()].filter((operation) => operation.pane === binding.pane)
      for (const operation of operations.filter((item) => item.started)) await this.cancelOperation(operation)
      for (const operation of operations.filter((item) => !item.started).reverse()) await this.cancelOperation(operation)
    }
    if (params.interrupt === true && this.enabled()) await this.interrupt(binding).catch(() => undefined)
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async interaction(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    const request = params.request
    const action = params.action
    if (typeof request !== 'string' || request.length === 0) throw this.context.error('invalid-params', 'question request ID is required')
    if (action !== 'answer' && action !== 'collapse' && action !== 'expand' && action !== 'dismiss') {
      throw this.context.error('invalid-params', 'invalid interaction action')
    }
    const current = await this.refreshProvider(binding, true)
    if (!current.question || current.question.id !== request) throw this.context.error('not-found', 'question request is stale or no longer pending')

    if (action !== 'answer') {
      const old = this.overlays.get(binding.pane)
      const overlay: QuestionOverlay = {
        id: request,
        collapsed: action === 'collapse' ? true : action === 'expand' ? false : old?.collapsed ?? current.question.collapsed,
        dismissed: action === 'dismiss' ? true : false
      }
      this.overlays.set(binding.pane, overlay)
      this.announce(binding.pane)
      return this.stateForBinding(binding, false)
    }

    const answers = params.answers
    if (!Array.isArray(answers) || !answers.every((group) => Array.isArray(group) && group.every((value) => typeof value === 'string'))) {
      throw this.context.error('invalid-params', 'answers must be a string matrix')
    }
    this.validateAnswers(current.question, answers as string[][])
    await this.enqueueControl(binding, async (signal) => {
      await this.ensureWritable(binding, signal)
      const latest = await this.refreshProvider(binding, true)
      if (!latest.question || latest.question.id !== request) throw this.context.error('not-found', 'question request became stale before answer')
      this.validateAnswers(latest.question, answers as string[][])
      const result = await this.withDeadline(
        this.bridge.answer(binding.session, latest.question, answers as string[][], signal),
        15_000,
        'provider answer'
      )
      await this.ensureWritable(binding, signal)
      if (result.confirmed) {
        this.rememberResolvedQuestion(binding.pane, request)
        this.overlays.delete(binding.pane)
      }
      this.providers.delete(binding.pane)
      const refreshed = await this.refreshProvider(binding, true)
      if (!result.confirmed) {
        this.providers.set(binding.pane, {
          session: binding.session.id,
          agent: binding.session.agent,
          question: refreshed.question,
          options: optionsWithNotice(refreshed.options, optionNotice(result.notice) ?? 'Sent to the agent — not confirmed'),
          readAt: Date.now()
        })
      }
    })
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async options(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (!this.enabled()) throw this.context.error('invalid-params', 'Terminal dock is disabled')
    const hasKind = Object.hasOwn(params, 'kind')
    const hasValue = Object.hasOwn(params, 'value')
    if (hasKind !== hasValue) throw this.context.error('invalid-params', 'options mutation requires both kind and value')
    if (!hasKind) return this.stateForBinding(binding)
    const kind = params.kind
    const value = params.value
    if ((kind !== 'model' && kind !== 'effort' && kind !== 'permission') || typeof value !== 'string' || value.length === 0) {
      throw this.context.error('invalid-params', 'options requires a supported kind and nonempty value')
    }
    const current = await this.refreshProvider(binding, true)
    if (!current.options.choices[kind].includes(value)) throw this.context.error('invalid-params', `${kind} choice is not available for this session`)

    await this.enqueueControl(binding, async (signal) => {
      await this.ensureWritable(binding, signal)
      const latest = await this.refreshProvider(binding, true)
      if (!latest.options.choices[kind].includes(value)) throw this.context.error('invalid-params', `${kind} choice is no longer available`)
      const result = await this.withDeadline(
        this.bridge.setOption(binding.session, kind, value, signal),
        15_000,
        'provider option change'
      )
      await this.ensureWritable(binding, signal)
      this.providers.delete(binding.pane)
      const refreshed = await this.refreshProvider(binding, true)
      if (result.confirmed) {
        const confirmed = { ...refreshed.options, choices: { ...refreshed.options.choices }, [kind]: value }
        this.providers.set(binding.pane, {
          session: binding.session.id,
          agent: binding.session.agent,
          question: refreshed.question,
          options: confirmed,
          readAt: Date.now()
        })
      } else {
        this.providers.set(binding.pane, {
          session: binding.session.id,
          agent: binding.session.agent,
          question: refreshed.question,
          options: optionsWithNotice(refreshed.options, optionNotice(result.notice) ?? 'Sent to the agent — not confirmed'),
          readAt: Date.now()
        })
      }
    })
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async driver(params: Record<string, unknown>): Promise<DockState> {
    const binding = await this.resolveBinding({ pane: params.pane })
    if (this.enabled()) {
      await this.ensureRecovered()
      await this.reconcileBinding(binding, binding.status)
    }
    if (params.owner === undefined) {
      if (params.ttlMs !== undefined) throw this.context.error('invalid-params', 'ttlMs requires a driver owner')
      this.releaseDriver(binding.pane)
    } else {
      if (typeof params.owner !== 'string' || params.owner.trim().length === 0 || params.owner.length > 160) {
        throw this.context.error('invalid-params', 'driver owner must be a nonempty identifier')
      }
      const ttlMs = params.ttlMs === undefined ? 30_000 : params.ttlMs
      if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
        throw this.context.error('invalid-params', 'driver ttlMs must be an integer from 1 to 300000')
      }
      this.setDriver(binding.pane, params.owner, ttlMs)
    }
    this.announce(binding.pane)
    return this.stateForBinding(binding, false)
  }

  private async enqueueControl(binding: PaneBinding, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const operation = this.createOperation(`control-${randomUUID()}`, binding, 'control', async (operation) => {
      try {
        await this.ensureWritable(binding, operation.controller.signal)
        await run(operation.controller.signal)
        await this.ensureWritable(binding, operation.controller.signal)
      } catch (error) {
        operation.controller.abort()
        throw error
      }
    })
    await this.enqueue(operation)
  }

  private createOperation(
    id: string,
    binding: PaneBinding,
    kind: Operation['kind'],
    run: (operation: Operation) => Promise<unknown>,
    snapshot?: DockRecovery
  ): Operation {
    const deferred = Promise.withResolvers<unknown>()
    const operation: Operation = {
      id,
      binding,
      pane: binding.pane,
      session: binding.session.id,
      kind,
      phase: kind === 'send' ? 'queued' : 'control',
      controller: new AbortController(),
      started: false,
      settled: false,
      restored: false,
      ...(snapshot ? { snapshot } : {}),
      run,
      promise: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject
    }
    return operation
  }

  private enqueue(operation: Operation): Promise<unknown> {
    const queue = this.queueFor(operation.session)
    queue.pending.push(operation)
    if (operation.kind === 'send') {
      this.sendOperations.set(operation.id, operation)
      this.publishQueued(operation)
      queueMicrotask(() => void this.pump(operation.session, queue))
    } else {
      this.announce(operation.pane)
      void this.pump(operation.session, queue)
    }
    return operation.promise
  }

  private publishQueued(operation: Operation): void {
    const record = this.store.get(operation.pane) ?? defaultDockRecord(operation.pane, operation.session, operation.binding.tab)
    const state = this.stateFrom(operation.binding, record, { noTerminal: false, reason: null }, null)
    this.context.emit('changed', { pane: operation.pane, state })
  }

  private queueFor(session: string): SessionQueue {
    let queue = this.queues.get(session)
    if (!queue) {
      queue = { active: null, pending: [], pumping: false }
      this.queues.set(session, queue)
    }
    return queue
  }
  private async reserveSendAdmission(identity: string): Promise<() => void> {
    const previous = this.sendAdmissionTails.get(identity)
    const { promise: current, resolve: releaseCurrent } = Promise.withResolvers<void>()
    this.sendAdmissionTails.set(identity, current)
    if (previous) await previous
    let released = false
    return () => {
      if (released) return
      released = true
      releaseCurrent(undefined)
      if (this.sendAdmissionTails.get(identity) === current) this.sendAdmissionTails.delete(identity)
    }
  }

  private async pump(session: string, queue: SessionQueue): Promise<void> {
    if (queue.pumping || this.stopped) return
    queue.pumping = true
    try {
      while (!this.stopped && queue.pending.length > 0) {
        const operation = queue.pending.shift()!
        if (operation.settled) continue
        if (operation.controller.signal.aborted) {
          await this.cancelQueuedOperation(operation)
          continue
        }
        queue.active = operation
        operation.started = true
        if (operation.kind === 'send') operation.phase = 'preparing'
        this.announce(operation.pane)
        try {
          const result = await operation.run(operation)
          if (operation.kind === 'send') await this.finishSend(operation, result as SendResult)
          operation.resolve(result)
        } catch (error) {
          if (operation.kind === 'send') {
            const refused: SendResult = { id: operation.id, outcome: 'refused', accepted: false, reason: error instanceof Error ? error.message : String(error) }
            try {
              await this.finishSend(operation, refused)
              operation.resolve(refused)
            } catch (finishError) {
              operation.reject(finishError)
            }
          } else {
            operation.reject(error)
          }
        } finally {
          operation.settled = true
          this.sendOperations.delete(operation.id)
          queue.active = null
          this.announce(operation.pane)
        }
      }
    } finally {
      queue.pumping = false
      if (!this.stopped && queue.pending.length > 0) void this.pump(session, queue)
    }
  }

  private async cancelOperation(operation: Operation): Promise<void> {
    if (operation.settled) return
    operation.controller.abort()
    if (operation.started) return
    await this.cancelQueuedOperation(operation)
  }

  private async cancelQueuedOperation(operation: Operation): Promise<void> {
    if (operation.settled) return
    const queue = this.queues.get(operation.session)
    if (queue) queue.pending = queue.pending.filter((item) => item !== operation)
    if (operation.kind === 'send' && this.enabled() && !this.stopped) {
      const cancelled: SendResult = { id: operation.id, outcome: 'cancelled', accepted: false }
      await this.finishSend(operation, cancelled)
    }
    operation.settled = true
    this.sendOperations.delete(operation.id)
    if (operation.kind === 'send') operation.resolve({ id: operation.id, outcome: 'cancelled', accepted: false } satisfies SendResult)
    else operation.reject(new Error('queued terminal operation cancelled'))
    this.announce(operation.pane)
  }

  private async finishSend(operation: Operation, result: SendResult): Promise<void> {
    if (operation.restored || this.stopped || !this.enabled()) return
    let garbage: DockAttachment[] = []
    const successful = result.accepted && (result.outcome === 'observed-cleared' || result.outcome === 'unobservable')
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) return
      const record = this.store.get(operation.pane)
      const snapshot = record?.recovery.find((item) => item.id === operation.id)
      if (!record || !snapshot) return
      const remaining = record.recovery.filter((item) => item.id !== operation.id)
      if (successful) {
        record.recovery = remaining
        if (result.accepted) record.history = boundedHistory([...record.history, snapshot.text])
        if (result.outcome === 'observed-cleared' || result.outcome === 'unobservable') record.notice = null
      } else {
        record.draft = combineText([snapshot.text, record.draft])
        record.draftAttachments = prependUnique(snapshot.attachments, record.draftAttachments)
        record.recovery = remaining
        if (result.accepted) {
          record.history = boundedHistory([...record.history, snapshot.text])
          record.notice = RECOVERY_WARNING
        } else {
          record.notice = optionNotice(result.reason)
        }
      }
      garbage = this.collectUnreferencedMetadata(record)
      record.revision++
      record.updatedAt = Date.now()
      this.store.put(record)
      operation.restored = true
    })
    await this.deleteOwnedUploads(garbage)
  }

  private async ensureWritable(binding: PaneBinding, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('send cancelled')
    const current = await this.resolveBinding({ pane: binding.pane, session: binding.session.id })
    if (
      current.session.id !== binding.session.id || current.session.kind !== 'terminal' ||
      current.session.status === 'exited' || current.session.agent !== binding.session.agent
    ) {
      throw new Error('No terminal session')
    }
    const status = current.status
    const refusal = await this.writeRefusal(current, status)
    if (refusal) throw new Error(refusal)
  }

  private async writeRefusal(binding: PaneBinding, status?: StatusProjection): Promise<string | null> {
    const activeStatus = status ?? binding.status
    const transport = await this.transportFor(binding)
    if (binding.session.kind !== 'terminal' || this.sessionEnded(binding, activeStatus) || transport.noTerminal) return 'No terminal session'
    if (transport.reason) return transport.reason
    if (this.activeDriver(binding.pane)) return 'Mobile device is composing'
    if (!this.enabled()) return 'Terminal dock is disabled'
    if (!this.supported(binding.session)) return 'This agent is not supported by Terminal Dock'
    return null
  }

  private async interrupt(binding: PaneBinding): Promise<void> {
    const status = binding.status
    const refusal = await this.writeRefusal(binding, status)
    if (refusal) return
    const signal = status?.state === 'working' || binding.session.status === 'working' ? String.fromCharCode(3) : String.fromCharCode(27)
    await this.context.pty.writeAccepted(binding.session.id, signal)
  }

  private async readProvider(binding: PaneBinding): Promise<ProviderRead> {
    const value = await this.withDeadline(this.bridge.read(binding.session), PROVIDER_READ_DEADLINE_MS, 'provider status lookup')
    if (!value || !isObject(value) || !isObject(value.options)) throw new Error('provider status is malformed')
    const question = isQuestion(value.question) ? value.question : null
    const options = value.options as DockOptions
    const prompts = Array.isArray(value.prompts) ? value.prompts.filter((prompt): prompt is string => typeof prompt === 'string') : []
    return { question, options, prompts }
  }

  private async refreshProvider(binding: PaneBinding, force = false): Promise<{ question: DockQuestion | null; options: DockOptions }> {
    let cached = this.providers.get(binding.pane)
    if (cached && (cached.session !== binding.session.id || cached.agent !== binding.session.agent)) {
      this.providers.delete(binding.pane)
      this.overlays.delete(binding.pane)
      this.resolvedQuestions.delete(binding.pane)
      cached = undefined
    }
    if (!force && cached && Date.now() - cached.readAt < 500) {
      return { question: cached.question, options: cached.options }
    }
    if (!this.enabled() || !this.supported(binding.session) || !Object.hasOwn(PROVIDER_AGENTS, binding.session.agent) || binding.session.status === 'exited') {
      return { question: null, options: this.emptyOptions() }
    }
    try {
      const value = await this.readProvider(binding)
      const previousQuestion = cached?.question
      if (value.question && this.questionResolved(binding.pane, value.question.id)) value.question = null
      if (value.question && value.question.id !== previousQuestion?.id) {
        this.overlays.set(binding.pane, { id: value.question.id, collapsed: value.question.collapsed, dismissed: value.question.dismissed })
      }
      if (!value.question && previousQuestion) this.overlays.delete(binding.pane)
      const result = { question: value.question, options: value.options }
      this.providers.set(binding.pane, { session: binding.session.id, agent: binding.session.agent, ...result, readAt: Date.now() })
      if (value.prompts.length > 0) await this.seedHistory(binding.pane, binding.session.id, value.prompts)
      return result
    } catch (error) {
      const unavailable = `Provider status unavailable: ${error instanceof Error ? error.message : String(error)}`
      const failed = { question: null, options: optionsWithNotice(this.emptyOptions(), unavailable) }
      this.providers.set(binding.pane, { session: binding.session.id, agent: binding.session.agent, ...failed, readAt: Date.now() })
      return failed
    }
  }

  private async seedHistory(pane: string, session: string, prompts: string[]): Promise<void> {
    if (!this.enabled()) return
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) return
      const record = this.store.get(pane)
      if (!record || record.session !== session || prompts.length <= record.providerPromptCount) return
      const newPrompts = prompts.slice(record.providerPromptCount)
      const history = boundedHistory([...record.history, ...newPrompts])
      record.providerPromptCount = prompts.length
      if (history.join('\0') !== record.history.join('\0') || newPrompts.length > 0) {
        record.history = history
        record.revision++
        record.updatedAt = Date.now()
        this.store.put(record)
      }
    })
  }

  private validateAnswers(question: DockQuestion, answers: string[][]): void {
    if (answers.length !== question.questions.length) throw this.context.error('invalid-params', 'answer count does not match the current question')
    for (let index = 0; index < answers.length; index++) {
      const options = question.questions[index]!.choices
      const selected = answers[index]!
      if (selected.length === 0 || (!question.questions[index]!.multiple && selected.length !== 1)) {
        throw this.context.error('invalid-params', 'answer selection count is invalid')
      }
      if (new Set(selected).size !== selected.length || selected.some((value) => !options.some((choice) => choice.value === value))) {
        throw this.context.error('invalid-params', 'answer values do not match the current request')
      }
    }
  }

  private questionFor(pane: string, question: DockQuestion | null): DockQuestion | null {
    if (!question || this.questionResolved(pane, question.id)) return null
    const overlay = this.overlays.get(pane)
    if (!overlay || overlay.id !== question.id) return question
    return { ...question, collapsed: overlay.collapsed, dismissed: overlay.dismissed }
  }

  private rememberResolvedQuestion(pane: string, id: string): void {
    const resolved = this.resolvedQuestions.get(pane) ?? new Set<string>()
    resolved.add(id)
    while (resolved.size > 64) resolved.delete(resolved.values().next().value as string)
    this.resolvedQuestions.set(pane, resolved)
  }

  private questionResolved(pane: string, id: string): boolean {
    return this.resolvedQuestions.get(pane)?.has(id) === true
  }

  private emptyOptions(): DockOptions {
    return { ...DEFAULT_OPTIONS, choices: { ...DEFAULT_OPTIONS.choices } }
  }


  private setDriver(pane: string, owner: string, ttlMs: number): void {
    this.releaseDriver(pane)
    const timer = setTimeout(() => {
      this.releaseDriver(pane)
      this.announce(pane)
    }, ttlMs)
    this.drivers.set(pane, { owner, expiresAt: Date.now() + ttlMs, timer })
  }

  private releaseDriver(pane: string): void {
    const lease = this.drivers.get(pane)
    if (lease) clearTimeout(lease.timer)
    this.drivers.delete(pane)
  }

  private activeDriver(pane: string): DriverLease | undefined {
    const lease = this.drivers.get(pane)
    if (lease && lease.expiresAt <= Date.now()) {
      this.releaseDriver(pane)
      return undefined
    }
    return lease
  }

  private connectionId(caller: PluginCaller): number | undefined {
    if (!('connection' in caller) || !caller.connection) return undefined
    return caller.connection.id
  }

  private hasMountedReport(pane: string): boolean {
    for (const reports of this.reports.values()) if (reports.get(pane)?.mounted) return true
    return false
  }

  private mountedPanes(): Set<string> {
    const panes = new Set<string>()
    for (const reports of this.reports.values()) {
      for (const report of reports.values()) if (report.mounted) panes.add(report.pane)
    }
    return panes
  }

  private hasActivePassthrough(pane: string): boolean {
    for (const connection of this.activeWindows) {
      if (!this.passthroughOwners.get(connection)?.has(pane)) continue
      const report = this.reports.get(connection)?.get(pane)
      if (report?.mounted && report.focused) return true
    }
    return false
  }

  private clearPanePassthrough(pane: string): void {
    for (const owners of this.passthroughOwners.values()) owners.delete(pane)
  }

  private clearAllPassthrough(): void {
    this.passthroughOwners.clear()
  }


  private async onSessionExit(sessionId: string): Promise<void> {
    this.markConfirmedExit(sessionId)
    const queue = this.queues.get(sessionId)
    if (queue?.active) queue.active.controller.abort()
    if (queue) {
      for (const operation of [...queue.pending].reverse()) {
        operation.controller.abort()
        if (operation.kind === 'send' && this.enabled()) await this.cancelQueuedOperation(operation)
        else {
          queue.pending = queue.pending.filter((item) => item !== operation)
          operation.settled = true
          operation.reject(new Error('terminal session exited'))
        }
      }
    }
    if (!this.enabled()) return
    await this.mutate(() => {
      if (!this.enabled() || this.stopped) return
      for (const record of this.store.all()) {
        if (record.session !== sessionId) continue
        this.providers.delete(record.pane)
        this.overlays.delete(record.pane)
        this.resolvedQuestions.delete(record.pane)
        if (!record.docked && record.agent === null && !record.autoOpenEvaluated) continue
        record.docked = false
        record.agent = null
        record.autoOpenEvaluated = false
        record.revision++
        record.updatedAt = Date.now()
        this.store.put(record)
        this.clearPanePassthrough(record.pane)
        this.announce(record.pane)
      }
    })
  }

  private cancelForFeatureOff(): void {
    for (const queue of this.queues.values()) {
      const panes = new Set(queue.pending.map((operation) => operation.pane))
      if (queue.active) panes.add(queue.active.pane)
      for (const operation of [...queue.pending]) {
        operation.controller.abort()
        queue.pending = queue.pending.filter((item) => item !== operation)
        operation.settled = true
        this.sendOperations.delete(operation.id)
        if (operation.kind === 'send') operation.resolve({ id: operation.id, outcome: 'cancelled', accepted: false } satisfies SendResult)
        else operation.reject(new Error('Terminal dock is disabled'))
      }
      queue.active?.controller.abort()
      for (const pane of panes) this.announce(pane)
  }
  }

  private wasUsedId(id: string): boolean {
    if (this.sendOperations.has(id)) return true
    return this.store.all().some((record) => record.recentSendIds.includes(id))
  }

  private async withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    const timeout = Promise.withResolvers<T>()
    const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)), ms)
    try {
      return await Promise.race([work, timeout.promise])
    } finally {
      clearTimeout(timer)
    }
  }

  private mutate<T>(work: () => T): Promise<T> {
    const current = this.mutationTail.then(work)
    this.mutationTail = current.then(() => undefined, () => undefined)
    return current
  }

  private collectUnreferencedMetadata(record: DockRecord): DockAttachment[] {
    const referenced = new Set([...record.draftAttachments, ...record.recovery.flatMap((snapshot) => snapshot.attachments)])
    const owned = new Set(record.ownedAttachmentIds)
    const garbage = record.attachments.filter((attachment) => !referenced.has(attachment.id) && owned.has(attachment.id))
    record.attachments = record.attachments.filter((attachment) => referenced.has(attachment.id))
    record.ownedAttachmentIds = record.ownedAttachmentIds.filter((id) => referenced.has(id))
    return garbage
  }

  private async deleteOwnedUploads(attachments: DockAttachment[]): Promise<void> {
    if (!this.enabled() || this.stopped) return
    const checked = new Set<string>()
    for (const attachment of attachments) {
      if (checked.has(attachment.id)) continue
      checked.add(attachment.id)
      const referenced = this.store.all().some((record) =>
        record.attachments.some((candidate) => candidate.id === attachment.id) ||
        record.draftAttachments.includes(attachment.id) ||
        record.recovery.some((snapshot) => snapshot.attachments.includes(attachment.id))
      )
      if (referenced) continue
      try {
        const root = realpathSync(this.context.dataDir)
        const path = realpathSync(attachment.path)
        const fromRoot = relative(root, path)
        if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) continue
        if (statSync(path).isFile()) unlinkSync(path)
      } catch {
        // Missing files and paths outside plugin storage are not removed.
      }
    }
  }


  private async announceState(pane: string): Promise<void> {
    if (this.stopped || pane.length === 0) return
    try {
      const binding = await this.resolveBinding({ pane })
      const state = await this.stateForBinding(binding, false)
      this.context.emit('changed', { pane, state })
    } catch {
      // A pane may leave the workspace while a state event is being published.
    }
  }

  private announce(pane: string): void {
    void this.announceState(pane)
  }

  private announceAllMounted(): void {
    for (const pane of this.mountedPanes()) this.announce(pane)
  }
}
