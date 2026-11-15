import type { UiPluginContext } from '@quirky/protocol'

export const PANE_UI_CONTROL_COMMAND = 'command:quirky.browser/paneUiControl'
export const PANE_UI_CONTROL_ACTIONS = ['open-find', 'dismiss-message', 'retry-watch', 'retry-native', 'dismiss-page-error', 'close-browser-menu', 'close-history-menu'] as const
export type PaneUiControlAction = typeof PANE_UI_CONTROL_ACTIONS[number]
export type PaneUiControlArgs = { action: PaneUiControlAction; pane: string }
export type PaneUiControlResult = { pane: string; action: PaneUiControlAction; delivered: number }
export const DESIGN_CONTROL_COMMAND = 'command:quirky.browser/designControl'
export const DESIGN_CONTROL_ACTIONS = [
  'toggle-grab',
  'toggle-annotate',
  'draw',
  'copy-selection',
  'copy-selection-screenshot',
  'select-another',
  'cancel-selection',
  'set-intent',
  'save-annotation',
  'close-annotation',
  'edit-annotation',
  'delete-annotation',
  'copy-annotation',
  'toggle-annotations',
  'open-targets',
  'close-targets',
  'copy-annotations',
  'clear-annotations',
  'send-annotations',
  'markup-tool',
  'markup-undo',
  'markup-redo',
  'markup-clear',
  'markup-close',
  'markup-copy'
] as const
export const MARKUP_TOOLS = ['pen', 'highlighter', 'arrow', 'rectangle', 'ellipse', 'text', 'eraser'] as const
export type MarkupTool = typeof MARKUP_TOOLS[number]
export type DesignControlAction = typeof DESIGN_CONTROL_ACTIONS[number]
export type DesignControlArgs = {
  action: DesignControlAction
  pane: string
  annotation?: number
  intent?: 'change' | 'question'
  session?: string
  agent?: string
  tool?: MarkupTool
}
export type DesignControlResult = { pane: string; action: DesignControlAction; delivered: number }

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
const designControllers = controllerRegistry<DesignControlArgs>()
const markupControllers = controllerRegistry<DesignControlArgs>()

export function registerPaneUiController(context: UiPluginContext, pane: string, handler: (args: PaneUiControlArgs) => void): () => void {
  return paneControllers.register(context, pane, handler)
}
export function registerDesignController(context: UiPluginContext, pane: string, handler: (args: DesignControlArgs) => void): () => void {
  return designControllers.register(context, pane, handler)
}

export function registerMarkupController(context: UiPluginContext, pane: string, handler: (args: DesignControlArgs) => void): () => void {
  return markupControllers.register(context, pane, handler)
}

const DESIGN_CONTROL_INVALID = 'Browser design control needs a known action, a non-empty pane id and the fields that action takes.'

function normalizeDesignControlArgs(value: unknown): DesignControlArgs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(DESIGN_CONTROL_INVALID)
  }
  const action = Reflect.get(value, 'action')
  const pane = Reflect.get(value, 'pane')
  if (typeof action !== 'string' || !DESIGN_CONTROL_ACTIONS.includes(action as DesignControlAction) || typeof pane !== 'string' || pane === '') {
    throw new Error(DESIGN_CONTROL_INVALID)
  }

  const request: DesignControlArgs = { action: action as DesignControlAction, pane }
  switch (request.action) {
    case 'edit-annotation':
    case 'delete-annotation':
    case 'copy-annotation': {
      const annotation = Reflect.get(value, 'annotation')
      if (typeof annotation !== 'number' || !Number.isInteger(annotation) || annotation < 1 || annotation > 20) {
        throw new Error(DESIGN_CONTROL_INVALID)
      }
      request.annotation = annotation
      break
    }
    case 'set-intent': {
      const intent = Reflect.get(value, 'intent')
      if (intent !== 'change' && intent !== 'question') throw new Error(DESIGN_CONTROL_INVALID)
      request.intent = intent
      break
    }
    case 'send-annotations': {
      const hasSession = Reflect.has(value, 'session')
      const hasAgent = Reflect.has(value, 'agent')
      if (hasSession === hasAgent) throw new Error(DESIGN_CONTROL_INVALID)
      const target = Reflect.get(value, hasSession ? 'session' : 'agent')
      if (typeof target !== 'string' || target === '') throw new Error(DESIGN_CONTROL_INVALID)
      if (hasSession) request.session = target
      else request.agent = target
      break
    }
    case 'markup-tool': {
      const tool = Reflect.get(value, 'tool')
      if (typeof tool !== 'string' || !MARKUP_TOOLS.includes(tool as MarkupTool)) {
        throw new Error(DESIGN_CONTROL_INVALID)
      }
      request.tool = tool as MarkupTool
      break
    }
  }
  return request
}

export function dispatchDesignControl(context: UiPluginContext, args: unknown): DesignControlResult {
  const request = normalizeDesignControlArgs(args)
  const controllers = request.action.startsWith('markup-') ? markupControllers : designControllers
  const delivered = controllers.dispatch(context, request.pane, request)
  return { pane: request.pane, action: request.action, delivered }
}

export function requestDesignControl(context: UiPluginContext, args: DesignControlArgs): Promise<void> {
  return context.executeCommand(DESIGN_CONTROL_COMMAND, args, { activateOwner: false })
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
