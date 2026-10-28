import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { PaneTab } from './pane-contract'
import { BrowserPaneWindow, focusBrowserAddress, focusBrowserFind, focusedBrowserPane } from './window/BrowserPaneWindow'
import { registerPreferencesUi } from './preferences-ui'

const PAGE_VIEW = 'view:quirky.browser/page'
const WORKTREE_VIEW = 'view:quirky.session/worktree'

type CommandArgs = Record<string, unknown>
type BrowserCommand = (args?: unknown) => Promise<unknown> | unknown

let deactivateCurrent: (() => void) | null = null

function argsOf(value: unknown): CommandArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as CommandArgs : {}
}

function worktreeFrom(context: UiPluginContext, args: CommandArgs): string | null {
  if (typeof args.worktree === 'string' && args.worktree !== '') return args.worktree
  const layout = context.getLayout()
  const input = layout.view?.input
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const worktree = Reflect.get(input, 'worktree')
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function openBrowserTab(context: UiPluginContext, raw: unknown): Promise<unknown> {
  const args = argsOf(raw)
  const worktree = worktreeFrom(context, args)
  if (!worktree) {
    const message = 'Open a worktree before creating a browser tab.'
    context.toast('Could not open Browser', message, { kind: 'warning' })
    return { ok: false, reason: message }
  }
  const params: Record<string, unknown> = { worktree }
  for (const name of ['url', 'page', 'mode', 'profile'] as const) {
    if (typeof args[name] === 'string' && args[name] !== '') params[name] = args[name]
  }
  try {
    const pane = await context.call('quirky.browser/paneOpen', params) as PaneTab
    const workspace = pane.worktreeId.startsWith('id:') ? pane.worktreeId : `id:${pane.worktreeId}`
    context.openView(WORKTREE_VIEW, { worktree: workspace })
    return { pane: pane.id, tabId: pane.tabId }
  } catch (error) {
    const message = problem(error)
    context.toast('Could not open Browser', message, { kind: 'error' })
    return { ok: false, reason: message }
  }
}

async function controlFocused(context: UiPluginContext, action: 'back' | 'forward' | 'reload' | 'hardReload' | 'zoom', delta?: number): Promise<unknown> {
  const pane = focusedBrowserPane()
  if (!pane) return { ok: false, reason: 'No browser pane is focused.' }
  if (action !== 'zoom' && action !== 'hardReload') return context.call('quirky.browser/paneControl', { pane, action })
  const state = await context.call('quirky.browser/paneState', {}) as { tabs?: { id: string; zoom: number; mode: 'native' | 'watch' }[] }
  const current = state.tabs?.find((tab) => tab.id === pane)
  if (!current) return { ok: false, reason: `Browser pane ${pane} is no longer open.` }
  if (action === 'hardReload') {
    if (current.mode === 'native') {
      const reason = 'Hard Reload is unavailable in Native mode; the pinned SDK supports ordinary reload only.'
      context.toast('Hard Reload unavailable', reason, { kind: 'warning' })
      return { ok: false, reason }
    }
    return context.call('quirky.browser/paneControl', { pane, action })
  }
  const level = delta === undefined ? 0 : Math.min(5, Math.max(-3, current.zoom + delta))
  return context.call('quirky.browser/paneControl', { pane, action: 'zoom', level })
}

function commandHandlers(context: UiPluginContext): Record<string, BrowserCommand> {
  return {
    'new-tab': (args) => openBrowserTab(context, args),
    'focus-address': () => {
      focusBrowserAddress()
      return { focused: focusedBrowserPane() !== null }
    },
    find: () => {
      focusBrowserFind()
      return { opened: focusedBrowserPane() !== null }
    },
    back: () => controlFocused(context, 'back'),
    forward: () => controlFocused(context, 'forward'),
    reload: () => controlFocused(context, 'reload'),
    'hard-reload': () => controlFocused(context, 'hardReload'),
    'zoom-in': () => controlFocused(context, 'zoom', 0.5),
    'zoom-out': () => controlFocused(context, 'zoom', -0.5),
    'zoom-reset': () => controlFocused(context, 'zoom')
  }
}

export function activate(context: UiPluginContext): void {
  deactivateCurrent?.()
  registerPreferencesUi(context)
  context.provide(PAGE_VIEW, (element: HTMLElement, props: { input?: unknown }) => {
    const root = createRoot(element)
    root.render(<BrowserPaneWindow context={context} input={props.input} />)
    return () => root.unmount()
  })
  for (const [name, handler] of Object.entries(commandHandlers(context))) {
    context.provide(`command:quirky.browser/${name}`, handler)
  }
  deactivateCurrent = () => {
    context.setContext('browserFocus', false)
  }
}

export function deactivate(): void {
  deactivateCurrent?.()
  deactivateCurrent = null
}
