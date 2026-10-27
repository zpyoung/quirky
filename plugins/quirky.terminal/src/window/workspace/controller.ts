import type { ReactNode } from 'react'
import { RpcErrorCode, type QuirkyEvent, type Session, type UiPluginContext } from '@quirky/protocol'
import { displayTitle } from '../../layout/titles'
import { findGroup, groupsInOrder, paneLeaves, setGroupRatio, setPaneRatio } from '../../layout/tree'
import type { DropZone } from '../../layout/tree'
import { FLOATING_WORKSPACE, TAB_COLOR_HEX, TAB_COLORS } from '../../layout/types'
import type { Edge, Group, GroupNode, PaneLeaf, PaneNode, Workspace } from '../../layout/types'
import type { PaneReport, SearchOptions, TerminalPaneHandle, TerminalPaneProps } from '../pane/TerminalPaneView'
import { SEPARATOR, type MenuItem } from './Menu'
import { AGENTS_VIEW_ID, TERMINAL_ONLY_MENU, filterEntries, loadMenuEntries, type MenuEntry } from './menuEntries'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  focusedPaneOf,
  focusedTabOf,
  hasCode,
  isAgentQuestion,
  locatePane,
  locateSession,
  locateTab,
  panesReport,
  readWorkspaceSettings,
  switcherOrder,
  tabsReport,
  visibleSessionsOf,
  terminalSettingName,
  type PaneStateReport,
  type TabReport,
  type WorkspaceSettings
} from './model'
import type { NewSessionRequest } from './PromptDialog'

/** Clicks on a dialog this soon after the previous close was confirmed are taken for a double click. */
export const DOUBLE_REQUEST_GUARD_MS = 350

const TERMINAL_PREFIX = 'quirky.terminal/'
const SETTING_PREFIX = 'setting:quirky.terminal/'

/** What the person closes: one tab, one pane, or the tabs on one side of a tab. */
export type CloseTarget =
  | { kind: 'tab'; tab: string }
  | { kind: 'pane'; pane: string }
  | { kind: 'tabs'; tab: string; which: 'others' | 'right' | 'left' }

export type MenuState = { kind: string; target: string | null; x: number; y: number; query: string }

export type DialogState =
  | { kind: 'close-running'; title: string; target: CloseTarget; tabLabel: string; agent: boolean; notBefore: number }
  | { kind: 'close-pinned'; title: string; target: CloseTarget; tabLabel: string; notBefore: number }
  | { kind: 'switch-tabs'; title: string; group: string; order: string[]; index: number }
  | { kind: 'new-session'; title: string; request: NewSessionRequest; group: string | null }

export type PaneDropTarget = { kind: 'edge'; pane: string; edge: Edge } | { kind: 'tab'; tab: string }

/** A drag in flight: the divider preview, a pane being moved, or a tab being moved. */
export type Preview = { kind: 'pane' | 'group'; split: string; ratio: number }
export type TabDrop = { kind: 'zone'; group: string; zone: DropZone } | { kind: 'strip'; group: string; index: number }

export type ControllerState = {
  status: 'loading' | 'ready' | 'missing' | 'error'
  workspace: Workspace | null
  sessions: Readonly<Record<string, Session>>
  cwds: Readonly<Record<string, string>>
  settings: WorkspaceSettings
  /** Counts up on each reconnect, so panes attach to their streams again. */
  epoch: number
  agents: MenuEntry[]
  menu: MenuState | null
  dialog: DialogState | null
  rename: { kind: 'tab' | 'pane'; id: string } | null
  preview: Preview | null
  dragging: boolean
  paneStates: Readonly<Record<string, PaneReport>>
  tabDrag: { tab: string; over: TabDrop | null } | null
  paneDrag: { pane: string; target: PaneDropTarget | null } | null
}

/** The slots and switches a host of the workspace can set. */
export type WorkspaceOptions = {
  /** `floating` mounts the floating workspace: no tab is created for it, and closing its last tab minimizes the panel. */
  workspace?: 'floating'
  /** Rendered after the `+` button of each group's strip. */
  stripExtras?: (group: Group) => ReactNode
  /** The rows of the pane menu's Quick Commands submenu. */
  paneMenuExtras?: (pane: PaneLeaf) => MenuItem[]
  /** Menus beyond `tab`, `pane`, `plus` and `actions`, opened by `openMenu(kind, target)`. */
  extraMenus?: Record<string, (target: string | null) => MenuItem[]>
  /** The element carrying the theme's custom properties; defaults to the mount element. */
  themeSource?: Element
  createWebgl?: TerminalPaneProps['createWebgl']
}

export type ViewReport = {
  worktree: string | null
  active: string | null
  tabs: TabReport[]
  /** The sessions of every pane the window mounts. */
  visibleSessions: string[]
  layout: Workspace | null
  focusedPane: string | null
  panes: PaneStateReport[]
  menu: { kind: string; target: string | null; items: { label: string; key: string | null; enabled: boolean; separator: boolean }[] } | null
  dialog: { kind: string; title: string } | null
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const hasTabs = (workspace: Workspace): boolean => groupsInOrder(workspace.root).some((group) => group.tabs.length > 0)

/** Whether `element` is a text field a person types into, other than a terminal's own input. */
function isEditableControl(element: Element): boolean {
  if (element.classList.contains('xterm-helper-textarea')) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (element as HTMLElement).isContentEditable === true
}

/** MIME payloads carry a bounded, declared UI command rather than arbitrary shell text. */
export const COMMAND_DROP_MIME = 'application/x-quirky-command'

export type CommandDropDescriptor = { command: string; args: Record<string, unknown> }

export function hasCommandDrop(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && Array.from(transfer.types).includes(COMMAND_DROP_MIME)
}

function boundedValue(value: unknown, depth: number, budget: { nodes: number }): boolean {
  budget.nodes += 1
  if (budget.nodes > 256 || depth > 5) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 4096
  if (Array.isArray(value)) return value.length <= 32 && value.every((item) => boundedValue(item, depth + 1, budget))
  if (typeof value !== 'object') return false
  const entries = Object.entries(value)
  if (entries.length > 32) return false
  return entries.every(([key, item]) =>
    key.length <= 128 && key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && boundedValue(item, depth + 1, budget)
  )
}

export function parseCommandDrop(transfer: DataTransfer | null): CommandDropDescriptor | null {
  const data = transfer
  if (!hasCommandDrop(data)) return null
  const raw = data.getData(COMMAND_DROP_MIME)
  if (raw.length === 0 || raw.length > 8192) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const descriptor = parsed as Record<string, unknown>
    if (Object.keys(descriptor).some((key) => key !== 'command' && key !== 'args')) return null
    const command = descriptor.command
    if (typeof command !== 'string' || command.length > 192 || !/^command:[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(command)) return null
    const args = descriptor.args === undefined ? {} : descriptor.args
    if (!args || typeof args !== 'object' || Array.isArray(args) || !boundedValue(args, 0, { nodes: 0 })) return null
    return { command, args: args as Record<string, unknown> }
  } catch {
    return null
  }
}

/** Writes to the clipboard; the failure case is the caller's to report. */
async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('the clipboard is not available')
  await navigator.clipboard.writeText(text)
}

/**
 * One mounted workspace: it loads the daemon's layout, keeps it current from events, and offers
 * every action the commands, menus and gestures share. It never changes the layout itself; each
 * action is a daemon call whose result replaces the workspace, except while a drag previews a
 * divider.
 */
export class WorkspaceController {
  readonly floating: boolean
  /** The element the view is mounted on; menus anchor to its descendants. */
  root: HTMLElement | null = null
  private state: ControllerState
  private listeners = new Set<() => void>()
  private handles = new Map<string, TerminalPaneHandle>()
  private unsubscribes: (() => void)[] = []
  private settingOverrides: Record<string, unknown> = {}
  private stopped = false
  private loading = false
  private reloadAfter = false
  private loadingSessions = false
  private wasReconnecting = false
  private guardUntil = 0
  private startSession: string | undefined
  private didFocusInput = false
  private lastReport = ''
  /** Receives the view report whenever it changes. */
  onReport: ((report: ViewReport) => void) | null = null

  constructor(
    readonly context: UiPluginContext,
    /** A worktree selector or `floating`; replaced by the workspace's own ID once it loads. */
    readonly selector: string,
    readonly options: WorkspaceOptions = {},
    session?: string
  ) {
    this.floating = options.workspace === 'floating' || selector === FLOATING_WORKSPACE
    this.startSession = session
    this.state = {
      status: 'loading',
      workspace: null,
      sessions: {},
      cwds: {},
      settings: DEFAULT_WORKSPACE_SETTINGS,
      epoch: 0,
      agents: TERMINAL_ONLY_MENU,
      menu: null,
      dialog: null,
      rename: null,
      preview: null,
      dragging: false,
      paneStates: {},
      tabDrag: null,
      paneDrag: null
    }
  }

  // ---- store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ControllerState => this.state

  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
    this.publish()
  }

  /** The workspace's ID: the daemon's once loaded, else the selector. */
  get workspaceId(): string {
    return this.state.workspace?.id ?? this.selector
  }

  // ---- lifecycle

  /** Subscribes to events and connection changes and loads the workspace and its sessions. */
  start(): void {
    this.unsubscribes.push(
      this.context.subscribe((event) => this.onEvent(event)),
      this.context.onConnection((status) => {
        if (status === 'reconnecting') {
          this.wasReconnecting = true
          return
        }
        if (!this.wasReconnecting) return
        this.wasReconnecting = false
        this.set({ epoch: this.state.epoch + 1 })
        void this.load(false)
      })
    )
    this.set({ settings: readWorkspaceSettings(this.context, this.settingOverrides) })
    void this.load(!this.floating)
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.listeners.clear()
    this.handles.clear()
    this.onReport = null
  }

  /** Reloads the workspace and its sessions, as after an event the controller can't apply itself. */
  refresh(): Promise<void> {
    return this.load(false)
  }

  private async load(ensure: boolean): Promise<void> {
    if (this.loading) {
      this.reloadAfter = true
      return
    }
    this.loading = true
    try {
      let first = ensure
      do {
        this.reloadAfter = false
        await this.loadOnce(first)
        first = false
      } while (this.reloadAfter && !this.stopped)
    } finally {
      this.loading = false
    }
  }

  private async loadOnce(ensure: boolean): Promise<void> {
    let workspace: Workspace
    let sessions: Session[] | null
    try {
      const [loaded, listed] = await Promise.all([
        this.context.call(`${TERMINAL_PREFIX}workspace`, { workspace: this.workspaceId, ...(ensure ? { ensure: true } : {}) }),
        this.listSessions()
      ])
      workspace = (loaded as { workspace: Workspace }).workspace
      sessions = listed
    } catch (error) {
      if (this.stopped) return
      if (hasCode(error, RpcErrorCode.NotFound)) this.set({ status: 'missing', workspace: null })
      else {
        this.set({ status: this.state.workspace ? this.state.status : 'error' })
        this.context.toast('Could not load the workspace', messageOf(error))
      }
      return
    }
    if (this.stopped) return
    const held = this.state.workspace
    const next = held && workspace.revision < held.revision ? held : workspace
    this.set({ status: 'ready', workspace: next, ...(sessions ? { sessions: Object.fromEntries(sessions.map((session) => [session.id, session])) } : {}) })
    this.afterWorkspace(next)
  }

  /** The worktree's sessions, or null when the lookup failed so the caller keeps what it already knows. */
  private async listSessions(): Promise<Session[] | null> {
    try {
      return (await this.context.call('quirky.session/list', { worktree: this.workspaceId })) as Session[]
    } catch {
      return null
    }
  }

  private async loadAgents(): Promise<void> {
    const agents = await loadMenuEntries(this.context)
    if (!this.stopped) this.set({ agents })
  }

  private afterWorkspace(workspace: Workspace): void {
    if (!this.didFocusInput && this.startSession !== undefined) {
      this.didFocusInput = true
      const loc = locateSession(workspace, this.startSession)
      if (loc) void this.focusPane(loc.leaf.id)
    }
    const unknown = groupsInOrder(workspace.root).some((group) =>
      group.tabs.some((tab) => paneLeaves(tab.root).some((leaf) => !this.state.sessions[leaf.session]))
    )
    if (unknown) void this.reloadSessions()
  }

  private async reloadSessions(): Promise<void> {
    if (this.loadingSessions) return
    this.loadingSessions = true
    try {
      const sessions = await this.listSessions()
      if (!this.stopped && sessions) this.set({ sessions: Object.fromEntries(sessions.map((session) => [session.id, session])) })
    } finally {
      this.loadingSessions = false
    }
  }

  private onEvent(event: QuirkyEvent): void {
    if (this.stopped) return
    const data = (event as { data?: unknown }).data as Record<string, any> | undefined
    switch (event.type) {
      case 'quirky.terminal/layout': {
        const held = this.state.workspace
        if (held && (data?.workspace !== held.id || (typeof data?.revision === 'number' && data.revision <= held.revision))) return
        if (!held && data?.workspace !== this.selector) return
        void this.load(false)
        return
      }
      case 'quirky.session/changed': {
        const session = data?.session as Session | undefined
        if (session && session.worktreeId === this.workspaceId) {
          this.set({ sessions: { ...this.state.sessions, [session.id]: session } })
          void this.load(false)
        }
        return
      }
      case 'quirky.session/removed': {
        const id = data?.sessionId as string | undefined
        if (id !== undefined && id in this.state.sessions) {
          const { [id]: _removed, ...rest } = this.state.sessions
          this.set({ sessions: rest })
          void this.load(false)
        }
        return
      }
      case 'quirky.terminal/cwd': {
        if (typeof data?.sessionId === 'string' && typeof data.cwd === 'string') this.set({ cwds: { ...this.state.cwds, [data.sessionId]: data.cwd } })
        return
      }
      case 'setting.changed': {
        const name = terminalSettingName(event.id)
        if (name !== null) this.settingOverrides[name] = event.value
        this.set({ settings: readWorkspaceSettings(this.context, this.settingOverrides) })
        if (name !== null) void this.load(false)
        return
      }
    }
  }

  // ---- daemon calls

  /** Calls a `quirky.terminal` method and adopts the workspace it returns; null after a failure, which is shown as a toast. */
  private async run(method: string, params: Record<string, unknown>, what: string): Promise<Workspace | null> {
    try {
      const result = (await this.context.call(`${TERMINAL_PREFIX}${method}`, params)) as { workspace?: Workspace } | undefined
      if (this.stopped) return null
      if (result?.workspace) {
        this.apply(result.workspace)
        return result.workspace
      }
      return this.state.workspace
    } catch (error) {
      if (this.stopped) return null
      if (hasCode(error, RpcErrorCode.Conflict)) void this.refresh()
      else this.context.toast(`Could not ${what}`, messageOf(error))
      return null
    }
  }

  /** Takes a workspace from a call result, unless the controller already holds a newer one. */
  private apply(workspace: Workspace): void {
    const held = this.state.workspace
    if (held && workspace.revision < held.revision) return
    this.set({ workspace, status: 'ready', preview: null })
    this.afterWorkspace(workspace)
  }

  private get ws(): Workspace | null {
    return this.state.workspace
  }

  // ---- panes: handles and state

  registerHandle(paneId: string, handle: TerminalPaneHandle | null): void {
    if (handle) this.handles.set(paneId, handle)
    else this.handles.delete(paneId)
  }

  setPaneState(paneId: string, report: PaneReport): void {
    this.set({ paneStates: { ...this.state.paneStates, [paneId]: report } })
  }

  private handleOf(paneId?: string): TerminalPaneHandle | undefined {
    const target = paneId ?? (this.ws ? focusedPaneOf(this.ws)?.leaf.id : undefined)
    return target === undefined ? undefined : this.handles.get(target)
  }

  /** Gives keyboard focus back to the focused pane after the layout changed under it; a text field that holds focus keeps it. */
  refocus(): void {
    const { menu, dialog, rename } = this.state
    if (menu || dialog || rename || !this.ws) return
    const active = this.root?.ownerDocument.activeElement
    if (active && active !== this.root?.ownerDocument.body && !this.root?.contains(active)) return
    if (active && isEditableControl(active)) return
    this.handleOf()?.focus()
  }

  // ---- layout actions

  /** Opens a tab, in `group` or the active group. */
  async newTab(spec: { group?: string; agent?: string; prompt?: string; cwd?: string; title?: string } = {}): Promise<void> {
    await this.run('newTab', { workspace: this.workspaceId, ...spec }, 'open a tab')
  }

  async activateTab(tabId: string): Promise<void> {
    const loc = this.ws ? locateTab(this.ws, tabId) : null
    if (!loc) return
    if (loc.group.activeTab === tabId && this.ws!.activeGroup === loc.group.id) return
    await this.run('activateTab', { tab: tabId }, 'switch tabs')
  }

  async selectTab(index: number): Promise<void> {
    const at = this.ws ? focusedTabOf(this.ws) : null
    if (!at || !Number.isInteger(index) || index < 1 || index > at.group.tabs.length) return
    await this.run('activateTab', { workspace: this.workspaceId, index }, 'switch tabs')
  }

  async nextTab(): Promise<void> {
    await this.run('activateTab', { workspace: this.workspaceId, offset: 1, order: 'position' }, 'switch tabs')
  }

  async previousTab(): Promise<void> {
    await this.run('activateTab', { workspace: this.workspaceId, offset: -1, order: 'position' }, 'switch tabs')
  }

  async reopenTab(): Promise<void> {
    try {
      const result = (await this.context.call(`${TERMINAL_PREFIX}reopenTab`, { workspace: this.workspaceId })) as { workspace?: Workspace }
      if (result?.workspace) this.apply(result.workspace)
    } catch (error) {
      if (hasCode(error, RpcErrorCode.NotFound)) this.context.toast('No closed tab to reopen', 'Tabs that went away with their shell are not remembered.')
      else this.context.toast('Could not reopen the tab', messageOf(error))
    }
  }

  async setTabColor(tabId: string, color: string): Promise<void> {
    await this.run('setTabColor', { tab: tabId, color }, 'set the tab colour')
  }

  async pinTab(tabId: string, pinned: boolean): Promise<void> {
    await this.run('pinTab', { tab: tabId, pinned }, pinned ? 'pin the tab' : 'unpin the tab')
  }

  /** Moves a tab to `index` of a group (the end when omitted); it becomes that group's active tab. */
  async moveTabToGroup(tabId: string, group: string, index?: number): Promise<void> {
    await this.run('moveTab', { tab: tabId, group, ...(index === undefined ? {} : { index }) }, 'move the tab')
  }

  /** Moves a tab into a new group opened on `side` of group `of`. */
  async moveTabToSplit(tabId: string, side: 'right' | 'left' | 'down' | 'up', of?: string): Promise<void> {
    await this.run('moveTab', { tab: tabId, split: side, ...(of === undefined ? {} : { of }) }, 'move the tab')
  }

  async closeGroup(group: string): Promise<void> {
    await this.run('closeGroup', { group }, 'close the split')
  }

  private activePaneId(): string | null {
    return this.ws ? (focusedPaneOf(this.ws)?.leaf.id ?? null) : null
  }

  private resolvePane(paneId?: string): string | null {
    return paneId ?? this.activePaneId()
  }

  async splitPane(direction: 'right' | 'down', paneId?: string): Promise<void> {
    const pane = this.resolvePane(paneId)
    if (pane) await this.run('splitPane', { pane, direction }, 'split the pane')
  }

  splitRight(paneId?: string): Promise<void> {
    return this.splitPane('right', paneId)
  }

  splitDown(paneId?: string): Promise<void> {
    return this.splitPane('down', paneId)
  }

  async focusPane(paneId: string): Promise<void> {
    const ws = this.ws
    const loc = ws ? locatePane(ws, paneId) : null
    if (!ws || !loc) return
    const shown = loc.tab.expandedPane === null || loc.tab.expandedPane === paneId
    if (loc.tab.activePane === paneId && loc.group.activeTab === loc.tab.id && ws.activeGroup === loc.group.id && shown) return
    await this.run('focusPane', { pane: paneId }, 'focus the pane')
  }

  private async cycleFocus(offset: 1 | -1): Promise<void> {
    const at = this.ws ? focusedTabOf(this.ws) : null
    if (at) await this.run('focusPane', { tab: at.tab.id, offset }, 'focus the pane')
  }

  focusNext(): Promise<void> {
    return this.cycleFocus(1)
  }

  focusPrevious(): Promise<void> {
    return this.cycleFocus(-1)
  }

  /** Expands the focused pane to fill its tab, or collapses an expanded one; nothing happens with a single pane. */
  async toggleExpand(paneId?: string): Promise<void> {
    const loc = this.ws ? (paneId ? locatePane(this.ws, paneId) : focusedPaneOf(this.ws)) : null
    if (!loc || paneLeaves(loc.tab.root).length < 2) return
    await this.run('expandPane', { pane: loc.leaf.id, expanded: loc.tab.expandedPane === null }, 'expand the pane')
  }

  async equalize(tabId?: string): Promise<void> {
    const at = this.ws ? focusedTabOf(this.ws) : null
    const tab = tabId ?? at?.tab.id
    const loc = tab && this.ws ? locateTab(this.ws, tab) : null
    if (loc && paneLeaves(loc.tab.root).length > 1) await this.run('equalize', { tab: loc.tab.id }, 'equalize the panes')
  }

  async clearPane(paneId?: string): Promise<void> {
    const pane = this.resolvePane(paneId)
    if (pane) await this.run('clearPane', { pane }, 'clear the screen')
  }

  async resetPane(paneId?: string): Promise<void> {
    const pane = this.resolvePane(paneId)
    if (pane) await this.run('resetPane', { pane }, 'reset the terminal')
  }

  async restartPane(paneId: string): Promise<void> {
    await this.run('restartPane', { pane: paneId }, 'restart the terminal')
  }

  async clearTitle(paneId?: string): Promise<void> {
    const pane = this.resolvePane(paneId)
    if (pane) await this.run('setPaneTitle', { pane, title: '' }, 'clear the title')
  }

  /** Opens the inline title field in the header of a pane (the focused one by default), focusing it first. */
  async setTitle(paneId?: string): Promise<void> {
    const pane = this.resolvePane(paneId)
    if (!pane) return
    await this.focusPane(pane)
    this.set({ rename: { kind: 'pane', id: pane }, menu: null })
  }

  /** Opens the inline rename field on a tab (the active one by default). */
  renameTab(tabId?: string): void {
    const tab = tabId ?? (this.ws ? focusedTabOf(this.ws)?.tab.id : undefined)
    if (tab) this.set({ rename: { kind: 'tab', id: tab }, menu: null })
  }

  /** Ends the inline field; a changed value is sent, an unchanged one is not. */
  async commitRename(value: string): Promise<void> {
    const rename = this.state.rename
    if (!rename) return
    this.set({ rename: null })
    const ws = this.ws
    if (!ws) return
    if (rename.kind === 'tab') {
      const loc = locateTab(ws, rename.id)
      if (!loc) return
      const current = loc.tab.customTitle ?? displayTitle(loc.tab)
      if (value.trim() === current) return
      await this.run('renameTab', { tab: rename.id, title: value }, 'rename the tab')
    } else {
      const loc = locatePane(ws, rename.id)
      if (!loc || value.trim() === (loc.leaf.title ?? '')) return
      await this.run('setPaneTitle', { pane: rename.id, title: value }, 'set the title')
    }
  }

  cancelRename(): void {
    if (this.state.rename) this.set({ rename: null })
  }

  /** Moves a pane beside another pane of its tab, or into another tab. */
  async movePane(paneId: string, to: PaneDropTarget): Promise<void> {
    const params = to.kind === 'edge' ? { pane: paneId, toPane: to.pane, edge: to.edge } : { pane: paneId, toTab: to.tab }
    await this.run('movePane', params, 'move the pane')
  }

  // ---- closing

  /**
   * Starts closing something: asks first when it is pinned or has a command or agent running
   * (each question can be turned off in settings), then calls the destructive method with
   * `yes: true`. A request that follows a confirmed close by less than 350 ms is dropped.
   */
  async requestClose(target: CloseTarget): Promise<void> {
    if (Date.now() < this.guardUntil) return
    const current = this.state.dialog
    if (current && (current.kind === 'close-running' || current.kind === 'close-pinned')) return
    const ws = this.ws
    if (!ws) return
    if (target.kind === 'tab') {
      const loc = locateTab(ws, target.tab)
      if (!loc) return
      if (loc.tab.pinned && this.state.settings['confirm-close-pinned']) {
        this.set({ dialog: { kind: 'close-pinned', title: 'Close pinned tab?', target, tabLabel: displayTitle(loc.tab), notBefore: 0 }, menu: null })
        return
      }
    }
    await this.askRunning(target, 0)
  }

  private closeParams(target: CloseTarget): Record<string, unknown> {
    if (target.kind === 'tab') return { tab: target.tab }
    if (target.kind === 'pane') return { pane: target.pane }
    return { tab: target.tab, which: target.which }
  }

  private tabLabelOf(target: CloseTarget): string {
    const ws = this.ws
    if (!ws) return ''
    const loc = target.kind === 'pane' ? locatePane(ws, target.pane) : locateTab(ws, target.tab)
    return loc ? displayTitle(loc.tab) : ''
  }

  private async askRunning(target: CloseTarget, notBefore: number): Promise<void> {
    let question: string | null
    try {
      question = (await this.context.call(`${TERMINAL_PREFIX}describeClose`, this.closeParams(target))) as string | null
    } catch (error) {
      this.context.toast('Could not close', messageOf(error))
      return
    }
    if (this.stopped) return
    if (typeof question === 'string' && question !== '' && this.state.settings['confirm-close-running']) {
      const agent = isAgentQuestion(question)
      this.set({
        menu: null,
        dialog: { kind: 'close-running', title: agent ? 'Stop this agent?' : 'Stop running command?', target, tabLabel: this.tabLabelOf(target), agent, notBefore }
      })
      return
    }
    await this.execClose(target)
  }

  private async execClose(target: CloseTarget): Promise<void> {
    const params = { ...this.closeParams(target), yes: true }
    const hadTabs = this.ws !== null && hasTabs(this.ws)
    let after: Workspace | null
    if (target.kind === 'tab') after = await this.run('closeTab', params, 'close the tab')
    else if (target.kind === 'pane') after = await this.run('closePane', params, 'close the pane')
    else after = await this.run('closeTabs', params, 'close the tabs')
    if (hadTabs && after && !hasTabs(after)) await this.minimizeFloating()
  }

  /** Minimizes the floating panel; nothing happens in a worktree's workspace. */
  private async minimizeFloating(): Promise<void> {
    if (this.floating && !this.stopped) await this.context.call(`${TERMINAL_PREFIX}setFloating`, { open: false }).catch(() => {})
  }

  private async setBooleanSetting(name: string, value: boolean): Promise<void> {
    this.settingOverrides[name] = value
    this.set({ settings: readWorkspaceSettings(this.context, this.settingOverrides) })
    try {
      await this.context.call('setting.set', { id: `${SETTING_PREFIX}${name}`, value })
    } catch (error) {
      this.context.toast('Could not save the setting', messageOf(error))
    }
  }

  /** Answers the open close dialog; a click inside the double-request guard is ignored. */
  async answerCloseDialog(confirmed: boolean, dontAskAgain = false): Promise<void> {
    const dialog = this.state.dialog
    if (!dialog || (dialog.kind !== 'close-running' && dialog.kind !== 'close-pinned')) return
    if (confirmed && Date.now() < dialog.notBefore) return
    this.set({ dialog: null })
    if (!confirmed) return
    this.guardUntil = Date.now() + DOUBLE_REQUEST_GUARD_MS
    if (dontAskAgain) await this.setBooleanSetting(dialog.kind === 'close-running' ? 'confirm-close-running' : 'confirm-close-pinned', false)
    if (dialog.kind === 'close-pinned') await this.askRunning(dialog.target, Date.now() + DOUBLE_REQUEST_GUARD_MS)
    else await this.execClose(dialog.target)
  }

  closeTab(tabId: string): Promise<void> {
    return this.requestClose({ kind: 'tab', tab: tabId })
  }

  closePane(paneId: string): Promise<void> {
    return this.requestClose({ kind: 'pane', pane: paneId })
  }

  closeTabs(tabId: string, which: 'others' | 'right' | 'left'): Promise<void> {
    return this.requestClose({ kind: 'tabs', tab: tabId, which })
  }

  /** Closes the focused pane of a split tab, else the focused tab; with nothing open a floating workspace minimizes. */
  async closeFocused(): Promise<void> {
    const at = this.ws ? focusedPaneOf(this.ws) : null
    if (!at) {
      await this.minimizeFloating()
      return
    }
    if (paneLeaves(at.tab.root).length > 1) await this.requestClose({ kind: 'pane', pane: at.leaf.id })
    else await this.requestClose({ kind: 'tab', tab: at.tab.id })
  }

  // ---- tab switcher

  /** Opens the Ctrl+Tab list with the previously used tab highlighted, or moves down it when it is open. */
  recentTab(): void {
    const dialog = this.state.dialog
    if (dialog?.kind === 'switch-tabs') {
      this.stepSwitcher(1)
      return
    }
    const at = this.ws ? focusedTabOf(this.ws) : null
    if (!at) return
    const order = switcherOrder(at.group, this.state.settings['ctrl-tab-order'])
    if (order.length < 2) return
    const index = (Math.max(order.indexOf(at.tab.id), 0) + 1) % order.length
    this.set({ dialog: { kind: 'switch-tabs', title: 'Switch tabs', group: at.group.id, order, index }, menu: null })
  }

  stepSwitcher(direction: 1 | -1): void {
    const dialog = this.state.dialog
    if (dialog?.kind !== 'switch-tabs') return
    this.set({ dialog: { ...dialog, index: (dialog.index + direction + dialog.order.length) % dialog.order.length } })
  }

  setSwitcherIndex(index: number): void {
    const dialog = this.state.dialog
    if (dialog?.kind === 'switch-tabs') this.set({ dialog: { ...dialog, index } })
  }

  /** Closes the Ctrl+Tab list, activating the highlighted tab when `activate` is set. */
  async endSwitcher(activate: boolean): Promise<void> {
    const dialog = this.state.dialog
    if (dialog?.kind !== 'switch-tabs') return
    this.set({ dialog: null })
    const tab = dialog.order[dialog.index]
    if (activate && tab !== undefined) await this.activateTab(tab)
  }

  // ---- menus

  /** Opens a menu on a tab (`tab`), a pane (`pane`), a group's `+` (`plus`) or `…` (`actions`), or an extra menu; at a screen position or beside its target. */
  openMenu(kind: string, target?: string | null, at?: { x: number; y: number }): void {
    const resolved = target ?? this.defaultTarget(kind)
    const position = at ?? this.anchorOf(kind, resolved)
    if (kind === 'plus') void this.loadAgents()
    this.set({ menu: { kind, target: resolved, x: position.x, y: position.y, query: '' }, rename: null })
  }

  closeMenu(): void {
    if (this.state.menu) this.set({ menu: null })
  }

  setMenuQuery(query: string): void {
    if (this.state.menu) this.set({ menu: { ...this.state.menu, query } })
  }

  private defaultTarget(kind: string): string | null {
    const ws = this.ws
    if (!ws) return null
    if (kind === 'tab') return focusedTabOf(ws)?.tab.id ?? null
    if (kind === 'pane') return this.activePaneId()
    if (kind === 'plus' || kind === 'actions') return ws.activeGroup
    return null
  }

  private anchorOf(kind: string, target: string | null): { x: number; y: number } {
    const selector = kind === 'tab' ? `[data-tab="${target}"]` : kind === 'pane' ? `[data-pane="${target}"]` : kind === 'plus' ? `[data-plus="${target}"]` : kind === 'actions' ? `[data-actions="${target}"]` : '[data-qt-root]'
    const rect = this.root?.querySelector(selector)?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return kind === 'pane' ? { x: rect.left + 8, y: rect.top + 8 } : { x: rect.left, y: rect.bottom }
  }

  /** The rows of the open menu, in display order. */
  menuItems(): MenuItem[] {
    const menu = this.state.menu
    if (!menu) return []
    switch (menu.kind) {
      case 'tab':
        return menu.target ? this.tabMenuItems(menu.target) : []
      case 'pane':
        return menu.target ? this.paneMenuItems(menu.target) : []
      case 'plus':
        return this.plusItems(menu.target, menu.query)
      case 'actions':
        return menu.target ? this.actionItems(menu.target) : []
      default:
        return this.options.extraMenus?.[menu.kind]?.(menu.target) ?? []
    }
  }

  private async copyText(text: string): Promise<void> {
    try {
      await writeClipboard(text)
    } catch (error) {
      this.context.toast('Could not copy', messageOf(error))
    }
  }

  private tabMenuItems(tabId: string): MenuItem[] {
    const ws = this.ws
    const loc = ws ? locateTab(ws, tabId) : null
    if (!ws || !loc) return []
    const { group, tab } = loc
    const index = group.tabs.findIndex((entry) => entry.id === tabId)
    const sides: ['Right' | 'Left' | 'Down' | 'Up', 'right' | 'left' | 'down' | 'up'][] = [['Right', 'right'], ['Left', 'left'], ['Down', 'down'], ['Up', 'up']]
    const items: MenuItem[] = [
      {
        label: 'Move Tab to Split',
        enabled: group.tabs.length > 1,
        submenu: sides.map(([label, side]) => ({ label, onSelect: () => void this.moveTabToSplit(tabId, side, group.id) }))
      },
      {
        label: 'Split Terminal',
        submenu: [
          { label: 'Right', onSelect: () => void this.splitRight(tab.activePane) },
          { label: 'Down', onSelect: () => void this.splitDown(tab.activePane) }
        ]
      },
      { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', onSelect: () => void this.pinTab(tabId, !tab.pinned) },
      { label: 'Copy Tab ID', onSelect: () => void this.copyText(tabId) },
      { label: 'Close', key: '⌘W', onSelect: () => void this.closeTab(tabId) },
      { label: 'Close Others', enabled: group.tabs.length > 1, onSelect: () => void this.closeTabs(tabId, 'others') },
      { label: 'Close All Tabs To The Right', enabled: index < group.tabs.length - 1, onSelect: () => void this.closeTabs(tabId, 'right') },
      { label: 'Close All Tabs To The Left', enabled: index > 0, onSelect: () => void this.closeTabs(tabId, 'left') },
      { label: 'Change Title', key: '⌘R', onSelect: () => this.renameTab(tabId) },
      {
        label: 'Tab Color',
        submenu: TAB_COLORS.map((color) => ({
          label: color === 'none' ? 'None' : color[0]!.toUpperCase() + color.slice(1),
          ...(color === 'none' ? {} : { swatch: TAB_COLOR_HEX[color] }),
          checked: tab.color === color,
          onSelect: () => void this.setTabColor(tabId, color)
        }))
      }
    ]
    if (ws.root.kind === 'split') items.push({ label: 'Close Split Pane', onSelect: () => void this.closeGroup(group.id) })
    return items
  }

  private paneMenuItems(paneId: string): MenuItem[] {
    const ws = this.ws
    const loc = ws ? locatePane(ws, paneId) : null
    if (!ws || !loc) return []
    const { tab, leaf } = loc
    const split = paneLeaves(tab.root).length > 1
    const quick = this.options.paneMenuExtras?.(leaf) ?? []
    const items: MenuItem[] = [
      { label: 'Copy', key: '⌘C', onSelect: () => this.copy(paneId) },
      { label: 'Select All', key: '⌘A', onSelect: () => this.selectAll(paneId) },
      { label: 'Paste', key: '⌘V', onSelect: () => void this.pasteFromClipboard(paneId) },
      { label: 'Quick Commands', submenu: quick.length > 0 ? quick : [{ label: 'No quick commands', enabled: false }] },
      SEPARATOR,
      { label: 'Split Terminal Right', key: '⌘D', onSelect: () => void this.splitRight(paneId) },
      { label: 'Split Terminal Down', key: '⌘⇧D', onSelect: () => void this.splitDown(paneId) }
    ]
    if (split) {
      items.push(
        { label: 'Equalize Pane Sizes', onSelect: () => void this.equalize(tab.id) },
        { label: tab.expandedPane === null ? 'Expand Pane' : 'Collapse Pane', key: '⌘⇧Enter', onSelect: () => void this.toggleExpand(paneId) }
      )
    }
    items.push(SEPARATOR, { label: 'Set Title…', onSelect: () => void this.setTitle(paneId) })
    if (leaf.title) items.push({ label: 'Clear Pane Title', onSelect: () => void this.clearTitle(paneId) })
    items.push(
      { label: 'Copy Terminal ID', onSelect: () => void this.copyText(leaf.session) },
      { label: 'Copy Pane ID', onSelect: () => void this.copyText(paneId) }
    )
    if (split) items.push({ label: 'Close Pane', key: '⌘W', danger: true, onSelect: () => void this.closePane(paneId) })
    items.push(
      SEPARATOR,
      { label: 'Clear Screen', key: '⌘K', onSelect: () => void this.clearPane(paneId) },
      { label: 'Reset Terminal', onSelect: () => void this.resetPane(paneId) }
    )
    return items
  }

  private plusItems(groupId: string | null, query: string): MenuItem[] {
    const group = groupId && this.ws ? findGroup(this.ws.root, groupId) : null
    const target = group?.id
    const rows: MenuItem[] = filterEntries(this.state.agents, query).map((entry) => ({
      label: entry.label,
      key: entry.kind === 'terminal' ? '⌘T' : null,
      onSelect: () => this.chooseEntry(entry, target)
    }))
    const needle = query.trim().toLowerCase()
    if (needle !== '' && this.ws) {
      for (const candidate of groupsInOrder(this.ws.root)) {
        for (const tab of candidate.tabs) {
          const title = displayTitle(tab)
          if (title.toLowerCase().includes(needle)) rows.push({ label: title, onSelect: () => void this.activateTab(tab.id) })
        }
      }
    }
    return rows
  }

  private actionItems(groupId: string): MenuItem[] {
    const split = this.ws?.root.kind === 'split'
    return split ? [{ label: 'Close Split Pane', onSelect: () => void this.closeGroup(groupId) }] : []
  }

  private chooseEntry(entry: MenuEntry, group: string | undefined): void {
    if (entry.kind === 'terminal') void this.newTab(group === undefined ? {} : { group })
    else if (entry.kind === 'manage') this.context.openView(AGENTS_VIEW_ID)
    else this.set({ dialog: { kind: 'new-session', title: `New ${entry.request.label} session`, request: entry.request, group: group ?? null } })
  }

  /** Starts the agent session the New Session dialog asked for, or drops the dialog when `prompt` is null. */
  async submitNewSession(prompt: string | null): Promise<void> {
    const dialog = this.state.dialog
    if (dialog?.kind !== 'new-session') return
    this.set({ dialog: null })
    if (prompt === null) return
    const text = prompt.trim()
    const { request, group } = dialog
    if (request.background) {
      try {
        await this.context.call('quirky.structured/create', { worktree: this.workspaceId, agent: request.agent, prompt: text })
      } catch (error) {
        this.context.toast('Could not start session', messageOf(error))
      }
      return
    }
    await this.newTab({ ...(group === null ? {} : { group }), agent: request.agent, ...(text === '' ? {} : { prompt: text }) })
  }

  closeDialog(): void {
    const dialog = this.state.dialog
    if (!dialog) return
    if (dialog.kind === 'switch-tabs') void this.endSwitcher(false)
    else if (dialog.kind === 'close-running' || dialog.kind === 'close-pinned') void this.answerCloseDialog(false)
    else this.set({ dialog: null })
  }

  // ---- pane handle passthroughs

  /** Copies the selection of a pane (the focused one by default) and returns the copied text. */
  copy(paneId?: string): { text: string } {
    return { text: this.handleOf(paneId)?.copy() ?? '' }
  }

  selectAll(paneId?: string): void {
    this.handleOf(paneId)?.selectAll()
  }

  paste(text: string, paneId?: string): Promise<void> {
    return this.handleOf(paneId)?.paste(text) ?? Promise.resolve()
  }

  private async pasteFromClipboard(paneId: string): Promise<void> {
    try {
      const text = await navigator.clipboard?.readText()
      if (text) await this.paste(text, paneId)
    } catch (error) {
      this.context.toast('Could not paste', messageOf(error))
    }
  }

  search(query?: string, options?: SearchOptions, paneId?: string): void {
    this.handleOf(paneId)?.search(query, options)
  }

  searchNext(paneId?: string): void {
    this.handleOf(paneId)?.searchNext()
  }

  searchPrevious(paneId?: string): void {
    this.handleOf(paneId)?.searchPrevious()
  }

  searchClose(paneId?: string): void {
    this.handleOf(paneId)?.searchClose()
  }

  zoomIn(paneId?: string): void {
    this.handleOf(paneId)?.zoomIn()
  }

  zoomOut(paneId?: string): void {
    this.handleOf(paneId)?.zoomOut()
  }

  zoomReset(paneId?: string): void {
    this.handleOf(paneId)?.zoomReset()
  }

  // ---- drags

  /** Marks a divider or panel drag, so panes refit locally and tell their shell the size once it ends. */
  setDragging(dragging: boolean): void {
    if (this.state.dragging !== dragging) this.set({ dragging })
  }

  previewDivider(preview: Preview): void {
    this.set({ preview, dragging: true })
  }

  /** Ends a divider drag with one `resizeSplit` call; the preview stays until the daemon's answer replaces it. */
  async endDividerDrag(preview: Preview | null, changed: boolean): Promise<void> {
    this.set({ dragging: false })
    if (!preview || !changed) {
      this.set({ preview: null })
      return
    }
    const ws = this.ws
    const result = await this.run('resizeSplit', { split: preview.split, ratio: preview.ratio, ...(ws ? { revision: ws.revision } : {}) }, 'resize the split')
    if (!result) this.set({ preview: null })
  }

  /** Puts a divider back at the middle of its pair. */
  async resetDivider(split: string): Promise<void> {
    const ws = this.ws
    await this.run('resizeSplit', { split, ratio: 0.5, ...(ws ? { revision: ws.revision } : {}) }, 'resize the split')
  }

  /** The group tree with a divider drag's ratio applied, for drawing while the pointer moves. */
  previewedRoot(root: GroupNode): GroupNode {
    const preview = this.state.preview
    if (!preview || preview.kind !== 'group') return root
    const result = setGroupRatio(root, preview.split, preview.ratio)
    return result.ok ? result.value : root
  }

  /** A tab's pane tree with a divider drag's ratio applied. */
  previewedPanes(root: PaneNode): PaneNode {
    const preview = this.state.preview
    if (!preview || preview.kind !== 'pane') return root
    const result = setPaneRatio(root, preview.split, preview.ratio)
    return result.ok ? result.value : root
  }

  /** Shows where a pane being dragged by its header would land; null ends the drag. */
  setPaneDrag(drag: { pane: string; target: PaneDropTarget | null } | null): void {
    if (JSON.stringify(this.state.paneDrag) !== JSON.stringify(drag)) this.set({ paneDrag: drag })
  }

  beginTabDrag(tabId: string): void {
    this.set({ tabDrag: { tab: tabId, over: null } })
  }

  overTabDrag(over: TabDrop | null): void {
    const drag = this.state.tabDrag
    if (!drag) return
    const same = JSON.stringify(drag.over) === JSON.stringify(over)
    if (!same) this.set({ tabDrag: { ...drag, over } })
  }

  endTabDrag(): void {
    if (this.state.tabDrag) this.set({ tabDrag: null })
  }

  /** Completes a tab drag: onto a strip position, the middle of a group body, or one of its sides. */
  async dropTab(drop: TabDrop): Promise<void> {
    const drag = this.state.tabDrag
    this.set({ tabDrag: null })
    if (!drag) return
    if (drop.kind === 'strip') await this.moveTabToGroup(drag.tab, drop.group, drop.index)
    else if (drop.zone === 'center') await this.moveTabToGroup(drag.tab, drop.group)
    else await this.moveTabToSplit(drag.tab, drop.zone, drop.group)
  }

  /** Executes one declared UI command after the daemon validates its explicit group target. */
  async dropCommand(transfer: DataTransfer | null, groupId: string): Promise<void> {
    const descriptor = parseCommandDrop(transfer)
    const workspace = this.ws
    if (!descriptor || !workspace || workspace.id === FLOATING_WORKSPACE || !findGroup(workspace.root, groupId)) return
    try {
      const info = await this.context.call('quirky.terminal/groupInfo', { group: groupId })
      const target = info && typeof info === 'object' && 'workspace' in info && typeof info.workspace === 'string' ? info.workspace : null
      const current = this.ws
      if (target === null || target !== workspace.id || current !== workspace || current === null || !findGroup(current.root, groupId)) {
        this.context.toast('Could not run dropped command', 'The target group is no longer available in this worktree.')
        return
      }
      await this.context.executeCommand(descriptor.command, { ...descriptor.args, group: groupId, worktree: target })
    } catch (error) {
      this.context.toast('Could not run dropped command', messageOf(error))
    }
  }

  // ---- report

  /** What `ui state` shows for this workspace. */
  report(): ViewReport {
    const ws = this.ws
    const focused = ws ? focusedPaneOf(ws) : null
    const menu = this.state.menu
    const dialog = this.state.dialog
    return {
      worktree: this.state.status === 'missing' ? null : this.workspaceId,
      active: focused?.leaf.session ?? null,
      tabs: ws ? tabsReport(ws, this.state.sessions) : [],
      visibleSessions: ws ? visibleSessionsOf(ws) : [],
      layout: ws,
      focusedPane: focused?.leaf.id ?? null,
      panes: ws ? panesReport(ws, this.state.paneStates, this.state.settings['font-size']) : [],
      menu: menu
        ? {
            kind: menu.kind,
            target: menu.target,
            items: this.menuItems().map((item) => ({ label: item.label, key: item.key ?? null, enabled: item.enabled !== false && !item.separator, separator: item.separator === true }))
          }
        : null,
      dialog: dialog ? { kind: dialog.kind, title: dialog.title } : null
    }
  }

  private publish(): void {
    if (!this.onReport || this.state.status === 'loading' || this.stopped) return
    const report = this.report()
    const text = JSON.stringify(report)
    if (text === this.lastReport) return
    this.lastReport = text
    this.onReport(report)
  }
}
