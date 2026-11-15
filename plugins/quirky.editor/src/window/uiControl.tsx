import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

export type EditorUiControl = {
  surface: string
  target: string
  generation: string
  action: string
  data?: Record<string, unknown>
}

export type EditorUiControlAddress = {
  surface: string
  target: string
  generation: string
  actions: string[]
}

export type EditorUiControlResult = { delivered: boolean }
export type EditorUiControlHandler = (control: EditorUiControl) => Promise<EditorUiControlResult>
export const EDITOR_UI_CONTROL_COMMAND = 'command:quirky.editor/ui-control'

export type EditorUiControlReportScope = {
  readonly surface: string
  report(state: unknown): void
  dispose(): void
}

export type EditorUiControlReportOptions = { surface: string; context?: UiPluginContext }

export type UseEditorUiControlOptions = {
  context: UiPluginContext
  address: EditorUiControlAddress | null
  handler: EditorUiControlHandler
  onError?(error: Error): void
}

export type EditorUiControlActions = {
  run(action: string, data?: Record<string, unknown>): Promise<EditorUiControlResult>
  isCurrent(): boolean
}

type RegistryEntry = {
  key: string
  address: EditorUiControlAddress
  handler: EditorUiControlHandler
  owner?: ScopeState
  token?: object
}

type ScopeState = {
  context?: UiPluginContext
  latestReport: unknown
  hasReport: boolean
  active: boolean
  onReport?(report: unknown): void
}

type ControlRecord = Record<string, unknown>

const registry = new Map<string, RegistryEntry>()
const reportScopes = new Set<ScopeState>()
const reportScopeState = new WeakMap<EditorUiControlReportScope, ScopeState>()
const EditorUiControlScopeContext = createContext<EditorUiControlReportScope | null>(null)

const NOT_AVAILABLE_MESSAGE = 'The editor control is no longer available.'
const BRIDGE_RESPONSE_MESSAGE = 'The editor control bridge returned an invalid response.'

function isRecord(value: unknown): value is ControlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function onlyKeys(value: ControlRecord, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
}

function hasOwnKeys(value: ControlRecord, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key))
}

function validateAddress(value: unknown): EditorUiControlAddress | null {
  if (!isRecord(value) || !onlyKeys(value, ['surface', 'target', 'generation', 'actions']) ||
    !hasOwnKeys(value, ['surface', 'target', 'generation', 'actions'])) return null
  if (!isNonEmptyString(value.surface) || !isNonEmptyString(value.target) || !isNonEmptyString(value.generation)) return null
  if (!Array.isArray(value.actions)) return null
  const actions = Array.from(value.actions)
  if (actions.some((action) => !isNonEmptyString(action)) || new Set(actions).size !== actions.length) return null
  return { surface: value.surface, target: value.target, generation: value.generation, actions }
}

function parseControl(value: unknown): EditorUiControl | null {
  if (!isRecord(value) || !onlyKeys(value, ['surface', 'target', 'generation', 'action', 'data']) ||
    !hasOwnKeys(value, ['surface', 'target', 'generation', 'action'])) return null
  if (!isNonEmptyString(value.surface) || !isNonEmptyString(value.target) || !isNonEmptyString(value.generation) || !isNonEmptyString(value.action)) return null
  if (Object.hasOwn(value, 'data') && !isRecord(value.data)) return null
  return {
    surface: value.surface,
    target: value.target,
    generation: value.generation,
    action: value.action,
    ...(Object.hasOwn(value, 'data') ? { data: value.data as Record<string, unknown> } : {})
  }
}

function identityKey(address: Pick<EditorUiControlAddress, 'surface' | 'target' | 'generation'>): string {
  return JSON.stringify([address.surface, address.target, address.generation])
}

function parseResult(value: unknown): EditorUiControlResult | null {
  if (!isRecord(value) || !onlyKeys(value, ['delivered']) || !hasOwnKeys(value, ['delivered']) || typeof value.delivered !== 'boolean') return null
  return { delivered: value.delivered }
}

function latestAddresses(scope: ScopeState): EditorUiControlAddress[] {
  return [...registry.values()]
    .filter((entry) => entry.owner === scope)
    .map(({ address }) => ({ ...address, actions: [...address.actions] }))
}

function publishScope(scope: ScopeState): void {
  if (!scope.active || !scope.hasReport) return
  const raw = scope.latestReport
  const fields = isRecord(raw) ? raw : {}
  const report = raw === null || raw === undefined || isRecord(raw) ? fields : { value: raw }
  scope.onReport?.({ ...report, uiControls: latestAddresses(scope) })
}

function notifyScopes(): void {
  for (const scope of reportScopes) publishScope(scope)
}

function registerControl(
  address: EditorUiControlAddress,
  handler: EditorUiControlHandler,
  owner?: ScopeState,
  token?: object
): RegistryEntry {
  const entry: RegistryEntry = {
    key: identityKey(address),
    address: { ...address, actions: [...address.actions] },
    handler,
    owner,
    token
  }
  registry.set(entry.key, entry)
  notifyScopes()
  return entry
}

function unregisterControl(entry: RegistryEntry): void {
  if (registry.get(entry.key) !== entry) return
  registry.delete(entry.key)
  notifyScopes()
}

export function registerEditorUiControl(
  address: EditorUiControlAddress,
  handler: EditorUiControlHandler
): () => void {
  const validAddress = validateAddress(address)
  if (!validAddress) throw new TypeError('Invalid editor UI control address.')
  if (typeof handler !== 'function') throw new TypeError('Editor UI control handler must be a function.')
  const entry = registerControl(validAddress, handler)
  return () => unregisterControl(entry)
}

export function clearEditorUiControls(): void {
  if (registry.size === 0) return
  registry.clear()
  notifyScopes()
}

export function editorUiControlDescriptor(args: EditorUiControl): {
  command: typeof EDITOR_UI_CONTROL_COMMAND
  args: EditorUiControl
} {
  if (!parseControl(args)) throw new TypeError('Invalid editor UI control command arguments.')
  return { command: EDITOR_UI_CONTROL_COMMAND, args }
}

export async function requestEditorUiControl(
  context: UiPluginContext,
  args: EditorUiControl
): Promise<EditorUiControlResult> {
  const descriptor = editorUiControlDescriptor(args)
  const identity: unknown = await context.call('ui.window.self', {})
  if (!isRecord(identity) || !Object.hasOwn(identity, 'connId') ||
    typeof identity.connId !== 'number' || !Number.isSafeInteger(identity.connId) || identity.connId <= 0) {
    throw new Error('The daemon did not identify this window.')
  }
  const response: unknown = await context.call('ui.window.command.run', {
    connId: identity.connId,
    id: descriptor.command,
    args: descriptor.args
  })
  if (!isRecord(response) || !onlyKeys(response, ['result']) || !hasOwnKeys(response, ['result'])) throw new Error(BRIDGE_RESPONSE_MESSAGE)
  const result = parseResult(response.result)
  if (!result) throw new Error(BRIDGE_RESPONSE_MESSAGE)
  return result
}

export async function runEditorUiControl(rawArgs: unknown): Promise<EditorUiControlResult> {
  const control = parseControl(rawArgs)
  if (!control) return { delivered: false }
  const key = identityKey(control)
  const entry = registry.get(key)
  if (!entry || !entry.address.actions.includes(control.action)) return { delivered: false }
  const result = parseResult(await entry.handler(control))
  if (!result) return { delivered: false }
  return result
}

export function createEditorUiControlReportScope(
  onReport: ((report: unknown) => void) | undefined,
  options: EditorUiControlReportOptions
): EditorUiControlReportScope {
  if (!isNonEmptyString(options?.surface)) throw new TypeError('Editor UI control report scope requires a surface.')
  const state: ScopeState = {
    context: options.context,
    latestReport: undefined,
    hasReport: false,
    active: true,
    onReport
  }
  const scope: EditorUiControlReportScope = {
    surface: options.surface,
    report(report) {
      if (!state.active) return
      state.latestReport = isRecord(state.latestReport) && isRecord(report)
        ? { ...state.latestReport, ...report }
        : report
      state.hasReport = true
      publishScope(state)
    },
    dispose() {
      if (!state.active) return
      state.active = false
      reportScopes.delete(state)
      let changed = false
      for (const [key, entry] of registry) {
        if (entry.owner === state) {
          registry.delete(key)
          changed = true
        }
      }
      if (changed) notifyScopes()
    }
  }
  reportScopeState.set(scope, state)
  reportScopes.add(state)
  return scope
}

export function EditorUiControlProvider({
  scope,
  children
}: {
  scope: EditorUiControlReportScope
  children: ReactNode
}) {
  if (!reportScopeState.get(scope)?.active) throw new Error('Editor UI control report scope is not active.')
  return <EditorUiControlScopeContext.Provider value={scope}>{children}</EditorUiControlScopeContext.Provider>
}

function useRequiredScope(): EditorUiControlReportScope {
  const scope = useContext(EditorUiControlScopeContext)
  if (!scope || !reportScopeState.get(scope)?.active) {
    throw new Error('Editor UI controls must be used inside an EditorUiControlProvider.')
  }
  return scope
}

export function useEditorUiControlReport(): (state: unknown) => void {
  const scope = useRequiredScope()
  return scope.report
}

export function useEditorUiControlSurface(): string {
  return useRequiredScope().surface
}

/** Returns the public context belonging to the nearest mounted Editor surface. */
export function useEditorUiControlContext(): UiPluginContext {
  const context = reportScopeState.get(useRequiredScope())?.context
  if (!context) throw new Error('Editor UI control mount scope has no plugin context.')
  return context
}

function errorOf(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : String(reason))
}

export function useEditorUiControl({
  context,
  address,
  handler,
  onError
}: UseEditorUiControlOptions): EditorUiControlActions {
  const scope = useRequiredScope()
  const validAddress = address === null ? null : validateAddress(address)
  if (address !== null && !validAddress) throw new TypeError('Invalid editor UI control address.')
  if (validAddress && validAddress.surface !== scope.surface) {
    throw new Error(`Editor UI control surface ${validAddress.surface} does not match its mount scope ${scope.surface}.`)
  }
  const key = validAddress ? identityKey(validAddress) : null
  const actionsKey = validAddress ? JSON.stringify(validAddress.actions) : null
  const token = useMemo(() => ({}), [scope, key, actionsKey])
  const addressRef = useRef(validAddress)
  const handlerRef = useRef(handler)
  const onErrorRef = useRef(onError)
  const registrationRef = useRef<RegistryEntry | null>(null)
  addressRef.current = validAddress
  handlerRef.current = handler
  onErrorRef.current = onError

  const isCurrent = useCallback(() => {
    const entry = registrationRef.current
    const owner = reportScopeState.get(scope)
    return entry !== null && entry.token === token && registry.get(entry.key) === entry && entry.owner === owner && owner?.active === true
  }, [scope, token])

  useEffect(() => {
    const currentAddress = addressRef.current
    if (!currentAddress || !key) return
    const owner = reportScopeState.get(scope)
    if (!owner?.active) return
    let entry: RegistryEntry
    entry = registerControl(currentAddress, async (control) => {
      if (!isCurrent() || registrationRef.current !== entry) return { delivered: false }
      return handlerRef.current(control)
    }, owner, token)
    registrationRef.current = entry
    return () => {
      if (registrationRef.current === entry) registrationRef.current = null
      unregisterControl(entry)
    }
  }, [scope, key, actionsKey, token, isCurrent])

  async function run(action: string, data?: Record<string, unknown>): Promise<EditorUiControlResult> {
    const current = addressRef.current
    if (!current || !current.actions.includes(action) || !isCurrent()) return { delivered: false }
    const args: EditorUiControl = {
      surface: current.surface,
      target: current.target,
      generation: current.generation,
      action,
      ...(data === undefined ? {} : { data })
    }
    try {
      const result = await requestEditorUiControl(context, args)
      if (!result.delivered && isCurrent()) onErrorRef.current?.(new Error(NOT_AVAILABLE_MESSAGE))
      return result
    } catch (reason) {
      if (isCurrent()) onErrorRef.current?.(errorOf(reason))
      return { delivered: false }
    }
  }
  const stableRun = useCallback(run, [context, isCurrent])

  return { run: stableRun, isCurrent }
}
