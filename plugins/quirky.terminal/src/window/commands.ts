import { TERMINAL_PANE_MENU, TERMINAL_TAB_MENU, type Session, type UiMenuItemEntry, type UiModel, type UiPluginContext } from '@quirky/protocol'
import { findGroup } from '../layout/tree'
import type { FloatingState, Group, PaneLeaf, QuickCommand, Workspace } from '../layout/types'
import { FLOATING_WORKSPACE } from '../layout/types'
import { isQuickCommandComplete } from '../quick-commands/normalize'
import { paneQuickCommandItems } from './quick-commands'
import { repoFirst } from './quick-commands/search'
import { SEPARATOR, controllerFor, focusedController, type MenuItem, type WorkspaceController } from './workspace'
import { locatePane, locateTab } from './workspace/model'
import { waitForController } from './workspace/registry'

export const QUICK_COMMANDS_PANEL = 'panel:quirky.terminal/quick-commands'
export const QUICK_COMMANDS_MENU = 'quick-commands'

const QUICK_COMMANDS_EVENT = 'quirky.terminal/quickCommands'
const MENU_KINDS = ['tab', 'pane', 'plus', 'actions', QUICK_COMMANDS_MENU]
const WORKTREE_VIEW = 'view:quirky.session/worktree'

/** What a window command returns when it can't act: JSON, so a caller on the CLI can read it. */
export type CommandFailure = { ok: false; reason: string }
export type CommandHandler = (args?: unknown) => unknown

export const NO_WORKSPACE: CommandFailure = { ok: false, reason: 'no terminal workspace is open' }
const OK = { ok: true } as const

type Args = Record<string, unknown>

function argsOf(raw: unknown): Args {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Args) : {}
}

function textArg(args: Args, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Like `textArg` but an explicit empty string survives, so a caller can tell "cleared" from "omitted". */
function stringArg(args: Args, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' ? value : undefined
}

function viewedWorktree(context: UiPluginContext): string | null {
  const worktree = (context.getLayout().view?.input as { worktree?: unknown } | null | undefined)?.worktree
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

/** The controllers a command can be aimed at: the focused one, the floating one and the one the main view shows. */
function candidates(context: UiPluginContext): WorkspaceController[] {
  const worktree = viewedWorktree(context)
  const all = [focusedController(), controllerFor(FLOATING_WORKSPACE), worktree === null ? null : controllerFor(worktree)]
  return all.filter((controller, index): controller is WorkspaceController => controller !== null && all.indexOf(controller) === index)
}

function holds(controller: WorkspaceController, id: string): boolean {
  const workspace = controller.getSnapshot().workspace
  return workspace !== null && (locatePane(workspace, id) !== null || locateTab(workspace, id) !== null || findGroup(workspace.root, id) !== null)
}

/**
 * The workspace a command runs in: the one holding the pane, tab or group `args[key]` names, else
 * the focused one. A failure when nothing is mounted or the named item is in no mounted workspace.
 */
function resolve(context: UiPluginContext, args: Args, key: string): { controller: WorkspaceController } | CommandFailure {
  const id = textArg(args, key)
  if (id !== undefined) {
    const owner = candidates(context).find((controller) => holds(controller, id))
    return owner ? { controller: owner } : { ok: false, reason: `no mounted terminal workspace holds ${id}` }
  }
  const controller = focusedController()
  return controller ? { controller } : NO_WORKSPACE
}

/** Runs `act` on the workspace `args[key]` resolves to; a command with nothing to say answers `{ok: true}`. */
function on(context: UiPluginContext, key: string, act: (controller: WorkspaceController, args: Args) => unknown): CommandHandler {
  return async (raw) => {
    const args = argsOf(raw)
    const found = resolve(context, args, key)
    if ('ok' in found) return found
    const result = await act(found.controller, args)
    return result === undefined ? OK : result
  }
}

const onPane = (context: UiPluginContext, act: (controller: WorkspaceController, pane: string | undefined, args: Args) => unknown): CommandHandler =>
  on(context, 'pane', (controller, args) => act(controller, textArg(args, 'pane'), args))

async function readClipboard(context: UiPluginContext): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? ''
  } catch (error) {
    context.toast('Could not paste', error instanceof Error ? error.message : String(error))
    return ''
  }
}

function searchOptions(args: Args): { regex?: boolean; caseSensitive?: boolean } | undefined {
  const options: { regex?: boolean; caseSensitive?: boolean } = {}
  if (typeof args.regex === 'boolean') options.regex = args.regex
  if (typeof args.caseSensitive === 'boolean') options.caseSensitive = args.caseSensitive
  return Object.keys(options).length > 0 ? options : undefined
}

/**
 * Opens the searchable quick-commands menu the strip's chevron opens, on `group` (default: the
 * active one). A failure when the workspace draws no such button, as the floating one does not.
 */
function openQuickCommandsMenu(controller: WorkspaceController, group: string | undefined): CommandFailure | undefined {
  const source = quickSources.get(controller.workspaceId)
  if (controller.floating || !source) return { ok: false, reason: 'this workspace has no quick-commands menu' }
  const workspace = controller.getSnapshot().workspace
  const target = group ?? workspace?.activeGroup ?? null
  if (workspace === null || target === null || findGroup(workspace.root, target) === null) return { ok: false, reason: `no tab group ${target ?? ''} in this workspace` }
  controller.closeMenu()
  source.openMenu(target)
}

/** Closes what a command opened: the workspace's menu and the quick-commands menu. */
function closeMenus(controller: WorkspaceController): void {
  controller.closeMenu()
  quickSources.get(controller.workspaceId)?.closeMenu()
}

async function changeFloating(context: UiPluginContext, change: (state: FloatingState) => Partial<FloatingState>): Promise<unknown> {
  const state = (await context.call('quirky.terminal/floating')) as FloatingState
  if (!state.enabled) return { ok: false, reason: 'the floating workspace is turned off' } satisfies CommandFailure
  return context.call('quirky.terminal/setFloating', change(state))
}

async function focusPaneCommand(context: UiPluginContext, raw: unknown): Promise<CommandFailure | typeof OK> {
  const args = argsOf(raw)
  const pane = textArg(args, 'pane')
  if (pane === undefined) return { ok: false, reason: 'pane is required' }
  try {
    const location = (await context.call('quirky.terminal/paneOf', { pane })) as { workspace: string }
    const requestedWorkspace = textArg(args, 'workspace')
    if (requestedWorkspace !== undefined && requestedWorkspace !== location.workspace) {
      return { ok: false, reason: `pane ${pane} belongs to workspace ${location.workspace}, not ${requestedWorkspace}` }
    }
    if (location.workspace === FLOATING_WORKSPACE) {
      const state = (await context.call('quirky.terminal/floating')) as FloatingState
      if (!state.enabled) return { ok: false, reason: 'the floating workspace is turned off' }
      if (!state.open) await context.call('quirky.terminal/setFloating', { open: true })
    } else {
      context.openView(WORKTREE_VIEW, { worktree: location.workspace })
    }
    const controller = controllerFor(location.workspace) ?? (await waitForController(location.workspace))
    if (!controller || controllerFor(location.workspace) !== controller) return { ok: false, reason: `workspace ${location.workspace} did not open` }
    if (!(await controller.focusPaneForCommand(pane))) return { ok: false, reason: `pane ${pane} is not a terminal pane` }
    return OK
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    context.toast('Could not focus pane', reason)
    return { ok: false, reason }
  }
}

async function openSessionCommand(context: UiPluginContext, raw: unknown): Promise<CommandFailure | typeof OK> {
  const args = argsOf(raw)
  const session = textArg(args, 'session')
  if (session === undefined) return { ok: false, reason: 'session is required' }
  const workspace = textArg(args, 'workspace')
  try {
    const opened = (await context.call('quirky.terminal/openSession', { session, ...(workspace === undefined ? {} : { workspace }) })) as {
      workspace: Workspace
      pane: string
    }
    const focused: unknown = await context.executeCommand('command:quirky.terminal/focus-pane', {
      pane: opened.pane,
      workspace: opened.workspace.id
    })
    if (typeof focused === 'object' && focused !== null && 'ok' in focused && focused.ok === false) {
      const reason = 'reason' in focused && typeof focused.reason === 'string' ? focused.reason : 'could not focus pane'
      return { ok: false, reason }
    }
    return OK
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    context.toast('Could not open session', reason)
    return { ok: false, reason }
  }
}

/**
 * The handlers of `quirky.terminal`'s window commands, by command name. Most act on the focused
 * workspace or an explicit target; `focus-pane` and `open-session` open the target workspace.
 * Commands return JSON: `{ok: true}` (`copy` returns `{text}`), or `{ok: false, reason}` on failure.
 */
export function terminalCommands(context: UiPluginContext): Record<string, CommandHandler> {
  return {
    copy: onPane(context, (controller, pane) => controller.copy(pane)),
    'select-all': onPane(context, (controller, pane) => controller.selectAll(pane)),
    paste: onPane(context, async (controller, pane, args) => {
      const text = typeof args.text === 'string' ? args.text : await readClipboard(context)
      if (text !== '') await controller.paste(text, pane)
    }),
    search: onPane(context, (controller, pane, args) => controller.search(stringArg(args, 'query'), searchOptions(args), pane)),
    'search-next': onPane(context, (controller, pane) => controller.searchNext(pane)),
    'search-previous': onPane(context, (controller, pane) => controller.searchPrevious(pane)),
    'search-close': onPane(context, (controller, pane) => controller.searchClose(pane)),
    clear: onPane(context, (controller, pane) => controller.clearPane(pane)),
    'reset-terminal': onPane(context, (controller, pane) => controller.resetPane(pane)),
    'focus-next-pane': on(context, 'pane', (controller) => controller.focusNext()),
    'focus-pane': (args) => focusPaneCommand(context, args),
    'focus-previous-pane': on(context, 'pane', (controller) => controller.focusPrevious()),
    'open-session': (args) => openSessionCommand(context, args),
    'toggle-expand-pane': onPane(context, (controller, pane) => controller.toggleExpand(pane)),
    equalize: on(context, 'tab', (controller, args) => controller.equalize(textArg(args, 'tab'))),
    'set-pane-title': onPane(context, (controller, pane) => controller.setTitle(pane)),
    'clear-pane-title': onPane(context, (controller, pane) => controller.clearTitle(pane)),
    'close-pane': onPane(context, (controller, pane) => (pane === undefined ? controller.closeFocused() : controller.closePane(pane))),
    'split-right': onPane(context, (controller, pane) => controller.splitRight(pane)),
    'split-down': onPane(context, (controller, pane) => controller.splitDown(pane)),
    'zoom-in': onPane(context, (controller, pane) => controller.zoomIn(pane)),
    'zoom-out': onPane(context, (controller, pane) => controller.zoomOut(pane)),
    'zoom-reset': onPane(context, (controller, pane) => controller.zoomReset(pane)),
    'rename-tab': on(context, 'tab', (controller, args) => controller.renameTab(textArg(args, 'tab'))),
    'reopen-tab': on(context, 'tab', (controller) => controller.reopenTab()),
    'next-tab': on(context, 'tab', (controller) => controller.nextTab()),
    'previous-tab': on(context, 'tab', (controller) => controller.previousTab()),
    'recent-tab': on(context, 'tab', (controller) => controller.recentTab()),
    'toggle-quick-commands': on(context, 'target', (controller, args) => {
      const source = quickSources.get(controller.workspaceId)
      if (source && source.menu() !== null) return source.closeMenu()
      return openQuickCommandsMenu(controller, textArg(args, 'target'))
    }),
    'manage-quick-commands': () => {
      context.togglePanel(QUICK_COMMANDS_PANEL, true)
      return OK
    },
    'open-menu': on(context, 'target', (controller, args) => {
      const kind = textArg(args, 'kind')
      if (kind === undefined || !MENU_KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${MENU_KINDS.join(', ')}` } satisfies CommandFailure
      if (kind === QUICK_COMMANDS_MENU) return openQuickCommandsMenu(controller, textArg(args, 'target'))
      closeMenus(controller)
      controller.openMenu(kind, textArg(args, 'target'))
    }),
    'close-menu': on(context, 'target', (controller) => closeMenus(controller)),
    'toggle-floating': () => changeFloating(context, (state) => ({ open: !state.open })),
    'maximize-floating': () => changeFloating(context, () => ({ open: true, maximized: true })),
    'minimize-floating': () => changeFloating(context, () => ({ open: false }))
  }
}

/**
 * The handlers for the `quirky.session` commands this plugin overrides, by command name: new tab,
 * close, and select tab by index, all acting on the focused workspace (the floating one while it
 * holds focus). With no workspace mounted `new-shell` still opens a tab in the worktree the window shows.
 */
export function sessionCommands(context: UiPluginContext): Record<string, CommandHandler> {
  const select = (index: (args: Args) => number) =>
    on(context, 'tab', async (controller, args) => {
      await controller.selectTab(index(args))
    })
  const handlers: Record<string, CommandHandler> = {
    'new-shell': async () => {
      const controller = focusedController()
      if (controller) {
        await controller.newTab()
        return OK
      }
      const worktree = viewedWorktree(context)
      if (worktree === null) return NO_WORKSPACE
      await context.call('quirky.terminal/newTab', { workspace: worktree })
      return OK
    },
    'close-session': on(context, 'pane', (controller) => controller.closeFocused()),
    'select-tab': select((args) => Number(args.index))
  }
  for (let n = 1; n <= 9; n += 1) handlers[`select-tab-${n}`] = select(() => n)
  return handlers
}

/**
 * The quick commands a workspace sees, its repo and which group's quick-commands menu is open,
 * kept current for views and window commands that must read them synchronously. The strip button
 * draws the menu; the window commands open and close it through this. `dispose` stops listening.
 */
export type QuickCommandSource = {
  commands(): QuickCommand[]
  repo(): string | null
  /** The tab group whose quick-commands menu is open; null when none is. */
  menu(): string | null
  openMenu(group: string): void
  /** Closes the open menu; with `group`, only when it is that group's. */
  closeMenu(group?: string): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

const quickSources = new Map<string, QuickCommandSource>()

export function watchQuickCommands(context: UiPluginContext, workspace: string): QuickCommandSource {
  let commands: QuickCommand[] = []
  let repo: string | null = null
  let menu: string | null = null
  let live = true
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach((listener) => listener())

  let latest = 0
  const load = async () => {
    const mine = ++latest
    try {
      const result = (await context.call('quirky.terminal/quickCommands', { workspace })) as { commands: QuickCommand[] }
      if (live && mine === latest) commands = result.commands
    } catch {
      // the menus show "No quick commands" until the next change brings them
    }
    changed()
  }
  const findRepo = async () => {
    if (workspace === FLOATING_WORKSPACE) return
    try {
      const resolved = (await context.call('quirky.worktree/resolve', { selector: `id:${workspace}` })) as { repoId: string | null }
      if (live) repo = resolved.repoId
    } catch {
      // without a repo the Add dialog preselects no project
    }
    changed()
  }
  void load()
  void findRepo()
  const unsubscribe = context.subscribe((event) => {
    if (event.type === QUICK_COMMANDS_EVENT) void load()
  })
  const source: QuickCommandSource = {
    commands: () => commands,
    repo: () => repo,
    menu: () => menu,
    openMenu(group) {
      if (menu === group) return
      menu = group
      changed()
    },
    closeMenu(group) {
      if (menu === null || (group !== undefined && menu !== group)) return
      menu = null
      changed()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      live = false
      menu = null
      unsubscribe()
      listeners.clear()
      if (quickSources.get(workspace) === source) quickSources.delete(workspace)
    }
  }
  quickSources.set(workspace, source)
  return source
}

type ReportedMenu = { kind: string; target: string | null; items: { label: string; key: string | null; enabled: boolean; separator: boolean }[] }

function quickMenuReport(source: QuickCommandSource, group: string): ReportedMenu {
  const items = repoFirst(source.commands()).map((entry) => ({ label: entry.label, key: null, enabled: isQuickCommandComplete(entry), separator: false }))
  return { kind: QUICK_COMMANDS_MENU, target: group, items: [...items, { label: '+ Command', key: null, enabled: true, separator: false }] }
}

/**
 * Wraps a workspace view's `report` so the open quick-commands menu, which the strip button draws
 * and the workspace controller does not know, shows as the report's `menu`. Feed the controller's
 * reports to `report`; `stop` ends the listening.
 */
export function reportQuickCommandsMenu(source: QuickCommandSource, publish: (state: unknown) => void): { report(state: unknown): void; stop(): void } {
  let latest: Record<string, unknown> | null = null
  let lastText = ''
  const emit = () => {
    if (latest === null) return
    const group = source.menu()
    const layout = latest.layout as Workspace | null | undefined
    const open = group !== null && layout != null && findGroup(layout.root, group) !== null
    const state = open ? { ...latest, menu: quickMenuReport(source, group) } : latest
    const text = JSON.stringify(state)
    if (text === lastText) return
    lastText = text
    publish(state)
  }
  const stop = source.subscribe(emit)
  return {
    report(state) {
      if (typeof state !== 'object' || state === null) return publish(state)
      latest = state as Record<string, unknown>
      emit()
    },
    stop
  }
}

/** The pane menu's Quick Commands rows for `pane`, adapted to the workspace menu's row shape. */
export function paneMenuQuickCommands(context: UiPluginContext, source: QuickCommandSource, pane: string): MenuItem[] {
  return paneQuickCommandItems(context, source.commands(), pane, { repo: source.repo() }).flatMap((item) => {
    const row: MenuItem = { label: item.label, key: item.hint ?? null, enabled: item.enabled, onSelect: () => void item.onSelect() }
    return item.separatorBefore ? [SEPARATOR, row] : [row]
  })
}

/** The effective public `menu-item` registry snapshot shared by the pane and tab menus. */
export type MenuContributionSource = {
  items(): UiMenuItemEntry[]
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function watchMenuContributions(context: UiPluginContext): MenuContributionSource {
  let items: UiMenuItemEntry[] = []
  let live = true
  let latest = 0
  const listeners = new Set<() => void>()
  const load = async () => {
    const mine = ++latest
    try {
      const model = (await context.call('ui.contributions')) as UiModel
      if (live && mine === latest) {
        items = model.menuItems ?? []
        for (const listener of [...listeners]) listener()
      }
    } catch {
      // The last effective list remains until the next change brings one.
    }
  }
  void load()
  const unsubscribe = context.subscribe((event) => {
    if (event.type === 'plugin.changed') void load()
  })
  const stopConnection = context.onConnection((status) => {
    if (status === 'connected') void load()
  })
  return {
    items: () => items,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      live = false
      unsubscribe()
      stopConnection()
      listeners.clear()
    }
  }
}

/**
 * The pane menu rows other plugins contribute for `pane`. An item conditioned on `agent: 'any'`
 * applies only when the pane's session runs an agent; choosing a row runs its command with the session.
 */
export function paneMenuContributions(context: UiPluginContext, source: MenuContributionSource, pane: PaneLeaf, session: Session | undefined): MenuItem[] {
  const runsAgent = session !== undefined && session.agent !== 'shell'
  return source
    .items()
    .filter((item) => item.menu === TERMINAL_PANE_MENU && (item.when?.agent !== 'any' || runsAgent))
    .map((item) => ({
      label: item.title,
      onSelect: () =>
        void context.executeCommand(item.command, { session: pane.session }).catch((error: unknown) => {
          context.toast(item.title, error instanceof Error ? error.message : String(error))
        })
    }))
}
/** The public tab-menu rows, scoped to the worktree, workspace, and group that opened the menu. */
export function tabMenuContributions(
  context: UiPluginContext,
  source: MenuContributionSource,
  worktree: string,
  workspace: string,
  group: Group
): MenuItem[] {
  return source
    .items()
    .filter((item) => item.menu === TERMINAL_TAB_MENU)
    .map((item) => ({
      id: item.id,
      label: item.title,
      onSelect: () =>
        void context.executeCommand(item.command, { worktree, workspace, group: group.id }).catch((error: unknown) => {
          context.toast(item.title, error instanceof Error ? error.message : String(error))
        })
    }))
}
