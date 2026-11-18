import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { act as ReactAct, createElement as ReactCreateElement } from 'react'
import type { createRoot as ReactCreateRoot, Root } from 'react-dom/client'
import { UI_CONTROL_COMMAND, type ScopedUiControlInput, type UiControlResult } from '../src/ui-control'
import type { WorktreeStatusDefinition } from '../src/parity-types'
import type { Tag, TagColor } from '../src/view-types'
import type { StatusSettingsDialog as StatusSettingsDialogComponent } from '../src/StatusSettingsDialog'
import type { TagsPopover as TagsPopoverComponent } from '../src/TagsPopover'
import type { DeleteGroupDialog as DeleteGroupDialogComponent } from '../src/GroupDialogs'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'

const INVALID_STATUS = 'Invalid status-settings control.'
const INVALID_TAGS = 'Invalid tags-popover control.'
const CONTROL_COMMAND = UI_CONTROL_COMMAND

type Params = Record<string, unknown>
type Call = { method: string; params: Params }
type Provider = (args: unknown) => unknown
type Listener = (event: QuirkyEvent) => void
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
type HarnessOptions = { connId?: number; onCall?(method: string, params: Params): unknown }
type Harness = {
  connId: number
  context: UiPluginContext
  calls: Call[]
  toasts: Array<{ title: string; body: string }>
  logs: string[]
  listeners: Set<Listener>
  connections: Set<(status: string) => void>
  provided: Map<string, Provider>
  executed: string[]
  setSelf(next: () => unknown | Promise<unknown>): void
  setRouteFailure(error: Error | null): void
  setWindowReply(reply: ((params: Params, result: unknown) => unknown) | null): void
  setOnCall(handler: HarnessOptions['onCall']): void
}
function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}
let StatusSettingsDialog: typeof StatusSettingsDialogComponent
let TagsPopover: typeof TagsPopoverComponent
let DeleteGroupDialog: typeof DeleteGroupDialogComponent
let activate: typeof Activate
let deactivate: typeof Deactivate
let act: typeof ReactAct
let createElement: typeof ReactCreateElement
let createRoot: typeof ReactCreateRoot
const roots: Root[] = []
const harnesses: Harness[] = []
const byConnection = new Map<number, Harness>()

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const react = await import('react')
  act = react.act
  createElement = react.createElement
  const [reactDom, status, tags, groups, ui] = await Promise.all([
    import('react-dom/client'),
    import('../src/StatusSettingsDialog'),
    import('../src/TagsPopover'),
    import('../src/GroupDialogs'),
    import('../src/ui')
  ])
  createRoot = reactDom.createRoot
  StatusSettingsDialog = status.StatusSettingsDialog
  TagsPopover = tags.TagsPopover
  DeleteGroupDialog = groups.DeleteGroupDialog
  activate = ui.activate
  deactivate = ui.deactivate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  deactivate()
  for (const harness of harnesses.splice(0)) {
    expect(harness.listeners.size).toBe(0)
    expect(harness.connections.size).toBe(0)
    byConnection.delete(harness.connId)
  }
  document.body.replaceChildren()
})

function makeHarness(options: HarnessOptions = {}) {
  const connId = options.connId ?? 7
  const calls: Call[] = []
  const toasts: Array<{ title: string; body: string }> = []
  const logs: string[] = []
  const listeners = new Set<Listener>()
  const connections = new Set<(status: string) => void>()
  const provided = new Map<string, Provider>()
  const executed: string[] = []
  let self: () => unknown | Promise<unknown> = () => ({ connId })
  let routeFailure: Error | null = null
  let windowReply: ((params: Params, result: unknown) => unknown) | null = null
  let customCall = options.onCall
  let context!: UiPluginContext

  const call = async (method: string, params: Params = {}): Promise<unknown> => {
    calls.push({ method, params })
    if (method === 'ui.window.self') return await self()
    if (method === 'ui.window.command.run') {
      if (routeFailure) throw routeFailure
      if (params.id !== CONTROL_COMMAND) throw new Error(`unexpected UI command ${String(params.id)}`)
      const target = byConnection.get(params.connId as number)
      const provider = target?.provided.get(CONTROL_COMMAND)
      if (!provider) throw new Error(`no live UI window ${String(params.connId)}`)
      if (windowReply) return windowReply(params, undefined)
      return { result: provider(params.args) }
    }
    if (method === 'ui.command.run') {
      if (params.id !== CONTROL_COMMAND) throw new Error(`unexpected UI command ${String(params.id)}`)
      const provider = provided.get(CONTROL_COMMAND)
      if (!provider) throw new Error(`no provided command ${CONTROL_COMMAND}`)
      return provider(params.args)
    }
    const custom = customCall?.(method, params)
    if (custom !== undefined) return await custom
    switch (method) {
      case 'quirky.worktree/tags': return { tags: [], assignments: {} }
      case 'quirky.worktree/tagCreate': return { tag: { id: 't-new', name: params.name, color: null } }
      case 'quirky.worktree/tagUpdate': return { tag: { id: params.id, name: 'urgent', color: params.color } }
      case 'quirky.worktree/tagAssign': return { ok: true }
      case 'quirky.worktree/setStatusDefinitions': return params.statuses
      case 'quirky.repo/groupList': return []
      case 'quirky.ledger/request': return { removalPreview: [] }
      case 'quirky.worktree/list':
      case 'quirky.session/list':
      case 'quirky.ask/list': return []
      case 'quirky.sidebar-extras/projection': return { workspaces: [] }
      default: throw new Error(`unexpected call ${method}`)
    }
  }

  context = {
    call,
    provide(id: string, handler: unknown) {
      provided.set(id, handler as Provider)
      if (id === CONTROL_COMMAND) byConnection.set(connId, harness)
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onConnection(listener: (status: string) => void) {
      connections.add(listener)
      return () => { connections.delete(listener) }
    },
    toast(title: string, body = '') { toasts.push({ title, body }) },
    log(message: string) { logs.push(message) },
    executeCommand(command: string) { executed.push(command); throw new Error('executeCommand fallback must not be used') },
    setPanelBadge() {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    mountView: () => () => {},
    openView() {},
    togglePanel() {},
    getSetting: () => undefined
  } as unknown as UiPluginContext

  const harness = {
    connId,
    context,
    calls,
    toasts,
    logs,
    listeners,
    connections,
    provided,
    executed,
    setSelf(next: () => unknown | Promise<unknown>) { self = next },
    setRouteFailure(error: Error | null) { routeFailure = error },
    setWindowReply(reply: ((params: Params, result: unknown) => unknown) | null) { windowReply = reply },
    setOnCall(handler: HarnessOptions['onCall']) { customCall = handler }
  }
  harnesses.push(harness)
  return harness
}

function install(harness: Harness): void {
  activate(harness.context)
  if (!harness.provided.has(CONTROL_COMMAND)) throw new Error('activate did not provide the Worktree UI control command')
}

function scope(scopeName: string, target: string, operation: string, payload: Params = {}): ScopedUiControlInput {
  return { action: 'control', scope: scopeName, target, operation, payload }
}

async function publicCommand(harness: Harness, args: unknown): Promise<unknown> {
  let result: unknown = undefined
  await act(async () => {
    result = await harness.context.call('ui.command.run', { id: CONTROL_COMMAND, args })
  })
  await flush()
  return result
}

function attachRoot(): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  return { host, root }
}

async function unmount(root: Root): Promise<void> {
  const index = roots.indexOf(root)
  if (index >= 0) roots.splice(index, 1)
  await act(async () => root.unmount())
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await flush()
    const value = read()
    if (value !== null && value !== undefined && value !== false) return value as T
  }
  throw new Error('UI did not reach the expected state')
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  if (!element) throw new Error('Expected a rendered control')
  await act(async () => { element.click() })
  await flush()
}

async function setText(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('HTMLInputElement.value setter is unavailable')
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

function button(label: string, root: ParentNode = document): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)
}
function labeledInput(label: string): HTMLInputElement | undefined {
  const accessible = [...document.querySelectorAll<HTMLInputElement>('input[aria-label]')]
    .find((candidate) => candidate.getAttribute('aria-label') === label)
  if (accessible) return accessible
  const fieldLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find((candidate) => candidate.textContent?.trim() === label)
  if (!fieldLabel) return undefined
  const control = document.getElementById(fieldLabel.htmlFor)
  return control instanceof HTMLInputElement ? control : undefined
}
function routeCalls(harness: Harness, operation: string): Call[] {
  return harness.calls.filter((call) => call.method === 'ui.window.command.run' &&
    (call.params.args as { operation?: unknown } | undefined)?.operation === operation)
}
function lastRoute(harness: Harness, operation: string): ScopedUiControlInput {
  const call = routeCalls(harness, operation).at(-1)
  if (!call) throw new Error(`No window request for ${operation}`)
  return call.params.args as ScopedUiControlInput
}
function payloadOf(args: ScopedUiControlInput): Params {
  return args.payload ?? {}
}
function tagsCheckbox(name: string): HTMLInputElement | undefined {
  const label = [...document.querySelectorAll<HTMLLabelElement>('.ui-checkbox')].find((candidate) => candidate.textContent?.trim() === name)
  return label?.querySelector('input') ?? undefined
}

const BUILT_INS: WorktreeStatusDefinition[] = [
  { id: 'todo', label: 'Todo', color: '#8b8b8b' },
  { id: 'in-progress', label: 'In progress', color: '#3478c5' },
  { id: 'in-review', label: 'In review', color: '#a57de8' },
  { id: 'done', label: 'Done', color: '#48a878' }
]
const tag = (id: string, name: string, color: TagColor | null = null): Tag => ({ id, name, color })
function snapshot(tags: Tag[], assignments: Record<string, string[]> = {}) {
  return { tags, assignments }
}

async function mountStatuses(harness: Harness, statuses: WorktreeStatusDefinition[] = BUILT_INS, callbacks?: {
  onClose?(): void
  onSaved?(saved: WorktreeStatusDefinition[]): void
}): Promise<{ root: Root; host: HTMLElement }> {
  const mounted = attachRoot()
  await act(async () => mounted.root.render(createElement(StatusSettingsDialog, {
    context: harness.context,
    statuses,
    onClose: callbacks?.onClose ?? (() => {}),
    onSaved: callbacks?.onSaved ?? (() => {})
  })))
  await flush()
  return mounted
}

async function mountTags(harness: Harness, worktreeIds = ['a', 'b'], callbacks?: { onClose?(): void }): Promise<{ root: Root; host: HTMLElement; anchor: HTMLButtonElement }> {
  const mounted = attachRoot()
  const anchor = document.createElement('button')
  anchor.textContent = 'Open tags'
  document.body.append(anchor)
  await act(async () => mounted.root.render(createElement(TagsPopover, {
    context: harness.context,
    worktreeIds,
    anchor,
    onClose: callbacks?.onClose ?? (() => {})
  })))
  await flush()
  return { ...mounted, anchor }
}

async function emitTagsChanged(harness: Harness): Promise<void> {
  await act(async () => {
    for (const listener of [...harness.listeners]) listener({ type: 'quirky.worktree/tagsChanged', data: {} } as QuirkyEvent)
  })
  await flush()
}

test('status controls route Add and Remove and preserve built-in identity and custom row focus', async () => {
  const harness = makeHarness()
  install(harness)
  const initial = [...BUILT_INS, { id: 'custom-5', label: 'Custom status', color: BUILT_INS[0]!.color }]
  await mountStatuses(harness, initial)

  const builtinId = labeledInput('Status ID 1')!
  expect(builtinId.disabled).toBe(true)
  expect(button('Remove status', builtinId.closest('fieldset') ?? document)).toBeUndefined()
  await click(button('Add status'))
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(6)
  expect(labeledInput('Status ID 6')?.value).toBe('custom-6')
  expect(labeledInput('Status label 6')?.value).toBe('Custom status')
  expect(labeledInput('Status color 6')?.value).toBe(BUILT_INS[0]!.color)
  expect(payloadOf(lastRoute(harness, 'add-status'))).toMatchObject({ owner: expect.any(String), revision: expect.any(Number) })
  const addCall = routeCalls(harness, 'add-status').at(-1)!
  expect(addCall.params.connId).toBe(7)
  expect(addCall.params.id).toBe(CONTROL_COMMAND)

  const addEnvelope = scope('status-settings', 'statuses', 'add-status', {})
  const apiResult = await publicCommand(harness, addEnvelope) as UiControlResult
  expect(apiResult).toEqual({ ...addEnvelope, delivered: 1 })
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(7)
  expect(labeledInput('Status ID 7')?.value).toBe('custom-7')

  await click(button('Remove status', labeledInput('Status ID 7')?.closest('fieldset') ?? document))
  expect(payloadOf(lastRoute(harness, 'remove-status'))).toMatchObject({
    index: 6, owner: expect.any(String), revision: expect.any(Number)
  })
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(6)
  const removeEnvelope = scope('status-settings', 'statuses', 'remove-status', { index: 5 })
  expect((await publicCommand(harness, removeEnvelope) as UiControlResult).delivered).toBe(1)
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(5)
  const rejectedBuiltin = await publicCommand(harness, scope('status-settings', 'statuses', 'remove-status', { index: 0 })) as UiControlResult
  expect(rejectedBuiltin.delivered).toBe(0)

  const customId = labeledInput('Status ID 5')!
  customId.focus()
  await setText(customId, 'todo')
  expect(labeledInput('Status ID 5')).toBe(customId)
  expect(document.activeElement).toBe(customId)
  expect(customId.disabled).toBe(false)
  expect(button('Remove status', customId.closest('fieldset')!)).toBeDefined()
  expect(harness.executed).toEqual([])
})

test('status saves the complete open-time draft once, tolerates its own refresh, and fences unmounted replies', async () => {
  const harness = makeHarness()
  install(harness)
  const pending = deferred<unknown>()
  let saveCount = 0
  let saved: WorktreeStatusDefinition[] | undefined
  let closed = 0
  let statusEventCount = 0
  const unsubscribeStatus = harness.context.subscribe((event) => {
    if (event.type === 'quirky.worktree/statusDefinitionsChanged') statusEventCount += 1
  })
  harness.setOnCall((method, params) => {
    if (method !== 'quirky.worktree/setStatusDefinitions') return undefined
    saveCount += 1
    expect(params.statuses).toHaveLength(5)
    expect(params.statuses).toEqual([...BUILT_INS, { id: 'custom-5', label: 'Release', color: '#12ABEF', icon: '★' }])
    for (const listener of harness.listeners) {
      listener({ type: 'quirky.worktree/statusDefinitionsChanged', data: {} } as QuirkyEvent)
    }
    return pending.promise
  })
  const mounted = await mountStatuses(harness, [...BUILT_INS, { id: 'custom-5', label: 'Custom status', color: '#8b8b8b' }], {
    onClose: () => { closed += 1 },
    onSaved: (result) => { saved = result; closed += 1 }
  })
  await setText(labeledInput('Status label 5')!, 'Release')
  await setText(labeledInput('Status color 5')!, '#12ABEF')
  await setText(labeledInput('Status icon 5')!, '★')
  const save = button('Save statuses')!
  await act(async () => { save.click(); save.click() })
  await flush()
  expect(saveCount).toBe(1)
  expect(save.disabled).toBe(true)
  expect(statusEventCount).toBe(1)
  expect((await publicCommand(harness, scope('status-settings', 'statuses', 'add-status', {})) as UiControlResult).delivered).toBe(0)
  expect((await publicCommand(harness, scope('status-settings', 'statuses', 'remove-status', { index: 4 })) as UiControlResult).delivered).toBe(0)
  await setText(labeledInput('Status label 5')!, 'Changed during save')

  await act(async () => mounted.root.render(createElement(StatusSettingsDialog, {
    context: harness.context,
    statuses: [...BUILT_INS, { id: 'custom-5', label: 'From refresh', color: '#000000' }],
    onClose: () => { closed += 1 },
    onSaved: (result: WorktreeStatusDefinition[]) => { saved = result; closed += 1 }
  })))
  await flush()
  expect(labeledInput('Status label 5')?.value).toBe('Release')
  const normalized = [...BUILT_INS, { id: 'custom-5', label: 'release', color: '#12abef', icon: '★' }]
  pending.resolve(normalized)
  await flush()
  expect(saved).toEqual(normalized)
  expect(closed).toBe(1)
  expect(harness.calls.find((call) => call.method === 'quirky.worktree/setStatusDefinitions')?.params).toEqual({ statuses: [...BUILT_INS, { id: 'custom-5', label: 'Release', color: '#12ABEF', icon: '★' }] })
  expect(harness.executed).toEqual([])
  unsubscribeStatus()

  const oldSave = deferred<unknown>()
  harness.setOnCall((method) => method === 'quirky.worktree/setStatusDefinitions' ? oldSave.promise : undefined)
  let oldSaved = 0
  const oldMount = await mountStatuses(harness, BUILT_INS, { onSaved: () => { oldSaved += 1 } })
  await click(button('Save statuses'))
  await unmount(oldMount.root)
  oldSave.resolve(BUILT_INS)
  await flush()
  expect(oldSaved).toBe(0)
})

test('status validation and failed-save errors remain retryable without duplicate direct submits', async () => {
  const harness = makeHarness()
  install(harness)
  let saveCount = 0
  const first = deferred<unknown>()
  harness.setOnCall((method) => {
    if (method !== 'quirky.worktree/setStatusDefinitions') return undefined
    saveCount += 1
    return saveCount === 1 ? first.promise : [...BUILT_INS]
  })
  await mountStatuses(harness, [...BUILT_INS, { id: 'custom-5', label: 'Custom status', color: '#8b8b8b' }])
  await setText(labeledInput('Status icon 5')!, 'https://invalid/icon.svg')
  await click(button('Save statuses'))
  expect(saveCount).toBe(0)
  expect(harness.toasts.at(-1)).toEqual({ title: 'Invalid status icon', body: 'Use plain-text emoji or symbols; URLs, SVG and HTML are not allowed.' })

  await setText(labeledInput('Status icon 5')!, '★')
  const save = button('Save statuses')!
  await act(async () => { save.click(); save.click() })
  await flush()
  expect(saveCount).toBe(1)
  first.reject(new Error('Denied'))
  await flush()
  expect(harness.toasts.at(-1)).toEqual({ title: 'Could not save workspace statuses', body: 'Denied' })
  expect(save.disabled).toBe(false)
  await click(save)
  expect(saveCount).toBe(2)

  const invalidReplyHarness = makeHarness({ connId: 9 })
  install(invalidReplyHarness)
  invalidReplyHarness.setOnCall((method) => method === 'quirky.worktree/setStatusDefinitions' ? { statuses: BUILT_INS } : undefined)
  const invalidReplyMounted = await mountStatuses(invalidReplyHarness)
  await click(button('Save statuses', invalidReplyMounted.host))
  expect(invalidReplyHarness.toasts.at(-1)).toEqual({
    title: 'Could not save workspace statuses',
    body: 'The workspace status owner returned an invalid result.'
  })
})

test('status control validation is exhaustive and stale owners, revisions, edits, and removals decline', async () => {
  const harness = makeHarness()
  install(harness)
  const mounted = await mountStatuses(harness, [...BUILT_INS, { id: 'custom-5', label: 'Custom status', color: '#8b8b8b' }])
  const validAdd = scope('status-settings', 'statuses', 'add-status', {})
  const invalid: unknown[] = [
    scope('status-settings', 'statuses', 'mystery', {}),
    scope('status-settings', 'statuses', 'add-status', { extra: true }),
    scope('status-settings', 'statuses', 'remove-status', {}),
    scope('status-settings', 'statuses', 'remove-status', { index: '4' }),
    scope('status-settings', 'statuses', 'remove-status', { index: true }),
    scope('status-settings', 'statuses', 'remove-status', { index: [] }),
    scope('status-settings', 'statuses', 'remove-status', { index: -1 }),
    scope('status-settings', 'statuses', 'remove-status', { index: 0.5 }),
    scope('status-settings', 'statuses', 'remove-status', { index: Number.MAX_SAFE_INTEGER + 1 }),
    scope('status-settings', 'statuses', 'remove-status', { index: 4, unexpected: true }),
    scope('status-settings', 'statuses', 'add-status', { owner: '  ' }),
    scope('status-settings', 'statuses', 'add-status', { owner: 7 }),
    scope('status-settings', 'statuses', 'add-status', { revision: -1 }),
    scope('status-settings', 'statuses', 'add-status', { revision: 0.5 }),
    scope('status-settings', 'statuses', 'add-status', { revision: '1' }),
    scope('status-settings', 'statuses', 'add-status', { revision: Number.MAX_SAFE_INTEGER + 1 })
  ]
  for (const args of invalid) await expect(publicCommand(harness, args)).rejects.toThrow(INVALID_STATUS)
  const otherTarget = await publicCommand(harness, scope('status-settings', 'not-statuses', 'mystery', { malformed: true })) as UiControlResult
  expect(otherTarget.delivered).toBe(0)
  expect((await publicCommand(harness, scope('status-settings', 'statuses', 'remove-status', { index: 999 })) as UiControlResult).delivered).toBe(0)

  await click(button('Add status'))
  const prior = lastRoute(harness, 'add-status')
  const oldPayload = payloadOf(prior)
  const staleOwner = scope('status-settings', 'statuses', 'add-status', { owner: `${String(oldPayload.owner)}-stale`, revision: oldPayload.revision })
  expect((await publicCommand(harness, staleOwner) as UiControlResult).delivered).toBe(0)
  expect((await publicCommand(harness, scope('status-settings', 'statuses', 'add-status', { owner: oldPayload.owner, revision: oldPayload.revision })) as UiControlResult).delivered).toBe(0)

  const held = deferred<unknown>()
  harness.setSelf(() => held.promise)
  const before = document.querySelectorAll('input[aria-label^="Status ID"]').length
  await click(button('Add status'))
  await setText(labeledInput('Status label 5')!, 'Changed while waiting')
  held.resolve({ connId: 7 })
  await flush()
  const staleArgs = lastRoute(harness, 'add-status')
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(before)
  expect(harness.logs).toContain('worktree: add-status reached no mounted target')

  harness.setSelf(() => ({ connId: 7 }))
  await publicCommand(harness, scope('status-settings', 'statuses', 'remove-status', { index: 4 }))
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(before - 1)
  const oldRevision = lastRoute(harness, 'add-status')
  expect((await publicCommand(harness, { ...validAdd, payload: payloadOf(oldRevision) }) as UiControlResult).delivered).toBe(0)
  await unmount(mounted.root)
})

test('status ownership fences A-to-B-to-A and same-resource reopen while local controls route through the installed provider', async () => {
  const contextA = makeHarness({ connId: 7 })
  const contextB = makeHarness({ connId: 9 })
  install(contextA)
  install(contextB)
  const mounted = await mountStatuses(contextA)
  const held = deferred<unknown>()
  contextA.setSelf(() => held.promise)
  await click(button('Add status'))
  const countBefore = document.querySelectorAll('input[aria-label^="Status ID"]').length

  await act(async () => mounted.root.render(createElement(StatusSettingsDialog, {
    context: contextB.context, statuses: BUILT_INS, onClose() {}, onSaved() {}
  })))
  await flush()
  await act(async () => mounted.root.render(createElement(StatusSettingsDialog, {
    context: contextA.context, statuses: BUILT_INS, onClose() {}, onSaved() {}
  })))
  await flush()
  held.resolve({ connId: 7 })
  await flush()
  const staleArgs = lastRoute(contextA, 'add-status')
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(countBefore)
  expect((await publicCommand(contextA, staleArgs) as UiControlResult).delivered).toBe(0)
  expect(contextA.toasts).toEqual([])
  expect(contextB.toasts).toEqual([])
  await click(button('Add status', mounted.host))
  const reopenControl = lastRoute(contextA, 'add-status')
  await unmount(mounted.root)
  const reopened = await mountStatuses(contextA)
  expect((await publicCommand(contextA, reopenControl) as UiControlResult).delivered).toBe(0)
  await unmount(reopened.root)

  const twoOne = await mountStatuses(contextA)
  const twoTwo = await mountStatuses(contextA)
  const unguarded = scope('status-settings', 'statuses', 'add-status', {})
  expect((await publicCommand(contextA, unguarded) as UiControlResult).delivered).toBe(2)
  await unmount(twoOne.root)
  expect((await publicCommand(contextA, unguarded) as UiControlResult).delivered).toBe(1)
  await unmount(twoTwo.root)
  expect((await publicCommand(contextA, unguarded) as UiControlResult).delivered).toBe(0)
})

test('tags distinguish pending, failed, empty, and ready catalog states and route both retry paths', async () => {
  const first = deferred<unknown>()
  const retryReply = deferred<unknown>()
  let reads = 0
  const harness = makeHarness({ onCall(method) {
    if (method !== 'quirky.worktree/tags') return undefined
    reads += 1
    if (reads === 1) return first.promise
    if (reads === 2) return retryReply.promise
    if (reads === 3) throw new Error('Refresh offline')
    return snapshot([])
  } })
  install(harness)
  await mountTags(harness)
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading tags…')
  expect(document.body.textContent).not.toContain('No tags yet')
  expect(button('Create "release"')).toBeUndefined()
  await setText(labeledInput('Add or create a tag')!, 'release')
  expect(button('Create "release"')).toBeUndefined()

  first.reject(new Error('Tags offline'))
  await flush()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load tags: Tags offline')
  await click(button('Retry'))
  expect(reads).toBe(2)
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading tags…')
  expect(routeCalls(harness, 'retry')).toHaveLength(1)
  expect(payloadOf(lastRoute(harness, 'retry'))).toMatchObject({
    worktreeIds: ['a', 'b'], owner: expect.any(String), revision: expect.any(Number)
  })
  retryReply.resolve(snapshot([]))
  await flush()
  expect(document.querySelector('.ui-empty-state')).toBeNull()
  expect(button('Create "release"')).toBeDefined()
  expect(labeledInput('Add or create a tag')?.value).toBe('release')
  await setText(labeledInput('Add or create a tag')!, '')
  expect(document.querySelector('.ui-empty-state')?.textContent).toBe('No tags yet. Type a name to create one.')
  await setText(labeledInput('Add or create a tag')!, 'another')
  await emitTagsChanged(harness)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load tags: Refresh offline')
  expect(labeledInput('Add or create a tag')?.value).toBe('another')
  const retryArgs = scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a', 'b'] })
  expect(await publicCommand(harness, retryArgs)).toEqual({ ...retryArgs, delivered: 1 })
  await flush()
  expect(reads).toBe(4)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(button('Create "another"')).toBeDefined()
  expect(labeledInput('Add or create a tag')?.value).toBe('another')
  expect(harness.executed).toEqual([])
})

test('tag mutations preserve payloads and selection order, mixed state, shared swatches, Enter semantics, and busy guards', async () => {
  const createReply = deferred<unknown>()
  const firstAssignReply = deferred<unknown>()
  const createAssignReply = deferred<unknown>()
  let createCount = 0
  let assignCount = 0
  let docsAssigned = false
  const harness = makeHarness({ onCall(method, params) {
    if (method === 'quirky.worktree/tags') {
      return snapshot([tag('t1', 'urgent'), tag('t2', 'docs', 'blue')], {
        a: docsAssigned ? ['t1', 't2'] : ['t1'],
        b: ['t1', 't2']
      })
    }
    if (method === 'quirky.worktree/tagCreate') {
      createCount += 1
      return createReply.promise
    }
    if (method === 'quirky.worktree/tagAssign') {
      assignCount += 1
      if (params.tagId === 't2') docsAssigned = params.assigned === true
      return assignCount === 1 ? firstAssignReply.promise : assignCount === 2 ? createAssignReply.promise : { ok: true }
    }
    if (method === 'quirky.worktree/tagUpdate') return { tag: tag(String(harness.calls.at(-1)?.params.id), 'urgent', null) }
    return undefined
  } })
  install(harness)
  await mountTags(harness, ['a', 'b'])
  expect(tagsCheckbox('urgent')?.checked).toBe(true)
  expect(tagsCheckbox('urgent')?.getAttribute('aria-checked')).toBe('true')
  expect(tagsCheckbox('docs')?.checked).toBe(false)
  expect(tagsCheckbox('docs')?.getAttribute('aria-checked')).toBe('mixed')
  expect(tagsCheckbox('docs')?.indeterminate).toBe(true)
  const docsCheckbox = tagsCheckbox('docs')!
  await act(async () => { docsCheckbox.click(); docsCheckbox.click() })
  await flush()
  expect(harness.calls.find((call) => call.method === 'quirky.worktree/tagAssign')?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 't2', assigned: true })
  expect(assignCount).toBe(1)

  const search = labeledInput('Add or create a tag')!
  await setText(search, '  release  ')
  await act(async () => {
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
  expect(createCount).toBe(0)
  firstAssignReply.resolve({ ok: true })
  await flush()
  expect(button('Create "release"')?.closest('fieldset')?.disabled).toBe(false)

  await act(async () => {
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
  expect(createCount).toBe(1)
  expect(harness.calls.find((call) => call.method === 'quirky.worktree/tagCreate')?.params).toEqual({ name: 'release' })
  expect(button('Create "release"')?.closest('fieldset')?.disabled).toBe(true)
  createReply.resolve({ tag: tag('t-new', 'release') })
  await flush()
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 't-new', assigned: true })
  expect(assignCount).toBe(2)
  expect(tagsCheckbox('docs')?.closest('fieldset')?.disabled).toBe(true)
  createAssignReply.resolve({ ok: true })
  await flush()
  expect(search.value).toBe('')

  await setText(search, 'docs')
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await flush()
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 't2', assigned: false })
  expect(assignCount).toBe(3)

  await setText(search, '')
  const opener = document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]')!
  await click(opener)
  const group = document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')!
  expect(group.querySelectorAll('[role="radio"]')).toHaveLength(9)
  await click(group.querySelector('[data-color="teal"]') as HTMLElement)
  expect(harness.calls.find((call) => call.method === 'quirky.worktree/tagUpdate')?.params).toEqual({ id: 't1', color: 'teal' })
  expect(payloadOf(lastRoute(harness, 'set-color-picker'))).toMatchObject({
    worktreeIds: ['a', 'b'], owner: expect.any(String), revision: expect.any(Number), tagId: 't1'
  })
  await click(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"] [data-color="grey"]') as HTMLElement)
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagUpdate').at(-1)?.params).toEqual({ id: 't1', color: null })
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  expect(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')).toBeNull()
  expect(routeCalls(harness, 'set-color-picker').length).toBeGreaterThanOrEqual(2)
  expect(routeCalls(harness, 'set-color-picker').every((call) => call.params.connId === 7 && call.params.id === CONTROL_COMMAND)).toBe(true)
  expect(harness.executed).toEqual([])
})

test('tag refresh failures retain the catalog but disable mutations until retry succeeds', async () => {
  let reads = 0
  const next = deferred<unknown>()
  const harness = makeHarness({ onCall(method) {
    if (method !== 'quirky.worktree/tags') return undefined
    reads += 1
    if (reads === 1) return snapshot([tag('t1', 'urgent')], { a: ['t1'] })
    if (reads === 2) return next.promise
    return snapshot([tag('t1', 'urgent')], { a: ['t1'] })
  } })
  install(harness)
  await mountTags(harness, ['a'])
  expect(tagsCheckbox('urgent')).toBeDefined()
  await emitTagsChanged(harness)
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading tags…')
  expect(tagsCheckbox('urgent')).toBeDefined()
  expect(tagsCheckbox('urgent')?.closest('fieldset')?.disabled).toBe(true)
  next.reject(new Error('Tags offline'))
  await flush()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load tags: Tags offline')
  expect(tagsCheckbox('urgent')?.closest('fieldset')?.disabled).toBe(true)
  await click(button('Retry'))
  expect(reads).toBe(3)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(tagsCheckbox('urgent')?.closest('fieldset')?.disabled).toBe(false)
  await click(tagsCheckbox('urgent')!)
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a'], tagId: 't1', assigned: false })
})

test('tag mutation leases preserve newer queries and equivalent selection sets but fence replacements and close/reopen', async () => {
  const create = deferred<unknown>()
  const harness = makeHarness({ onCall(method) {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    if (method === 'quirky.worktree/tagCreate') return create.promise
    return undefined
  } })
  install(harness)
  const mounted = await mountTags(harness, ['a', 'b'])
  const search = labeledInput('Add or create a tag')!
  await setText(search, 'release')
  await click(button('Create "release"'))
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagCreate')).toHaveLength(1)
  await setText(search, 'new query')
  await act(async () => mounted.root.render(createElement(TagsPopover, {
    context: harness.context, worktreeIds: ['b', 'a'], anchor: mounted.anchor, onClose() {}
  })))
  await flush()
  create.resolve({ tag: tag('t-new', 'release') })
  await flush()
  expect(search.value).toBe('new query')
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 't-new', assigned: true })

  const replacementCreate = deferred<unknown>()
  harness.setOnCall((method) => {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    if (method === 'quirky.worktree/tagCreate') return replacementCreate.promise
    return undefined
  })
  await setText(search, 'another')
  await click(button('Create "another"'))
  const assignsBefore = harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').length
  await act(async () => mounted.root.render(createElement(TagsPopover, {
    context: harness.context, worktreeIds: ['c'], anchor: mounted.anchor, onClose() {}
  })))
  await flush()
  await setText(labeledInput('Add or create a tag')!, 'replacement query')
  replacementCreate.resolve({ tag: tag('t-old', 'another') })
  await flush()
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign')).toHaveLength(assignsBefore)
  expect(labeledInput('Add or create a tag')?.value).toBe('replacement query')

  const closeReply = deferred<unknown>()
  harness.setOnCall((method) => {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    if (method === 'quirky.worktree/tagCreate') return closeReply.promise
    return undefined
  })
  const oldReadCount = harness.calls.filter((call) => call.method === 'quirky.worktree/tags').length
  await setText(labeledInput('Add or create a tag')!, 'close me')
  await click(button('Create "close me"'))
  await unmount(mounted.root)
  const reopened = await mountTags(harness, ['c'])
  const reopenedReadCount = harness.calls.filter((call) => call.method === 'quirky.worktree/tags').length
  closeReply.resolve({ tag: tag('t-close', 'close me') })
  await flush()
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tags').length).toBe(reopenedReadCount)
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').length).toBe(assignsBefore)
  expect(labeledInput('Add or create a tag')?.value).toBe('')
  await unmount(reopened.root)
  expect(oldReadCount).toBeGreaterThan(0)
})

test('a pending tag create cannot cross a context replacement', async () => {
  const create = deferred<unknown>()
  const contextA = makeHarness({ connId: 7, onCall(method) {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    if (method === 'quirky.worktree/tagCreate') return create.promise
    return undefined
  } })
  const contextB = makeHarness({ connId: 9, onCall(method) {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    return undefined
  } })
  install(contextA)
  install(contextB)
  const mounted = await mountTags(contextA, ['a'])
  await setText(labeledInput('Add or create a tag')!, 'release')
  await click(button('Create "release"'))

  await act(async () => mounted.root.render(createElement(TagsPopover, {
    context: contextB.context, worktreeIds: ['a'], anchor: mounted.anchor, onClose() {}
  })))
  await flush()
  await setText(labeledInput('Add or create a tag')!, 'replacement query')
  create.resolve({ tag: tag('t-new', 'release') })
  await flush()
  expect(contextA.calls.filter((call) => call.method === 'quirky.worktree/tagAssign')).toHaveLength(0)
  expect(contextA.calls.filter((call) => call.method === 'quirky.worktree/tags')).toHaveLength(1)
  expect(contextB.calls.filter((call) => call.method === 'quirky.worktree/tagAssign')).toHaveLength(0)
  expect(labeledInput('Add or create a tag')?.value).toBe('replacement query')
  await unmount(mounted.root)
})

test('tag reads are latest-issued and own tagsChanged events do not cancel a live create', async () => {
  const initial = deferred<unknown>()
  const refresh = deferred<unknown>()
  const create = deferred<unknown>()
  let reads = 0
  let createCalls = 0
  let harness!: Harness
  harness = makeHarness({ onCall(method) {
    if (method === 'quirky.worktree/tags') {
      reads += 1
      return reads === 1 ? initial.promise : reads === 2 ? refresh.promise : snapshot([tag('t-new', 'release')])
    }
    if (method === 'quirky.worktree/tagCreate') {
      createCalls += 1
      for (const listener of harness.listeners) {
        listener({ type: 'quirky.worktree/tagsChanged', data: {} } as QuirkyEvent)
      }
      return create.promise
    }
    return undefined
  } })
  install(harness)
  const mounted = await mountTags(harness, ['a', 'b'])
  await emitTagsChanged(harness)
  expect(reads).toBe(2)
  refresh.resolve(snapshot([tag('fresh', 'Fresh')]))
  await flush()
  initial.resolve(snapshot([tag('stale', 'Stale')]))
  await flush()
  expect(document.body.textContent).toContain('Fresh')
  expect(document.body.textContent).not.toContain('Stale')

  await setText(labeledInput('Add or create a tag')!, 'release')
  await click(button('Create "release"'))
  expect(createCalls).toBe(1)
  await flush()
  expect(reads).toBeGreaterThanOrEqual(3)
  create.resolve({ tag: tag('t-new', 'release') })
  await flush()
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 't-new', assigned: true })
  expect(harness.listeners.size).toBe(1 + 1)
  const oldRead = deferred<unknown>()
  harness.setOnCall((method) => method === 'quirky.worktree/tags' ? oldRead.promise : undefined)
  await emitTagsChanged(harness)
  await unmount(mounted.root)
  harness.setOnCall((method) => method === 'quirky.worktree/tags'
    ? snapshot([tag('reopened', 'Reopened')])
    : undefined)
  const reopened = await mountTags(harness, ['a', 'b'])
  await flush()
  oldRead.resolve(snapshot([tag('closed', 'Stale after close')]))
  await flush()
  expect(document.body.textContent).toContain('Reopened')
  expect(document.body.textContent).not.toContain('Stale after close')
  await unmount(reopened.root)
})

test('tag scope validation, retry eligibility, missing anchors, busy writes, and stale selection revisions are enforced', async () => {
  const assign = deferred<unknown>()
  const harness = makeHarness({ onCall(method) {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    if (method === 'quirky.worktree/tagAssign') return assign.promise
    return undefined
  } })
  install(harness)
  const mounted = await mountTags(harness, ['a'])
  const malformed: unknown[] = [
    scope('tags-popover', 'tags', 'unknown', {}),
    scope('tags-popover', 'tags', 'retry', {}),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], extra: true }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: 'a' }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: [] }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['  '] }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: [1] }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], owner: ' ' }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], owner: 7 }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], revision: -1 }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], revision: '1' }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], revision: 0.1 }),
    scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'], revision: Number.MAX_SAFE_INTEGER + 1 }),
    scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'] }),
    scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: true }),
    scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: '  ' }),
    scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: null, unexpected: true })
  ]
  for (const args of malformed) await expect(publicCommand(harness, args)).rejects.toThrow(INVALID_TAGS)
  expect((await publicCommand(harness, scope('tags-popover', 'other', 'unknown', { nonsense: true })) as UiControlResult).delivered).toBe(0)
  expect((await publicCommand(harness, scope('tags-popover', 'tags', 'retry', { worktreeIds: ['a'] })) as UiControlResult).delivered).toBe(0)
  expect((await publicCommand(harness, scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: 'missing' })) as UiControlResult).delivered).toBe(0)

  await click(tagsCheckbox('urgent')!)
  expect((await publicCommand(harness, scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: 't1' })) as UiControlResult).delivered).toBe(0)
  expect(tagsCheckbox('urgent')?.closest('fieldset')?.disabled).toBe(true)
  assign.resolve({ ok: true })
  await flush()
  expect(tagsCheckbox('urgent')?.closest('fieldset')?.disabled).toBe(false)

  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  const route = lastRoute(harness, 'set-color-picker')
  const payload = payloadOf(route)
  const stale = scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: 't1', owner: payload.owner, revision: payload.revision })
  expect((await publicCommand(harness, stale) as UiControlResult).delivered).toBe(0)
  const colorButton = document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]')!
  colorButton.remove()
  expect((await publicCommand(harness, scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['a'], tagId: null })) as UiControlResult).delivered).toBe(0)
  await unmount(mounted.root)
  const emptyTargets = await mountTags(harness, [])
  expect(tagsCheckbox('urgent')?.closest('fieldset')?.disabled).toBe(true)
  await setText(labeledInput('Add or create a tag')!, 'new tag')
  const createButton = button('Create "new tag"')!
  expect(createButton.disabled).toBe(true)
  const beforeEmptyTargetCalls = harness.calls.filter((call) => call.method.startsWith('quirky.worktree/tag')).length
  expect((await publicCommand(harness, scope('tags-popover', 'tags', 'set-color-picker', {
    worktreeIds: ['a'], tagId: 't1'
  })) as UiControlResult).delivered).toBe(0)
  await click(createButton)
  expect(harness.calls.filter((call) => call.method.startsWith('quirky.worktree/tag'))).toHaveLength(beforeEmptyTargetCalls)
  await unmount(emptyTargets.root)
})

test('tag picker value controls are idempotent across ABA and same-id set reordering', async () => {
  const harness = makeHarness({ onCall(method) {
    if (method === 'quirky.worktree/tags') return snapshot([tag('t1', 'urgent')])
    return undefined
  } })
  install(harness)
  const mounted = await mountTags(harness, ['a', 'b'])
  const held = deferred<unknown>()
  harness.setSelf(() => held.promise)
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  const publicSet = (tagId: string | null) => publicCommand(harness, scope('tags-popover', 'tags', 'set-color-picker', { worktreeIds: ['b', 'a'], tagId }))
  expect((await publicSet('t1') as UiControlResult).delivered).toBe(1)
  expect((await publicSet(null) as UiControlResult).delivered).toBe(1)
  expect((await publicSet('t1') as UiControlResult).delivered).toBe(1)
  held.resolve({ connId: 7 })
  await flush()
  const delayedPayload = payloadOf(lastRoute(harness, 'set-color-picker'))
  expect(delayedPayload).toMatchObject({ worktreeIds: ['a', 'b'], tagId: 't1', owner: expect.any(String), revision: expect.any(Number) })
  expect(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')).not.toBeNull()
  expect(harness.logs).toContain('worktree: set-color-picker reached no mounted target')

  const replacement = deferred<unknown>()
  harness.setOnCall((method) => method === 'quirky.worktree/tags' ? snapshot([tag('t1', 'urgent')]) : undefined)
  harness.setSelf(() => replacement.promise)
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  await act(async () => mounted.root.render(createElement(TagsPopover, {
    context: harness.context, worktreeIds: ['c'], anchor: mounted.anchor, onClose() {}
  })))
  await flush()
  replacement.resolve({ connId: 7 })
  await flush()
  const staleSelection = lastRoute(harness, 'set-color-picker')
  expect((await publicCommand(harness, staleSelection) as UiControlResult).delivered).toBe(0)
  expect(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')).toBeNull()
})

test('tag helper failures toast, preserve current text, and permit retry without inventing a successful refresh', async () => {
  let reads = 0
  let creates = 0
  let assignments = 0
  let updates = 0
  const harness = makeHarness({ onCall(method) {
    if (method === 'quirky.worktree/tags') { reads += 1; return snapshot([tag('t1', 'urgent')]) }
    if (method === 'quirky.worktree/tagCreate') { creates += 1; if (creates === 1) throw new Error('Create denied'); return { tag: tag('t2', 'release') } }
    if (method === 'quirky.worktree/tagAssign') { assignments += 1; if (assignments === 1) throw new Error('Assign denied'); return { ok: true } }
    if (method === 'quirky.worktree/tagUpdate') { updates += 1; if (updates === 1) throw new Error('Update denied'); return { tag: tag('t1', 'urgent', 'teal') } }
    return undefined
  } })
  install(harness)
  await mountTags(harness, ['a'])
  const query = labeledInput('Add or create a tag')!
  await setText(query, 'release')
  await click(button('Create "release"'))
  expect(harness.toasts.at(-1)).toEqual({ title: 'Could not create tag', body: 'Create denied' })
  expect(query.value).toBe('release')
  expect(reads).toBe(1)
  const createAssignToastCount = harness.toasts.length
  await click(button('Create "release"'))
  expect(creates).toBe(2)
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a'], tagId: 't2', assigned: true })
  expect(harness.toasts).toHaveLength(createAssignToastCount + 1)
  expect(harness.toasts.at(-1)).toEqual({ title: 'Could not update tags', body: 'Assign denied' })
  expect(reads).toBe(1)
  expect(query.value).toBe('')

  await click(tagsCheckbox('urgent')!)
  expect(assignments).toBe(2)
  expect(harness.toasts).toHaveLength(createAssignToastCount + 1)
  expect(reads).toBe(2)

  const updateToastCount = harness.toasts.length
  const readsBeforeUpdate = reads
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  await click(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"] [data-color="teal"]') as HTMLElement)
  expect(harness.toasts).toHaveLength(updateToastCount + 1)
  expect(harness.toasts.at(-1)).toEqual({ title: 'Could not update tag', body: 'Update denied' })
  expect(reads).toBe(readsBeforeUpdate)
  await click(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"] [data-color="teal"]') as HTMLElement)
  expect(updates).toBe(2)
  expect(reads).toBe(readsBeforeUpdate + 1)
})

test('status and tag route failures toast without a local fallback, malformed replies are caught, and obsolete failures stay silent', async () => {
  const status = makeHarness()
  install(status)
  await mountStatuses(status)
  status.setSelf(() => ({ connId: 0 }))
  await click(button('Add status'))
  expect(status.toasts.at(-1)).toEqual({ title: 'Could not update workspace statuses', body: 'ui.window.self returned an invalid connection identity.' })
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(4)

  status.setSelf(() => ({ connId: 7 }))
  status.setWindowReply(() => ({ result: { malformed: true } }))
  await click(button('Add status'))
  expect(status.toasts.at(-1)).toEqual({ title: 'Could not update workspace statuses', body: 'The window returned no UI control result.' })
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(4)

  status.setWindowReply(null)
  status.setRouteFailure(new Error('no live UI window 7'))
  await click(button('Add status'))
  expect(status.toasts.at(-1)).toEqual({ title: 'Could not update workspace statuses', body: 'no live UI window 7' })
  expect(document.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(4)
  expect(status.executed).toEqual([])

  const tags = makeHarness({ connId: 9, onCall(method) { return method === 'quirky.worktree/tags' ? snapshot([tag('t1', 'urgent')]) : undefined } })
  install(tags)
  await mountTags(tags, ['a'])
  tags.setSelf(() => Promise.reject(new Error('self lookup failed')))
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  expect(tags.toasts.at(-1)).toEqual({ title: 'Could not update tags', body: 'self lookup failed' })
  expect(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')).toBeNull()

  tags.setSelf(() => ({ connId: 9 }))
  tags.setWindowReply(() => ({ result: { action: 'control', scope: 'tags-popover', target: 'tags', operation: 'set-color-picker', payload: {}, delivered: -1 } }))
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  expect(tags.toasts.at(-1)).toEqual({ title: 'Could not update tags', body: 'The window returned no UI control result.' })
  expect(document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')).toBeNull()

  const held = deferred<unknown>()
  tags.setWindowReply(null)
  tags.setSelf(() => held.promise)
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="Color for urgent"]'))
  const tagRoot = roots.at(-1)!
  await act(async () => tagRoot.render(createElement(TagsPopover, {
    context: tags.context, worktreeIds: ['b'], anchor: document.querySelector('button') as HTMLElement, onClose() {}
  })))
  await flush()
  held.reject(new Error('obsolete routing failure'))
  await flush()
  expect(tags.toasts.map((toast) => toast.body)).not.toContain('obsolete routing failure')
  expect(tags.executed).toEqual([])
})

test('group retry reaches the real installed provider from both its button and ui.command.run', async () => {
  let previews = 0
  const group: ProjectGroup = {
    id: 'g1',
    name: 'Backend',
    parentPath: null,
    collapsed: false,
    order: 0,
    createdFrom: 'manual',
    repoIds: [],
    parentId: null
  }
  const harness = makeHarness({ onCall(method) {
    if (method === 'quirky.repo/groupList') return [group]
    if (method === 'quirky.ledger/request') {
      previews += 1
      if (previews < 3) throw new Error('Ledger offline')
      return { removalPreview: [] }
    }
    return undefined
  } })
  install(harness)
  const mounted = attachRoot()
  await act(async () => mounted.root.render(createElement(DeleteGroupDialog, { context: harness.context, group, onClose() {} })))
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('Could not check retained ledger records: Ledger offline') ?? false)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not check retained ledger records: Ledger offline')
  await click(button('Retry'))
  expect(routeCalls(harness, 'retry-preview')).toHaveLength(1)
  expect(previews).toBe(2)
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('Ledger offline') ?? false)
  const retry = scope('group-dialog', 'g1', 'retry-preview', {})
  expect(await publicCommand(harness, retry)).toEqual({ ...retry, delivered: 1 })
  expect(previews).toBe(3)
  await waitFor(() => document.body.textContent?.includes('Ledger records retained: No affected ledgers.') ?? false)
  expect(routeCalls(harness, 'retry-preview').at(-1)?.params).toMatchObject({ connId: 7, id: CONTROL_COMMAND })
  expect(harness.executed).toEqual([])
})

// The actual activated provider, not dispatchUiControl, is the test boundary for all public API routes above.
test('the installed provider is captured from activation and window requests keep each context exact', async () => {
  const first = makeHarness({ connId: 7 })
  const second = makeHarness({ connId: 9 })
  install(first)
  install(second)
  expect(typeof first.provided.get(CONTROL_COMMAND)).toBe('function')
  expect(typeof second.provided.get(CONTROL_COMMAND)).toBe('function')
  const one = await mountStatuses(first)
  const two = await mountStatuses(second)
  await click(button('Add status', one.host))
  const firstAdd = routeCalls(first, 'add-status').at(-1)
  expect(firstAdd?.params).toMatchObject({ connId: 7, id: CONTROL_COMMAND })
  expect(routeCalls(second, 'add-status')).toHaveLength(0)
  expect(one.host.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(5)
  expect(two.host.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(4)
  const envelope = scope('status-settings', 'statuses', 'add-status', {})
  expect(await publicCommand(first, envelope)).toEqual({ ...envelope, delivered: 1 })
  expect(one.host.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(6)
  expect(two.host.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(4)
  expect(await publicCommand(second, envelope)).toEqual({ ...envelope, delivered: 1 })
  expect(two.host.querySelectorAll('input[aria-label^="Status ID"]')).toHaveLength(5)
  expect(first.calls.filter((call) => call.method === 'ui.window.command.run').every((call) => call.params.connId === 7)).toBe(true)
  expect(second.calls.filter((call) => call.method === 'ui.window.command.run').every((call) => call.params.connId === 9)).toBe(true)
  await unmount(one.root)
  expect(await publicCommand(first, envelope)).toEqual({ ...envelope, delivered: 0 })
  await unmount(two.root)
  expect(await publicCommand(second, envelope)).toEqual({ ...envelope, delivered: 0 })
})
