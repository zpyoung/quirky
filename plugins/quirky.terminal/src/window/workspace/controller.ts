import type { ReactNode } from 'react'
import { RpcErrorCode, type QuirkyEvent, type Session, type UiMenuItemEntry, type UiPluginContext } from '@quirky/protocol'
import { CONTEXT_MENU_SEPARATOR, type ContextMenuItem } from '@quirky/ui'
import { displayTitle } from '../../layout/titles'
import { findGroup, groupsInOrder, paneLeaves, setGroupRatio, setPaneRatio } from '../../layout/tree'
import type { DropZone } from '../../layout/tree'
import { FLOATING_WORKSPACE, isTerminalTab, isViewTab, TAB_COLOR_HEX, TAB_COLORS } from '../../layout/types'
import type { Edge, Group, GroupNode, PaneLeaf, PaneNode, Tab, Workspace } from '../../layout/types'
import type { PaneReport, SearchOptions, TerminalPaneHandle, TerminalPaneProps } from '../pane/TerminalPaneView'
import type { DockState } from '../dock/types'
import { AGENTS_VIEW_ID, TERMINAL_ONLY_MENU, filterEntries, loadMenuEntries, type MenuEntry } from './menuEntries'
import { focusedController } from './registry'
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
const EDITOR_VIEW_ID = 'view:quirky.editor/document'

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
  | { kind: 'new-session'; title: string; request: NewSessionRequest; group: string | null; pending?: boolean; error?: string | null; startedSession?: Session }

export type PaneDropTarget = { kind: 'edge'; pane: string; edge: Edge } | { kind: 'tab'; tab: string }

/** A drag in flight: the divider preview, a pane being moved, or a tab being moved. */
export type Preview = { kind: 'pane' | 'group'; split: string; ratio: number }
export type TabDrop = { kind: 'zone'; group: string; zone: DropZone } | { kind: 'strip'; group: string; index: number }

export type ControllerState = {
  status: 'loading' | 'ready' | 'missing' | 'error'
  selectionError: string | null
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
  focusFlash: { pane: string; token: number } | null
  paneStates: Readonly<Record<string, PaneReport>>
  dockStates: Readonly<Record<string, DockState>>
  dockHosts: Readonly<Record<string, DockHostState>>
  tabDrag: { tab: string; over: TabDrop | null } | null
  paneDrag: { pane: string; target: PaneDropTarget | null } | null
}
type DockHostState = { mounted: boolean; focused: boolean; composerFocused: boolean }

export type MenuContributionItem = ContextMenuItem & Pick<UiMenuItemEntry, 'after'>
/** The slots and switches a host of the workspace can set. */
export type WorkspaceOptions = {
  /** `floating` mounts the floating workspace: no tab is created for it, and closing its last tab minimizes the panel. */
  workspace?: 'floating'
  /** Rendered after the `+` button of each group's strip. */
  stripExtras?: (group: Group) => ReactNode
  /** Quick-command rows supplied by the terminal host for this pane. */
  paneMenuExtras?: (pane: PaneLeaf) => ContextMenuItem[]
  /** Rows other plugins contribute to the pane menu, shown right after the Quick Commands row. */
  paneMenuContributions?: (pane: PaneLeaf, session: Session | undefined) => ContextMenuItem[]
  /** After-placed tab rows are searchable; unplaced rows are static, before Agent settings. */
  tabMenuContributions?: (group: Group, workspace: string) => MenuContributionItem[]
  /** The public menu contribution list changes, keeping an open + menu current. */
  subscribeMenuContributions?: (listener: () => void) => () => void
  /** Effective user-remappable shortcut labels; null hides disabled or shadowed commands. */
  shortcutKey?: (command: string) => string | null
  /** Menus beyond `tab`, `pane`, `plus` and `actions`, opened by `openMenu(kind, target)`. */
  extraMenus?: Record<string, (target: string | null) => ContextMenuItem[]>
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
  /** Whether the active document element is inside this view's root. */
  focused?: boolean
  /** The window-local sequence when this view last gained focus; zero if it has never been focused. */
  focusSequence?: number
  panes: PaneStateReport[]
  /** Mounted terminal accessory contribution IDs by pane ID. */
  mountedAccessories: Record<string, string[]>
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

/** The MIME type identifies a host-minted one-use token; dragover checks only its presence. */
export const COMMAND_DROP_MIME = 'application/x-quirky-command'

export function hasCommandDrop(transfer: DataTransfer | null | undefined): transfer is DataTransfer {
  return transfer !== null && transfer !== undefined && Array.from(transfer.types).includes(COMMAND_DROP_MIME)
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
  private rootElement: HTMLElement | null = null
  private dockContextEligible: boolean | undefined
  private dockContextMounted: boolean | undefined
  private dockContextFocus: boolean | undefined
  private rootWasFocused = false
  private focusSequence = 0
  private onRootFocusChange = () =>
    queueMicrotask(() => {
      const focusWithin = this.hasRootFocus()
      if (focusWithin && !this.rootWasFocused) this.focusSequence = ++windowFocusSequence
      this.rootWasFocused = focusWithin
      this.updateDockContexts()
      this.publish()
    })
  private state: ControllerState
  private listeners = new Set<() => void>()
  private handles = new Map<string, TerminalPaneHandle>()
  private pendingFocusPane: string | null = null
  private focusFlashToken = 0
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
  private mountedAccessories: Record<string, string[]> = {}
  /** Receives the view report whenever it changes. */
  onReport: ((report: ViewReport) => void) | null = null

  get root(): HTMLElement | null {
    return this.rootElement
  }

  set root(element: HTMLElement | null) {
    if (this.rootElement === element) return
    this.rootElement?.removeEventListener('focusin', this.onRootFocusChange, true)
    this.rootElement?.removeEventListener('focusout', this.onRootFocusChange, true)
    this.rootElement = element
    this.rootElement?.addEventListener('focusin', this.onRootFocusChange, true)
    this.rootElement?.addEventListener('focusout', this.onRootFocusChange, true)
    this.rootWasFocused = this.hasRootFocus()
    if (this.rootWasFocused) this.focusSequence = ++windowFocusSequence
    this.updateDockContexts()
  }

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
      selectionError: null,
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
      dockStates: {},
      dockHosts: {},
      focusFlash: null,
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
    this.updateDockContexts()
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
    const unsubscribeMenuContributions = this.options.subscribeMenuContributions?.(() => {
      if (this.state.menu?.kind === 'plus') this.set({})
    })
    if (unsubscribeMenuContributions) this.unsubscribes.push(unsubscribeMenuContributions)
    this.set({ settings: readWorkspaceSettings(this.context, this.settingOverrides) })
    void this.load(!this.floating && this.startSession === undefined)
  }

  stop(): void {
    this.stopped = true
    this.pendingFocusPane = null
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.listeners.clear()
    this.handles.clear()
    if (dockContextOwner === this) {
      dockContextOwner = null
      this.writeDockContextValues(false, false, false)
    }
    this.rootElement?.removeEventListener('focusin', this.onRootFocusChange, true)
    this.rootElement?.removeEventListener('focusout', this.onRootFocusChange, true)
    this.rootElement = null
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
      void this.openRequestedSession(workspace, this.startSession)
    }
    const unknown = groupsInOrder(workspace.root).some((group) =>
      group.tabs.some((tab) => isTerminalTab(tab) && paneLeaves(tab.root).some((leaf) => !this.state.sessions[leaf.session]))
    )
    if (unknown) void this.reloadSessions()
  }

  private async openRequestedSession(workspace: Workspace, sessionId: string): Promise<void> {
    let session = this.state.sessions[sessionId]
    if (!session) {
      try {
        session = (await this.context.call('quirky.session/get', { session: sessionId })) as Session
      } catch (error) {
        if (this.stopped) return
        const message = hasCode(error, RpcErrorCode.NotFound)
          ? `Session ${sessionId} was not found.`
          : `Could not open session ${sessionId}: ${messageOf(error)}`
        this.set({ selectionError: message })
        return
      }
    }
    if (this.stopped) return
    if (session.worktreeId !== workspace.id) {
      this.set({ selectionError: `Session ${sessionId} belongs to a different worktree.` })
      return
    }

    this.set({ sessions: { ...this.state.sessions, [sessionId]: session }, selectionError: null })
    const current = this.ws ?? workspace
    const existing = locateSession(current, sessionId)
    if (existing) {
      await this.focusRequestedSession(current, sessionId)
      return
    }

    const group = groupsInOrder(current.root)[0]
    if (!group) {
      this.set({ selectionError: `No workspace group is available for session ${sessionId}.` })
      return
    }

    let result: { workspace?: Workspace } | undefined
    try {
      result = (await this.context.call(`${TERMINAL_PREFIX}adoptSession`, { group: group.id, session: sessionId })) as
        | { workspace?: Workspace }
        | undefined
    } catch (error) {
      if (this.stopped) return
      this.set({ selectionError: `Could not open session ${sessionId}: ${messageOf(error)}` })
      return
    }
    if (this.stopped) return
    if (!result?.workspace) {
      this.set({ selectionError: `Could not open session ${sessionId}.` })
      return
    }
    this.apply(result.workspace)
    const adopted = locateSession(this.ws ?? result.workspace, sessionId)
    if (!adopted) {
      this.set({ selectionError: `Could not select session ${sessionId}.` })
      return
    }
    await this.focusRequestedSession(this.ws ?? result.workspace, sessionId)
  }

  private async focusRequestedSession(workspace: Workspace, sessionId: string): Promise<void> {
    const loc = locateSession(workspace, sessionId)
    if (!loc) {
      this.set({ selectionError: `Could not select session ${sessionId}.` })
      return
    }
    const shown = loc.tab.expandedPane === null || loc.tab.expandedPane === loc.leaf.id
    if (
      loc.tab.activePane === loc.leaf.id &&
      loc.group.activeTab === loc.tab.id &&
      workspace.activeGroup === loc.group.id &&
      shown
    ) {
      return
    }
    const focused = await this.run('focusPane', { pane: loc.leaf.id }, 'select the session')
    if (!focused && !this.stopped) this.set({ selectionError: `Could not select session ${sessionId}.` })
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
    if (this.pendingFocusPane !== null && !locatePane(workspace, this.pendingFocusPane)) this.pendingFocusPane = null
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

  setDockState(paneId: string, dock: DockState): void {
    const previous = this.state.dockStates[paneId]
    if (
      previous &&
      previous.revision === dock.revision &&
      previous.gutterRows === dock.gutterRows &&
      previous.agent === dock.agent &&
      previous.userUndocked === dock.userUndocked &&
      previous.enabled === dock.enabled &&
      previous.supported === dock.supported &&
      previous.docked === dock.docked &&
      previous.mounted === dock.mounted &&
      previous.passthrough === dock.passthrough
    ) {
      return
    }
    this.set({ dockStates: { ...this.state.dockStates, [paneId]: dock } })
  }

  clearDockState(paneId: string): void {
    if (!(paneId in this.state.dockStates)) return
    const { [paneId]: _dock, ...dockStates } = this.state.dockStates
    this.set({ dockStates })
  }

  setDockHostState(paneId: string, mounted: boolean, focused: boolean, composerFocused: boolean): void {
    const previous = this.state.dockHosts[paneId]
    if (previous?.mounted === mounted && previous.focused === focused && previous.composerFocused === composerFocused) return
    this.set({ dockHosts: { ...this.state.dockHosts, [paneId]: { mounted, focused, composerFocused } } })
  }

  clearDockHostState(paneId: string): void {
    if (!(paneId in this.state.dockHosts)) return
    const { [paneId]: _host, ...dockHosts } = this.state.dockHosts
    this.set({ dockHosts })
  }
  canFocusDock(paneId: string): boolean {
    const document = this.root?.ownerDocument
    // Closing a pane menu temporarily returns focus to body; retain its known owner, not a background pane.
    const transientBodyFocus = document?.activeElement === document?.body && this.focusSequence > 0 && focusedController() === this
    return (this.hasRootFocus() || transientBodyFocus) && this.ws !== null && focusedPaneOf(this.ws)?.leaf.id === paneId
  }

  private handleOf(paneId?: string): TerminalPaneHandle | undefined {
    const target = paneId ?? (this.ws ? focusedPaneOf(this.ws)?.leaf.id : undefined)
    return target === undefined ? undefined : this.handles.get(target)
  }

  /** Completes a queued terminal focus after the active pane view has mounted. */
  focusPendingPane(paneId: string): void {
    if (this.pendingFocusPane !== paneId) return
    const handle = this.handleOf(paneId)
    if (!handle) return
    this.pendingFocusPane = null
    handle.focus()
    handle.scrollToBottom()
  }

  /** Gives keyboard focus back to the focused pane after the layout changed under it; a text field or dock owner keeps it. */
  refocus(): void {
    const { menu, dialog, rename } = this.state
    if (menu || dialog || rename || !this.ws) return
    const pane = focusedPaneOf(this.ws)?.leaf.id
    const dock = pane ? this.state.dockStates[pane] : undefined
    const host = pane ? this.state.dockHosts[pane] : undefined
    if (dock?.enabled && dock.supported && dock.docked && dock.mounted && host?.mounted && !dock.passthrough) return
    const active = this.root?.ownerDocument.activeElement
    if (this.floating && (!active || active === this.root?.ownerDocument.body)) return
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
    if (loc.group.activeTab === tabId && this.ws!.activeGroup === loc.group.id) {
      const { menu, dialog, rename } = this.state
      if (menu || dialog || rename) return
      const pane = this.activePaneId()
      const dock = pane ? this.state.dockStates[pane] : undefined
      const host = pane ? this.state.dockHosts[pane] : undefined
      if (pane && dock?.enabled && dock.supported && dock.docked && dock.mounted && host?.mounted && !dock.passthrough) {
        try {
          await this.context.executeCommand('command:quirky.terminal-dock/focus', { pane })
        } catch (error) {
          this.context.toast('Could not focus agent composer', messageOf(error))
        }
      } else if (pane) this.handleOf(pane)?.focus()
      return
    }
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

  async promoteViewTab(tabId: string): Promise<void> {
    const loc = this.ws ? locateTab(this.ws, tabId) : null
    if (!loc || !isViewTab(loc.tab) || !loc.tab.preview) return
    const bufferId = loc.tab.viewId === EDITOR_VIEW_ID ? loc.tab.input?.bufferId : undefined
    if (typeof bufferId === 'string') {
      try {
        await this.context.call('quirky.editor/view', { bufferId, tabId, action: 'promote' })
      } catch (error) {
        this.context.toast('Could not promote the preview', messageOf(error))
      }
      return
    }
    await this.run('rekeyViewTabs', {
      workspace: this.workspaceId,
      viewId: loc.tab.viewId,
      changes: [{ tab: tabId, key: loc.tab.key, preview: false }]
    }, 'promote the preview')
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

  /** Activates a pane through the daemon, then requests native focus, a scroll to bottom and a visible flash. */
  async focusPaneForCommand(paneId: string): Promise<boolean> {
    const workspace = await this.run('focusPane', { pane: paneId }, 'focus the pane')
    if (!workspace) return false
    const loc = locatePane(workspace, paneId)
    if (!loc || this.state.sessions[loc.leaf.session]?.kind === 'structured') return false
    this.pendingFocusPane = paneId
    this.set({ focusFlash: { pane: paneId, token: ++this.focusFlashToken } })
    this.focusPendingPane(paneId)
    return true
  }

  private async cycleFocus(offset: 1 | -1): Promise<void> {
    const at = this.ws ? focusedTabOf(this.ws) : null
    if (at && isTerminalTab(at.tab)) await this.run('focusPane', { tab: at.tab.id, offset }, 'focus the pane')
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
    if (loc && isTerminalTab(loc.tab) && paneLeaves(loc.tab.root).length > 1) {
      await this.run('equalize', { tab: loc.tab.id }, 'equalize the panes')
    }
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
      const current = isViewTab(loc.tab) ? loc.tab.title : loc.tab.customTitle ?? displayTitle(loc.tab)
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
    const hadTabs = this.ws !== null && hasTabs(this.ws)
    if (target.kind === 'tab') {
      const loc = this.ws ? locateTab(this.ws, target.tab) : null
      if (loc && isViewTab(loc.tab) && loc.tab.closeCommand) {
        try {
          await this.context.executeCommand(loc.tab.closeCommand, { ...(loc.tab.closeParams ?? {}), tabId: loc.tab.id })
        } catch (error) {
          this.context.toast('Could not close the tab', messageOf(error))
          return
        }
        const after = await this.run('workspace', { workspace: this.workspaceId }, 'refresh the workspace')
        if (hadTabs && after && !hasTabs(after)) await this.minimizeFloating()
        return
      }
    }
    const params = { ...this.closeParams(target), yes: true }
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

  /** Closes the active view tab or terminal pane; with nothing open a floating workspace minimizes. */
  async closeFocused(): Promise<void> {
    const selected = this.ws ? focusedTabOf(this.ws) : null
    if (selected && isViewTab(selected.tab)) {
      await this.requestClose({ kind: 'tab', tab: selected.tab.id })
      return
    }
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
  menuItems(): ContextMenuItem[] {
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
  private menuKey(command: string, fallback: string): string | null {
    return this.options.shortcutKey
      ? this.options.shortcutKey(command.startsWith('command:') ? command : `command:quirky.terminal/${command}`)
      : fallback
  }


  private tabMenuItems(tabId: string): ContextMenuItem[] {
    const ws = this.ws
    const loc = ws ? locateTab(ws, tabId) : null
    if (!ws || !loc) return []
    const { group, tab } = loc
    const index = group.tabs.findIndex((entry) => entry.id === tabId)
    const sides: ['Right' | 'Left' | 'Down' | 'Up', 'right' | 'left' | 'down' | 'up'][] = [['Right', 'right'], ['Left', 'left'], ['Down', 'down'], ['Up', 'up']]
    const items: ContextMenuItem[] = [
      {
        label: 'Move Tab to Split',
        enabled: group.tabs.length > 1,
        submenu: sides.map(([label, side]) => ({ label, onSelect: () => void this.moveTabToSplit(tabId, side, group.id) }))
      },
      ...(isTerminalTab(tab) ? [{
        label: 'Split Terminal',
        submenu: [
          { label: 'Right', onSelect: () => void this.splitRight(tab.activePane) },
          { label: 'Down', onSelect: () => void this.splitDown(tab.activePane) }
        ]
      }] : []),
      { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', onSelect: () => void this.pinTab(tabId, !tab.pinned) },
      { label: 'Copy Tab ID', onSelect: () => void this.copyText(tabId) },
      { label: 'Close', key: this.menuKey('close-pane', '⌘W'), onSelect: () => void this.closeTab(tabId) },
      { label: 'Close Others', enabled: group.tabs.length > 1, onSelect: () => void this.closeTabs(tabId, 'others') },
      { label: 'Close All Tabs To The Right', enabled: index < group.tabs.length - 1, onSelect: () => void this.closeTabs(tabId, 'right') },
      { label: 'Close All Tabs To The Left', enabled: index > 0, onSelect: () => void this.closeTabs(tabId, 'left') },
      { label: 'Change Title', key: this.menuKey('rename-tab', '⌘R'), onSelect: () => this.renameTab(tabId) },
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

  private paneMenuItems(paneId: string): ContextMenuItem[] {
    const ws = this.ws
    const loc = ws ? locatePane(ws, paneId) : null
    if (!ws || !loc) return []
    const { tab, leaf } = loc
    const split = paneLeaves(tab.root).length > 1
    const quick = this.options.paneMenuExtras?.(leaf) ?? []
    const contributed = this.options.paneMenuContributions?.(leaf, this.state.sessions[leaf.session]) ?? []
    const items: ContextMenuItem[] = [
      { label: 'Copy', key: this.menuKey('copy', '⌘C'), onSelect: () => this.copy(paneId) },
      { label: 'Select All', key: this.menuKey('select-all', '⌘A'), onSelect: () => this.selectAll(paneId) },
      { label: 'Paste', key: this.menuKey('paste', '⌘V'), onSelect: () => void this.pasteFromClipboard(paneId) },
      { label: 'Quick Commands', submenu: quick.length > 0 ? quick : [{ label: 'No quick commands', enabled: false }] },
      ...contributed,
      CONTEXT_MENU_SEPARATOR,
      { label: 'Split Terminal Right', key: this.menuKey('split-right', '⌘D'), onSelect: () => void this.splitRight(paneId) },
      { label: 'Split Terminal Down', key: this.menuKey('split-down', '⌘⇧D'), onSelect: () => void this.splitDown(paneId) }
    ]
    const dock = this.state.dockStates[paneId]
    if (this.state.sessions[leaf.session]?.kind === 'terminal' && dock?.enabled && dock.supported) {
      items.push(CONTEXT_MENU_SEPARATOR, {
        label: dock.docked ? 'Hide agent composer' : 'Show agent composer',
        key: this.menuKey('command:quirky.terminal-dock/toggle', '⌘⇧K'),
        onSelect: () => {
          void this.context
            .executeCommand('command:quirky.terminal-dock/toggle', { pane: paneId })
            .catch((error) => this.context.toast('Could not toggle the agent composer', messageOf(error)))
        }
      })
    }
    if (split) {
      items.push(
        { label: 'Equalize Pane Sizes', onSelect: () => void this.equalize(tab.id) },
        { label: tab.expandedPane === null ? 'Expand Pane' : 'Collapse Pane', key: this.menuKey('toggle-expand-pane', '⌘⇧Enter'), onSelect: () => void this.toggleExpand(paneId) }
      )
    }
    items.push(CONTEXT_MENU_SEPARATOR, { label: 'Set Title…', onSelect: () => void this.setTitle(paneId) })
    if (leaf.title) items.push({ label: 'Clear Pane Title', onSelect: () => void this.clearTitle(paneId) })
    items.push(
      { label: 'Copy Terminal ID', onSelect: () => void this.copyText(leaf.session) },
      { label: 'Copy Pane ID', onSelect: () => void this.copyText(paneId) }
    )
    if (split) items.push({ label: 'Close Pane', key: this.menuKey('close-pane', '⌘W'), danger: true, onSelect: () => void this.closePane(paneId) })
    items.push(
      CONTEXT_MENU_SEPARATOR,
      { label: 'Clear Screen', key: this.menuKey('clear', '⌘K'), onSelect: () => void this.clearPane(paneId) },
      { label: 'Reset Terminal', onSelect: () => void this.resetPane(paneId) }
    )
    return items
  }

  private plusItems(groupId: string | null, query: string): ContextMenuItem[] {
    const group = groupId && this.ws ? findGroup(this.ws.root, groupId) : null
    const target = group?.id
    const needle = query.trim().toLowerCase()
    const contributed = group ? (this.options.tabMenuContributions?.(group, this.workspaceId) ?? []) : []
    const entries = filterEntries(this.state.agents, query)
    const rows: ContextMenuItem[] = entries.map((entry) => ({
      label: entry.label,
      key: entry.kind === 'terminal' ? this.menuKey('command:quirky.session/new-shell', '⌘T') : null,
      onSelect: () => this.chooseEntry(entry, target)
    }))
    const footer = entries.findIndex((entry) => entry.kind === 'manage')
    const visibleContributions = contributed.filter(
      (item) =>
        (needle === '' || item.after === 'quick-commands') &&
        (needle === '' || item.label.toLowerCase().includes(needle))
    )
    rows.splice(footer < 0 ? rows.length : footer, 0, ...visibleContributions)
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

  private actionItems(groupId: string): ContextMenuItem[] {
    const split = this.ws?.root.kind === 'split'
    return split ? [{ label: 'Close Split Pane', onSelect: () => void this.closeGroup(groupId) }] : []
  }

  private chooseEntry(entry: MenuEntry, group: string | undefined): void {
    if (entry.kind === 'terminal') void this.newTab(group === undefined ? {} : { group })
    else if (entry.kind === 'manage') this.context.openView(AGENTS_VIEW_ID)
    else this.set({ dialog: { kind: 'new-session', title: `New ${entry.request.label} session`, request: entry.request, group: group ?? null } })
  }

  /**
   * Starts the agent session the New Session dialog asked for, or drops the dialog when `prompt` is
   * null. The dialog stays open with the error when the start fails, so the prompt is not lost.
   */
  async submitNewSession(prompt: string | null): Promise<void> {
    const dialog = this.state.dialog
    if (dialog?.kind !== 'new-session' || dialog.pending) return
    if (prompt === null) {
      this.set({ dialog: null })
      return
    }
    const text = prompt.trim()
    const { request, group } = dialog
    let startedSession = dialog.startedSession
    this.set({ dialog: { ...dialog, pending: true, error: null } })
    try {
      if (request.background) {
        const session = startedSession ?? ((await this.context.call('quirky.structured/create', {
          worktree: this.workspaceId,
          agent: request.agent,
          prompt: text
        })) as Session)
        startedSession = session
        if (this.stopped) return
        const targetGroup = group ?? this.ws?.activeGroup
        const result = (await this.context.call(`${TERMINAL_PREFIX}adoptSession`, {
          group: targetGroup,
          session: session.id
        })) as { workspace?: Workspace } | undefined
        if (this.stopped) return
        if (!result?.workspace) throw new Error(`Could not adopt session ${session.id}.`)
        this.set({ sessions: { ...this.state.sessions, [session.id]: this.state.sessions[session.id] ?? session } })
        this.apply(result.workspace)
      } else {
        const spec = { ...(group === null ? {} : { group }), agent: request.agent, ...(text === '' ? {} : { prompt: text }) }
        const result = (await this.context.call(`${TERMINAL_PREFIX}newTab`, { workspace: this.workspaceId, ...spec })) as { workspace?: Workspace } | undefined
        if (!this.stopped && result?.workspace) this.apply(result.workspace)
      }
      if (!this.stopped) this.set({ dialog: null })
    } catch (error) {
      if (this.stopped) return
      if (hasCode(error, RpcErrorCode.Conflict)) void this.refresh()
      const message = messageOf(error)
      this.set({
        dialog: {
          ...dialog,
          ...(startedSession ? { startedSession } : {}),
          pending: false,
          error: startedSession ? `Session already started; could not open it: ${message}` : message
        }
      })
    }
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
      const text = await this.context.readClipboardText()
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

  /** Executes a trusted command after the daemon validates its explicit group target. */
  async dropCommand(transfer: DataTransfer | null, groupId: string): Promise<void> {
    const token = hasCommandDrop(transfer) ? transfer.getData(COMMAND_DROP_MIME) : ''
    const descriptor = token === '' ? null : this.context.consumeCommandDrag(token)
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

  setMountedAccessories(paneId: string, ids: string[]): void {
    if (this.stopped) return
    const current = this.mountedAccessories[paneId]
    if (current && current.length === ids.length && current.every((id, index) => id === ids[index])) return
    if (current === undefined && ids.length === 0) return
    const next = { ...this.mountedAccessories }
    if (ids.length === 0) delete next[paneId]
    else next[paneId] = [...ids]
    this.mountedAccessories = next
    this.publish()
  }

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
      focused: this.hasRootFocus(),
      focusSequence: this.focusSequence,
      panes: ws ? panesReport(ws, this.state.paneStates, this.state.settings['font-size'], this.state.dockStates) : [],
      mountedAccessories: this.mountedAccessories,
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

  private hasRootFocus(): boolean {
    const root = this.rootElement
    const active = root?.ownerDocument.activeElement
    return Boolean(root && active && active !== root.ownerDocument.body && root.contains(active))
  }

  private updateDockContexts(): void {
    if (!this.hasRootFocus()) {
      if (dockContextOwner && !dockContextOwner.hasRootFocus()) {
        const previousOwner = dockContextOwner
        dockContextOwner = null
        previousOwner.writeDockContextValues(false, false, false)
      }
      return
    }

    if (dockContextOwner && dockContextOwner !== this) dockContextOwner.writeDockContextValues(false, false, false)
    dockContextOwner = this
    const pane = this.ws ? focusedPaneOf(this.ws)?.leaf.id : undefined
    const dock = pane ? this.state.dockStates[pane] : undefined
    const host = pane ? this.state.dockHosts[pane] : undefined
    const eligible = Boolean(dock?.enabled && dock.supported && host?.focused)
    const mounted = eligible && Boolean(dock?.docked && dock.mounted && host?.mounted)
    const focused = mounted && Boolean(!dock?.passthrough && host?.composerFocused)
    this.writeDockContextValues(eligible, mounted, focused)
  }

  private writeDockContextValues(eligible: boolean, mounted: boolean, focused: boolean): void {
    if (this.dockContextEligible !== eligible) {
      this.dockContextEligible = eligible
      this.context.setContext('terminalDockEligible', eligible)
    }
    if (this.dockContextMounted !== mounted) {
      this.dockContextMounted = mounted
      this.context.setContext('terminalDockMounted', mounted)
    }
    if (this.dockContextFocus !== focused) {
      this.dockContextFocus = focused
      this.context.setContext('terminalDockFocus', focused)
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
let dockContextOwner: WorkspaceController | null = null
let windowFocusSequence = 0
