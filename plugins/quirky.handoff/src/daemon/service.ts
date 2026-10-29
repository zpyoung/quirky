import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { RpcErrorCode, type OwnerHostIdentity, type OwnerSessionWorkspaceRef, type PluginContext, type PluginErrorKind, type PluginStore, type QuirkyEvent, type Session, type Worktree } from '@quirky/protocol'
import { composeBrief, estimateTokens, LOCKED_NOTICE, scanSecrets, type SourceFacts, type Warning } from '../core'
import { TEMPLATE_LIMIT } from '../core/template'
import { DeliveryTracker } from './delivery'
import { PathHistory } from './history'
import { jump } from './jump'
import { LAUNCH_FAILED, Launcher } from './launch'
import { LineageStore, MAX_LINEAGE } from './lineage'
import { OwnerRouter, hostRefOf, sameWorkspaceRef, workspaceRefOf } from './owners'
import { probeTranscript, type ProbeResult } from './probe'
import {
  claimedTranscripts,
  destinationOf,
  listAgents,
  readCapture,
  readEditorTabs,
  readRepoState,
  resolveSource,
  sourceKey,
  type Call,
  type Composition,
  type Destination
} from './source'
import { isRecord } from './guards'
import { DEFAULT_INCLUDE, mutateCatalog, readCatalog, readPrefs, TemplateError } from './store'
import type {
  Controls,
  Draft,
  Include,
  Outcome,
  Preview,
  RepoStateResult,
  Relationship,
  LineageEnd,
  SourceInfo,
  SourceRef,
  Target,
  TemplateOp
} from './types'

export const NO_CONTEXT_MESSAGE = 'No session context is available to continue in a new session.'
const REPO_STATE_FAILED = 'Could not refresh repository state. The handoff can still continue.'
const TRANSCRIPT_UNREACHABLE = 'The transcript is not reachable from the target. A bounded capture will be used when available.'
const TRANSCRIPT_UNVERIFIABLE = 'The transcript could not be verified on the target. A bounded capture will be used when available.'
const FULL_UNVERIFIABLE = 'A full saved transcript could not be verified on this target. Focused context will be used.'
const FULL_UNREACHABLE = 'A full saved transcript is not reachable on this target. Focused context will be used.'
const NO_LIVE_PANE = 'This source has no live pane. Idle waiting and live scrollback recapture are unavailable.'

const RELATIONSHIPS: readonly string[] = ['continues', 'reviews', 'branches-from']

const MAX_DRAFTS = 64
const MAX_CAPTURES = 32

type Params = Record<string, unknown>

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value as string)
}

/**
 * The handoff rules: resolving a source, listing where it can go, probing its transcript,
 * composing the preview, keeping drafts and templates, starting the new session, delivering the
 * brief and recording lineage. Reads other plugins only through `context.call` and never types
 * into the source session.
 */

export class HandoffService {
  private readonly call: Call
  private readonly owners: OwnerRouter
  private readonly history = new PathHistory()
  private readonly drafts = new Map<string, Draft>()
  private readonly captures = new Map<string, string | null>()
  private readonly lineageStore: LineageStore
  private readonly delivery: DeliveryTracker
  private readonly launcher: Launcher
  private readonly awaitingProvider = new Set<string>()
  private stopped = false
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore
  ) {
    this.call = (method, params) => context.call(method, params)
    this.owners = new OwnerRouter(this.call, (kind, message, data) => this.fail(kind, message, data))
    this.lineageStore = new LineageStore(store)
    this.delivery = new DeliveryTracker(context, this.call)
    this.launcher = new Launcher({
      context,
      call: this.call,
      store,
      lineage: this.lineageStore,
      delivery: this.delivery,
      destination: async (ref, controls) => {
        const { destination } = await this.gatherDestination(ref)
        await this.checkTarget(controls.target, destination)
        return destination
      },
      compose: (ref, controls, options) => this.compose(ref, controls, options),
      targetAgents: (target) => this.targetAgents({ target }),
      remoteStart: (target, agent, body, notice, wait) => this.startOnOwner(target, agent, body, notice, wait),
      localIdentity: () => this.localIdentity(),
      sourceIdentity: (ref, info) => this.sourceIdentity(ref, info),
      rememberRemoteChild: (lineageId, session, target) => this.rememberRemoteChild(lineageId, session, target),
      clearDraft: (key) => this.drafts.delete(key),
      track: (child) => this.awaitingProvider.add(child),
      fail: (kind, message, data) => this.fail(kind, message, data)
    })
  }

  /** Starts following only this activation's sessions and provider changes. */
  activate(): () => void {
    this.unsubscribe = this.context.subscribe((event) => this.onEvent(event))
    try {
      for (const child of this.lineageStore.awaitingProvider()) this.awaitingProvider.add(child)
    } catch {
      this.awaitingProvider.clear()
    }
    void this.seedHistory()
    return () => this.stop()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async seedHistory(): Promise<void> {
    try {
      for (const session of (await this.call('quirky.session/list', {})) as Session[]) this.record(session)
    } catch {
      return
    }
  }

  private record(session: Session | undefined): void {
    const path = session?.providerSession?.transcriptPath
    if (session && path) this.history.record(session.id, path)
  }

  onEvent(event: QuirkyEvent): void {
    if (this.stopped) return
    this.delivery.onEvent(event)
    if (event.type !== 'quirky.session/changed') return
    const session = (event.data as { session?: Session } | undefined)?.session
    this.record(session)
    this.enrich(session)
  }

  private enrich(session: Session | undefined): void {
    const providerId = session?.providerSession?.id
    if (!session || !providerId || !this.awaitingProvider.has(session.id)) return
    try {
      const changed = this.lineageStore.fillChildProvider(session.id, providerId)
      this.awaitingProvider.delete(session.id)
      if (changed) this.context.emit('changed', { kind: 'lineage' })
    } catch {
      return
    }
  }

  private fail(kind: PluginErrorKind, message: string, data?: Record<string, unknown>): Error {
    const error = this.context.error(kind, message)
    return data === undefined ? error : Object.assign(error, { data })
  }

  private rememberRemoteChild(lineageId: string | null, session: string, target: OwnerSessionWorkspaceRef): void {
    try {
      const key = `handoff-remote-child:${lineageId ?? randomUUID()}`
      this.store.run(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify({ lineageId, session, target })
      )
      const rows = this.store.all<{ key: string }>("SELECT key FROM kv WHERE key LIKE 'handoff-remote-child:%' ORDER BY rowid DESC")
      for (const stale of rows.slice(MAX_LINEAGE)) this.store.run('DELETE FROM kv WHERE key = ?', stale.key)
    } catch {
      this.context.log('could not retain the exact owner binding for a remote handoff child')
    }
  }

  private remoteChildFor(
    session: string,
    lineageId?: string
  ): { key: string; lineageId: string | null; target: OwnerSessionWorkspaceRef } | null {
    const rows = lineageId === undefined
      ? this.store.all<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'handoff-remote-child:%' ORDER BY rowid DESC")
      : (() => {
          const key = `handoff-remote-child:${lineageId}`
          const row = this.store.get<{ key: string; value: string }>('SELECT key, value FROM kv WHERE key = ?', key)
          return row === null ? [] : [row]
        })()
    const matches: { key: string; lineageId: string | null; target: OwnerSessionWorkspaceRef }[] = []
    for (const row of rows) {
      let value: unknown
      try {
        value = JSON.parse(row.value)
      } catch {
        continue
      }
      const storedLineage = isRecord(value) ? value.lineageId : undefined
      const validLineage = typeof storedLineage === 'string' ? storedLineage : storedLineage === null ? null : undefined
      if (!isRecord(value) || value.session !== session || validLineage === undefined ||
        (lineageId !== undefined && validLineage !== lineageId)) continue
      const target = workspaceRefOf(value.target)
      if (target) matches.push({ key: row.key, lineageId: validLineage, target })
    }
    if (matches.length > 1 && lineageId === undefined) {
      throw this.fail('conflict', 'More than one owner-qualified handoff names this session; specify its lineage id.', { reason: 'ambiguous-lineage' })
    }
    if (matches.length === 1 && lineageId === undefined && this.delivery.hasBrief(session)) {
      throw this.fail('conflict', 'A local and owner-qualified handoff share this session id; specify its lineage id.', { reason: 'ambiguous-lineage' })
    }
    return matches[0] ?? null
  }

  private async isRemoteLineageChild(session: string, lineageId?: string): Promise<boolean> {
    const selected = lineageId === undefined ? null : this.lineageStore.get(lineageId)
    const records = lineageId === undefined ? this.lineageStore.list(session) : selected === null ? [] : [selected]
    const children = records.filter((record) =>
      record.child.session === session && record.child.executionHost !== undefined
    )
    if (children.length === 0) return false
    const local = await this.localIdentity()
    const remote = children.filter((record) =>
      record.child.executionHost!.hostId !== local.hostId || record.child.executionHost!.generation !== local.generation
    )
    if (remote.length > 1 && lineageId === undefined) {
      throw this.fail('conflict', 'More than one remote handoff names this session; specify its lineage id.', { reason: 'ambiguous-lineage' })
    }
    return remote.length > 0
  }

  private parseSource(value: unknown): SourceRef {
    if (!isRecord(value)) throw this.fail('invalid-params', 'source must be an object')
    const { session, archived } = value
    if ((session === undefined) === (archived === undefined)) {
      throw this.fail('invalid-params', 'source needs exactly one of session or archived')
    }
    if (typeof session === 'string' && session !== '') return { session }
    if (!isRecord(archived) || typeof archived.agent !== 'string' || archived.agent.trim() === '') {
      throw this.fail('invalid-params', 'an archived source needs an agent')
    }
    const owner = archived.owner === undefined ? undefined : hostRefOf(archived.owner)
    const vaultId = archived.vaultId
    if ((archived.owner !== undefined && !owner) || (owner === undefined) !== (vaultId === undefined) ||
      (vaultId !== undefined && (typeof vaultId !== 'string' || vaultId.trim() === ''))) {
      throw this.fail('invalid-params', 'an owner-qualified archived source needs its exact owner and opaque Vault id')
    }
    const fields = ['providerSessionId', 'transcriptPath', 'title', 'worktree', 'cwd', 'prompt', 'lastMessage'] as const
    const metadata: Partial<Record<(typeof fields)[number], string>> = {}
    for (const field of fields) {
      const candidate = archived[field]
      if (candidate === undefined) continue
      if (typeof candidate !== 'string') throw this.fail('invalid-params', `archived ${field} must be a string`)
      metadata[field] = candidate
    }
    return { archived: { agent: archived.agent, ...metadata, ...(owner ? { owner, vaultId: vaultId as string } : {}) } }
  }

  private async sourceInfo(ref: SourceRef): Promise<SourceInfo> {
    if (!('archived' in ref) || !ref.archived.owner || !ref.archived.vaultId) {
      return resolveSource(this.call, ref)
    }
    const { owner, vaultId } = ref.archived
    const value = await this.owners.ownerCall(owner, 'quirky.vault/get', { id: vaultId })
    if (value === null) throw this.fail('not-found', 'The archived source is no longer available on its owner.', { reason: 'source-missing' })
    if (!isRecord(value) || typeof value.agent !== 'string' || typeof value.sessionId !== 'string' ||
      typeof value.title !== 'string' || (value.cwd !== null && typeof value.cwd !== 'string') ||
      !Array.isArray(value.previewMessages)) {
      throw this.fail('conflict', 'The archived source owner returned incomplete session metadata.', { reason: 'source-unverifiable' })
    }
    const lastUserPrompt = typeof value.lastUserPrompt === 'string' && value.lastUserPrompt !== '' ? value.lastUserPrompt : null
    let prompt = lastUserPrompt
    let lastMessage: string | null = null
    for (const message of value.previewMessages) {
      if (!isRecord(message)) continue
      if (message.role === 'assistant' && typeof message.text === 'string') lastMessage = message.text
      if (lastUserPrompt === null && message.role === 'user' && typeof message.text === 'string' && message.text !== '') prompt = message.text
    }
    return {
      key: sourceKey(ref),
      session: null,
      agent: value.agent,
      title: value.title || null,
      cwd: null,
      worktreeId: null,
      providerSessionId: value.sessionId,
      transcriptPath: null,
      prompt,
      lastMessage,
      live: false,
      busy: false
    }
  }

  /** Opens the owner's real window dialog for an archived source supplied by a public integration. */
  async openArchived(params: Params): Promise<{ opened: true }> {
    const ref = this.parseSource(params.source)
    if (!('archived' in ref)) throw this.fail('invalid-params', 'openArchived requires an archived source')
    const response = await this.call('ui.command.run', {
      id: 'command:quirky.handoff/open-archived',
      args: { source: ref }
    })
    const result = isRecord(response) ? response.result : undefined
    if (!isRecord(result) || result.ok !== true) {
      const reason = isRecord(result) && typeof result.reason === 'string' ? `: ${result.reason}` : ''
      throw this.fail('conflict', `the handoff dialog did not open${reason}`)
    }
    return { opened: true }
  }

  private parseTarget(value: unknown): Target | undefined {
    if (value === undefined || value === null) return undefined
    if (!isRecord(value)) throw this.fail('invalid-params', 'target must be an object')
    const keys = Object.keys(value)
    if (keys.length === 1 && typeof value.worktree === 'string' && value.worktree.trim() !== '') {
      return { worktree: value.worktree }
    }
    if (keys.length === 1 && 'remote' in value) {
      const remote = workspaceRefOf(value.remote)
      if (remote) return { remote }
      throw this.fail('invalid-params', 'remote target must contain an exact owner workspace reference')
    }
    const create = value.create
    if (keys.length === 1 && isRecord(create) && Object.keys(create).every((key) => key === 'name' || key === 'base') &&
      typeof create.name === 'string' && (create.base === undefined || typeof create.base === 'string')) {
      return { create: { name: create.name, ...(typeof create.base === 'string' ? { base: create.base } : {}) } }
    }
    throw this.fail('invalid-params', 'target needs exactly one local worktree, remote workspace or create target')
  }

  private parseInclude(value: unknown): Include {
    const given = isRecord(value) ? value : {}
    const pick = (key: keyof Include) => (typeof given[key] === 'boolean' ? (given[key] as boolean) : DEFAULT_INCLUDE[key])
    return { repoState: pick('repoState'), diffBodies: pick('diffBodies'), openEditorTabs: pick('openEditorTabs') }
  }

  private parseControls(value: unknown): Controls {
    const given = isRecord(value) ? value : {}
    const target = this.parseTarget(given.target)
    const agent = text(given.agent)
    return {
      ...(target ? { target } : {}),
      ...(agent ? { agent } : {}),
      relationship: this.parseRelationship(given.relationship),
      context: given.context === 'full' ? 'full' : 'focused',
      include: this.parseInclude(given.include),
      templateId: text(given.templateId) ?? null,
      note: text(given.note) ?? ''
    }
  }

  private parseRelationship(value: unknown): Relationship {
    if (value === undefined) return 'continues'
    if (typeof value !== 'string' || !RELATIONSHIPS.includes(value)) {
      throw this.fail('invalid-params', 'relationship must be continues, reviews or branches-from')
    }
    return value as Relationship
  }

  private async localWorktree(value: unknown): Promise<Worktree> {
    if (!text(value)) throw this.fail('invalid-params', 'worktree is required', { reason: 'invalid-target' })
    let worktree: Worktree
    try {
      worktree = (await this.call('quirky.worktree/show', { worktree: `id:${value}` })) as Worktree
    } catch {
      throw this.fail('conflict', 'The selected local worktree is unavailable.', { reason: 'invalid-target' })
    }
    if (worktree.id !== value) throw this.fail('conflict', 'The selected local worktree changed.', { reason: 'invalid-target' })
    return worktree
  }

  private async ownerWorktree(value: unknown, expectedInstanceId: unknown): Promise<Worktree> {
    if (!text(expectedInstanceId)) {
      throw this.fail('invalid-params', 'expectedInstanceId is required', { reason: 'invalid-target' })
    }
    const worktree = await this.localWorktree(value)
    if (worktree.instanceId !== expectedInstanceId) {
      throw this.fail('conflict', 'The selected workspace instance changed. Refresh targets and choose it again.', { reason: 'target-stale' })
    }
    return worktree
  }

  private async read(session: string): Promise<Session | null> {
    try {
      return (await this.call('quirky.session/get', { session })) as Session
    } catch {
      return null
    }
  }

  private agentList(value: unknown): { state: 'ready' | 'failed'; list: { id: string; label: string }[]; defaultAgent: string | null } {
    if (!isRecord(value) || (value.state !== 'ready' && value.state !== 'failed') || !Array.isArray(value.list)) {
      throw this.fail('conflict', 'Agent detection returned an incomplete result.', { reason: 'agents-unavailable' })
    }
    const list: { id: string; label: string }[] = []
    for (const agent of value.list) {
      if (!isRecord(agent)) {
        throw this.fail('conflict', 'Agent detection returned an invalid result.', { reason: 'agents-unavailable' })
      }
      const id = text(agent.id)
      if (!id || typeof agent.label !== 'string') {
        throw this.fail('conflict', 'Agent detection returned an invalid result.', { reason: 'agents-unavailable' })
      }
      list.push({ id, label: agent.label })
    }
    return {
      state: value.state,
      list,
      defaultAgent: typeof value.defaultAgent === 'string' ? value.defaultAgent : null
    }
  }

  /** Detects enabled Agents on the exact selected local worktree or registered remote owner. */
  async targetAgents(params: Params) {
    const target = this.parseTarget(params.target)
    if (!target) throw this.fail('invalid-params', 'target is required', { reason: 'invalid-target' })
    if ('remote' in target) {
      const resolved = await this.owners.resolveWorkspace(target.remote)
      return this.agentList(await this.owners.ownerCall(resolved.ref.owner, 'quirky.handoff/ownerAgents', {
        worktree: resolved.ref.worktreeId,
        expectedInstanceId: resolved.ref.instanceId
      }))
    }
    if ('worktree' in target) await this.localWorktree(target.worktree)
    return listAgents(this.call)
  }

  private async startOnOwner(
    target: OwnerSessionWorkspaceRef,
    agent: string,
    body: string,
    notice: string,
    wait: boolean
  ): Promise<{ child: { session: string; tab: string; worktreeId: string; providerSessionId?: string | null; title?: string | null }; delivery: Outcome | 'pending' }> {
    const resolved = await this.owners.resolveWorkspace(target)
    const value = await this.owners.ownerCall(resolved.ref.owner, 'quirky.handoff/ownerStart', {
      worktree: resolved.ref.worktreeId,
      expectedInstanceId: resolved.ref.instanceId,
      agent,
      body,
      notice,
      wait
    })
    if (!isRecord(value) || !isRecord(value.child) || typeof value.child.session !== 'string' ||
      typeof value.child.tab !== 'string' || value.child.worktreeId !== resolved.ref.worktreeId ||
      !['delivered', 'resent', 'retry-failed', 'unobservable', 'pending'].includes(String(value.delivery)) ||
      (value.child.providerSessionId !== undefined && value.child.providerSessionId !== null && typeof value.child.providerSessionId !== 'string') ||
      (value.child.title !== undefined && value.child.title !== null && typeof value.child.title !== 'string')) {
      throw this.fail('conflict', 'The target owner returned an incomplete handoff launch result.', { reason: 'owner-unavailable' })
    }
    return {
      child: {
        session: value.child.session,
        tab: value.child.tab,
        worktreeId: value.child.worktreeId,
        providerSessionId: value.child.providerSessionId as string | null | undefined,
        title: value.child.title as string | null | undefined
      },
      delivery: value.delivery as Outcome | 'pending'
    }
  }

  /** Target-side agent detection; the exact canonical owner instance is checked before listing. */
  async ownerAgents(params: Params) {
    if (Object.keys(params).some((key) => key !== 'worktree' && key !== 'expectedInstanceId')) {
      throw this.fail('invalid-params', 'ownerAgents accepts only worktree and expectedInstanceId')
    }
    await this.ownerWorktree(params.worktree, params.expectedInstanceId)
    return listAgents(this.call)
  }

  /** Target-side transcript probe; only provider roots on this owner establish reachability. */
  async ownerProbe(params: Params): Promise<ProbeResult> {
    await this.ownerWorktree(params.worktree, params.expectedInstanceId)
    const source = params.source
    if (!isRecord(source)) {
      throw this.fail('invalid-params', 'ownerProbe needs an agent and optional provider session identity')
    }
    const agent = text(source.agent)
    if (Object.keys(source).some((key) =>
      !['agent', 'providerSessionId', 'reportedPath'].includes(key)
    ) || !agent) {
      throw this.fail('invalid-params', 'ownerProbe needs an agent and optional provider session identity')
    }
    const optionalText = (value: unknown, name: string): string | null => {
      if (value === undefined || value === null) return null
      if (typeof value !== 'string') throw this.fail('invalid-params', `${name} must be a string or null`)
      return value
    }
    const env = process.env
    const result = await probeTranscript({
      agent,
      sessionId: null,
      providerSessionId: optionalText(source.providerSessionId, 'providerSessionId'),
      reportedPath: optionalText(source.reportedPath, 'reportedPath'),
      cwd: '',
      history: [],
      claimed: await claimedTranscripts(this.call, null),
      env: {
        HOME: env.HOME || homedir(),
        ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
        ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {})
      }
    })
    return { ...result, path: null }
  }

  /** Revalidates an exact target instance and enabled agent immediately before remote child creation. */
  async ownerStart(params: Params): Promise<{ child: { session: string; tab: string; worktreeId: string; providerSessionId: string | null; title: string | null }; delivery: Outcome | 'pending' }> {
    const worktree = await this.ownerWorktree(params.worktree, params.expectedInstanceId)
    const agent = text(params.agent)
    const body = text(params.body)
    if (!agent || !body || body.trim() === '' || typeof params.notice !== 'string' || params.notice !== LOCKED_NOTICE || typeof params.wait !== 'boolean') {
      throw this.fail('invalid-params', 'ownerStart needs an enabled agent, reviewed body, locked notice and wait flag')
    }
    const detected = await listAgents(this.call)
    if (detected.state !== 'ready' || !detected.list.some((candidate) => candidate.id === agent)) {
      throw this.fail('conflict', 'The selected Agent is no longer available on the target host.', { reason: 'agent-unavailable' })
    }
    const current = await this.ownerWorktree(worktree.id, params.expectedInstanceId)
    const launchedAt = Date.now()
    let opened: { session: string; tab: string }
    try {
      opened = (await this.call('quirky.terminal/newTab', {
        workspace: current.id,
        agent,
        cwd: current.path,
        activate: false
      })) as { session: string; tab: string }
    } catch {
      throw this.fail('conflict', LAUNCH_FAILED, { reason: 'launch-failed' })
    }
    const textToDeliver = `${body}\n\n${LOCKED_NOTICE}`
    this.delivery.retain(opened.session, { agent, text: textToDeliver, lineageId: null })

    const outcome = this.delivery.deliver(opened.session, launchedAt).catch(() => 'unobservable' as Outcome)
    const child = await this.read(opened.session)
    return {
      child: {
        session: opened.session,
        tab: opened.tab,
        worktreeId: current.id,
        providerSessionId: child?.providerSession?.id ?? null,
        title: child?.title ?? null
      },
      delivery: params.wait ? await outcome : 'pending'
    }
  }

  /** Resends only the retained brief for the exact target owner child. */
  async ownerResend(params: Params): Promise<{ delivery: Outcome }> {
    await this.ownerWorktree(params.worktree, params.expectedInstanceId)
    const session = this.requireSession(params.session)
    const child = await this.read(session)
    if (!child || child.worktreeId !== params.worktree) {
      throw this.fail('conflict', 'The target child is no longer on the selected workspace instance.', { reason: 'target-stale' })
    }
    if (!this.delivery.hasBrief(session)) throw this.fail('not-found', 'No brief is kept for this session.', { reason: 'no-brief' })
    return { delivery: await this.delivery.resend(session) }
  }

  async ownerDiscard(params: Params): Promise<{ discarded: boolean }> {
    await this.ownerWorktree(params.worktree, params.expectedInstanceId)
    const session = this.requireSession(params.session)
    const child = await this.read(session)
    if (!child || child.worktreeId !== params.worktree) {
      throw this.fail('conflict', 'The target child is no longer on the selected workspace instance.', { reason: 'target-stale' })
    }
    return { discarded: this.delivery.discard(session) }
  }

  /** Focuses a remote target session only after revalidating its workspace instance. */
  async ownerJump(params: Params): Promise<{ focused: { session: string; pane: string } }> {
    await this.ownerWorktree(params.worktree, params.expectedInstanceId)
    const session = this.requireSession(params.session)
    const target = await this.read(session)
    if (!target || target.worktreeId !== params.worktree || target.status === 'exited') {
      throw this.fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
    }
    try {
      const pane = (await this.call('quirky.terminal/paneOf', { session })) as { pane: string }
      await this.call('quirky.terminal/focusPane', { session })
      return { focused: { session, pane: pane.pane } }
    } catch {
      throw this.fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
    }
  }

  private parseDraft(value: unknown): Draft | null {
    if (value === null || value === undefined) return null
    if (!isRecord(value) || !isRecord(value.controls)) throw this.fail('invalid-params', 'draft needs controls')
    const preview = value.preview
    if (preview !== null && preview !== undefined && (!isRecord(preview) || typeof preview.text !== 'string')) {
      throw this.fail('invalid-params', 'draft preview needs text')
    }
    const stale = isRecord(preview) && Array.isArray(preview.stale) ? preview.stale.filter((item) => typeof item === 'string') : []
    return {
      controls: this.parseControls(value.controls),
      preview: isRecord(preview) ? { text: preview.text as string, stale } : null
    }
  }

  private invalidTarget(message: string): Error {
    return this.fail('invalid-params', message, { reason: 'invalid-target' })
  }

  private async checkTarget(target: Target | undefined, destination: Destination): Promise<void> {
    if (target === undefined) return
    if ('worktree' in target) {
      if (!destination.candidates.some((candidate) => candidate.remote === undefined && candidate.id === target.worktree)) {
        throw this.invalidTarget(`${target.worktree} is not a local worktree this handoff can go to`)
      }
      return
    }
    if ('remote' in target) {
      const candidate = destination.candidates.find((item) => item.remote !== undefined && sameWorkspaceRef(item.remote, target.remote))
      if (!candidate) {
        throw this.fail('conflict', 'The selected remote workspace changed. Refresh targets and choose it again.', { reason: 'target-stale' })
      }
      await this.owners.resolveWorkspace(target.remote)
      return
    }
    if (!destination.canCreateWorktree) throw this.invalidTarget('A new worktree can only be created for a source in a git repository')
    if (target.create.name.trim() === '') throw this.invalidTarget('A new worktree needs a name')
  }

  private async probeOf(info: SourceInfo): Promise<ProbeResult> {
    const env = process.env
    const probeEnv: { HOME: string; CLAUDE_CONFIG_DIR?: string; CODEX_HOME?: string } = {
      HOME: env.HOME || homedir(),
      ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
      ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {})
    }
    const claimed = await claimedTranscripts(this.call, info.session)
    if (info.session !== null) {
      let sessionHome: unknown
      let optionalUnavailable = false
      try {
        sessionHome = await this.call('quirky.accounts/sessionHome', { session: info.session })
      } catch (error) {
        if (isRecord(error) && error.code === RpcErrorCode.MethodNotFound) optionalUnavailable = true
        else throw error
      }
      if (!optionalUnavailable) {
        if (!isRecord(sessionHome)) {
          return {
            verdict: 'unverifiable',
            path: null,
            reason: 'path-outside-known-roots',
            candidate: null
          }
        }
        const provider = sessionHome.provider
        const home = sessionHome.home
        if (provider === null && home === null) {
          // No account provenance was recorded; retain the daemon-root behavior.
        } else if (
          (provider !== 'claude' && provider !== 'codex') ||
          provider !== info.agent ||
          typeof home !== 'string' ||
          !isAbsolute(home)
        ) {
          return {
            verdict: 'unverifiable',
            path: null,
            reason: 'path-outside-known-roots',
            candidate: null
          }
        } else if (provider === 'claude') {
          probeEnv.CLAUDE_CONFIG_DIR = home
        } else {
          probeEnv.CODEX_HOME = home
        }
      }
    }
    return probeTranscript({
      agent: info.agent,
      sessionId: info.session,
      providerSessionId: info.providerSessionId,
      reportedPath: info.transcriptPath,
      cwd: info.cwd ?? '',
      history: info.session === null ? [] : this.history.get(info.session),
      claimed,
      env: probeEnv
    })
  }

  private async captureOf(info: SourceInfo, refresh: boolean): Promise<string | null> {
    if (info.session === null) return null
    if (!refresh && this.captures.has(info.key)) return this.captures.get(info.key) ?? null
    const capture = await readCapture(this.call, info.session)
    remember(this.captures, info.key, capture, MAX_CAPTURES)
    return capture
  }

  private async probeFor(ref: SourceRef, info: SourceInfo, target: Target | undefined): Promise<ProbeResult> {
    if (!target || !('remote' in target)) {
      if ('archived' in ref && ref.archived.owner) {
        return { verdict: 'unverifiable', path: null, reason: 'path-outside-known-roots', candidate: null }
      }
      return this.probeOf(info)
    }
    const resolved = await this.owners.resolveWorkspace(target.remote)
    const value = await this.owners.ownerCall(resolved.ref.owner, 'quirky.handoff/ownerProbe', {
      worktree: resolved.ref.worktreeId,
      expectedInstanceId: resolved.ref.instanceId,
      source: {
        agent: info.agent,
        providerSessionId: info.providerSessionId,
        reportedPath: info.transcriptPath
      }
    })
    if (!isRecord(value) ||
      !['usable', 'unverifiable', 'unreachable', 'none'].includes(String(value.verdict)) ||
      (value.path !== null && typeof value.path !== 'string') ||
      (value.reason !== null && typeof value.reason !== 'string') ||
      (value.candidate !== null && typeof value.candidate !== 'string')) {
      throw this.fail('conflict', 'The target owner returned an invalid transcript probe.', { reason: 'target-unavailable' })
    }
    return value as unknown as ProbeResult
  }

  private publicProbe(probe: ProbeResult, target: Target | undefined): ProbeResult {
    return target && 'remote' in target ? { ...probe, path: null } : probe
  }

  private async localIdentity(): Promise<OwnerHostIdentity> {
    const value = await this.call('quirky.cli/hostIdentity', {})
    if (!isRecord(value)) throw this.fail('conflict', 'This daemon host identity could not be verified.')
    const hostId = text(value.hostId)
    const generation = text(value.generation)
    if (!hostId || !generation) throw this.fail('conflict', 'This daemon host identity could not be verified.')
    return { hostId, generation }
  }

  private sourceIdentity(ref: SourceRef, _info: SourceInfo): Promise<OwnerHostIdentity> {
    return 'archived' in ref && ref.archived.owner
      ? Promise.resolve(ref.archived.owner.identity)
      : this.localIdentity()
  }

  private async remoteWorkspaceForLineage(lineageId: string, end: LineageEnd): Promise<OwnerSessionWorkspaceRef> {
    if (!end.executionHost || !end.worktreeId) {
      throw this.fail('conflict', 'The lineage does not identify a registered remote workspace.', { reason: 'target-unavailable' })
    }
    if (end.session) {
      const prior = this.remoteChildFor(end.session, lineageId)
      if (prior) return (await this.owners.resolveWorkspace(prior.target)).ref
    }
    return this.owners.workspaceFor(end.executionHost, end.worktreeId, end.instanceId ?? null)
  }

  private async remoteCandidates() {
    return this.owners.candidates()
  }

  /** The source and current local/registered mirror candidates, without probing or capturing. */
  private async gatherDestination(ref: SourceRef) {
    const info = await this.sourceInfo(ref)
    const destination = await destinationOf(this.call, info, await this.remoteCandidates())
    return { info, destination }
  }

  /** Resolves current target authority before probing and composing. */
  private async gather(ref: SourceRef, refreshCapture: boolean, target?: Target) {
    const info = await this.sourceInfo(ref)
    const destination = await destinationOf(this.call, info, await this.remoteCandidates())
    if (target !== undefined) await this.checkTarget(target, destination)
    const probe = await this.probeFor(ref, info, target)
    const capture = probe.verdict === 'usable' ? null : await this.captureOf(info, refreshCapture)
    const ownerArchive = 'archived' in ref && ref.archived.owner !== undefined
    const hasContext = info.session === null
      ? ownerArchive || info.transcriptPath !== null || info.prompt !== null || info.lastMessage !== null || probe.verdict === 'usable'
      : info.transcriptPath !== null || probe.verdict === 'usable' || capture !== null
    if (!hasContext) throw this.fail('conflict', NO_CONTEXT_MESSAGE, { reason: 'no-context' })
    return { info, probe, destination, capture }
  }

  /**
   * Everything the dialog needs to open on a source: where it can go, which agents are available,
   * the controls seeded from the source's draft, the remembered choices and the defaults, and the
   * template catalog. Refuses a source with no session context. Takes a fresh terminal capture.
   */
  async prepare(params: Params) {
    const ref = this.parseSource(params.source)
    this.captures.delete(sourceKey(ref))
    const { info, destination } = await this.gather(ref, true)
    const agents = await listAgents(this.call)
    const catalog = readCatalog(this.store)
    const prefs = readPrefs(this.store)
    const draft = this.drafts.get(info.key) ?? null
    const known = (id: string | null | undefined) => (id && catalog.templates.some((template) => template.id === id) ? id : null)

    const listed = (id: string | null | undefined): id is string => !!id && agents.list.some((agent) => agent.id === id)
    const agent = [draft?.controls.agent, prefs?.lastAgent, info.agent, agents.defaultAgent].find(listed) ?? agents.list[0]?.id

    const wanted = draft?.controls.target
    let target: Target | undefined
    if (wanted && 'remote' in wanted) {
      target = wanted
      try {
        await this.checkTarget(wanted, destination)
      } catch {
        // Keep the captured remote identity visible; detection and Start will report its stale state.
      }
    } else if (wanted) {
      try {
        await this.checkTarget(wanted, destination)
        target = wanted
      } catch {
        target = undefined
      }
    }
    if (target === undefined && destination.home) target = { worktree: destination.home.id }
    const controls: Controls = {
      ...(target ? { target } : {}),
      ...(agent ? { agent } : {}),
      relationship: draft?.controls.relationship ?? 'continues',
      context: 'focused',
      include: draft?.controls.include ?? prefs?.includeToggles ?? { ...DEFAULT_INCLUDE },
      templateId: draft ? known(draft.controls.templateId) : known(prefs?.lastTemplateId),
      note: draft?.controls.note ?? ''
    }
    return {
      source: info,
      candidates: destination.candidates,
      canCreateWorktree: destination.canCreateWorktree,
      agents: { state: agents.state, list: agents.list },
      controls,
      draft,
      templates: catalog.templates
    }
  }

  /**
   * Composes the brief for a source and controls, with its warnings, secret hits and cost. With
   * `body` the text is the caller's edit instead: it is analyzed as is while the warnings still
   * follow the controls and the transcript probe. A terminal capture is reused until `recapture`.
   */
  async preview(params: Params): Promise<Preview> {
    const body = typeof params.body === 'string' ? params.body : undefined
    const { preview } = await this.compose(this.parseSource(params.source), this.parseControls(params.controls), {
      recapture: params.recapture === true,
      ...(body === undefined ? {} : { body })
    })
    return preview
  }

  /** The preview and what it was read from; `start` composes through here so it sends what `preview` shows. */
  async compose(ref: SourceRef, controls: Controls, options: { recapture: boolean; body?: string }): Promise<Composition> {
    const { info, probe, destination, capture } = await this.gather(ref, options.recapture, controls.target)
    const home = destination.home
    const gitHome = home !== null && home.kind === 'git' ? home : null
    const readRepo = async (): Promise<{ repoState: Preview['repoState']; repo: RepoStateResult | null }> => {
      if (!controls.include.repoState) return { repoState: 'off', repo: null }
      if (gitHome === null) return { repoState: 'none', repo: null }
      try {
        return { repoState: 'ok', repo: await readRepoState(this.call, gitHome.id, controls.include.diffBodies) }
      } catch {
        return { repoState: 'failed', repo: null }
      }
    }
    const [{ repoState, repo }, editorTabs] = await Promise.all([
      readRepo(),
      controls.include.openEditorTabs && home !== null ? readEditorTabs(this.call, home) : Promise.resolve(null)
    ])

    const usable = probe.verdict === 'usable'
    const remoteTarget = controls.target !== undefined && 'remote' in controls.target
    const facts: SourceFacts = {
      agent: info.agent,
      sessionId: info.session,
      name: info.title,
      cwd: info.cwd,
      prompt: info.prompt,
      lastMessage: info.lastMessage,
      providerSessionId: info.providerSessionId
    }
    const template = controls.templateId
      ? (readCatalog(this.store).templates.find((candidate) => candidate.id === controls.templateId) ?? null)
      : null
    const composed = composeBrief({
      source: facts,
      transcriptPath: usable && !remoteTarget ? probe.path : null,
      targetTranscriptAvailable: usable && remoteTarget,
      capture,
      context: controls.context === 'full' && usable ? 'full' : 'focused',
      repoState: repo,
      editorTabs,
      template,
      note: controls.note
    })

    const warnings: Warning[] = []
    const sourceHost = await this.sourceIdentity(ref, info)
    const targetHost = controls.target && 'remote' in controls.target
      ? controls.target.remote.owner.identity
      : await this.localIdentity()
    if (sourceHost.hostId !== targetHost.hostId || sourceHost.generation !== targetHost.generation) {
      warnings.push({
        code: 'host-change',
        message: 'This handoff will run on a different owner host. Review the destination and any potential secrets before starting.'
      })
    }
    if (probe.verdict === 'unreachable') warnings.push({ code: 'transcript-unreachable', message: TRANSCRIPT_UNREACHABLE })
    if (probe.verdict === 'unverifiable') warnings.push({ code: 'transcript-unverifiable', message: TRANSCRIPT_UNVERIFIABLE })
    if (controls.context === 'full' && !usable) {
      warnings.push({ code: 'full-unavailable', message: probe.verdict === 'unverifiable' ? FULL_UNVERIFIABLE : FULL_UNREACHABLE })
    }
    if (!info.live) warnings.push({ code: 'no-live-pane', message: NO_LIVE_PANE })
    if (repoState === 'failed') warnings.push({ code: 'repo-state-failed', message: REPO_STATE_FAILED })
    const detached = options.body !== undefined
    const brief = options.body ?? composed.brief
    const contextAvailable = detached ? brief.trim() !== '' : !composed.warnings.some((warning) => warning.code === 'no-context')
    warnings.push(...composed.warnings.filter((warning) => !(detached && warning.code === 'no-context')))
    if (detached && !contextAvailable) warnings.push({ code: 'no-context', message: NO_CONTEXT_MESSAGE })
    const secrets = scanSecrets(brief)
    if (secrets.length > 0) {
      warnings.push({
        code: 'secrets',
        message: `${secrets.length} potential secrets found. Review the inline preview markers before starting.`
      })
    }
    const preview: Preview = {
      brief,
      notice: composed.notice,
      characters: brief.length,
      tokens: estimateTokens(brief),
      warnings,
      secrets,
      probe: this.publicProbe(probe, controls.target),
      repoState,
      busy: info.busy,
      live: info.live,
      contextAvailable
    }
    return { preview, info, destination }
  }

  /** Whether the source's transcript can be read on this daemon, and where it is. */
  async probe(params: Params): Promise<ProbeResult> {
    const ref = this.parseSource(params.source)
    const info = await this.sourceInfo(ref)
    return this.probeFor(ref, info, undefined)
  }

  templates() {
    const { templates, custom } = readCatalog(this.store)
    return { templates, custom, limit: TEMPLATE_LIMIT }
  }

  /**
   * Adds, updates, removes or resets the template catalog and returns the result. Refuses with
   * reason `limit` for a full catalog and `invalid` for a template that is empty or unknown.
   */
  templateMutate(params: Params) {
    const change: TemplateOp = { op: params.op as TemplateOp['op'] }
    if (isRecord(params.template)) {
      const { id, name, body } = params.template
      change.template = { name: text(name) ?? '', body: text(body) ?? '', ...(text(id) === undefined ? {} : { id: text(id) }) }
    }
    if (typeof params.id === 'string') change.id = params.id
    let result: ReturnType<typeof mutateCatalog>
    try {
      result = mutateCatalog(this.store, change)
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error
      const kind: PluginErrorKind = error.reason === 'limit' ? 'conflict' : error.missing ? 'not-found' : 'invalid-params'
      throw this.fail(kind, error.message, { reason: error.reason })
    }
    this.context.emit('changed', { kind: 'templates' })
    return result
  }

  /** Keeps (or with null, clears) the dialog state for a source so closing without starting loses nothing. */
  draft(params: Params): { ok: true } {
    const key = sourceKey(this.parseSource(params.source))
    const draft = this.parseDraft(params.draft)
    if (draft === null) this.drafts.delete(key)
    else remember(this.drafts, key, structuredClone(draft), MAX_DRAFTS)
    return { ok: true }
  }

  /**
   * Starts the new session for a handoff and delivers the brief. With `wait` it resolves after
   * the delivery outcome; otherwise `delivery` is `pending` and the outcome arrives as an event.
   * See `Launcher.start` for the order of steps and the errors.
   */
  start(params: Params) {
    const body = text(params.body)
    const shown = text(params.shown)
    return this.launcher.start({
      ref: this.parseSource(params.source),
      controls: this.parseControls(params.controls),
      wait: params.wait === true,
      ...(body === undefined ? {} : { body }),
      ...(shown === undefined ? {} : { shown })
    })
  }

  /** Sends the brief retained for a child again; fails with reason `no-brief` when none is kept. */
  async resend(params: Params) {
    const session = this.requireSession(params.session)
    const lineageId = text(params.lineage)
    const remote = this.remoteChildFor(session, lineageId)
    if (remote) {
      const target = await this.owners.resolveWorkspace(remote.target)
      const result = await this.owners.ownerCall(target.ref.owner, 'quirky.handoff/ownerResend', {
        worktree: target.ref.worktreeId,
        expectedInstanceId: target.ref.instanceId,
        session
      })
      if (!isRecord(result) || !['delivered', 'resent', 'retry-failed', 'unobservable'].includes(String(result.delivery))) {
        throw this.fail('conflict', 'The target owner returned an invalid resend result.', { reason: 'owner-unavailable' })
      }
      return { delivery: result.delivery as Outcome }
    }
    if (await this.isRemoteLineageChild(session, lineageId)) {
      throw this.fail('not-found', 'No owner-qualified brief is kept for this handoff.', { reason: 'no-brief' })
    }
    if (!this.delivery.hasBrief(session)) throw this.fail('not-found', 'No brief is kept for this session.', { reason: 'no-brief' })
    return { delivery: await this.delivery.resend(session) }
  }

  async discard(params: Params): Promise<{ discarded: boolean }> {
    const session = this.requireSession(params.session)
    const lineageId = text(params.lineage)
    const remote = this.remoteChildFor(session, lineageId)
    if (remote) {
      const target = await this.owners.resolveWorkspace(remote.target)
      const result = await this.owners.ownerCall(target.ref.owner, 'quirky.handoff/ownerDiscard', {
        worktree: target.ref.worktreeId,
        expectedInstanceId: target.ref.instanceId,
        session
      })
      const discarded = isRecord(result) && result.discarded === true
      return { discarded }
    }
    if (await this.isRemoteLineageChild(session, lineageId)) {
      throw this.fail('not-found', 'No owner-qualified brief is kept for this handoff.', { reason: 'no-brief' })
    }
    return { discarded: this.delivery.discard(session) }
  }

  /** The handoff records, newest first; with `session` only those naming it on either side. */
  lineage(params: Params): { records: ReturnType<LineageStore['list']> } {
    const session = text(params.session)
    return { records: this.lineageStore.list(session) }
  }

  /** Focuses the other end of a handoff; see `jump` for the failures. */
  jump(params: Params) {
    return jump(
      {
        call: this.call,
        lineage: this.lineageStore,
        remoteWorkspace: (lineageId, end) => this.remoteWorkspaceForLineage(lineageId, end),
        localIdentity: () => this.localIdentity(),
        ownerCall: (owner, method, args) => this.owners.ownerCall(owner, method, args),
        fail: (kind, message, data) => this.fail(kind, message, data)
      },
      this.requireSession(params.session),
      text(params.lineage)
    )
  }

  private requireSession(value: unknown): string {
    if (typeof value !== 'string' || value === '') throw this.fail('invalid-params', 'session is required')
    return value
  }
}
