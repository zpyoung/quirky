import type { UiPluginContext } from '@quirky/protocol'
import type { ViewPlacement } from './core/contract'

export const MOVE_COMMAND_ID = 'command:quirky.view/move'
export const ACTION_COMMAND_ID = 'command:quirky.view/action'
export const CONTROL_COMMAND_ID = 'command:quirky.view/control'

export type ViewUiState = {
  instance: string
  surface: 'view:quirky.view/render' | 'view:quirky.view/pane'
  session?: string
  viewId?: string
  activeViewId: string | null
  phase: 'loading' | 'ready' | 'failed' | 'missing'
  tabs: { viewId: string; title: string }[]
  pendingLink: string | null
}

export type ViewControl =
  | { action: 'state' }
  | { instance: string; action: 'refresh' }
  | { instance: string; action: 'select-tab' | 'dismiss-tab'; viewId: string }
  | { instance: string; action: 'link-preview'; viewId: string; href: string }
  | { instance: string; action: 'link-cancel' | 'link-confirm'; viewId: string }

type ViewHandlers = {
  refresh?: () => void | Promise<void>
  selectTab?: (viewId: string) => void | Promise<void>
  dismissTab?: (viewId: string) => void | Promise<void>
  previewLink?: (href: string) => void
  cancelLink?: () => void
}

type ViewUiPatch = Partial<Pick<ViewUiState, 'activeViewId' | 'phase' | 'tabs' | 'pendingLink'>>

type MountOptions = {
  surface: ViewUiState['surface']
  session?: string
  viewId?: string
  report?: (state: unknown) => void
}

type MountEntry = { state: ViewUiState; handlers: ViewHandlers; report?: (state: unknown) => void }

export type ViewUiInstance = {
  readonly id: string
  update(patch: ViewUiPatch): void
  setHandlers(handlers: ViewHandlers): void
  clearHandlers(...names: (keyof ViewHandlers)[]): void
  dispose(): void
}

const STALE_INSTANCE = 'View UI instance is no longer mounted.'
const NOT_OPEN_TAB = 'View is not an open pane tab.'
const NO_PENDING_LINK = 'No link is awaiting confirmation.'
const INVALID_CONTROL = 'Invalid view control arguments.'

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error(`Invalid ${label}.`)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${label}.`)
  return value
}

function requiredArgument(args: Record<string, unknown>, key: string, label: string): string {
  if (!Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`Invalid ${label}.`)
  return requiredText(args[key], label)
}

function moveArgs(value: unknown): { viewId: string; placement: ViewPlacement } {
  const args = requireObject(value, 'view move arguments')
  exactKeys(args, ['viewId', 'placement'], 'view move arguments')
  const viewId = requiredArgument(args, 'viewId', 'view ID')
  if (!Object.prototype.hasOwnProperty.call(args, 'placement') || (args.placement !== 'inline' && args.placement !== 'pane')) {
    throw new Error('Invalid view placement.')
  }
  return { viewId, placement: args.placement }
}

function actionArgs(value: unknown): { viewId: string; name: string; source: string; data?: Record<string, unknown> } {
  const args = requireObject(value, 'view action arguments')
  exactKeys(args, ['viewId', 'name', 'source', 'data'], 'view action arguments')
  const viewId = requiredArgument(args, 'viewId', 'view ID')
  const name = requiredArgument(args, 'name', 'view action name')
  const source = requiredArgument(args, 'source', 'view action source')
  if (!Object.prototype.hasOwnProperty.call(args, 'data')) return { viewId, name, source }
  const data = requireObject(args.data, 'view action data')
  return { viewId, name, source, data }
}

function controlArgs(value: unknown): ViewControl {
  const args = requireObject(value, 'view control arguments')
  const action = requiredArgument(args, 'action', 'view control action')
  if (action === 'state') {
    exactKeys(args, ['action'], 'view control arguments')
    return { action }
  }

  const instance = requiredArgument(args, 'instance', 'view UI instance')
  if (action === 'refresh') {
    exactKeys(args, ['instance', 'action'], 'view control arguments')
    return { instance, action }
  }
  const viewId = requiredArgument(args, 'viewId', 'view ID')
  if (action === 'select-tab' || action === 'dismiss-tab') {
    exactKeys(args, ['instance', 'action', 'viewId'], 'view control arguments')
    return { instance, action, viewId }
  }
  if (action === 'link-preview') {
    exactKeys(args, ['instance', 'action', 'viewId', 'href'], 'view control arguments')
    return { instance, action, viewId, href: requiredArgument(args, 'href', 'link URL') }
  }
  if (action === 'link-cancel' || action === 'link-confirm') {
    exactKeys(args, ['instance', 'action', 'viewId'], 'view control arguments')
    return { instance, action, viewId }
  }
  throw new Error(INVALID_CONTROL)
}

function validateLink(href: string): string {
  if (href.trim() !== href) throw new Error('Invalid link URL.')
  let url: URL
  try {
    url = new URL(href)
  } catch {
    throw new Error('Invalid link URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid link URL.')
  return href
}

function snapshot(state: ViewUiState): ViewUiState {
  return { ...state, tabs: state.tabs.map((tab) => ({ ...tab })) }
}

/** Routes view commands to explicit live mounts without changing daemon authority. */
export function createViewUiController(context: UiPluginContext): { mount(options: MountOptions): ViewUiInstance } {
  const mounts = new Map<string, MountEntry>()

  const mount = (options: MountOptions): ViewUiInstance => {
    let id = globalThis.crypto.randomUUID()
    while (mounts.has(id)) id = globalThis.crypto.randomUUID()

    const state: ViewUiState = {
      instance: id,
      surface: options.surface,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.viewId === undefined ? {} : { viewId: options.viewId }),
      activeViewId: options.viewId ?? null,
      phase: 'loading',
      tabs: [],
      pendingLink: null
    }
    const entry: MountEntry = { state, handlers: {}, ...(options.report === undefined ? {} : { report: options.report }) }
    mounts.set(id, entry)

    reportEntry(entry, mounts, context)

    return {
      id,
      update(patch) {
        if (mounts.get(id) !== entry) return
        const activeChanged = patch.activeViewId !== undefined && patch.activeViewId !== entry.state.activeViewId
        entry.state = {
          ...entry.state,
          ...patch,
          ...(activeChanged ? { pendingLink: null } : {}),
          tabs: patch.tabs === undefined ? entry.state.tabs : patch.tabs.map((tab) => ({ ...tab }))
        }
        if (activeChanged || patch.pendingLink === null) entry.handlers.cancelLink?.()
        reportEntry(entry, mounts, context)
      },
      setHandlers(handlers) {
        if (mounts.get(id) === entry) entry.handlers = { ...entry.handlers, ...handlers }
      },
      clearHandlers(...names) {
        if (mounts.get(id) !== entry) return
        const next = { ...entry.handlers }
        for (const name of names) delete next[name]
        entry.handlers = next
      },
      dispose() {
        if (mounts.get(id) === entry) mounts.delete(id)
      }
    }
  }

  const getMount = (instance: string): MountEntry => {
    const entry = mounts.get(instance)
    if (!entry) throw new Error(STALE_INSTANCE)
    return entry
  }

  const stateCommand = (): { instances: ViewUiState[] } => ({ instances: [...mounts.values()].map(({ state }) => snapshot(state)) })

  const controlCommand = async (value: unknown): Promise<{ ok: true } | { instances: ViewUiState[] }> => {
    const command = controlArgs(value)
    if (command.action === 'state') return stateCommand()

    const entry = getMount(command.instance)
    if (command.action === 'refresh') {
      if (!entry.handlers.refresh) throw new Error('View refresh is not available for this mount.')
      await entry.handlers.refresh()
      return { ok: true }
    }

    if (command.action === 'select-tab' || command.action === 'dismiss-tab') {
      if (entry.state.surface !== 'view:quirky.view/pane' || !entry.state.tabs.some((tab) => tab.viewId === command.viewId)) {
        throw new Error(NOT_OPEN_TAB)
      }
      const handler = command.action === 'select-tab' ? entry.handlers.selectTab : entry.handlers.dismissTab
      if (!handler) throw new Error('View tab action is not available for this mount.')
      await handler(command.viewId)
      return { ok: true }
    }

    if (entry.state.activeViewId !== command.viewId) throw new Error('View is not the active card.')
    if (command.action === 'link-preview') {
      const href = validateLink(command.href)
      if (!entry.handlers.previewLink) throw new Error('View link preview is not available for this mount.')
      entry.handlers.previewLink(href)
      entry.state = { ...entry.state, pendingLink: href }
      reportEntry(entry, mounts, context)
      return { ok: true }
    }

    if (command.action === 'link-cancel') {
      entry.state = { ...entry.state, pendingLink: null }
      entry.handlers.cancelLink?.()
      reportEntry(entry, mounts, context)
      return { ok: true }
    }

    if (entry.state.pendingLink === null) throw new Error(NO_PENDING_LINK)
    const target = entry.state.pendingLink
    entry.state = { ...entry.state, pendingLink: null }
    entry.handlers.cancelLink?.()
    reportEntry(entry, mounts, context)
    await context.call('quirky.terminal/openExternal', { target })
    return { ok: true }
  }

  context.provide(MOVE_COMMAND_ID, async (value?: unknown) => {
    const args = moveArgs(value)
    return context.call('quirky.view/move', args)
  })
  context.provide(ACTION_COMMAND_ID, async (value?: unknown) => {
    const args = actionArgs(value)
    return context.call('quirky.view/action', args)
  })
  context.provide(CONTROL_COMMAND_ID, controlCommand)

  return { mount }
}

function reportEntry(entry: MountEntry, mounts: Map<string, MountEntry>, context: UiPluginContext): void {
  if (mounts.get(entry.state.instance) !== entry || !entry.report) return
  try {
    entry.report(snapshot(entry.state))
  } catch (error) {
    context.log(`could not report view UI state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

