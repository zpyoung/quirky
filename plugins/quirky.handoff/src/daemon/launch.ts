import { randomUUID } from 'node:crypto'
import type { OwnerHostIdentity, OwnerSessionWorkspaceRef, PluginContext, PluginErrorKind, PluginStore, Session, Worktree } from '@quirky/protocol'
import { NO_CONTEXT_MESSAGE } from '../core/compose'
import type { DeliveryTracker } from './delivery'
import type { LineageStore } from './lineage'
import { listAgents, type Call, type Composition, type Destination } from './source'
import { sameWorkspaceRef } from './owners'
import { readPrefs, writePrefs } from './store'
import type { Controls, LineageRecord, Outcome, Relationship, SourceInfo, SourceRef, Target } from './types'

const SOURCE_CHANGED = 'The source session changed. The preview was refreshed — review it, then start again.'
const AGENT_UNAVAILABLE = 'The selected Agent is no longer available on the target host.'
export const LAUNCH_FAILED = 'Could not start the new Agent session. Your handoff is unchanged.'

const JUMP_COMMAND = 'command:quirky.handoff/jump'

const wordOf = (relationship: Relationship): string => relationship.replace('-', ' ')

export type StartRequest = {
  ref: SourceRef
  controls: Controls
  /** Edited text to send as is; set means the preview was detached. */
  body?: string
  /** The attached preview text the caller showed; it must equal a fresh composition. */
  shown?: string
  wait: boolean
}

export type StartResult = {
  child: { session: string; tab: string; worktreeId: string }
  lineageId: string | null
  worktreeCreated: string | null
  delivery: Outcome | 'pending'
}

type TargetAgents = { state: 'ready' | 'failed'; list: { id: string; label: string }[]; defaultAgent: string | null }
type RemoteStart = { child: { session: string; tab: string; worktreeId: string; providerSessionId?: string | null; title?: string | null }; delivery: Outcome | 'pending' }

type LauncherDeps = {
  context: PluginContext
  call: Call
  store: PluginStore
  lineage: LineageStore
  delivery: DeliveryTracker
  /** Where the source can go, with the selected binding already checked. */
  destination: (ref: SourceRef, controls: Controls) => Promise<Destination>
  compose: (ref: SourceRef, controls: Controls, options: { recapture: boolean; body?: string }) => Promise<Composition>
  targetAgents: (target: Target) => Promise<TargetAgents>
  remoteStart: (target: OwnerSessionWorkspaceRef, agent: string, body: string, notice: string, wait: boolean) => Promise<RemoteStart>
  localIdentity: () => Promise<OwnerHostIdentity>
  sourceIdentity: (ref: SourceRef, info: SourceInfo) => Promise<OwnerHostIdentity>
  rememberRemoteChild: (lineageId: string | null, session: string, target: OwnerSessionWorkspaceRef) => void
  clearDraft: (key: string) => void
  track: (child: string) => void
  fail: (kind: PluginErrorKind, message: string, data?: Record<string, unknown>) => Error
}

type Place = { id: string; path: string | null; instanceId: string | null; remote?: OwnerSessionWorkspaceRef }

type GroupNode = { kind: string; id: string; tabs?: { id: string }[]; first?: GroupNode; second?: GroupNode }

function groupOfTab(node: GroupNode, tab: string): string | null {
  if (node.kind === 'group') return node.tabs?.some((item) => item.id === tab) ? node.id : null
  return (node.first && groupOfTab(node.first, tab)) || (node.second && groupOfTab(node.second, tab)) || null
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Starts the child session of a handoff and everything that follows from it. */
export class Launcher {
  constructor(private readonly deps: LauncherDeps) {}

  /**
   * Starts a handoff in this order: create the worktree when asked; resolve the body (a fresh
   * capture and composition; an attached preview must equal it) and append the locked notice; check the
   * agent; open the child's tab without focusing it; retain the brief; write lineage; badge both
   * ends; clear the draft; remember the choices; deliver. Nothing after the tab opens can fail the
   * start. A failure after a worktree was created names it in `data.worktreeCreated`.
   */
  async start(request: StartRequest): Promise<StartResult> {
    const { deps } = this
    const { ref, controls } = request
    if (request.body !== undefined && request.body.trim() === '') {
      throw deps.fail('conflict', NO_CONTEXT_MESSAGE, { reason: 'no-context' })
    }
    const destination = await deps.destination(ref, controls)
    const created = await this.createWorktree(destination, controls)
    try {
      const composed = await deps.compose(ref, controls, {
        recapture: request.body === undefined,
        ...(request.body === undefined ? {} : { body: request.body })
      })
      return await this.launch(request, composed, created)
    } catch (error) {
      throw created === null ? error : this.withCreated(error, created)
    }
  }

  private withCreated(error: unknown, worktree: Worktree): unknown {
    if (!(error instanceof Error)) return error
    const data = (error as { data?: Record<string, unknown> }).data
    return Object.assign(error, { data: { ...data, worktreeCreated: { id: worktree.id, name: worktree.name, path: worktree.path } } })
  }

  private async createWorktree(destination: Destination, controls: Controls): Promise<Worktree | null> {
    const { target } = controls
    const home = destination.home
    if (target === undefined || !('create' in target)) return null
    const base = target.create.base?.trim() || home?.branch || home?.head
    try {
      const result = (await this.deps.call('quirky.worktree/create', {
        repo: home?.repoId,
        name: target.create.name.trim(),
        ...(base ? { base } : {}),
        activate: false
      })) as { worktree: Worktree }
      return result.worktree
    } catch (error) {
      const message = messageOf(error)
      throw this.deps.fail('conflict', message, { reason: 'worktree-create-failed', message })
    }
  }

  private place(composed: Composition, controls: Controls, created: Worktree | null): Place {
    if (created !== null) return { id: created.id, path: created.path, instanceId: created.instanceId }
    const { target } = controls
    if (target !== undefined && 'remote' in target) {
      const candidate = composed.destination.candidates.find((item) => item.remote !== undefined && sameWorkspaceRef(item.remote, target.remote))
      if (!candidate) {
        throw this.deps.fail('conflict', 'The selected remote workspace changed. Refresh targets and choose it again.', { reason: 'target-stale' })
      }
      return { id: target.remote.worktreeId, path: null, instanceId: target.remote.instanceId, remote: target.remote }
    }
    const home = composed.destination.home
    if (target === undefined && home === null) {
      throw this.deps.fail('invalid-params', 'Choose a worktree for the new session', { reason: 'invalid-target' })
    }
    const id = target !== undefined && 'worktree' in target ? target.worktree : home!.id
    const found = composed.destination.candidates.find((candidate) => candidate.id === id && candidate.remote === undefined)
    if (!found) throw this.deps.fail('invalid-params', `${id} is not a worktree this handoff can go to`, { reason: 'invalid-target' })
    return { id: found.id, path: found.path, instanceId: found.id === home?.id ? home.instanceId : null }
  }

  private async pickAgent(composed: Composition, controls: Controls, place: Place): Promise<string> {
    const agents = place.remote
      ? await this.deps.targetAgents({ remote: place.remote })
      : await listAgents(this.deps.call)
    const listed = (id: string | null | undefined): id is string => !!id && agents.list.some((agent) => agent.id === id)
    const remembered = readPrefs(this.deps.store)?.lastAgent
    const agent = controls.agent ?? [remembered, composed.info.agent, agents.defaultAgent].find(listed) ?? agents.list[0]?.id
    if (agents.state !== 'ready' || !listed(agent)) {
      throw this.deps.fail('conflict', AGENT_UNAVAILABLE, { reason: 'agent-unavailable' })
    }
    return agent
  }

  /** The group the new tab joins: the source's own when it shares the worktree, else the target's active one. */
  private async groupFor(composed: Composition, place: Place): Promise<string | undefined> {
    if (place.remote) return undefined
    const { call } = this.deps
    const { info } = composed
    try {
      if (info.session !== null && info.worktreeId === place.id) {
        const pane = (await call('quirky.terminal/paneOf', { session: info.session })) as { workspace: string; tab: string }
        const { workspace } = (await call('quirky.terminal/workspace', { workspace: pane.workspace })) as { workspace: { root: GroupNode } }
        const group = groupOfTab(workspace.root, pane.tab)
        if (group !== null) return group
      }
    } catch {
      // a source with no pane falls back to the target's active group
    }
    try {
      const { workspace } = (await call('quirky.terminal/workspace', { workspace: place.id })) as { workspace: { activeGroup: string } }
      return workspace.activeGroup
    } catch {
      return undefined
    }
  }

  private async launch(request: StartRequest, composed: Composition, created: Worktree | null): Promise<StartResult> {
    const { deps } = this
    const { controls } = request
    const { preview, info } = composed

    if (request.body === undefined && request.shown !== undefined && request.shown !== preview.brief) {
      throw deps.fail('conflict', SOURCE_CHANGED, { reason: 'source-changed', preview })
    }

    const place = this.place(composed, controls, created)
    const agent = await this.pickAgent(composed, controls, place)
    if (place.remote) {
      const hostFacts = { local: await deps.localIdentity(), source: await deps.sourceIdentity(request.ref, info) }
      const started = await deps.remoteStart(place.remote, agent, request.body ?? preview.brief, preview.notice, request.wait)
      const child = started.child.session
      const lineageId = await this.recordLineage(request.ref, composed, controls, {
        agent,
        place,
        child,
        tab: started.child.tab,
        providerSessionId: started.child.providerSessionId ?? null,
        title: started.child.title ?? null
      }, hostFacts)
      deps.rememberRemoteChild(lineageId, child, place.remote)
      deps.clearDraft(info.key)
      this.rememberPrefs(agent, controls)
      if (started.delivery !== 'pending') deps.delivery.reportExternal(child, lineageId, started.delivery)
      return {
        child: { session: child, tab: started.child.tab, worktreeId: started.child.worktreeId },
        lineageId,
        worktreeCreated: null,
        delivery: started.delivery
      }
    }

    const text = `${request.body ?? preview.brief}\n\n${preview.notice}`
    const hostFacts = { local: await deps.localIdentity(), source: await deps.sourceIdentity(request.ref, info) }
    const group = await this.groupFor(composed, place)
    const launchedAt = Date.now()
    let opened: { session: string; tab: string }
    try {
      opened = (await deps.call('quirky.terminal/newTab', {
        workspace: place.id,
        ...(group === undefined ? {} : { group }),
        agent,
        cwd: place.path!,
        activate: false
      })) as { session: string; tab: string }
    } catch {
      throw deps.fail('conflict', LAUNCH_FAILED, { reason: 'launch-failed' })
    }
    const child = opened.session
    deps.delivery.retain(child, { agent, text, lineageId: null })
    const lineageId = await this.recordLineage(request.ref, composed, controls, {
      agent,
      place,
      child,
      tab: opened.tab
    }, hostFacts)
    if (lineageId !== null) deps.delivery.linkLineage(child, lineageId)
    deps.clearDraft(info.key)
    this.rememberPrefs(agent, controls)
    const outcome = deps.delivery.deliver(child, launchedAt).then(
      (result) => {
        deps.context.log(`handoff to ${child}: ${result}`)
        return result
      },
      () => 'unobservable' as Outcome
    )
    return {
      child: { session: child, tab: opened.tab, worktreeId: place.id },
      lineageId,
      worktreeCreated: created?.id ?? null,
      delivery: request.wait ? await outcome : 'pending'
    }
  }

  private rememberPrefs(agent: string, controls: Controls): void {
    try {
      writePrefs(this.deps.store, { lastAgent: agent, includeToggles: controls.include, lastTemplateId: controls.templateId })
    } catch (error) {
      this.deps.context.log(`could not remember handoff choices: ${messageOf(error)}`)
    }
  }

  /** Writes host-qualified lineage and badges local sessions; the remote target never resolves locally. */
  private async recordLineage(
    ref: SourceRef,
    composed: Composition,
    controls: Controls,
    opened: { agent: string; place: Place; child: string; tab: string; providerSessionId?: string | null; title?: string | null },
    hostFacts?: { local: OwnerHostIdentity; source: OwnerHostIdentity }
  ): Promise<string | null> {
    const { deps } = this
    const { info, preview, destination } = composed
    const childSession = opened.place.remote ? null : await this.read(opened.child)
    const localIdentity = hostFacts?.local ?? await deps.localIdentity()
    const parentHost = hostFacts?.source ?? await deps.sourceIdentity(ref, info)
    const childHost = opened.place.remote?.owner.identity ?? localIdentity
    const childInstanceId = opened.place.instanceId ?? (opened.place.remote ? null : await this.instanceOf(opened.place.id))
    const record: LineageRecord = {
      id: randomUUID(),
      createdAt: Date.now(),
      relationship: controls.relationship,
      parent: {
        session: info.session,
        agent: info.agent,
        providerSessionId: info.providerSessionId,
        transcriptPath: !opened.place.remote && preview.probe.verdict === 'usable' ? preview.probe.path : null,
        worktreeId: info.worktreeId,
        title: info.title,
        executionHost: parentHost,
        instanceId: destination.home?.id === info.worktreeId ? destination.home.instanceId : null
      },
      child: {
        session: opened.child,
        agent: opened.agent,
        providerSessionId: opened.providerSessionId ?? childSession?.providerSession?.id ?? null,
        transcriptPath: null,
        worktreeId: opened.place.id,
        title: opened.title ?? childSession?.title ?? null,
        tab: opened.tab,
        executionHost: childHost,
        instanceId: childInstanceId
      }
    }
    try {
      deps.lineage.add(record)
    } catch (error) {
      deps.context.log(`could not write handoff lineage: ${messageOf(error)}`)
      return null
    }
    deps.context.emit('changed', { kind: 'lineage' })
    if (record.child.providerSessionId === null && !opened.place.remote) deps.track(opened.child)

    const word = wordOf(controls.relationship)
    if (info.session !== null) {
      await this.badge(info.session, record.id, `Handed off · ${word}`, 'Go to the session this handoff started')
    }
    if (!opened.place.remote) {
      await this.badge(opened.child, record.id, `From handoff · ${word}`, 'Go to the session this handoff continued from')
    }
    return record.id
  }

  private async instanceOf(worktree: string): Promise<string | null> {
    try {
      const value = (await this.deps.call('quirky.worktree/show', { worktree: `id:${worktree}` })) as Worktree
      return value.id === worktree ? value.instanceId : null
    } catch {
      return null
    }
  }

  private async read(session: string): Promise<Session | null> {
    try {
      return (await this.deps.call('quirky.session/get', { session })) as Session
    } catch {
      return null
    }
  }

  private async badge(session: string, lineageId: string, label: string, tooltip: string): Promise<void> {
    try {
      await this.deps.call('quirky.session/setBadge', {
        session,
        key: `lineage:${lineageId}`,
        badge: { label, tooltip, command: JUMP_COMMAND, args: { session, lineage: lineageId } }
      })
    } catch (error) {
      this.deps.context.log(`could not badge ${session}: ${messageOf(error)}`)
    }
  }
}
