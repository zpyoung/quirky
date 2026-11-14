import type { UiPluginContext } from '@quirky/protocol'

export const PANE_UI_CONTROL_COMMAND = 'command:quirky.browser/paneUiControl'
export const PANE_UI_CONTROL_ACTIONS = ['open-find', 'dismiss-message', 'retry-watch', 'retry-native', 'dismiss-page-error', 'close-browser-menu', 'close-history-menu'] as const
export type PaneUiControlAction = typeof PANE_UI_CONTROL_ACTIONS[number]
export type PaneUiControlArgs = { action: PaneUiControlAction; pane: string }
export type PaneUiControlResult = { pane: string; action: PaneUiControlAction; delivered: number }

type Registration<T> = { handler: (args: T) => void }

function controllerRegistry<T>() {
  const contexts = new WeakMap<UiPluginContext, Map<string, Set<Registration<T>>>>()
  return {
    register(context: UiPluginContext, key: string, handler: (args: T) => void): () => void {
      let registry = contexts.get(context)
      if (!registry) contexts.set(context, registry = new Map())
      let handlers = registry.get(key)
      if (!handlers) registry.set(key, handlers = new Set())
      let active = true
      const registration = { handler }
      handlers.add(registration)
      return () => {
        if (!active) return
        active = false
        handlers.delete(registration)
        if (handlers.size === 0) registry.delete(key)
        if (registry.size === 0) contexts.delete(context)
      }
    },
    dispatch(context: UiPluginContext, key: string, args: T): number {
      const handlers = contexts.get(context)?.get(key)
      if (!handlers) return 0
      let delivered = 0
      for (const { handler } of handlers) {
        handler(args)
        delivered++
      }
      return delivered
    }
  }
}

const paneControllers = controllerRegistry<PaneUiControlArgs>()

export function registerPaneUiController(context: UiPluginContext, pane: string, handler: (args: PaneUiControlArgs) => void): () => void {
  return paneControllers.register(context, pane, handler)
}

export function dispatchPaneUiControl(context: UiPluginContext, args: unknown): PaneUiControlResult {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Browser pane control needs a known action and a non-empty pane id.')
  }
  const action = Reflect.get(args, 'action')
  const pane = Reflect.get(args, 'pane')
  if (typeof action !== 'string' || !PANE_UI_CONTROL_ACTIONS.includes(action as PaneUiControlAction) || typeof pane !== 'string' || pane === '') {
    throw new Error('Browser pane control needs a known action and a non-empty pane id.')
  }
  const request: PaneUiControlArgs = { action: action as PaneUiControlAction, pane }
  return { ...request, delivered: paneControllers.dispatch(context, pane, request) }
}

export async function requestPaneUiControl(context: UiPluginContext, args: PaneUiControlArgs): Promise<void> {
  await context.executeCommand(PANE_UI_CONTROL_COMMAND, args, { activateOwner: false })
}

export function browserPaneControlInstance(pane: string, part: 'profile-menu' | 'import-hint'): string {
  return `browser-pane:${pane}:${part}`
}
