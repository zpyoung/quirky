import { useEffect, useRef } from 'react'
import type { MountCleanup, MountFunction, UiPluginContext } from '@quirky/protocol'

export const GIT_UI_CONTROL_COMMAND = 'command:quirky.git/ui-control' as const
const UNAVAILABLE_ACTION = 'The source control action is no longer available.'

export type GitUiControl = {
  surface: string
  target: string
  generation: string
  action: string
  data?: Record<string, unknown>
}

export type GitUiControlAddress = {
  surface: string
  target: string
  generation: string
  actions: string[]
}

export type GitUiControlResult = { delivered: boolean }

export type GitUiControlHandler = (control: GitUiControl) => boolean

type Registration = {
  address: GitUiControlAddress
  handler: GitUiControlHandler
  scope?: ControlScope
}

type OwnerRegistry = Map<string, Registration>

type ControlScope = {
  owner: UiPluginContext
  surface: string
  registry: OwnerRegistry
  registrations: Map<string, Registration>
  report?: (state: unknown) => void
  rawReport?: unknown
  hasRawReport: boolean
  hasPublished: boolean
  disposed: boolean
}

const registries = new WeakMap<UiPluginContext, OwnerRegistry>()
const scopesByContext = new WeakMap<UiPluginContext, ControlScope>()
let generationSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function nonblankActions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  for (const action of value) {
    if (!nonblank(action)) return false
  }
  return true
}

export function canonicalContext(context: UiPluginContext): UiPluginContext {
  return scopesByContext.get(context)?.owner ?? context
}

function registryFor(context: UiPluginContext): OwnerRegistry {
  const owner = canonicalContext(context)
  let registry = registries.get(owner)
  if (!registry) {
    registry = new Map()
    registries.set(owner, registry)
  }
  return registry
}

function normalizedAddress(value: GitUiControlAddress): GitUiControlAddress {
  if (!isRecord(value) ||
      !Object.hasOwn(value, 'surface') || !Object.hasOwn(value, 'target') ||
      !Object.hasOwn(value, 'generation') || !Object.hasOwn(value, 'actions') ||
      !nonblank(value.surface) || !nonblank(value.target) || !nonblank(value.generation) ||
      !nonblankActions(value.actions)) {
    throw new Error('Git UI control address requires nonblank surface, target, generation, and actions.')
  }
  return {
    surface: value.surface,
    target: value.target,
    generation: value.generation,
    actions: [...new Set(value.actions)]
  }
}

function addressKey(address: GitUiControlAddress): string {
  return JSON.stringify([
    address.surface,
    address.target,
    address.generation,
    [...address.actions].sort()
  ])
}

function addressList(scope: ControlScope): GitUiControlAddress[] {
  return [...scope.registrations.values()]
    .map(({ address }) => ({ ...address, actions: [...address.actions] }))
    .sort((left, right) =>
      left.surface.localeCompare(right.surface) ||
      left.target.localeCompare(right.target) ||
      left.generation.localeCompare(right.generation) ||
      left.actions.join('\u0000').localeCompare(right.actions.join('\u0000'))
    )
}

function publishScope(scope: ControlScope): void {
  if (scope.disposed || !scope.report) return
  const raw = isRecord(scope.rawReport) ? scope.rawReport : {}
  scope.hasPublished = true
  scope.report({ ...raw, uiControls: addressList(scope) })
}

function disposeScope(scope: ControlScope): void {
  if (scope.disposed) return
  for (const [key, registration] of scope.registrations) {
    if (scope.registry.get(key) === registration) scope.registry.delete(key)
  }
  scope.registrations.clear()
  publishScope(scope)
  scope.disposed = true
}

function controlFromUnknown(value: unknown): GitUiControl | null {
  if (!isRecord(value)) return null
  if (Object.keys(value).some((key) => !['surface', 'target', 'generation', 'action', 'data'].includes(key))) return null
  if (!['surface', 'target', 'generation', 'action'].every((key) => Object.hasOwn(value, key))) return null
  if (!nonblank(value.surface) || !nonblank(value.target) || !nonblank(value.generation) || !nonblank(value.action)) return null
  let data: Record<string, unknown> | undefined
  if (Object.hasOwn(value, 'data')) {
    if (!isRecord(value.data)) return null
    data = { ...value.data }
  }
  return {
    surface: value.surface,
    target: value.target,
    generation: value.generation,
    action: value.action,
    ...(data === undefined ? {} : { data })
  }
}

function invalidControl(): never {
  throw new Error('Git UI control requires nonblank surface, target, generation, and action strings, with record-shaped data.')
}

export function gitUiControlDescriptor(args: GitUiControl): {
  command: typeof GIT_UI_CONTROL_COMMAND
  args: GitUiControl
} {
  let control: GitUiControl | null
  try {
    control = controlFromUnknown(args)
  } catch {
    return invalidControl()
  }
  if (!control) return invalidControl()
  return { command: 'command:quirky.git/ui-control', args: control }
}

export function dispatchGitUiControl(context: UiPluginContext, args: unknown): GitUiControlResult {
  let control: GitUiControl | null
  try {
    control = controlFromUnknown(args)
  } catch {
    return { delivered: false }
  }
  if (!control) return { delivered: false }
  const acceptedControl = control
  const registry = registries.get(canonicalContext(context))
  if (!registry) return { delivered: false }
  const matching = [...registry.values()].filter(({ address }) =>
    address.surface === acceptedControl.surface &&
    address.target === acceptedControl.target &&
    address.generation === acceptedControl.generation &&
    address.actions.includes(acceptedControl.action)
  )
  if (matching.length !== 1) return { delivered: false }
  try {
    return { delivered: matching[0]!.handler(acceptedControl) === true }
  } catch {
    return { delivered: false }
  }
}

function preservedError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) return cause
  if (typeof cause === 'string' && cause.trim() !== '') return new Error(cause)
  if (typeof cause === 'object' && cause !== null && 'message' in cause &&
      typeof cause.message === 'string' && cause.message.trim() !== '') return new Error(cause.message)
  return new Error(fallback)
}

export async function requestGitUiControl(
  context: UiPluginContext,
  args: GitUiControl
): Promise<GitUiControlResult> {
  const descriptor = gitUiControlDescriptor(args)
  let identity: unknown
  try {
    identity = await context.call('ui.window.self', {})
  } catch (cause) {
    throw preservedError(cause, UNAVAILABLE_ACTION)
  }
  if (!isRecord(identity) || typeof identity.connId !== 'number' ||
      !Number.isSafeInteger(identity.connId) || identity.connId <= 0) {
    throw new Error(UNAVAILABLE_ACTION)
  }

  let reply: unknown
  try {
    reply = await context.call('ui.window.command.run', {
      connId: identity.connId,
      id: descriptor.command,
      args: descriptor.args
    })
  } catch (cause) {
    throw preservedError(cause, UNAVAILABLE_ACTION)
  }

  let result = reply
  let unwrapped = false
  for (let depth = 0; depth < 8; depth++) {
    if (isRecord(result) && Object.hasOwn(result, 'delivered')) break
    if (!isRecord(result) || !Object.hasOwn(result, 'result')) {
      throw new Error(UNAVAILABLE_ACTION)
    }
    result = result.result
    unwrapped = true
  }
  if (!unwrapped || !isRecord(result) || !Object.hasOwn(result, 'delivered') || typeof result.delivered !== 'boolean') {
    throw new Error(UNAVAILABLE_ACTION)
  }
  return { delivered: result.delivered }
}

export function registerGitUiControl(
  context: UiPluginContext,
  address: GitUiControlAddress,
  handler: GitUiControlHandler
): () => void {
  const normalized = normalizedAddress(address)
  if (typeof handler !== 'function') throw new Error('Git UI control handler must be a function.')
  const scope = scopesByContext.get(context)
  if (scope?.disposed) throw new Error('Cannot register a Git UI control for a disposed mount.')
  if (scope && normalized.surface !== scope.surface) {
    throw new Error('Git UI control surface must match its mounted contribution.')
  }
  const registry = registryFor(context)
  const key = addressKey(normalized)
  const previous = registry.get(key)
  if (previous?.scope) previous.scope.registrations.delete(key)
  const registration: Registration = { address: normalized, handler, ...(scope ? { scope } : {}) }
  registry.set(key, registration)
  scope?.registrations.set(key, registration)
  if (previous?.scope && previous.scope !== scope) publishScope(previous.scope)
  if (scope) publishScope(scope)

  return () => {
    if (registry.get(key) !== registration) return
    registry.delete(key)
    scope?.registrations.delete(key)
    if (scope) publishScope(scope)
  }
}

export function useGitUiControl(
  context: UiPluginContext,
  address: GitUiControlAddress | null,
  handler: GitUiControlHandler
): void {
  const latestHandler = useRef(handler)
  const latestAddress = useRef(address)
  latestHandler.current = handler
  latestAddress.current = address
  const key = address === null ? null : addressKey(normalizedAddress(address))
  useEffect(() => {
    const activeAddress = latestAddress.current
    if (activeAddress === null) return
    return registerGitUiControl(context, activeAddress, (control) => latestHandler.current(control))
  }, [context, key])
}

export function newGitUiGeneration(): string {
  generationSequence++
  return `git-ui-${generationSequence}`
}

function delegatedContext(context: UiPluginContext): UiPluginContext {
  return {
    get nativeBrowser() { return context.nativeBrowser },
    get pluginId() { return context.pluginId },
    log(message) { context.log(message) },
    readClipboardText() { return context.readClipboardText() },
    nativeDropPaths(files) { return context.nativeDropPaths(files) },
    provide(contributionId, implementation) { context.provide(contributionId, implementation) },
    call(method, params) { return context.call(method, params) },
    subscribe(listener, options) { return context.subscribe(listener, options) },
    getSetting(name) { return context.getSetting(name) },
    executeCommand(id, args, options) { return context.executeCommand(id, args, options) },
    createCommandDrag(commandId, args) { return context.createCommandDrag(commandId, args) },
    consumeCommandDrag(token) { return context.consumeCommandDrag(token) },
    cancelCommandDrag(token) { context.cancelCommandDrag(token) },
    openView(id, input) { context.openView(id, input) },
    closeView() { context.closeView() },
    togglePanel(id, open) { context.togglePanel(id, open) },
    setPalette(open) { context.setPalette(open) },
    getLayout() { return context.getLayout() },
    onLayout(listener) { return context.onLayout(listener) },
    onStream(streamId, listener, options) { return context.onStream(streamId, listener, options) },
    onConnection(listener) { return context.onConnection(listener) },
    confirm(options) { return context.confirm(options) },
    toast(title, body, options) { context.toast(title, body, options) },
    setPanelBadge(panelId, count, title, tone) { context.setPanelBadge(panelId, count, title, tone) },
    setContext(key, value) { context.setContext(key, value) },
    mountView(viewId, element, input) { return context.mountView(viewId, element, input) }
  }
}

export function mountGitUiControls(
  context: UiPluginContext,
  surface: string,
  factory: (scopedContext: UiPluginContext) => MountFunction
): MountFunction {
  if (!nonblank(surface)) throw new Error('Git UI mount requires a nonblank surface.')
  return (element, props) => {
    const owner = canonicalContext(context)
    const scope: ControlScope = {
      owner,
      surface,
      registry: registryFor(owner),
      registrations: new Map(),
      report: props.report,
      hasRawReport: false,
      hasPublished: false,
      disposed: false
    }
    const scoped = delegatedContext(owner)
    scopesByContext.set(scoped, scope)
    const report = (state: unknown) => {
      if (scope.disposed) return
      scope.rawReport = state
      scope.hasRawReport = true
      publishScope(scope)
    }
    let mountedCleanup: MountCleanup | void
    try {
      mountedCleanup = factory(scoped)(element, { ...props, report })
    } catch (cause) {
      disposeScope(scope)
      throw cause
    }
    if (!scope.hasPublished && !scope.hasRawReport) publishScope(scope)

    const cleanup = (() => {
      disposeScope(scope)
      if (typeof mountedCleanup === 'function') mountedCleanup()
    }) as MountCleanup
    if (mountedCleanup && typeof mountedCleanup.updateInput === 'function') {
      const updateInput = mountedCleanup.updateInput
      cleanup.updateInput = (input) => Reflect.apply(updateInput, mountedCleanup, [input]) as boolean
    }
    return cleanup
  }
}
