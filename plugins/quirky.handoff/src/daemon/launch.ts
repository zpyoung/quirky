import { randomUUID } from 'node:crypto'
import type { PluginContext, PluginErrorKind, PluginStore, Session, Worktree } from '@quirky/protocol'
import type { DeliveryTracker } from './delivery'
import type { LineageStore } from './lineage'
import { listAgents, type Call, type Composition } from './source'
import { readPrefs, writePrefs } from './store'
import type { Controls, LineageRecord, Outcome, Relationship, SourceRef } from './types'

const SOURCE_CHANGED = 'The source session changed. The preview was refreshed — review it, then start again.'
const AGENT_UNAVAILABLE = 'The selected Agent is no longer available on the target host.'
const LAUNCH_FAILED = 'Could not start the new Agent session. Your handoff is unchanged.'

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

type LauncherDeps = {
  context: PluginContext
  call: Call
  store: PluginStore
  lineage: LineageStore
  delivery: DeliveryTracker
  compose: (ref: SourceRef, controls: Controls, options: { recapture: boolean; body?: string }) => Promise<Composition>
  clearDraft: (key: string) => void
  /** Notes a child whose provider session id lineage should fill in once it is reported. */
  track: (child: string) => void
  fail: (kind: PluginErrorKind, message: string, data?: Record<string, unknown>) => Error
}

type Place = { id: string; path: string }

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
   * Starts a handoff in this order: compose; create the worktree when asked; resolve the body
   * (an attached preview must equal a fresh composition) and append the locked notice; check the
   * agent; open the child's tab without focusing it; retain the brief; write lineage; badge both
   * ends; clear the draft; remember the choices; deliver. Nothing after the tab opens can fail the
   * start. A failure after a worktree was created names it in `data.worktreeCreated`.
   */
  async start(request: StartRequest): Promise<StartResult> {
    const { deps } = this
    const { ref, controls } = request
    const composed = await deps.compose(ref, controls, {
      recapture: request.body === undefined,
      ...(request.body === undefined ? {} : { body: request.body })
    })
    const created = await this.createWorktree(composed, controls)
    try {
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

  private async createWorktree(composed: Composition, controls: Controls): Promise<Worktree | null> {
    const { target } = controls
    const home = composed.destination.home
    if (target === undefined) {
      if (home === null) throw this.deps.fail('invalid-params', 'Choose a worktree for the new session', { reason: 'invalid-target' })
      return null
    }
    if (!('create' in target)) return null
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
    if (created !== null) return { id: created.id, path: created.path }
    const { target } = controls
    const id = target !== undefined && 'worktree' in target ? target.worktree : composed.destination.home!.id
    const found = composed.destination.candidates.find((candidate) => candidate.id === id)
    if (!found) throw this.deps.fail('invalid-params', `${id} is not a worktree this handoff can go to`, { reason: 'invalid-target' })
    return { id: found.id, path: found.path }
  }

  private async pickAgent(composed: Composition, controls: Controls): Promise<string> {
    const agents = await listAgents(this.deps.call)
    const listed = (id: string | null | undefined): id is string => !!id && agents.list.some((agent) => agent.id === id)
    const remembered = readPrefs(this.deps.store)?.lastAgent
    const agent = controls.agent ?? [remembered, composed.info.agent, agents.defaultAgent].find(listed)
    if (!listed(agent)) throw this.deps.fail('conflict', AGENT_UNAVAILABLE, { reason: 'agent-unavailable' })
    return agent
  }

  /** The group the new tab joins: the source's own when it shares the worktree, else the target's active one. */
  private async groupFor(composed: Composition, place: Place): Promise<string | undefined> {
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
    const text = `${request.body ?? preview.brief}\n\n${preview.notice}`

    const place = this.place(composed, controls, created)
    const agent = await this.pickAgent(composed, controls)
    const group = await this.groupFor(composed, place)

    const launchedAt = Date.now()
    let opened: { session: string; tab: string }
    try {
      opened = (await deps.call('quirky.terminal/newTab', {
        workspace: place.id,
        ...(group === undefined ? {} : { group }),
        agent,
        cwd: place.path,
        activate: false
      })) as { session: string; tab: string }
    } catch {
      throw deps.fail('conflict', LAUNCH_FAILED, { reason: 'launch-failed' })
    }
    const child = opened.session

    deps.delivery.retain(child, { agent, text, lineageId: null })
    const lineageId = await this.recordLineage(composed, controls, { agent, place, child, tab: opened.tab })
    if (lineageId !== null) deps.delivery.linkLineage(child, lineageId)
    deps.clearDraft(info.key)
    try {
      writePrefs(deps.store, { lastAgent: agent, includeToggles: controls.include, lastTemplateId: controls.templateId })
    } catch (error) {
      deps.context.log(`could not remember handoff choices: ${messageOf(error)}`)
    }

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

  /** Writes the lineage record and badges both ends; null when the record could not be written. */
  private async recordLineage(
    composed: Composition,
    controls: Controls,
    opened: { agent: string; place: Place; child: string; tab: string }
  ): Promise<string | null> {
    const { deps } = this
    const { info, preview } = composed
    const childSession = await this.read(opened.child)
    const record: LineageRecord = {
      id: randomUUID(),
      createdAt: Date.now(),
      relationship: controls.relationship,
      parent: {
        session: info.session,
        agent: info.agent,
        providerSessionId: info.providerSessionId,
        transcriptPath: preview.probe.verdict === 'usable' ? preview.probe.path : null,
        worktreeId: info.worktreeId,
        title: info.title
      },
      child: {
        session: opened.child,
        agent: opened.agent,
        providerSessionId: childSession?.providerSession?.id ?? null,
        transcriptPath: null,
        worktreeId: opened.place.id,
        title: childSession?.title ?? null,
        tab: opened.tab
      }
    }
    try {
      deps.lineage.add(record)
    } catch (error) {
      deps.context.log(`could not write handoff lineage: ${messageOf(error)}`)
      return null
    }
    deps.context.emit('changed', { kind: 'lineage' })
    if (record.child.providerSessionId === null) deps.track(opened.child)

    const word = wordOf(controls.relationship)
    if (info.session !== null) {
      await this.badge(info.session, record.id, `Handed off · ${word}`, 'Go to the session this handoff started')
    }
    await this.badge(opened.child, record.id, `From handoff · ${word}`, 'Go to the session this handoff continued from')
    return record.id
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
