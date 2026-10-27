import type { UiPluginContext } from '@quirky/protocol'
import { findGroup } from '../layout/tree'
import type { FloatingState, QuickCommand } from '../layout/types'
import { FLOATING_WORKSPACE } from '../layout/types'
import { paneQuickCommandItems } from './quick-commands'
import { runCommand } from './quick-commands/shared'
import { SEPARATOR, controllerFor, focusedController, type MenuItem, type WorkspaceController } from './workspace'
import { locatePane, locateTab } from './workspace/model'

export const QUICK_COMMANDS_PANEL = 'panel:quirky.terminal/quick-commands'
export const QUICK_COMMANDS_MENU = 'quick-commands'

const QUICK_COMMANDS_EVENT = 'quirky.terminal/quickCommands'
const MENU_KINDS = ['tab', 'pane', 'plus', 'actions', QUICK_COMMANDS_MENU]

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

/** Puts a menu opened by command next to the strip button it belongs to, or the workspace corner when none is drawn. */
function openMenu(controller: WorkspaceController, kind: string, target: string | undefined): void {
  if (kind !== QUICK_COMMANDS_MENU) {
    controller.openMenu(kind, target)
    return
  }
  const workspace = controller.getSnapshot().workspace
  const group = target ?? workspace?.activeGroup ?? null
  const rect = group === null ? undefined : controller.root?.querySelector(`[data-plus="${group}"]`)?.getBoundingClientRect()
  controller.openMenu(kind, group, rect ? { x: rect.right, y: rect.bottom } : undefined)
}

async function changeFloating(context: UiPluginContext, change: (state: FloatingState) => Partial<FloatingState>): Promise<unknown> {
  const state = (await context.call('quirky.terminal/floating')) as FloatingState
  if (!state.enabled) return { ok: false, reason: 'the floating workspace is turned off' } satisfies CommandFailure
  return context.call('quirky.terminal/setFloating', change(state))
}

/**
 * The handlers of `quirky.terminal`'s window commands, by command name. Each acts on the focused
 * workspace, or on the one holding the `pane`, `tab` or `target` it is given, and returns JSON:
 * `{ok: true}` (`copy` returns `{text}`), or `{ok: false, reason}` when no mounted workspace fits.
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
    'focus-previous-pane': on(context, 'pane', (controller) => controller.focusPrevious()),
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
      if (controller.getSnapshot().menu?.kind === QUICK_COMMANDS_MENU) controller.closeMenu()
      else openMenu(controller, QUICK_COMMANDS_MENU, textArg(args, 'target'))
    }),
    'manage-quick-commands': () => {
      context.togglePanel(QUICK_COMMANDS_PANEL, true)
      return OK
    },
    'open-menu': on(context, 'target', (controller, args) => {
      const kind = textArg(args, 'kind')
      if (kind === undefined || !MENU_KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${MENU_KINDS.join(', ')}` } satisfies CommandFailure
      openMenu(controller, kind, textArg(args, 'target'))
    }),
    'close-menu': on(context, 'target', (controller) => controller.closeMenu()),
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
 * The quick commands a workspace sees and its repo, kept current for menus that must read them
 * synchronously. `dispose` stops listening.
 */
export type QuickCommandSource = {
  commands(): QuickCommand[]
  repo(): string | null
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function watchQuickCommands(context: UiPluginContext, workspace: string): QuickCommandSource {
  let commands: QuickCommand[] = []
  let repo: string | null = null
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
  return {
    commands: () => commands,
    repo: () => repo,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      live = false
      unsubscribe()
      listeners.clear()
    }
  }
}

/** The pane menu's Quick Commands rows for `pane`, adapted to the workspace menu's row shape. */
export function paneMenuQuickCommands(context: UiPluginContext, source: QuickCommandSource, pane: string): MenuItem[] {
  return paneQuickCommandItems(context, source.commands(), pane, { repo: source.repo() }).flatMap((item) => {
    const row: MenuItem = { label: item.label, key: item.hint ?? null, enabled: item.enabled, onSelect: () => void item.onSelect() }
    return item.separatorBefore ? [SEPARATOR, row] : [row]
  })
}

/** The rows of the Quick Commands menu `toggle-quick-commands` opens: each command runs in a new tab of `group`. */
export function stripQuickCommandItems(context: UiPluginContext, source: QuickCommandSource, workspace: string, group: string | null): MenuItem[] {
  const all = source.commands().filter((entry) => entry.command.trim() !== '')
  const ordered = [...all.filter((entry) => entry.scope === 'repo'), ...all.filter((entry) => entry.scope !== 'repo')]
  const rows: MenuItem[] = ordered.map((entry) => ({
    label: entry.label,
    onSelect: () => void runCommand(context, { id: entry.id, workspace, ...(group === null ? {} : { group }) })
  }))
  if (rows.length === 0) rows.push({ label: 'No quick commands', enabled: false })
  rows.push(SEPARATOR, { label: 'Manage Quick Commands', onSelect: () => context.togglePanel(QUICK_COMMANDS_PANEL, true) })
  return rows
}
