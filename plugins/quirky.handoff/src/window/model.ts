import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { SecretHit, Template, Warning } from '../core/types'
import { TEMPLATE_BODY_MAX, TEMPLATE_LIMIT, TEMPLATE_NAME_MAX } from '../core/template'
import type { ProbeResult } from '../daemon/probe'
import type { Candidate, Controls, Draft, Include, Preview, Relationship, SourceInfo, SourceRef } from '../daemon/types'
import { DEBOUNCE_MS, messageOf, NO_CONTEXT_MESSAGE, PLUGIN_ID, reasonOf, STALE_MESSAGE } from './copy'

const METHOD = (name: string) => `${PLUGIN_ID}/${name}`

export type CommandResult = { ok: true } | { ok: false; reason: string }

const ok = (): CommandResult => ({ ok: true })
const refused = (reason: string): CommandResult => ({ ok: false, reason })

export type ShownWarning = { code: string; message: string }
export type AgentOption = { id: string; label: string }
export type Agents = { state: 'loading' | 'ready' | 'failed'; list: AgentOption[] }

/** What the last `preview` answer said about the brief, apart from its text. */
export type Analysis = {
  notice: string
  characters: number
  tokens: number
  warnings: Warning[]
  secrets: SecretHit[]
  probe: ProbeResult
  repoState: Preview['repoState']
  live: boolean
  contextAvailable: boolean
}

export type Snapshot = {
  shown: boolean
  source: (SourceInfo & { canCreateWorktree: boolean }) | null
  candidates: Candidate[]
  agents: Agents
  templates: Template[]
  mode: 'existing' | 'create'
  worktree: string | null
  createName: string
  createBase: string
  agent: string | null
  relationship: Relationship
  context: 'focused' | 'full'
  include: Include
  templateId: string | null
  note: string
  search: string
  text: string
  detached: boolean
  stale: string[]
  analysis: Analysis | null
  previewing: boolean
  working: boolean
  waiting: boolean
  starting: boolean
  error: string | null
  templateEditor: { name: string } | null
}

export const DEFAULT_INCLUDE: Include = { repoState: true, diffBodies: false, openEditorTabs: true }

const CLOSED: Snapshot = {
  shown: false,
  source: null,
  candidates: [],
  agents: { state: 'loading', list: [] },
  templates: [],
  mode: 'existing',
  worktree: null,
  createName: '',
  createBase: '',
  agent: null,
  relationship: 'continues',
  context: 'focused',
  include: DEFAULT_INCLUDE,
  templateId: null,
  note: '',
  search: '',
  text: '',
  detached: false,
  stale: [],
  analysis: null,
  previewing: false,
  working: false,
  waiting: false,
  starting: false,
  error: null,
  templateEditor: null
}

export const SETTABLE_FIELDS = [
  'worktree',
  'create',
  'createName',
  'createBase',
  'agent',
  'relationship',
  'context',
  'repoState',
  'diffBodies',
  'openEditorTabs',
  'template',
  'templateName',
  'note'
] as const
export type SettableField = (typeof SETTABLE_FIELDS)[number]

const TARGET_FIELDS: readonly SettableField[] = ['worktree', 'create', 'createName', 'createBase']
export const RELATIONSHIPS: readonly string[] = ['continues', 'reviews', 'branches-from']

/** The controls as the daemon takes them; a blank new-worktree name stays in the target so a draft keeps it. */
export function controlsOf(s: Snapshot): Controls {
  const base = s.createBase.trim()
  const target =
    s.mode === 'create'
      ? { create: { name: s.createName, ...(base === '' ? {} : { base }) } }
      : s.worktree === null
        ? undefined
        : { worktree: s.worktree }
  return {
    ...(target ? { target } : {}),
    ...(s.agent ? { agent: s.agent } : {}),
    relationship: s.relationship,
    context: s.context,
    include: s.include,
    templateId: s.templateId,
    note: s.note
  }
}

/** The worktrees that match the search box, by name or path. */
export function visibleCandidates(s: Snapshot): Candidate[] {
  const query = s.search.trim().toLowerCase()
  if (query === '') return s.candidates
  return s.candidates.filter((candidate) => `${candidate.name}\n${candidate.path}`.toLowerCase().includes(query))
}

/** The warnings the strip lists: the daemon's for the brief, then the stale-edit one. */
export function warningsOf(s: Snapshot): ShownWarning[] {
  const warnings: ShownWarning[] = s.analysis?.warnings ?? []
  return s.detached && s.stale.length > 0 ? [...warnings, { code: 'stale', message: STALE_MESSAGE }] : warnings
}

/** Why Start cannot run yet, as `start:<reason>`, and which controls are switched off, as `control:<name>`. */
export function disabledOf(s: Snapshot): string[] {
  const reasons: string[] = []
  const start = (reason: string) => reasons.push(`start:${reason}`)
  if (s.starting) start('starting')
  if (s.agents.state === 'loading') start('agents-loading')
  else if (s.agent === null || !s.agents.list.some((agent) => agent.id === s.agent)) start('no-agent')
  if (s.mode === 'create') {
    if (s.createName.trim() === '') start('create-name')
  } else if (s.worktree === null || !s.candidates.some((candidate) => candidate.id === s.worktree)) start('no-target')
  if (s.analysis !== null && !s.analysis.contextAvailable) start('no-context')
  if (!s.detached && (s.previewing || s.analysis === null)) {
    start('probe-loading')
    if (s.include.repoState) start('repo-state-loading')
  }

  if (s.detached) reasons.push('control:destination', 'control:content', 'control:notes')
  if (s.analysis === null || s.analysis.probe.verdict !== 'usable') reasons.push('control:context-full')
  if (!s.include.repoState) reasons.push('control:diffBodies')
  return reasons
}

export const canStartOf = (s: Snapshot): boolean => !disabledOf(s).some((reason) => reason.startsWith('start:'))

/** The overlay's report: exactly what the dialog shows, or `shown: false` while it is closed. */
export function reportOf(s: Snapshot) {
  return {
    shown: s.shown,
    source: s.source,
    controls: s.shown ? controlsOf(s) : null,
    candidates: s.shown ? visibleCandidates(s) : [],
    agents: { ...s.agents, message: agentsMessage(s.agents) },
    preview: {
      text: s.text,
      detached: s.detached,
      stale: s.stale,
      warnings: s.shown ? warningsOf(s) : [],
      secrets: s.analysis?.secrets ?? [],
      characters: s.analysis?.characters ?? 0,
      tokens: s.analysis?.tokens ?? 0
    },
    busy: { working: s.working, waiting: s.waiting },
    canStart: s.shown && canStartOf(s),
    disabled: s.shown ? disabledOf(s) : [],
    starting: s.starting,
    error: s.error,
    templateEditor: s.templateEditor
  }
}

export function agentsMessage(agents: Agents): string | null {
  if (agents.state === 'loading') return 'Detecting Agents on the target host…'
  if (agents.state === 'failed') return 'Could not detect Agents on the target host.'
  return agents.list.length === 0 ? 'No enabled Agents were detected on the target host.' : null
}

type Prepared = {
  source: SourceInfo
  candidates: Candidate[]
  canCreateWorktree: boolean
  agents: { state: 'ready' | 'failed'; list: AgentOption[] }
  controls: Controls
  draft: Draft | null
  templates: Template[]
}

type TemplateResult = { templates: Template[]; custom: boolean; warnings?: string[] }

/**
 * The state of the Continue in New Session dialog and every action on it. It owns the rules
 * (recomposing 150 ms after the last control change, detaching on edit, stale reasons, the busy
 * strip, start errors, drafts); the component only renders `getSnapshot()` and calls these.
 */
export class HandoffDialog {
  private snapshot: Snapshot = CLOSED
  private listeners = new Set<() => void>()
  private ref: SourceRef | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private sequence = 0
  private opening = 0
  private recapture = false
  private sourceWorking = false

  constructor(private readonly context: UiPluginContext) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): Snapshot => this.snapshot

  stop(): void {
    this.clearTimer()
    this.sequence += 1
    this.opening += 1
    this.listeners.clear()
  }

  private commit(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Opens the dialog on a session; with no session context it toasts and shows nothing. */
  async open(session: string): Promise<CommandResult> {
    if (this.snapshot.starting) return refused('starting')
    const attempt = ++this.opening
    const ref: SourceRef = { session }
    let prepared: Prepared
    try {
      prepared = (await this.context.call(METHOD('prepare'), { source: ref })) as Prepared
    } catch (error) {
      if (attempt !== this.opening) return refused('superseded')
      const reason = reasonOf(error)
      if (reason === 'no-context') {
        this.context.toast(NO_CONTEXT_MESSAGE, '')
        return refused('no-context')
      }
      this.context.toast('Could not open the handoff dialog', messageOf(error))
      return refused(reason ?? 'prepare-failed')
    }
    if (attempt !== this.opening) return refused('superseded')

    this.clearTimer()
    this.sequence += 1
    this.ref = ref
    this.recapture = false
    this.sourceWorking = prepared.source.busy
    const { controls } = prepared
    const target = controls.target
    const restored = prepared.draft?.preview ?? null
    const home = prepared.source.worktreeId
    this.snapshot = {
      ...CLOSED,
      shown: true,
      source: { ...prepared.source, canCreateWorktree: prepared.canCreateWorktree },
      candidates: prepared.candidates,
      agents: { state: prepared.agents.state, list: prepared.agents.list },
      templates: prepared.templates,
      mode: target && 'create' in target ? 'create' : 'existing',
      worktree: target && 'worktree' in target ? target.worktree : prepared.candidates.some((c) => c.id === home) ? home : null,
      createName: target && 'create' in target ? target.create.name : '',
      createBase: target && 'create' in target ? (target.create.base ?? '') : '',
      agent: controls.agent ?? null,
      relationship: controls.relationship,
      context: 'focused',
      include: controls.include,
      templateId: controls.templateId,
      note: controls.note,
      text: restored?.text ?? '',
      detached: restored !== null,
      stale: restored?.stale ?? [],
      working: prepared.source.busy,
      previewing: true
    }
    for (const listener of [...this.listeners]) listener()
    await this.refresh()
    return ok()
  }

  /** The preview call for the current controls; `body` makes it an analysis of the edited text. */
  private async refresh(): Promise<void> {
    this.clearTimer()
    const attempt = ++this.sequence
    const s = this.snapshot
    const ref = this.ref
    if (!s.shown || ref === null) return
    const recapture = this.recapture
    this.recapture = false
    const controls = controlsOf(s)
    if (s.mode === 'create' && s.createName.trim() === '') delete controls.target
    this.commit({ previewing: true })
    try {
      const result = (await this.context.call(METHOD('preview'), {
        source: ref,
        controls,
        ...(recapture ? { recapture: true } : {}),
        ...(s.detached ? { body: s.text } : {})
      })) as Preview
      if (attempt !== this.sequence) return
      this.applyPreview(result, !s.detached)
    } catch (error) {
      if (attempt !== this.sequence) return
      this.commit({ previewing: false, error: messageOf(error) })
    }
  }

  private applyPreview(result: Preview, adoptText: boolean): void {
    const s = this.snapshot
    this.commit({
      previewing: false,
      text: adoptText ? result.brief : s.text,
      context: s.context === 'full' && result.probe.verdict !== 'usable' ? 'focused' : s.context,
      analysis: {
        notice: result.notice,
        characters: result.characters,
        tokens: result.tokens,
        warnings: result.warnings,
        secrets: result.secrets,
        probe: result.probe,
        repoState: result.repoState,
        live: result.live,
        contextAvailable: result.contextAvailable
      }
    })
  }

  private schedule(options: { immediately?: boolean; recapture?: boolean } = {}): Promise<void> {
    this.clearTimer()
    this.sequence += 1
    if (options.recapture) this.recapture = true
    if (options.immediately) return this.refresh()
    this.commit({ previewing: true })
    this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS)
    return Promise.resolve()
  }

  private addStale(reason: string): void {
    const { stale } = this.snapshot
    if (!stale.includes(reason)) this.commit({ stale: [...stale, reason] })
  }

  private changed(field: SettableField): void {
    if (this.snapshot.detached) this.addStale(TARGET_FIELDS.includes(field) ? 'target' : 'controls')
    else void this.schedule()
  }

  /** Changes one control. A detached preview only gains a stale reason; an attached one recomposes. */
  set(field: string, value: unknown): CommandResult {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    if (!(SETTABLE_FIELDS as readonly string[]).includes(field)) return refused('unknown-field')
    const name = field as SettableField
    const patch = this.patchFor(name, value)
    if ('reason' in patch) return refused(patch.reason)
    this.commit({ ...patch.patch, error: null })
    if (name !== 'templateName' && !(name === 'template' && value === 'new')) this.changed(name)
    return ok()
  }

  private patchFor(field: SettableField, value: unknown): { patch: Partial<Snapshot> } | { reason: string } {
    const s = this.snapshot
    const text = typeof value === 'string' ? value : null
    switch (field) {
      case 'worktree':
        if (text === null || !s.candidates.some((candidate) => candidate.id === text)) return { reason: 'unknown-worktree' }
        return { patch: { worktree: text, mode: 'existing' } }
      case 'create':
        if (typeof value !== 'boolean') return { reason: 'invalid-value' }
        if (value && !s.source?.canCreateWorktree) return { reason: 'create-unavailable' }
        return { patch: { mode: value ? 'create' : 'existing' } }
      case 'createName':
        return text === null ? { reason: 'invalid-value' } : { patch: { createName: text } }
      case 'createBase':
        return text === null ? { reason: 'invalid-value' } : { patch: { createBase: text } }
      case 'agent':
        if (text === null || !s.agents.list.some((agent) => agent.id === text)) return { reason: 'unknown-agent' }
        return { patch: { agent: text } }
      case 'relationship':
        if (text === null || !RELATIONSHIPS.includes(text)) return { reason: 'invalid-value' }
        return { patch: { relationship: text as Relationship } }
      case 'context':
        if (value !== 'focused' && value !== 'full') return { reason: 'invalid-value' }
        if (value === 'full' && s.analysis?.probe.verdict !== 'usable') return { reason: 'full-unavailable' }
        return { patch: { context: value } }
      case 'repoState':
        if (typeof value !== 'boolean') return { reason: 'invalid-value' }
        return { patch: { include: { ...s.include, repoState: value, diffBodies: value && s.include.diffBodies } } }
      case 'diffBodies':
        if (typeof value !== 'boolean') return { reason: 'invalid-value' }
        if (value && !s.include.repoState) return { reason: 'repo-state-off' }
        return { patch: { include: { ...s.include, diffBodies: value } } }
      case 'openEditorTabs':
        if (typeof value !== 'boolean') return { reason: 'invalid-value' }
        return { patch: { include: { ...s.include, openEditorTabs: value } } }
      case 'template':
        if (value === 'new') return { patch: { templateEditor: { name: '' } } }
        if (value !== null && (text === null || !s.templates.some((template) => template.id === text))) return { reason: 'unknown-template' }
        return { patch: { templateId: value as string | null, templateEditor: null } }
      case 'templateName':
        if (text === null) return { reason: 'invalid-value' }
        return s.templateEditor === null ? { reason: 'no-template-editor' } : { patch: { templateEditor: { name: text.slice(0, TEMPLATE_NAME_MAX) } } }
      case 'note':
        return text === null ? { reason: 'invalid-value' } : { patch: { note: text } }
    }
  }

  /** Types into the preview: the first edit detaches it, and the cost and markers follow the edited text. */
  edit(text: string): CommandResult {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    if (s.detached && text === s.text) return ok()
    this.commit({ text, detached: true, error: null })
    void this.schedule()
    return ok()
  }

  /** Drops the edits and recomposes from the controls, recapturing if the session moved on while detached. */
  async regenerate(): Promise<CommandResult> {
    if (!this.snapshot.shown) return refused('not-open')
    this.commit({ detached: false, stale: [], error: null })
    await this.schedule({ immediately: true })
    return ok()
  }

  /** Marks that the next recomposition should take a fresh terminal capture, and waits for the source to go idle. */
  waitIdle(): CommandResult {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    if (!s.working) return refused('not-working')
    this.commit({ waiting: true })
    return ok()
  }

  /** Recaptures the source now and dismisses the busy strip. */
  async capture(): Promise<CommandResult> {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    this.commit({ working: false, waiting: false })
    if (s.detached) {
      this.recapture = true
      this.addStale('session')
    } else {
      await this.schedule({ immediately: true, recapture: true })
    }
    return ok()
  }

  search(query: string): CommandResult {
    if (!this.snapshot.shown) return refused('not-open')
    this.commit({ search: query })
    return ok()
  }

  /** Reacts to the source's agent status; a working to idle change recomposes with a fresh capture. */
  onEvent(event: QuirkyEvent): void {
    const s = this.snapshot
    if (event.type === 'quirky.handoff/changed') {
      if ((event.data as { kind?: string } | null)?.kind === 'templates') void this.reloadTemplates()
      return
    }
    if (event.type !== 'quirky.agent-status/changed' || !s.shown || s.source?.session == null) return
    const data = event.data as { sessionId?: string; row?: { state?: string } | null } | null
    if (data?.sessionId !== s.source.session) return
    const working = data.row?.state === 'working'
    if (working === this.sourceWorking) return
    this.sourceWorking = working
    if (working) {
      this.commit({ working: true })
      return
    }
    this.commit({ working: false, waiting: false })
    if (s.detached) {
      this.recapture = true
      this.addStale('session')
    } else {
      void this.schedule({ immediately: true, recapture: true })
    }
  }

  private async reloadTemplates(): Promise<void> {
    if (!this.snapshot.shown) return
    try {
      const { templates } = (await this.context.call(METHOD('templates'))) as TemplateResult
      if (!this.snapshot.shown) return
      const gone = this.snapshot.templateId !== null && !templates.some((template) => template.id === this.snapshot.templateId)
      this.commit({ templates, ...(gone ? { templateId: null } : {}) })
      if (gone) this.changed('template')
    } catch (error) {
      this.context.log(`handoff templates: ${messageOf(error)}`)
    }
  }

  /** Whether "Save template" is enabled for the note and name as typed. */
  canSaveTemplate(name = this.snapshot.templateEditor?.name ?? ''): boolean {
    const s = this.snapshot
    return (
      s.templateEditor !== null &&
      name.trim() !== '' &&
      name.trim().length <= TEMPLATE_NAME_MAX &&
      s.note.trim() !== '' &&
      s.note.length <= TEMPLATE_BODY_MAX &&
      s.templates.length < TEMPLATE_LIMIT
    )
  }

  /** Saves the steering note as a template named `name`; with no template picked before, it becomes the pick and the note clears. */
  async saveTemplate(name?: string): Promise<CommandResult> {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    if (s.templateEditor === null) return refused('no-template-editor')
    const typed = (name ?? s.templateEditor.name).trim()
    if (!this.canSaveTemplate(typed)) return refused('cannot-save')
    let result: TemplateResult
    try {
      result = (await this.context.call(METHOD('templateMutate'), { op: 'add', template: { name: typed, body: s.note } })) as TemplateResult
    } catch (error) {
      this.context.toast('Could not save the template', messageOf(error))
      return refused(reasonOf(error) ?? 'save-failed')
    }
    if (!this.snapshot.shown) return ok()
    const saved = result.templates[result.templates.length - 1]
    const select = this.snapshot.templateId === null && saved !== undefined
    this.commit({
      templates: result.templates,
      templateEditor: null,
      ...(select ? { templateId: saved.id, note: '' } : {})
    })
    if (select) this.changed('template')
    return ok()
  }

  /** Starts the new session. Errors stay in the strip with every field kept; success closes the dialog. */
  async start(): Promise<CommandResult> {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    if (!canStartOf(s)) return refused('cannot-start')
    const ref = this.ref!
    this.clearTimer()
    this.sequence += 1
    this.commit({ starting: true, error: null })
    try {
      await this.context.call(METHOD('start'), {
        source: ref,
        controls: controlsOf(s),
        ...(s.detached ? { body: s.text } : { shown: s.text })
      })
    } catch (error) {
      this.startFailed(error)
      return refused(reasonOf(error) ?? 'start-failed')
    }
    this.close()
    return ok()
  }

  private startFailed(error: unknown): void {
    const data = (error as { data?: { preview?: Preview; worktreeCreated?: { id: string; name: string; path: string } } } | null)?.data
    const patch: Partial<Snapshot> = { starting: false, error: messageOf(error) }
    const created = data?.worktreeCreated
    if (created) {
      const { candidates } = this.snapshot
      patch.mode = 'existing'
      patch.worktree = created.id
      patch.createName = ''
      if (!candidates.some((candidate) => candidate.id === created.id)) {
        patch.candidates = [...candidates, { id: created.id, name: created.name, path: created.path, kind: 'git', branch: null }]
      }
    }
    this.commit(patch)
    if (reasonOf(error) === 'source-changed' && data?.preview) this.applyPreview(data.preview, !this.snapshot.detached)
  }

  /** Closes the dialog, keeping a draft for the source on the daemon. */
  async cancel(): Promise<CommandResult> {
    const s = this.snapshot
    if (!s.shown) return refused('not-open')
    if (s.starting) return refused('starting')
    const draft: Draft = { controls: controlsOf(s), preview: s.detached ? { text: s.text, stale: s.stale } : null }
    try {
      await this.context.call(METHOD('draft'), { source: this.ref, draft })
    } catch (error) {
      this.context.log(`could not keep the handoff draft: ${messageOf(error)}`)
    }
    this.close()
    return ok()
  }

  private close(): void {
    this.clearTimer()
    this.sequence += 1
    this.opening += 1
    this.ref = null
    this.recapture = false
    this.snapshot = CLOSED
    for (const listener of [...this.listeners]) listener()
  }
}
