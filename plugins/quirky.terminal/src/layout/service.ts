import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import type { MethodHandler, PluginCaller, PluginContext, PtyFact, Session } from '@quirky/protocol'
import { applyFloatingUpdate } from '../floating'
import type { StoredFloating } from '../floating'
import type { InputTracker } from '../input-tracker'
import { checkExternalTarget, openExternal } from '../open-external'
import { defaultPs, runningChildOf } from '../processes'
import * as ops from './ops'
import type { OpResult } from './ops'
import { reconcileWorkspace } from './reconcile'
import { CounterIds } from './store'
import type { LayoutStore, UnreadableRow } from './store'
import { displayTitle, nextTerminalTitle } from './titles'
import { findGroup, findPane, paneLeaves } from './tree'
import type { GroupSide, TreeError } from './tree'
import { FLOATING_WORKSPACE, TITLE_MAX } from './types'
import type { ClosedTab, Edge, FloatingState, PaneLeaf, SplitDirection, Tab, Workspace } from './types'

type Params = Record<string, unknown>

const MAX_PATHS = 50
const CWD_REFUSED = /cwd must be an existing directory/
const ID_IN_TEXT = /"(?:tab|grp|pane|split)-(\d+)"/g

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const isNotFound = (error: unknown) => (error as { code?: number } | null)?.code === RpcErrorCode.NotFound
const isTabbed = (session: Session) => session.kind === 'terminal' || session.kind === 'structured'

/** What `createTab` takes beyond the workspace: where the tab goes and what its session runs. */
export type NewTabSpec = {
  group?: string
  cwd?: string
  agent?: string
  prompt?: string
  extraArgs?: string
  title?: string
  quickCommand?: string
  revision?: number
}

/** A start directory for a new session; a `soft` one is dropped when the session plugin refuses it. */
type StartCwd = { path: string; soft: boolean }

/**
 * The daemon-side owner of every workspace layout: one serial queue runs each mutation and each
 * reconciliation pass, each mutation is one store transaction that bumps the revision by one and
 * announces it, and sessions are created and bound inside the same queue slot so none is adopted twice.
 */
export class LayoutService {
  private readonly workspaces = new Map<string, Workspace>()
  private readonly unreadable = new Map<string, UnreadableRow>()
  private readonly titles = new Map<string, string>()
  private readonly cwds = new Map<string, string>()
  private factClock = 0
  private readonly titleAt = new Map<string, number>()
  private readonly cwdAt = new Map<string, number>()
  private counter: number
  private floatingStored: StoredFloating
  private tail: Promise<unknown> = Promise.resolve()
  private reconcileWaiting = false
  private closed = false
  private focusedWorkspace: string | null = null
  private stopFocusSettings: (() => void) | null = null

  constructor(
    private readonly context: PluginContext,
    private readonly store: LayoutStore,
    private readonly inputs: InputTracker
  ) {
    const loaded = store.loadWorkspaces()
    let counter = store.counter()
    for (const workspace of loaded.workspaces) {
      this.workspaces.set(workspace.id, workspace)
      for (const match of JSON.stringify(workspace).matchAll(ID_IN_TEXT)) counter = Math.max(counter, Number(match[1]))
    }
    for (const row of loaded.unreadable) {
      this.unreadable.set(row.id, row)
      context.log(`stored layout of ${row.id} is unreadable (${row.reason}); it will be rebuilt from its sessions`)
    }
    this.counter = counter
    this.floatingStored = store.floating()
    for (const workspace of this.workspaces.values()) {
      for (const leaf of ops.workspaceTabs(workspace).flatMap((tab) => paneLeaves(tab.root))) if (leaf.typed) inputs.mark(leaf.session)
    }
    inputs.onFirstMark((session) => this.enqueueBackground(async () => this.persistTyped(session), 'input record'))
  }

  /** The RPC methods of the plugin's layout half, by method name. */
  readonly methods: Record<string, MethodHandler> = {
    workspace: (params, caller) => this.queued(() => this.workspace(params, caller)),
    groupInfo: (params) => this.queued(() => this.groupInfo(params)),
    adoptSession: (params) => this.queued(() => this.adoptSession(params)),
    newTab: (params, caller) => this.queued(() => this.newTab(params, caller)),
    openSession: (params, caller) => this.queued(() => this.openSession(params, caller)),
    closeTab: (params) => this.queued(() => this.closeTab(params)),
    closeTabs: (params) => this.queued(() => this.closeTabs(params)),
    describeClose: (params) => this.queued(() => this.describeClose(params)),
    renameTab: (params) => this.queued(() => this.editTab(params, (ws, id) => ops.renameTab(ws, id, params.title as string))),
    setTabColor: (params) => this.queued(() => this.editTab(params, (ws, id) => ops.setTabColor(ws, id, params.color as string))),
    pinTab: (params) => this.queued(() => this.editTab(params, (ws, id) => ops.pinTab(ws, id, params.pinned as boolean))),
    moveTab: (params) => this.queued(() => this.moveTab(params)),
    activateTab: (params, caller) => this.queued(() => this.activateTab(params, caller)),
    reopenTab: (params, caller) => this.queued(() => this.reopenTab(params, caller)),
    splitPane: (params) => this.queued(() => this.splitPane(params)),
    closePane: (params) => this.queued(() => this.closePane(params)),
    restartPane: (params) => this.queued(() => this.restartPane(params)),
    focusPane: (params, caller) => this.queued(() => this.focusPane(params, caller)),
    focusContext: (params) => this.queued(() => this.readOrSetFocusContext(params)),
    setPaneTitle: (params) => this.queued(() => this.editPane(params, (ws, pane) => ops.setPaneTitle(ws, pane, params.title as string))),
    expandPane: (params) => this.queued(() => this.editPane(params, (ws, pane) => ops.expandPaneOp(ws, pane, params.expanded as boolean))),
    equalize: (params) => this.queued(() => this.editTab(params, (ws, id) => ops.equalizeTab(ws, id))),
    resizeSplit: (params) => this.queued(() => this.resizeSplit(params)),
    movePane: (params) => this.queued(() => this.movePane(params)),
    closeGroup: (params) => this.queued(() => this.closeGroup(params)),
    clearPane: (params) => this.queued(() => this.ptyAction(params, (session) => this.context.pty.clear(session))),
    resetPane: (params) => this.queued(() => this.ptyAction(params, (session) => this.context.pty.resetModes(session))),
    paneOf: (params) => this.queued(() => this.paneOf(params)),
    floating: () => this.floating(),
    setFloating: (params) => this.setFloating(params),
    openExternal: (params) => this.openExternal(params),
    pathsExist: (params) => this.pathsExist(params)
  }

  /** Starts the first reconciliation pass; calls that arrive meanwhile wait behind it. */
  start(): void {
    this.stopFocusSettings ??= this.context.subscribe((event) => {
      if (event.type === 'setting.changed' && event.id === 'setting:quirky.terminal/floating-enabled' && event.value !== true) {
        this.clearHiddenFloatingFocus()
      }
    })
    this.enqueueBackground(async () => {
      await this.seedFacts()
      await this.reconcile()
    }, 'startup reconciliation')
  }

  /** Reconciles after a session was created, changed or closed; passes already waiting absorb the request. */
  requestReconcile(): void {
    if (this.closed || this.reconcileWaiting) return
    this.reconcileWaiting = true
    this.enqueueBackground(async () => {
      this.reconcileWaiting = false
      await this.reconcile()
    }, 'reconciliation')
  }

  /** Reconciles again once the PTY host connection is back, since sessions may have ended meanwhile. */
  onReconnect = (): void => {
    this.enqueueBackground(async () => {
      await this.seedFacts()
      await this.reconcile()
    }, 'reconnect reconciliation')
  }

  /** Keeps the latest cwd and title per session; a title of the active pane also becomes its tab's live title. */
  onFact = (sessionId: string, fact: PtyFact): void => {
    if (fact.kind === 'cwd') {
      this.cwds.set(sessionId, fact.cwd)
      this.cwdAt.set(sessionId, ++this.factClock)
    }
    if (fact.kind !== 'title') return
    this.titles.set(sessionId, fact.title)
    this.titleAt.set(sessionId, ++this.factClock)
    this.enqueueBackground(async () => this.applyLiveTitle(sessionId, fact.title), 'title update')
  }

  /** Stops accepting work; a pass already running finishes. */
  shutdown(): void {
    this.closed = true
    this.stopFocusSettings?.()
    this.stopFocusSettings = null
  }

  /** The workspace a selector names; none means the caller's, and a floating caller means `floating`. */
  async resolveWorkspace(selector: unknown, caller: PluginCaller): Promise<string> {
    const given = typeof selector === 'string' && selector !== '' ? selector : undefined
    const identity = caller.role === 'plugin' ? {} : { cwd: caller.cwd, worktreeId: caller.worktreeId }
    const wantsCurrent = given === undefined || given === 'current'
    if (given === FLOATING_WORKSPACE || (wantsCurrent && identity.worktreeId === FLOATING_WORKSPACE)) return FLOATING_WORKSPACE
    if (given === undefined && identity.worktreeId) return identity.worktreeId
    const bare = given?.replace(/^id:/, '')
    if (bare !== undefined && this.workspaces.has(bare)) return bare
    const worktree = (await this.context.call('quirky.worktree/resolve', {
      selector: given ?? 'current',
      ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
      ...(identity.worktreeId === undefined ? {} : { worktreeId: identity.worktreeId })
    })) as { id: string }
    return worktree.id
  }

  /** The repo a workspace's worktree belongs to; null for the floating workspace. */
  async repoIdOf(workspaceId: string): Promise<string | null> {
    if (workspaceId === FLOATING_WORKSPACE) return null
    const worktree = (await this.context.call('quirky.worktree/resolve', { selector: `id:${workspaceId}` })) as { repoId: string }
    return worktree.repoId
  }

  /** The session behind a pane named by `pane` or `session`, waiting behind any change in progress. */
  paneSession(params: Params): Promise<{ workspace: string; session: string }> {
    return this.queued(async () => {
      const { ws, loc } = this.paneTarget(params)
      return { workspace: ws.id, session: loc.pane.session }
    })
  }

  /** Records `commandId` as the last quick command of the group holding `paneId`; a pane that has since gone is ignored. */
  rememberQuickCommand(paneId: string, commandId: string): Promise<void> {
    return this.queued(() => {
      for (const ws of this.workspaces.values()) {
        const loc = ops.locatePane(ws, paneId)
        if (!loc) continue
        if (loc.group.lastQuickCommand === commandId) return
        const ids = this.ids()
        this.commit(ws, ops.setLastQuickCommand(ws, loc.group.id, commandId), ids)
        return
      }
    })
  }

  /** Starts a session and binds it as a new tab in one queue slot. */
  createTab(workspaceId: string, spec: NewTabSpec): Promise<{ workspace: Workspace; session: Session }> {
    return this.queued(() => this.addTab(workspaceId, spec))
  }
  private groupInfo(params: Params): { workspace: string } {
    const group = params.group as string
    return { workspace: this.ownerOf('group', group).id }
  }

  private async adoptSession(params: Params): Promise<{ workspace: Workspace }> {
    const groupId = params.group as string
    const workspace = this.ownerOf('group', groupId)
    const session = await this.session(params.session as string)
    if (!isTabbed(session)) throw this.context.error('conflict', `session ${session.id} cannot be placed in a terminal tab`)
    if (session.worktreeId !== workspace.id) {
      throw this.context.error('conflict', `session ${session.id} belongs to ${session.worktreeId}, not workspace ${workspace.id}`)
    }

    let bound: { groupId: string; tabId: string } | undefined
    for (const current of this.workspaces.values()) {
      const location = ops.locateSession(current, session.id)
      if (!location) continue
      if (bound) throw this.context.error('conflict', `session ${session.id} is already present in multiple tabs`)
      if (current.id !== workspace.id) {
        throw this.context.error('conflict', `session ${session.id} is already bound to workspace ${current.id}`)
      }
      bound = { groupId: location.group.id, tabId: location.tab.id }
    }

    if (bound?.groupId === groupId) return { workspace }
    const ids = this.ids()
    if (bound) {
      const moved = this.unwrap(ops.moveTabToGroup(workspace, bound.tabId, groupId))
      return { workspace: this.commit(workspace, moved, ids) }
    }
    const tab = ops.makeTab(ids, { defaultTitle: session.title, session: session.id, now: this.now() })
    const appended = this.unwrap(ops.appendTab(workspace, groupId, tab))
    return { workspace: this.commit(workspace, appended, ids) }
  }

  private queued<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.closed) throw this.context.error('conflict', 'quirky.terminal is shut down')
      return work()
    })
    this.tail = run.catch(() => {})
    return run
  }

  private enqueueBackground(work: () => Promise<void>, what: string): void {
    this.queued(work).catch((error) => {
      if (!this.closed) this.context.log(`${what} failed: ${messageOf(error)}`)
    })
  }

  private ids(): CounterIds {
    return new CounterIds(this.counter)
  }

  private unwrap<T>(result: { ok: true; value: T } | { ok: false; error: TreeError }): T {
    if (result.ok) return result.value
    throw this.context.error(result.error.kind, result.error.message)
  }

  private checkRevision(ws: Workspace, revision: unknown): void {
    if (revision !== undefined && revision !== ws.revision) {
      throw this.context.error('conflict', `workspace ${ws.id} is at revision ${ws.revision}`)
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  /** The workspace `id`, created empty (revision 0) when it has none yet. */
  private ensure(id: string): Workspace {
    const existing = this.workspaces.get(id)
    if (existing) return existing
    const ids = this.ids()
    const created = ops.emptyWorkspace(id, ids, this.unreadable.get(id)?.revision ?? 0)
    this.store.save(created, ids.value)
    this.counter = ids.value
    this.workspaces.set(id, created)
    this.unreadable.delete(id)
    return created
  }

  private ownerOf(kind: 'tab' | 'group' | 'split', id: string): Workspace {
    for (const ws of this.workspaces.values()) {
      const found =
        kind === 'tab' ? ops.locateTab(ws, id) !== null : kind === 'group' ? findGroup(ws.root, id) !== null : ops.hasDivider(ws, id)
      if (found) return ws
    }
    throw this.context.error('not-found', `no ${kind} ${id}`)
  }

  private paneTarget(params: Params): { ws: Workspace; loc: ops.PaneLocation } {
    const paneId = params.pane as string | undefined
    const sessionId = params.session as string | undefined
    if (paneId === undefined && sessionId === undefined) throw this.context.error('invalid-params', 'pane or session is required')
    for (const ws of this.workspaces.values()) {
      const loc = paneId !== undefined ? ops.locatePane(ws, paneId) : ops.locateSession(ws, sessionId!)
      if (loc) return { ws, loc }
    }
    throw this.context.error('not-found', paneId !== undefined ? `no pane ${paneId}` : `no pane for session ${sessionId}`)
  }

  /** Saves `next` as the workspace after `prev`: one transaction, revision + 1, one `layout` event. */
  private commit(prev: Workspace, next: Workspace, ids: CounterIds): Workspace {
    const saved: Workspace = { ...this.syncLiveTitles(prev, ops.normalize(next)), revision: prev.revision + 1 }
    this.store.save(saved, ids.value)
    this.counter = ids.value
    this.workspaces.set(saved.id, saved)
    this.unreadable.delete(saved.id)
    this.context.emit('layout', { workspace: saved.id, revision: saved.revision })
    return saved
  }

  /** A tab whose active pane changed shows that pane's latest title. */
  private syncLiveTitles(prev: Workspace, next: Workspace): Workspace {
    const before = new Map(ops.workspaceTabs(prev).map((tab) => [tab.id, tab.activePane]))
    let current = next
    for (const tab of ops.workspaceTabs(next)) {
      if (before.get(tab.id) === tab.activePane) continue
      const leaf = findPane(tab.root, tab.activePane)
      const title = (leaf && this.titles.get(leaf.session)?.trim()) || null
      if (title !== tab.liveTitle) current = ops.setLiveTitle(current, tab.id, title)
    }
    return current
  }

  private applyLiveTitle(sessionId: string, title: string): void {
    const text = title.trim() || null
    for (const ws of this.workspaces.values()) {
      const loc = ops.locateSession(ws, sessionId)
      if (!loc) continue
      if (loc.tab.activePane !== loc.pane.id || loc.tab.liveTitle === text) return
      const ids = this.ids()
      this.commit(ws, ops.setLiveTitle(ws, loc.tab.id, text), ids)
      return
    }
  }

  private async session(sessionId: string): Promise<Session> {
    return (await this.context.call('quirky.session/get', { session: sessionId })) as Session
  }

  private cwdOf(session: Session): string {
    return this.cwds.get(session.id) ?? session.cwd
  }

  private floatingCwd(): string | undefined {
    const configured = this.context.getSetting('floating-cwd')
    const home = process.env.HOME
    if (typeof configured !== 'string' || configured.trim() === '' || configured === '~') return home
    if (configured.startsWith('~/')) return home ? join(home, configured.slice(2)) : undefined
    return configured
  }

  /** Starts a session in a workspace's worktree (or the floating one) through the session plugin. */
  private async startSession(
    workspaceId: string,
    spec: { agent: string; prompt?: string; extraArgs?: string; cwd?: StartCwd }
  ): Promise<Session> {
    const create = (cwd: string | undefined) =>
      this.context.call('quirky.session/create', {
        worktree: workspaceId === FLOATING_WORKSPACE ? FLOATING_WORKSPACE : `id:${workspaceId}`,
        agent: spec.agent,
        ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
        ...(spec.extraArgs === undefined || spec.extraArgs.trim() === '' ? {} : { extraArgs: spec.extraArgs }),
        ...(cwd === undefined ? {} : { cwd })
      }) as Promise<Session>
    const cwd = spec.cwd ?? (workspaceId === FLOATING_WORKSPACE ? { path: this.floatingCwd() ?? '', soft: true } : undefined)
    if (!cwd || cwd.path === '') return create(undefined)
    try {
      return await create(cwd.path)
    } catch (error) {
      if (cwd.soft && CWD_REFUSED.test(messageOf(error))) return create(undefined)
      throw error
    }
  }

  private async closeSessions(sessionIds: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(sessionIds.map((id) => this.context.call('quirky.session/close', { session: id })))
    const failed = results.find((result) => result.status === 'rejected' && !isNotFound(result.reason))
    if (failed) throw (failed as PromiseRejectedResult).reason
  }

  private async closeQuietly(sessionId: string): Promise<void> {
    await this.closeSessions([sessionId]).catch((error) => this.context.log(`could not close session ${sessionId}: ${messageOf(error)}`))
  }

  /** What `reopenTab` needs to start the tab again: its titles, colour, agent and the directory its first pane's session started in. */
  private async closedRecord(tab: Tab): Promise<ClosedTab> {
    const leaf = paneLeaves(tab.root)[0]!
    const session = await this.session(leaf.session).catch(() => null)
    return {
      title: tab.customTitle,
      defaultTitle: tab.defaultTitle,
      color: tab.color,
      cwd: session?.cwd ?? '',
      agent: session?.agent ?? 'shell',
      closedAt: this.now()
    }
  }

  /** Runs `op` on the workspace and commits it; the result of every simple mutation. */
  private edit(ws: Workspace, params: Params, op: (ids: CounterIds) => OpResult): { workspace: Workspace } {
    this.checkRevision(ws, params.revision)
    const ids = this.ids()
    return { workspace: this.commit(ws, this.unwrap(op(ids)), ids) }
  }

  private editTab(params: Params, op: (ws: Workspace, tabId: string) => OpResult): { workspace: Workspace } {
    const tabId = params.tab as string
    const ws = this.ownerOf('tab', tabId)
    return this.edit(ws, params, () => op(ws, tabId))
  }

  private editPane(params: Params, op: (ws: Workspace, paneId: string) => OpResult): { workspace: Workspace } {
    const { ws, loc } = this.paneTarget(params)
    return this.edit(ws, params, () => op(ws, loc.pane.id))
  }

  private async workspace(params: Params, caller: PluginCaller): Promise<{ workspace: Workspace }> {
    const id = await this.resolveWorkspace(params.workspace, caller)
    this.ensure(id)
    if (params.ensure === true && ops.workspaceTabs(this.workspaces.get(id)!).length === 0) {
      await this.reconcile([id])
      if (ops.workspaceTabs(this.workspaces.get(id)!).length === 0) await this.addTab(id, {})
    }
    return { workspace: this.workspaces.get(id)! }
  }

  private async newTab(params: Params, caller: PluginCaller): Promise<{ workspace: Workspace }> {
    const id =
      params.group !== undefined && params.workspace === undefined
        ? this.ownerOf('group', params.group as string).id
        : await this.resolveWorkspace(params.workspace, caller)
    const { workspace } = await this.addTab(id, {
      ...(params.group === undefined ? {} : { group: params.group as string }),
      ...(params.cwd === undefined ? {} : { cwd: params.cwd as string }),
      ...(params.agent === undefined ? {} : { agent: params.agent as string }),
      ...(params.prompt === undefined ? {} : { prompt: params.prompt as string }),
      ...(params.extraArgs === undefined ? {} : { extraArgs: params.extraArgs as string }),
      ...(params.title === undefined ? {} : { title: params.title as string }),
      ...(params.quickCommand === undefined ? {} : { quickCommand: params.quickCommand as string }),
      ...(params.revision === undefined ? {} : { revision: params.revision as number })
    })
    return { workspace }
  }

  /** Opens an already running local terminal session in its workspace without creating or restoring a process. */
  private async openSession(params: Params, caller: PluginCaller): Promise<{ workspace: Workspace; pane: string }> {
    if (typeof params.session !== 'string' || params.session.trim() === '') {
      throw this.context.error('invalid-params', 'session is required')
    }
    const session = await this.session(params.session)
    if (session.kind !== 'terminal') throw this.context.error('invalid-params', `session ${session.id} is not a terminal session`)
    if (session.status === 'exited') throw this.context.error('conflict', `session ${session.id} is not running`)
    if (typeof session.worktreeId !== 'string' || session.worktreeId.trim() === '') {
      throw this.context.error('invalid-params', `session ${session.id} has no local worktree`)
    }
    if (params.workspace !== undefined && (typeof params.workspace !== 'string' || params.workspace.trim() === '')) {
      throw this.context.error('invalid-params', 'workspace must be a worktree ID or floating')
    }
    const workspaceId =
      params.workspace === undefined ? session.worktreeId : await this.resolveWorkspace(params.workspace, caller)
    if (workspaceId !== session.worktreeId) {
      throw this.context.error('invalid-params', `session ${session.id} belongs to workspace ${session.worktreeId}, not ${workspaceId}`)
    }
    if (!(await this.context.pty.list()).some((entry) => entry.sessionId === session.id && entry.state === 'running')) {
      throw this.context.error('conflict', `session ${session.id} is not running in the local terminal host`)
    }

    for (const workspace of this.workspaces.values()) {
      const loc = ops.locateSession(workspace, session.id)
      if (!loc) continue
      if (workspace.id !== workspaceId) {
        throw this.context.error('conflict', `session ${session.id} is already open in workspace ${workspace.id}`)
      }
      const alreadyFocused =
        workspace.activeGroup === loc.group.id &&
        loc.group.activeTab === loc.tab.id &&
        loc.tab.activePane === loc.pane.id &&
        (loc.tab.expandedPane === null || loc.tab.expandedPane === loc.pane.id)
      const focused = alreadyFocused
        ? workspace
        : this.commit(workspace, this.unwrap(ops.focusPaneOp(workspace, loc.pane.id)), this.ids())
      if (workspaceId !== FLOATING_WORKSPACE || this.floatingIsVisible()) this.updateFocusContext(workspaceId)
      return { workspace: focused, pane: loc.pane.id }
    }

    const workspace = this.ensure(workspaceId)
    const group = findGroup(workspace.root, workspace.activeGroup)
    if (!group) throw this.context.error('conflict', `workspace ${workspaceId} has no active group`)
    const ids = this.ids()
    const tab = ops.makeTab(ids, { defaultTitle: session.title, session: session.id, now: this.now() })
    const pane = (tab.root as PaneLeaf).id
    const next = this.unwrap(ops.appendTab(workspace, group.id, tab))
    const focused = this.commit(workspace, next, ids)
    if (workspaceId !== FLOATING_WORKSPACE || this.floatingIsVisible()) this.updateFocusContext(workspaceId)
    return { workspace: focused, pane }
  }

  private async addTab(workspaceId: string, spec: NewTabSpec): Promise<{ workspace: Workspace; session: Session }> {
    const ws = this.ensure(workspaceId)
    this.checkRevision(ws, spec.revision)
    const group = spec.group === undefined ? findGroup(ws.root, ws.activeGroup) : findGroup(ws.root, spec.group)
    if (!group) throw this.context.error('not-found', `no group ${spec.group}`)
    const title = spec.title?.trim()
    if (title !== undefined && title.length > TITLE_MAX) {
      throw this.context.error('invalid-params', `title must be at most ${TITLE_MAX} characters`)
    }
    const agent = spec.agent ?? 'shell'
    const session = await this.startSession(workspaceId, {
      agent,
      ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
      ...(spec.extraArgs === undefined ? {} : { extraArgs: spec.extraArgs }),
      ...(spec.cwd === undefined ? {} : { cwd: { path: spec.cwd, soft: false } })
    })
    try {
      const ids = this.ids()
      const defaultTitle = title || (agent === 'shell' ? nextTerminalTitle(this.defaultTitles(ws)) : session.title)
      const tab = ops.makeTab(ids, { defaultTitle, session: session.id, now: this.now() })
      let next = this.unwrap(ops.appendTab(ws, group.id, tab))
      if (spec.quickCommand !== undefined) next = ops.setLastQuickCommand(next, group.id, spec.quickCommand)
      return { workspace: this.commit(ws, next, ids), session }
    } catch (error) {
      await this.closeQuietly(session.id)
      throw error
    }
  }

  private defaultTitles(ws: Workspace): string[] {
    return ops.workspaceTabs(ws).map((tab) => tab.defaultTitle)
  }

  private async closeTab(params: Params): Promise<{ workspace: Workspace }> {
    const tabId = params.tab as string
    const ws = this.ownerOf('tab', tabId)
    this.checkRevision(ws, params.revision)
    return this.removeTabs(ws, [tabId])
  }

  private async closeTabs(params: Params): Promise<{ workspace: Workspace }> {
    const tabId = params.tab as string
    const ws = this.ownerOf('tab', tabId)
    this.checkRevision(ws, params.revision)
    return this.removeTabs(ws, this.tabsFor(ws, tabId, params.which as string).map((tab) => tab.id))
  }

  /** The unpinned tabs of a tab's group that lie on `which` side of it. */
  private tabsFor(ws: Workspace, tabId: string, which: string): Tab[] {
    const loc = ops.locateTab(ws, tabId)!
    return loc.group.tabs.filter((tab, index) => {
      if (tab.pinned || tab.id === tabId) return false
      return which === 'right' ? index > loc.index : which === 'left' ? index < loc.index : true
    })
  }

  /** Ends the sessions of the tabs, then removes the tabs and remembers them for reopening. */
  private async removeTabs(ws: Workspace, tabIds: readonly string[]): Promise<{ workspace: Workspace }> {
    const tabs = tabIds.map((id) => ops.locateTab(ws, id)!.tab)
    const records = await Promise.all(tabs.map((tab) => this.closedRecord(tab)))
    await this.closeSessions(tabs.flatMap((tab) => paneLeaves(tab.root).map((leaf) => leaf.session)))
    const ids = this.ids()
    let next = ws
    for (const [index, tab] of tabs.entries()) next = this.unwrap(ops.removeTab(next, tab.id, records[index]!))
    return { workspace: this.commit(ws, next, ids) }
  }

  private async closePane(params: Params): Promise<{ workspace: Workspace }> {
    const { ws, loc } = this.paneTarget(params)
    this.checkRevision(ws, params.revision)
    if (paneLeaves(loc.tab.root).length === 1) return this.removeTabs(ws, [loc.tab.id])
    await this.closeSessions([loc.pane.session])
    const ids = this.ids()
    return { workspace: this.commit(ws, this.unwrap(ops.closePaneOp(ws, loc.pane.id, null)), ids) }
  }

  private async moveTab(params: Params): Promise<{ workspace: Workspace }> {
    const tabId = params.tab as string
    const ws = this.ownerOf('tab', tabId)
    const side = params.split as GroupSide | undefined
    const group = params.group as string | undefined
    if (side !== undefined && (group !== undefined || params.index !== undefined)) {
      throw this.context.error('invalid-params', 'pass either group and index or split')
    }
    if (side === undefined && group === undefined) throw this.context.error('invalid-params', 'group or split is required')
    return this.edit(ws, params, (ids) =>
      side === undefined ? ops.moveTabToGroup(ws, tabId, group!, params.index as number | undefined) : ops.moveTabToSplit(ws, tabId, side, params.of as string | undefined, ids)
    )
  }

  private async activateTab(params: Params, caller: PluginCaller): Promise<{ workspace: Workspace }> {
    if (params.tab !== undefined) {
      return this.editTab(params, (ws, id) => ops.activateTab(ws, id))
    }
    if (params.index === undefined && params.offset === undefined) {
      throw this.context.error('invalid-params', 'tab, index or offset is required')
    }
    const ws = this.ensure(await this.resolveWorkspace(params.workspace, caller))
    if (params.index !== undefined) {
      return this.edit(ws, params, () => ops.activateTabAt(ws, params.group as string | undefined, params.index as number))
    }
    return this.edit(ws, params, () => ops.activateTabBy(ws, params.offset as 1 | -1, (params.order as 'position' | 'recent' | undefined) ?? 'position'))
  }

  private async reopenTab(params: Params, caller: PluginCaller): Promise<{ workspace: Workspace }> {
    const id = await this.resolveWorkspace(params.workspace, caller)
    const ws = this.ensure(id)
    this.checkRevision(ws, params.revision)
    const closed = ws.closed[0]
    if (!closed) throw this.context.error('not-found', `no closed tab to reopen in ${await this.workspaceName(id)}`)
    const session = await this.startSession(id, {
      agent: closed.agent,
      ...(closed.cwd === '' ? {} : { cwd: { path: closed.cwd, soft: true } })
    })
    try {
      const ids = this.ids()
      const fresh = /^Terminal \d+$/.test(closed.defaultTitle)
      const defaultTitle = closed.agent === 'shell' && fresh ? nextTerminalTitle(this.defaultTitles(ws)) : closed.agent === 'shell' ? closed.defaultTitle : session.title
      const tab = ops.makeTab(ids, { defaultTitle, session: session.id, now: this.now(), customTitle: closed.title, color: closed.color })
      const next = this.unwrap(ops.reopenTabOp(ws, ws.activeGroup, tab))
      return { workspace: this.commit(ws, next, ids) }
    } catch (error) {
      await this.closeQuietly(session.id)
      throw error
    }
  }

  private async workspaceName(id: string): Promise<string> {
    if (id === FLOATING_WORKSPACE) return FLOATING_WORKSPACE
    try {
      return ((await this.context.call('quirky.worktree/resolve', { selector: `id:${id}` })) as { name: string }).name
    } catch {
      return id
    }
  }

  private async splitPane(params: Params): Promise<{ workspace: Workspace }> {
    const { ws, loc } = this.paneTarget(params)
    this.checkRevision(ws, params.revision)
    const source = await this.session(loc.pane.session).catch(() => null)
    const path = this.cwds.get(loc.pane.session) ?? source?.cwd
    const session = await this.startSession(ws.id, { agent: 'shell', ...(path ? { cwd: { path, soft: true } } : {}) })
    try {
      const ids = this.ids()
      const leaf: PaneLeaf = { kind: 'pane', id: ids.next('pane'), session: session.id, title: null, exit: null }
      const next = this.unwrap(ops.splitPaneOp(ws, loc.pane.id, params.direction as SplitDirection, leaf, ids))
      return { workspace: this.commit(ws, next, ids) }
    } catch (error) {
      await this.closeQuietly(session.id)
      throw error
    }
  }

  private async restartPane(params: Params): Promise<{ workspace: Workspace }> {
    const { ws, loc } = this.paneTarget(params)
    this.checkRevision(ws, params.revision)
    const old = await this.session(loc.pane.session)
    if (old.status !== 'exited') throw this.context.error('conflict', `pane ${loc.pane.id} is still running`)
    const session = await this.startSession(ws.id, { agent: 'shell', cwd: { path: this.cwdOf(old), soft: true } })
    let saved: Workspace
    try {
      const ids = this.ids()
      saved = this.commit(ws, this.unwrap(ops.rebindPane(ws, loc.pane.id, session.id)), ids)
    } catch (error) {
      await this.closeQuietly(session.id)
      throw error
    }
    await this.closeQuietly(old.id)
    return { workspace: saved }
  }

  private async focusPane(params: Params, caller: PluginCaller): Promise<{ workspace: Workspace }> {
    let result: { workspace: Workspace }
    if (params.offset === undefined) {
      result = await this.editPane(params, (ws, pane) => ops.focusPaneOp(ws, pane))
    } else {
      const ws =
        params.tab !== undefined ? this.ownerOf('tab', params.tab as string) : this.ensure(await this.resolveWorkspace(params.workspace, caller))
      result = await this.edit(ws, params, () => ops.focusPaneBy(ws, params.tab as string | undefined, params.offset as 1 | -1))
    }
    if (result.workspace.id !== FLOATING_WORKSPACE || this.floatingIsVisible()) this.updateFocusContext(result.workspace.id)
    return result
  }

  private resizeSplit(params: Params): { workspace: Workspace } {
    const split = params.split as string | undefined
    const pane = params.pane as string | undefined
    const group = params.group as string | undefined
    const given = [split, pane ?? (params.session as string | undefined), group].filter((value) => value !== undefined).length
    if (given !== 1) throw this.context.error('invalid-params', 'pass one of split, pane or group')
    if (split !== undefined) {
      const ws = this.ownerOf('split', split)
      return this.edit(ws, params, () => ops.resizeSplitOp(ws, { split, ratio: this.number(params.ratio, 'ratio') }))
    }
    if (group !== undefined) {
      const ws = this.ownerOf('group', group)
      return this.edit(ws, params, () => ops.resizeSplitOp(ws, { group, share: this.number(params.share, 'share') }))
    }
    const target = this.paneTarget(params)
    return this.edit(target.ws, params, () => ops.resizeSplitOp(target.ws, { pane: target.loc.pane.id, share: this.number(params.share, 'share') }))
  }

  private number(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw this.context.error('invalid-params', `${name} is required`)
    return value
  }

  private movePane(params: Params): { workspace: Workspace } {
    const { ws, loc } = this.paneTarget(params)
    const toPane = params.toPane as string | undefined
    const toTab = params.toTab as string | undefined
    if ((toPane === undefined) === (toTab === undefined)) throw this.context.error('invalid-params', 'pass either toPane and edge or toTab')
    if (toPane !== undefined) {
      if (params.edge === undefined) throw this.context.error('invalid-params', 'edge is required with toPane')
      if (!ops.locatePane(ws, toPane)) this.refuseOtherWorkspace('pane', toPane)
      return this.edit(ws, params, (ids) => ops.movePaneToPane(ws, loc.pane.id, toPane, params.edge as Edge, ids))
    }
    if (!ops.locateTab(ws, toTab!)) this.refuseOtherWorkspace('tab', toTab!)
    return this.edit(ws, params, (ids) => ops.movePaneToTab(ws, loc.pane.id, toTab!, ids))
  }

  /** A target that isn't in the pane's workspace: invalid if another workspace has it, else not found. */
  private refuseOtherWorkspace(kind: 'pane' | 'tab', id: string): never {
    const elsewhere = [...this.workspaces.values()].some((ws) => (kind === 'pane' ? ops.locatePane(ws, id) : ops.locateTab(ws, id)))
    throw elsewhere
      ? this.context.error('invalid-params', "a pane can't be moved to another workspace")
      : this.context.error('not-found', `no ${kind} ${id}`)
  }

  private closeGroup(params: Params): { workspace: Workspace } {
    const groupId = params.group as string
    const ws = this.ownerOf('group', groupId)
    return this.edit(ws, params, () => ops.closeGroupOp(ws, groupId))
  }

  /** A terminal-only action: it leaves the layout untouched, so the revision doesn't move and no `layout` event fires. */
  private async ptyAction(params: Params, action: (session: string) => Promise<void>): Promise<{ workspace: Workspace }> {
    const { ws, loc } = this.paneTarget(params)
    this.checkRevision(ws, params.revision)
    await action(loc.pane.session)
    return { workspace: ws }
  }

  private paneOf(params: Params): { workspace: string; tab: string; pane: string } {
    if ((params.pane === undefined) === (params.session === undefined)) throw this.context.error('invalid-params', 'pass one of pane or session')
    const { ws, loc } = this.paneTarget(params)
    return { workspace: ws.id, tab: loc.tab.id, pane: loc.pane.id }
  }

  /**
   * The question to ask before closing: one line per target session that has a running child
   * process or is an agent still alive. Null when closing loses nothing a reopen won't restore.
   */
  private async describeClose(params: Params): Promise<string | null> {
    const targets = this.closeTargets(params)
    const running = new Map((await this.context.pty.list().catch(() => [])).map((info) => [info.sessionId, info]))
    let table: string | undefined
    let psFailed = false
    const ps = () => {
      try {
        return (table ??= defaultPs())
      } catch (error) {
        psFailed = true
        throw error
      }
    }
    const lines: string[] = []
    for (const { tab, leaf } of targets) {
      const unknown = `Stop the session in ${displayTitle(tab)}?`
      let session: Session
      try {
        session = await this.session(leaf.session)
      } catch (error) {
        if (!isNotFound(error)) lines.push(unknown)
        continue
      }
      if (session.status === 'exited') continue
      if (session.agent !== 'shell') {
        lines.push(`Stop agent ${session.title}?`)
        continue
      }
      const info = running.get(session.id)
      if (!info || (info.alive && typeof info.pid !== 'number')) {
        lines.push(unknown)
        continue
      }
      const child = info.alive ? runningChildOf(info.pid, ps) : null
      if (child) lines.push(`Stop ${child.command} in ${displayTitle(tab)}?`)
      else if (psFailed) lines.push(unknown)
    }
    return lines.length > 0 ? lines.join('\n') : null
  }

  private closeTargets(params: Params): { tab: Tab; leaf: PaneLeaf }[] {
    if (params.pane !== undefined || params.session !== undefined) {
      const { loc } = this.paneTarget(params)
      return [{ tab: loc.tab, leaf: loc.pane }]
    }
    if (params.tab === undefined) throw this.context.error('invalid-params', 'tab, pane or session is required')
    const tabId = params.tab as string
    const ws = this.ownerOf('tab', tabId)
    const tabs = params.which === undefined ? [ops.locateTab(ws, tabId)!.tab] : this.tabsFor(ws, tabId, params.which as string)
    return tabs.flatMap((tab) => paneLeaves(tab.root).map((leaf) => ({ tab, leaf })))
  }

  private readOrSetFocusContext(params: Params): { workspace: string | null } {
    const workspace = params.workspace
    if (workspace !== undefined) {
      if (workspace !== null && (typeof workspace !== 'string' || workspace.trim() === '')) {
        throw this.context.error('invalid-params', 'workspace must be a non-empty worktree ID, floating, or null')
      }
      if (workspace === null) this.updateFocusContext(null)
      else if (workspace === FLOATING_WORKSPACE && !this.floatingIsVisible()) this.clearHiddenFloatingFocus()
      else this.updateFocusContext(workspace as string)
    } else {
      this.clearHiddenFloatingFocus()
    }
    return { workspace: this.focusedWorkspace }
  }

  private updateFocusContext(workspace: string | null): void {
    if (this.focusedWorkspace === workspace) return
    this.focusedWorkspace = workspace
    this.context.emit('focusContextChanged', { workspace })
  }

  private floatingIsVisible(): boolean {
    const state = this.floating()
    return state.enabled && state.open
  }

  private clearHiddenFloatingFocus(): void {
    if (this.focusedWorkspace === FLOATING_WORKSPACE && !this.floatingIsVisible()) this.updateFocusContext(null)
  }

  private floating(): FloatingState {
    return { enabled: this.context.getSetting('floating-enabled') !== false, ...this.floatingStored }
  }

  private setFloating(params: Params): FloatingState {
    const result = applyFloatingUpdate(this.floatingStored, params)
    if (!result.ok) throw this.context.error('invalid-params', result.message)
    this.store.saveFloating(result.state)
    this.floatingStored = result.state
    const state = this.floating()
    this.clearHiddenFloatingFocus()
    this.context.emit('floating', { state })
    return state
  }

  private openExternal(params: Params): { ok: true } {
    const problem = checkExternalTarget(params.target)
    if (problem) throw this.context.error('invalid-params', problem)
    openExternal({ target: params.target as string, reveal: params.reveal === true })
    return { ok: true }
  }

  private pathsExist(params: Params): { exists: boolean[] } {
    const paths = params.paths as string[]
    if (paths.length > MAX_PATHS) throw this.context.error('invalid-params', `at most ${MAX_PATHS} paths`)
    return { exists: paths.map((path) => isAbsolute(path) && existsSync(path)) }
  }

  /** Takes the title and directory the PTY host holds, except where a live fact arrived while the list was in flight. */
  private async seedFacts(): Promise<void> {
    const started = this.factClock
    try {
      for (const info of await this.context.pty.list()) {
        if (info.title && (this.titleAt.get(info.sessionId) ?? 0) <= started) this.titles.set(info.sessionId, info.title)
        if ((this.cwdAt.get(info.sessionId) ?? 0) <= started) this.cwds.set(info.sessionId, info.cwd)
      }
    } catch (error) {
      this.context.log(`could not read terminal facts: ${messageOf(error)}`)
    }
  }

  /**
   * Stores that a pane's session received driving input. It is bookkeeping rather than a layout
   * change, so the revision stays and no event fires, which keeps clients' revision checks valid.
   */
  private persistTyped(sessionId: string): void {
    for (const ws of this.workspaces.values()) {
      const loc = ops.locateSession(ws, sessionId)
      if (!loc) continue
      if (loc.pane.typed) return
      const next = this.unwrap(ops.setPaneTyped(ws, loc.pane.id))
      this.store.save(next)
      this.workspaces.set(next.id, next)
      return
    }
  }

  /** The workspace with `typed` set on panes whose session got input before the pane existed. */
  private withTyped(ws: Workspace): Workspace {
    let next = ws
    for (const leaf of ops.workspaceTabs(ws).flatMap((tab) => paneLeaves(tab.root))) {
      if (!leaf.typed && this.inputs.has(leaf.session)) next = this.unwrap(ops.setPaneTyped(next, leaf.id))
    }
    return next
  }

  /** Reconciles every workspace (or only `only`) with the session list. */
  private async reconcile(only?: readonly string[]): Promise<void> {
    if (this.closed) return
    let sessions: Session[]
    try {
      sessions = (await this.context.call('quirky.session/list', {})) as Session[]
    } catch (error) {
      this.context.log(`could not list sessions: ${messageOf(error)}`)
      return
    }
    const known = new Set(sessions.map((session) => session.id))
    this.inputs.retain(known)
    for (const map of [this.titles, this.cwds, this.titleAt, this.cwdAt]) for (const id of map.keys()) if (!known.has(id)) map.delete(id)

    const ids = new Set([...this.workspaces.keys(), ...this.unreadable.keys(), ...sessions.filter(isTabbed).map((session) => session.worktreeId)])
    for (const id of ids) {
      if (only && !only.includes(id)) continue
      await this.reconcileOne(id, sessions)
    }
  }

  private async reconcileOne(id: string, sessions: readonly Session[]): Promise<void> {
    const current = this.workspaces.get(id)
    const unreadable = current ? undefined : this.unreadable.get(id)
    const ids = this.ids()
    const stored = current ?? ops.emptyWorkspace(id, ids, unreadable?.revision ?? 0)
    const base = this.withTyped(stored)
    const boundElsewhere = new Set(
      [...this.workspaces.values()].filter((ws) => ws.id !== id).flatMap((ws) => ops.boundSessions(ws))
    )
    const result = reconcileWorkspace({ workspace: base, sessions, boundElsewhere, hasInput: (session) => this.inputs.has(session), ids, now: this.now() })
    const changed = unreadable !== undefined || JSON.stringify(result.workspace) !== JSON.stringify(stored)
    if (!changed) return
    this.commit(base, result.workspace, ids)
    this.context.log(
      unreadable
        ? `rebuilt the layout of ${id} from its sessions (${unreadable.reason}): ${result.notes.join('; ') || 'no sessions'}`
        : `repaired the layout of ${id}: ${result.notes.join('; ')}`
    )
    await this.closeSessions(result.closeSessions).catch((error) => this.context.log(`could not close ended sessions of ${id}: ${messageOf(error)}`))
  }
}
