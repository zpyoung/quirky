import type { UiPluginContext } from '@quirky/protocol'
import { currentWindowId } from './actions'

export const UI_CONTROL_COMMAND = 'command:quirky.worktree/uiControl'

export const UI_CONTROL_ACTIONS = [
  'open-workspace-menu',
  'close-workspace-menu',
  'open-vm-menu',
  'close-vm-menu',
  'add-reference',
  'unlink-reference'
] as const

type LegacyUiControlArgs =
  | { action: 'open-workspace-menu' | 'close-workspace-menu'; workspace: string }
  | { action: 'open-vm-menu' | 'close-vm-menu'; vm: string }
  | { action: 'add-reference'; worktree: string; url: string; label: string }
  | { action: 'unlink-reference'; worktree: string; url: string }


/** A scope-owned draft operation addressed by its public resource id. */
export type ScopedUiControlArgs = {
  action: 'control'
  scope: string
  target: string
  operation: string
  payload: Record<string, unknown>
}

/** Requests may omit payload; dispatch normalizes that omission to an empty object. */
export type ScopedUiControlInput = Omit<ScopedUiControlArgs, 'payload'> & {
  payload?: Record<string, unknown>
}

export type UiControlArgs = LegacyUiControlArgs | ScopedUiControlArgs
export type UiControlInput = LegacyUiControlArgs | ScopedUiControlInput
export type UiControlResult = UiControlArgs & { delivered: number }
export type UiControlTarget = 'remote-workspaces' | 'vm-environments' | 'worktree-details'

type UiControlHandler = (args: UiControlArgs) => boolean

type Controllers = Map<UiControlTarget, Set<UiControlHandler>>
const controllersByContext = new WeakMap<UiPluginContext, Controllers>()
type ScopedUiControlHandler = (args: ScopedUiControlArgs) => boolean
const scopesByContext = new WeakMap<UiPluginContext, Map<string, Set<ScopedUiControlHandler>>>()
const INVALID_ARGS = 'Worktree UI control needs a known action and its target.'

type UiControlPayload = {
  action?: unknown
  workspace?: unknown
  vm?: unknown
  worktree?: unknown
  url?: unknown
  label?: unknown
  scope?: unknown
  target?: unknown
  operation?: unknown
  payload?: unknown
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function invalidArgs(): never {
  throw new Error(INVALID_ARGS)
}

function normalizeUiControlArgs(raw: unknown): UiControlArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalidArgs()
  const value = raw as UiControlPayload

  switch (value.action) {
    case 'control':
      if (!isNonBlankString(value.scope) || !isNonBlankString(value.target) || !isNonBlankString(value.operation)) return invalidArgs()
      if (value.payload !== undefined && (typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload))) return invalidArgs()
      return {
        action: 'control',
        scope: value.scope,
        target: value.target,
        operation: value.operation,
        payload: value.payload === undefined ? {} : value.payload as Record<string, unknown>
      }
    case 'open-workspace-menu':
    case 'close-workspace-menu':
      if (!isNonBlankString(value.workspace)) return invalidArgs()
      return { action: value.action, workspace: value.workspace }
    case 'open-vm-menu':
    case 'close-vm-menu':
      if (!isNonBlankString(value.vm)) return invalidArgs()
      return { action: value.action, vm: value.vm }
    case 'add-reference':
      if (!isNonBlankString(value.worktree) || !isNonBlankString(value.url)) return invalidArgs()
      if (value.label !== undefined && typeof value.label !== 'string') return invalidArgs()
      return {
        action: 'add-reference',
        worktree: value.worktree,
        url: value.url,
        label: typeof value.label === 'string' ? value.label : ''
      }
    case 'unlink-reference':
      if (!isNonBlankString(value.worktree) || !isNonBlankString(value.url)) return invalidArgs()
      return { action: 'unlink-reference', worktree: value.worktree, url: value.url }
    default:
      return invalidArgs()
  }
}

function targetFor(args: LegacyUiControlArgs): UiControlTarget {
  switch (args.action) {
    case 'open-workspace-menu':
    case 'close-workspace-menu':
      return 'remote-workspaces'
    case 'open-vm-menu':
    case 'close-vm-menu':
      return 'vm-environments'
    case 'add-reference':
    case 'unlink-reference':
      return 'worktree-details'
  }
}

/** Registers a mounted target controller and returns its cleanup function. */
export function registerUiController(
  context: UiPluginContext,
  target: UiControlTarget,
  handler: (args: UiControlArgs) => boolean
): () => void {
  let controllers = controllersByContext.get(context)
  if (!controllers) {
    controllers = new Map()
    controllersByContext.set(context, controllers)
  }

  let handlers = controllers.get(target)
  if (!handlers) {
    handlers = new Set()
    controllers.set(target, handlers)
  }

  // keep registrations distinct when mounts reuse the same callback
  const registration: UiControlHandler = (args) => handler(args)
  handlers.add(registration)

  return () => {
    if (!handlers.delete(registration)) return
    if (handlers.size !== 0) return
    controllers.delete(target)
    if (controllers.size === 0) controllersByContext.delete(context)
  }
}

/** Registers an independent mounted scope; only accepted operations count toward delivery. */
export function registerUiControlScope(
  context: UiPluginContext,
  scope: string,
  handler: (args: ScopedUiControlArgs) => boolean
): () => void {
  if (!isNonBlankString(scope)) return invalidArgs()
  let scopes = scopesByContext.get(context)
  if (!scopes) {
    scopes = new Map()
    scopesByContext.set(context, scopes)
  }
  let handlers = scopes.get(scope)
  if (!handlers) {
    handlers = new Set()
    scopes.set(scope, handlers)
  }
  const registration: ScopedUiControlHandler = (args) => handler(args)
  handlers.add(registration)
  return () => {
    if (!handlers.delete(registration)) return
    if (handlers.size !== 0) return
    scopes.delete(scope)
    if (scopes.size === 0) scopesByContext.delete(context)
  }
}

/** Validates an action and dispatches it to matching mounted targets. */
export function dispatchUiControl(context: UiPluginContext, args: unknown): UiControlResult {
  const normalized = normalizeUiControlArgs(args)
  if (normalized.action === 'control') {
    const handlers = scopesByContext.get(context)?.get(normalized.scope)
    let delivered = 0
    if (handlers) {
      for (const handler of handlers) {
        if (handler(normalized)) delivered++
      }
    }
    return { ...normalized, delivered }
  }
  const handlers = controllersByContext.get(context)?.get(targetFor(normalized))
  let delivered = 0
  if (handlers) {
    for (const handler of handlers) {
      if (handler(normalized)) delivered++
    }
  }
  return { ...normalized, delivered } as UiControlResult
}

function uiControlRequest(args: UiControlInput): { command: typeof UI_CONTROL_COMMAND; args: UiControlInput } {
  return { command: UI_CONTROL_COMMAND, args }
}

/** Sends an action to this context's current window and returns its delivery result. */
export async function requestUiControl(context: UiPluginContext, args: UiControlInput): Promise<UiControlResult> {
  const connId = await currentWindowId(context)
  const request = uiControlRequest(args)
  const reply = await context.call('ui.window.command.run', {
    connId,
    id: request.command,
    args: request.args
  })
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply) || !('result' in reply)) {
    throw new Error('The window returned no UI control result.')
  }
  const result = reply.result
  if (typeof result !== 'object' || result === null || Array.isArray(result) || !('delivered' in result) || typeof result.delivered !== 'number') {
    throw new Error('The window returned no UI control result.')
  }
  return result as unknown as UiControlResult
}
