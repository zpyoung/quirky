import { homedir } from 'node:os'
import type { PluginContext, PluginErrorKind, PluginStore, QuirkyEvent, Session } from '@quirky/protocol'
import { composeBrief, estimateTokens, scanSecrets, type SourceFacts, type Warning } from '../core'
import { TEMPLATE_LIMIT } from '../core/template'
import { DeliveryTracker } from './delivery'
import { PathHistory } from './history'
import { jump } from './jump'
import { Launcher } from './launch'
import { LineageStore } from './lineage'
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
import { DEFAULT_INCLUDE, mutateCatalog, readCatalog, readPrefs, TemplateError } from './store'
import type {
  ArchivedSource,
  Controls,
  Draft,
  Include,
  Preview,
  RepoStateResult,
  Relationship,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  private readonly history = new PathHistory()
  private readonly drafts = new Map<string, Draft>()
  private readonly captures = new Map<string, string | null>()
  private readonly lineageStore: LineageStore
  private readonly delivery: DeliveryTracker
  private readonly launcher: Launcher
  private readonly awaitingProvider = new Set<string>()
  private stopped = false

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore
  ) {
    this.call = (method, params) => context.call(method, params)
    this.lineageStore = new LineageStore(store)
    this.delivery = new DeliveryTracker(context, this.call)
    this.launcher = new Launcher({
      context,
      call: this.call,
      store,
      lineage: this.lineageStore,
      delivery: this.delivery,
      compose: (ref, controls, options) => this.compose(ref, controls, options),
      clearDraft: (key) => this.drafts.delete(key),
      track: (child) => this.awaitingProvider.add(child),
      fail: (kind, message, data) => this.fail(kind, message, data)
    })
  }

  /** Starts following sessions: transcript paths for the probe, closes and status for delivery, provider ids for lineage. */
  activate(): void {
    this.context.subscribe((event) => this.onEvent(event))
    try {
      for (const child of this.lineageStore.awaitingProvider()) this.awaitingProvider.add(child)
    } catch {
      this.awaitingProvider.clear()
    }
    void this.seedHistory()
  }

  stop(): void {
    this.stopped = true
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

  private parseSource(value: unknown): SourceRef {
    if (!isRecord(value)) throw this.fail('invalid-params', 'source must be an object')
    const { session, archived } = value
    if ((session === undefined) === (archived === undefined)) {
      throw this.fail('invalid-params', 'source needs exactly one of session or archived')
    }
    if (typeof session === 'string') return { session }
    if (!isRecord(archived) || typeof archived.agent !== 'string') {
      throw this.fail('invalid-params', 'an archived source needs an agent')
    }
    return { archived: archived as ArchivedSource }
  }

  private parseTarget(value: unknown): Target | undefined {
    if (value === undefined || value === null) return undefined
    if (!isRecord(value)) throw this.fail('invalid-params', 'target must be an object')
    if (typeof value.worktree === 'string') return { worktree: value.worktree }
    const create = value.create
    if (isRecord(create) && typeof create.name === 'string') {
      return { create: { name: create.name, ...(typeof create.base === 'string' ? { base: create.base } : {}) } }
    }
    throw this.fail('invalid-params', 'target needs a worktree or a create name')
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

  private checkTarget(target: Target | undefined, destination: Destination): void {
    if (target === undefined) return
    if ('worktree' in target) {
      if (!destination.candidates.some((candidate) => candidate.id === target.worktree)) {
        throw this.invalidTarget(`${target.worktree} is not a worktree this handoff can go to`)
      }
      return
    }
    if (!destination.canCreateWorktree) throw this.invalidTarget('A new worktree can only be created for a source in a git repository')
    if (target.create.name.trim() === '') throw this.invalidTarget('A new worktree needs a name')
  }

  private probeOf(info: SourceInfo): Promise<ProbeResult> {
    const env = process.env
    return claimedTranscripts(this.call, info.session).then((claimed) =>
      probeTranscript({
        agent: info.agent,
        sessionId: info.session,
        providerSessionId: info.providerSessionId,
        reportedPath: info.transcriptPath,
        cwd: info.cwd ?? '',
        history: info.session === null ? [] : this.history.get(info.session),
        claimed,
        env: {
          HOME: env.HOME || homedir(),
          ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
          ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {})
        }
      })
    )
  }

  private async captureOf(info: SourceInfo, refresh: boolean): Promise<string | null> {
    if (info.session === null) return null
    if (!refresh && this.captures.has(info.key)) return this.captures.get(info.key) ?? null
    const capture = await readCapture(this.call, info.session)
    remember(this.captures, info.key, capture, MAX_CAPTURES)
    return capture
  }

  /** Reads the source, probes its transcript, takes a capture when the transcript is not usable, and refuses a source with no context. */
  private async gather(ref: SourceRef, refreshCapture: boolean) {
    const info = await resolveSource(this.call, ref)
    const [probe, destination] = await Promise.all([this.probeOf(info), destinationOf(this.call, info)])
    const capture = probe.verdict === 'usable' ? null : await this.captureOf(info, refreshCapture)
    const hasContext =
      info.session === null
        ? info.transcriptPath !== null || info.prompt !== null || info.lastMessage !== null || probe.verdict === 'usable'
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
    if (wanted) {
      try {
        this.checkTarget(wanted, destination)
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
    const { info, probe, destination, capture } = await this.gather(ref, options.recapture)
    this.checkTarget(controls.target, destination)

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
    const facts: SourceFacts = {
      agent: info.agent,
      sessionId: info.session,
      name: info.title,
      cwd: info.cwd,
      prompt: info.prompt,
      lastMessage: info.lastMessage
    }
    const template = controls.templateId
      ? (readCatalog(this.store).templates.find((candidate) => candidate.id === controls.templateId) ?? null)
      : null
    const composed = composeBrief({
      source: facts,
      transcriptPath: usable ? probe.path : null,
      capture,
      context: controls.context === 'full' && usable ? 'full' : 'focused',
      repoState: repo,
      editorTabs,
      template,
      note: controls.note
    })

    const warnings: Warning[] = []
    if (probe.verdict === 'unreachable') warnings.push({ code: 'transcript-unreachable', message: TRANSCRIPT_UNREACHABLE })
    if (probe.verdict === 'unverifiable') warnings.push({ code: 'transcript-unverifiable', message: TRANSCRIPT_UNVERIFIABLE })
    if (controls.context === 'full' && !usable) {
      warnings.push({ code: 'full-unavailable', message: probe.verdict === 'unverifiable' ? FULL_UNVERIFIABLE : FULL_UNREACHABLE })
    }
    if (!info.live) warnings.push({ code: 'no-live-pane', message: NO_LIVE_PANE })
    if (repoState === 'failed') warnings.push({ code: 'repo-state-failed', message: REPO_STATE_FAILED })
    warnings.push(...composed.warnings)

    const brief = options.body ?? composed.brief
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
      probe,
      repoState,
      busy: info.busy,
      live: info.live,
      contextAvailable: !composed.warnings.some((warning) => warning.code === 'no-context')
    }
    return { preview, info, destination }
  }

  /** Whether the source's transcript can be read here, and where it is. */
  async probe(params: Params): Promise<ProbeResult> {
    const info = await resolveSource(this.call, this.parseSource(params.source))
    return this.probeOf(info)
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
    if (!this.delivery.hasBrief(session)) throw this.fail('not-found', 'No brief is kept for this session.', { reason: 'no-brief' })
    return { delivery: await this.delivery.resend(session) }
  }

  /** Drops the brief retained for a child. */
  discard(params: Params): { discarded: boolean } {
    return { discarded: this.delivery.discard(this.requireSession(params.session)) }
  }

  /** The handoff records, newest first; with `session` only those naming it on either side. */
  lineage(params: Params): { records: ReturnType<LineageStore['list']> } {
    const session = text(params.session)
    return { records: this.lineageStore.list(session) }
  }

  /** Focuses the other end of a handoff; see `jump` for the failures. */
  jump(params: Params) {
    return jump(
      { call: this.call, lineage: this.lineageStore, fail: (kind, message, data) => this.fail(kind, message, data) },
      this.requireSession(params.session),
      text(params.lineage)
    )
  }

  private requireSession(value: unknown): string {
    if (typeof value !== 'string' || value === '') throw this.fail('invalid-params', 'session is required')
    return value
  }
}
