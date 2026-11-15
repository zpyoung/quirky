import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ProjectGroup, Repo, UiPluginContext } from '@quirky/protocol'
import type { ReactNode, act as ReactAct, createElement as ReactCreateElement } from 'react'
import type { Root } from 'react-dom/client'
import { dispatchUiControl, UI_CONTROL_COMMAND, type UiControlResult } from '../src/ui-control'
import type { DeleteGroupDialog as DeleteGroupDialogComponent } from '../src/GroupDialogs'
import type { NewGroupDialog as NewGroupDialogComponent } from '../src/GroupDialogs'
import type { NewWorktreeGroupDialog as NewWorktreeGroupDialogComponent } from '../src/GroupDialogs'
import type { RenameGroupDialog as RenameGroupDialogComponent } from '../src/GroupDialogs'
import { createWorkspace } from '../src/actions'

let act: typeof ReactAct
let createElement: typeof ReactCreateElement
let createRoot: (container: Element) => Root
let DeleteGroupDialog: typeof DeleteGroupDialogComponent
let NewGroupDialog: typeof NewGroupDialogComponent
let NewWorktreeGroupDialog: typeof NewWorktreeGroupDialogComponent
let RenameGroupDialog: typeof RenameGroupDialogComponent

type Call = { method: string; params: Record<string, unknown> }
type Toast = { title: string; body: string }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
type HarnessOptions = {
  connId?: number
  groups?: ProjectGroup[]
  onCall?(method: string, params: Record<string, unknown>): unknown
}
type Harness = {
  context: UiPluginContext
  calls: Call[]
  toasts: Toast[]
  logs: string[]
  executeCommands: string[]
}
type Mount = {
  host: HTMLDivElement
  render(node: ReactNode): Promise<void>
  unmount(): Promise<void>
}

const roots = new Set<{ root: Root; active: boolean }>()
const connections = new Map<number, UiPluginContext>()

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React DOM and dialog modules must bind to Happy DOM's document after registration.
  const react = await import('react')
  act = react.act
  createElement = react.createElement
  createRoot = (await import('react-dom/client')).createRoot
  const groups = await import('../src/GroupDialogs')
  DeleteGroupDialog = groups.DeleteGroupDialog
  NewGroupDialog = groups.NewGroupDialog
  NewWorktreeGroupDialog = groups.NewWorktreeGroupDialog
  RenameGroupDialog = groups.RenameGroupDialog
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  await act(async () => {
    for (const entry of roots) {
      if (!entry.active) continue
      entry.active = false
      await entry.root.unmount()
    }
  })
  roots.clear()
  connections.clear()
  document.body.replaceChildren()
})

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function group(id: string, name = id, parentId: string | null = null): ProjectGroup {
  return { id, name, parentId, parentPath: null, repoIds: [], collapsed: false, order: 0, createdFrom: 'manual' }
}

function repo(id = 'r1', name = 'api'): Repo {
  return { id, name, path: `/repos/${name}`, addedAt: 0, kind: 'git', displayName: null, groupId: null }
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: Call[] = []
  const toasts: Toast[] = []
  const logs: string[] = []
  const executeCommands: string[] = []
  const connId = options.connId ?? 7
  let context!: UiPluginContext
  context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const custom = options.onCall?.(method, params)
      if (custom !== undefined) return await custom
      if (method === 'ui.window.self') return { connId }
      if (method === 'ui.window.command.run') {
        const target = connections.get(params.connId as number)
        if (!target) throw new Error(`no live UI window ${String(params.connId)}`)
        if (params.id !== UI_CONTROL_COMMAND) throw new Error(`unexpected command ${String(params.id)}`)
        return { result: dispatchUiControl(target, params.args) }
      }
      if (method === 'quirky.repo/groupList') return options.groups ?? [group('g1')]
      if (method === 'quirky.ledger/request') return { removalPreview: [] }
      if (method === 'quirky.repo/groupCreate') return group('g-new', String(params.name))
      if (method === 'quirky.repo/groupAdd' || method === 'quirky.repo/groupRename' || method === 'quirky.repo/groupDelete') return { ok: true }
      if (method === 'quirky.worktree/createGroup') return { assigned: true }
      if (method === 'quirky.worktree/navigate') return { ok: true }
      throw new Error(`Unexpected call ${method}`)
    },
    getLayout: () => ({ view: null }),
    toast(title: string, body: string) { toasts.push({ title, body }) },
    log(message: string) { logs.push(message) },
    executeCommand(id: string) { executeCommands.push(id); throw new Error('executeCommand must not be used') }
  } as unknown as UiPluginContext
  connections.set(connId, context)
  return { context, calls, toasts, logs, executeCommands }
}

async function mount(node: ReactNode): Promise<Mount> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const entry = { root, active: true }
  roots.add(entry)
  const mounted: Mount = {
    host,
    async render(next) {
      if (!entry.active) throw new Error('Cannot render an unmounted dialog')
      await act(async () => root.render(next))
      await flush()
    },
    async unmount() {
      if (!entry.active) return
      entry.active = false
      roots.delete(entry)
      await act(async () => root.unmount())
    }
  }
  await mounted.render(node)
  return mounted
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    await flush()
    const value = read()
    if (value !== null && value !== undefined && value !== false) return value as T
  }
  throw new Error('Dialog did not reach the expected state')
}

function button(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
  )
}

function textField(root: ParentNode): HTMLInputElement {
  const field = root.querySelector<HTMLInputElement>('#project-group-name')
  if (!field) throw new Error('Group name field was not rendered')
  return field
}

function form(root: ParentNode): HTMLFormElement {
  const value = root.querySelector('form')
  if (!value) throw new Error('Group form was not rendered')
  return value
}

async function click(target: HTMLElement | undefined): Promise<void> {
  if (!target) throw new Error('Expected button was not rendered')
  await act(async () => { target.click(); await Promise.resolve() })
  await flush()
}

async function dispatchControlAndSettle(context: UiPluginContext, args: unknown): Promise<UiControlResult> {
  let result: UiControlResult | undefined
  await act(async () => { result = dispatchUiControl(context, args) })
  await flush()
  if (!result) throw new Error('Control dispatch did not return a result')
  return result
}

async function setText(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const noticeText = (root: ParentNode) => root.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()
const errorText = (root: ParentNode) => root.querySelector('.ui-inline-error__message')?.textContent?.trim()
const record = (harness: Harness, method: string) => harness.calls.filter((call) => call.method === method)
const removalRequest = (harness: Harness) => record(harness, 'quirky.ledger/request').at(-1)

test('delete preview is shared loading/error state and Retry is routed with the descendant scope', async () => {
  const firstPreview = deferred<unknown>()
  const retriedPreview = deferred<unknown>()
  let previewCalls = 0
  const groups = [group('g1'), group('g2', 'child', 'g1'), group('g3', 'nested', 'g2'), group('g1', 'cycle', 'g3'), group('g2', 'duplicate', 'g1')]
  const harness = makeHarness({
    groups,
    onCall(method) {
      if (method !== 'quirky.ledger/request') return undefined
      previewCalls += 1
      return previewCalls === 1 ? firstPreview.promise : retriedPreview.promise
    }
  })
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!

  expect(noticeText(dialog)).toBe('Checking retained ledger records…')
  expect(button(dialog, 'Delete section')?.disabled).toBe(true)
  expect(dialog.querySelector('.ui-empty-state')).toBeNull()
  expect(removalRequest(harness)?.params).toEqual({ operation: 'removal-preview', removal: { groupIds: ['g1', 'g2', 'g3'] } })

  await act(async () => firstPreview.reject(new Error('Ledger offline')))
  await flush()
  expect(errorText(dialog)).toBe('Could not check retained ledger records: Ledger offline')
  expect(button(dialog, 'Delete section')?.disabled).toBe(true)
  expect(dialog.querySelector('.ui-empty-state')).toBeNull()

  await click(button(dialog, 'Retry'))
  const request = record(harness, 'ui.window.command.run')
  expect(request).toHaveLength(1)
  expect(request[0]?.params).toMatchObject({
    connId: 7,
    id: UI_CONTROL_COMMAND,
    args: {
      action: 'control', scope: 'group-dialog', target: 'g1', operation: 'retry-preview',
      payload: { owner: expect.any(String), revision: expect.any(Number) }
    }
  })
  expect(harness.executeCommands).toEqual([])
  expect(noticeText(dialog)).toBe('Checking retained ledger records…')
  expect(record(harness, 'quirky.repo/groupList')).toHaveLength(2)
  await act(async () => retriedPreview.resolve({ removalPreview: [] }))
  await waitFor(() => dialog.textContent?.includes('Ledger records retained: No affected ledgers.'))
  expect(button(dialog, 'Delete section')?.disabled).toBe(false)
})

test('null, empty and nonempty previews retain their distinct delete payloads', async () => {
  const cases: Array<{
    label: string
    preview: unknown
    unavailable?: boolean
    notice: string | null
    expected: Record<string, unknown>
  }> = [
    { label: 'unavailable', preview: null, unavailable: true, notice: null, expected: { group: 'g1' } },
    { label: 'empty', preview: [], notice: 'Ledger records retained: No affected ledgers.', expected: { group: 'g1', expectedLedgers: [] } },
    {
      label: 'nonempty',
      preview: [{ ledgerId: 'l1', revision: 3, entryCount: 2 }],
      notice: 'Ledger records retained: 2 entries across 1 ledger will be retained and detached as needed.',
      expected: { group: 'g1', expectedLedgers: [{ ledgerId: 'l1', revision: 3 }] }
    }
  ]

  for (const example of cases) {
    const harness = makeHarness({
      onCall(method) {
        if (method !== 'quirky.ledger/request') return undefined
        if (example.unavailable) return Promise.reject(Object.assign(new Error('Ledger unavailable'), { code: -32601 }))
        return { removalPreview: example.preview }
      }
    })
    const onClose = () => {}
    const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose }))
    const dialog = mounted.host.querySelector('[role="dialog"]')!
    await waitFor(() => button(dialog, 'Delete section')?.disabled === false)
    expect(dialog.textContent?.includes('Ledger records retained:')).toBe(Boolean(example.notice))
    if (example.notice) expect(dialog.textContent).toContain(example.notice)
    else expect(dialog.textContent).not.toContain('Ledger records retained:')
    await click(button(dialog, 'Delete section'))
    expect(record(harness, 'quirky.repo/groupDelete').at(-1)?.params).toEqual(example.expected)
    await mounted.unmount()
  }
})

test('a rejected delete stays open, reports the existing error and reloads its preview', async () => {
  let previews = 0
  let deletions = 0
  const harness = makeHarness({
    onCall(method) {
      if (method === 'quirky.ledger/request') {
        previews += 1
        return { removalPreview: previews === 1 ? [{ ledgerId: 'l1', revision: 4, entryCount: 1 }] : [] }
      }
      if (method === 'quirky.repo/groupDelete') {
        deletions += 1
        if (deletions === 1) throw new Error('Ledger revision changed')
        return { ok: true }
      }
      return undefined
    }
  })
  let closes = 0
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() { closes += 1 } }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await waitFor(() => button(dialog, 'Delete section')?.disabled === false)
  await click(button(dialog, 'Delete section'))

  expect(harness.toasts).toEqual([{ title: 'Could not delete section', body: 'Ledger revision changed' }])
  expect(closes).toBe(0)
  await waitFor(() => dialog.textContent?.includes('Ledger records retained: No affected ledgers.'))
  expect(previews).toBe(2)
  expect(button(dialog, 'Delete section')?.disabled).toBe(false)
  await click(button(dialog, 'Delete section'))
  expect(record(harness, 'quirky.repo/groupDelete').map((call) => call.params)).toEqual([
    { group: 'g1', expectedLedgers: [{ ledgerId: 'l1', revision: 4 }] },
    { group: 'g1', expectedLedgers: [] }
  ])
  expect(closes).toBe(1)
})

test('name submission trims, rejects blanks, and synchronously admits only one group create', async () => {
  const created = deferred<unknown>()
  const harness = makeHarness({ onCall: (method) => method === 'quirky.repo/groupCreate' ? created.promise : undefined })
  let closes = 0
  const mounted = await mount(createElement(NewGroupDialog, { context: harness.context, repo: repo(), onClose() { closes += 1 } }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  const name = textField(dialog)
  form(dialog).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(record(harness, 'quirky.repo/groupCreate')).toHaveLength(0)

  await setText(name, '  backend  ')
  const create = button(dialog, 'Create')!
  await act(async () => {
    create.click()
    form(dialog).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form(dialog).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  await flush()
  expect(record(harness, 'quirky.repo/groupCreate').map((call) => call.params)).toEqual([{ name: 'backend' }])
  expect(record(harness, 'quirky.repo/groupAdd')).toHaveLength(0)
  expect(button(dialog, 'Create')?.disabled).toBe(true)

  await act(async () => created.resolve(group('g-new', 'backend')))
  await flush()
  expect(record(harness, 'quirky.repo/groupAdd').map((call) => call.params)).toEqual([{ group: 'g-new', repo: 'r1' }])
  expect(closes).toBe(1)
})

test('a partially successful project-group create remains visible but allows retry after groupAdd fails', async () => {
  let creates = 0
  let adds = 0
  const harness = makeHarness({
    onCall(method, params) {
      if (method === 'quirky.repo/groupCreate') return group(`g${++creates}`, String(params.name))
      if (method === 'quirky.repo/groupAdd') {
        adds += 1
        if (adds === 1) throw new Error('Repository moved')
        return { ok: true }
      }
      return undefined
    }
  })
  let closes = 0
  const mounted = await mount(createElement(NewGroupDialog, { context: harness.context, repo: repo(), onClose() { closes += 1 } }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await setText(textField(dialog), 'backend')
  await click(button(dialog, 'Create'))
  expect(harness.toasts).toEqual([{ title: 'Could not create section', body: 'Repository moved' }])
  expect(closes).toBe(0)
  expect(record(harness, 'quirky.repo/groupCreate')).toHaveLength(1)
  expect(button(dialog, 'Create')?.disabled).toBe(false)

  await click(button(dialog, 'Create'))
  expect(record(harness, 'quirky.repo/groupCreate').map((call) => call.params)).toEqual([{ name: 'backend' }, { name: 'backend' }])
  expect(record(harness, 'quirky.repo/groupAdd').map((call) => call.params)).toEqual([
    { group: 'g1', repo: 'r1' },
    { group: 'g2', repo: 'r1' }
  ])
  expect(closes).toBe(1)
})

test('an obsolete group-create completion cannot add to a replacement repository or close its form', async () => {
  const createResult = deferred<unknown>()
  const harness = makeHarness({ onCall: (method) => method === 'quirky.repo/groupCreate' ? createResult.promise : undefined })
  let closes = 0
  const mounted = await mount(createElement(NewGroupDialog, { context: harness.context, repo: repo('r1', 'api'), onClose() { closes += 1 } }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await setText(textField(dialog), 'draft')
  await mounted.render(createElement(NewGroupDialog, { context: harness.context, repo: repo('r1', 'api'), onClose() { closes += 1 } }))
  expect(textField(mounted.host).value).toBe('draft')
  await click(button(dialog, 'Create'))
  expect(record(harness, 'quirky.repo/groupCreate')).toHaveLength(1)

  await mounted.render(createElement(NewGroupDialog, { context: harness.context, repo: repo('r2', 'web'), onClose() { closes += 1 } }))
  expect(textField(mounted.host).value).toBe('')
  await act(async () => createResult.resolve(group('g-old', 'draft')))
  await flush()
  expect(record(harness, 'quirky.repo/groupAdd')).toHaveLength(0)
  expect(closes).toBe(0)
  expect(textField(mounted.host).value).toBe('')
  await setText(textField(mounted.host), 'replacement')
  expect(button(mounted.host, 'Create')?.disabled).toBe(false)
})

test('atomic worktree-section assignment preserves captured identity and reports refusal', async () => {
  const harness = makeHarness({ onCall: (method) => method === 'quirky.worktree/createGroup' ? { assigned: false } : undefined })
  let closes = 0
  const mounted = await mount(createElement(NewWorktreeGroupDialog, {
    context: harness.context,
    worktreeId: 'wt-1',
    initialName: '  backend  ',
    expectedInstanceId: 'instance-4',
    expectedProjectGroupId: null,
    onClose() { closes += 1 }
  }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await click(button(dialog, 'Create'))
  expect(record(harness, 'quirky.worktree/createGroup').map((call) => call.params)).toEqual([{
    worktree: 'wt-1', name: 'backend', expectedInstanceId: 'instance-4', expectedProjectGroupId: null
  }])
  expect(harness.toasts).toEqual([{ title: 'Could not create section', body: 'The worktree changed before it could be assigned.' }])
  expect(closes).toBe(1)
})

test('scope validation is exact and Retry controls stay inside their originating window', async () => {
  const harnessA = makeHarness({ connId: 7, onCall: (method) => method === 'quirky.ledger/request' ? Promise.reject(new Error('Ledger offline')) : undefined })
  const harnessB = makeHarness({ connId: 9, onCall: (method) => method === 'quirky.ledger/request' ? Promise.reject(new Error('Ledger offline')) : undefined })
  const mountedA = await mount(createElement(DeleteGroupDialog, { context: harnessA.context, group: group('g1'), onClose() {} }))
  const mountedB = await mount(createElement(DeleteGroupDialog, { context: harnessB.context, group: group('g1'), onClose() {} }))
  const dialogA = mountedA.host.querySelector('[role="dialog"]')!
  const dialogB = mountedB.host.querySelector('[role="dialog"]')!
  await waitFor(() => errorText(dialogA))
  await waitFor(() => errorText(dialogB))

  const bad = {
    action: 'control', scope: 'group-dialog', target: 'g1', operation: 'retry-preview', payload: { extra: true }
  }
  expect(() => dispatchUiControl(harnessA.context, { ...bad, operation: 'unknown' })).toThrow('Invalid group-dialog control.')
  expect(() => dispatchUiControl(harnessA.context, bad)).toThrow('Invalid group-dialog control.')
  expect(dispatchUiControl(harnessA.context, { ...bad, target: 'not-mounted', operation: 'unknown' }).delivered).toBe(0)

  await click(button(dialogA, 'Retry'))
  expect(record(harnessA, 'ui.window.command.run')).toHaveLength(1)
  expect(record(harnessA, 'ui.window.command.run')[0]?.params).toMatchObject({ connId: 7, id: UI_CONTROL_COMMAND })
  expect(record(harnessB, 'ui.window.command.run')).toHaveLength(0)
  expect(record(harnessA, 'quirky.ledger/request')).toHaveLength(2)
  expect(record(harnessB, 'quirky.ledger/request')).toHaveLength(1)
  expect(harnessA.executeCommands).toEqual([])
  expect(harnessB.executeCommands).toEqual([])
})

test('setup and issue skip choices accumulate as separate create fields', async () => {
  const rejected = (kind: 'setup' | 'issue', hash: string) => Object.assign(new Error(`${kind} requires a choice`), {
    data: { reason: 'hooks-untrusted', repo: 'r1', kind, script: `echo ${kind}`, hash }
  })
  const attempts: Array<{ method: string; params: Record<string, unknown> }> = []
  let createCount = 0
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      attempts.push({ method, params })
      if (method === 'ui.window.self') return { connId: 7 }
      if (method === 'quirky.worktree/create') {
        createCount += 1
        if (createCount === 1) throw rejected('setup', 'setup-hash')
        if (createCount === 2) throw rejected('issue', 'issue-hash')
        return { worktree: { id: 'wt', name: 'main', path: '/repos/api' } }
      }
      if (method === 'quirky.worktree/navigate') return { ok: true }
      throw new Error(`Unexpected call ${method}`)
    },
    getLayout: () => ({ view: null }),
    toast() {},
    log() {}
  } as unknown as UiPluginContext
  const choices: Array<'skip'> = ['skip', 'skip']
  const result = await createWorkspace(context, { repo: 'r1' }, {
    async askTrust() { return choices.shift() ?? 'cancel' },
    showFallback() {}
  })
  expect(result).toMatchObject({ worktree: { id: 'wt' } })
  expect(attempts.filter((call) => call.method === 'quirky.worktree/create').at(-1)?.params).toEqual({
    repo: 'r1', setup: 'skip', issueCommand: 'skip', createdBy: 'window'
  })
})

test('an older preview cannot populate a replacement group dialog', async () => {
  const oldPreview = deferred<unknown>()
  const groups = [group('g1'), group('g2')]
  const harness = makeHarness({
    groups,
    onCall(method, params) {
      if (method !== 'quirky.ledger/request') return undefined
      const ids = (params.removal as { groupIds: string[] }).groupIds
      return ids[0] === 'g1' ? oldPreview.promise : { removalPreview: [] }
    }
  })
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => record(harness, 'quirky.ledger/request').length === 1)
  await mounted.render(createElement(DeleteGroupDialog, { context: harness.context, group: group('g2'), onClose() {} }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await waitFor(() => dialog.textContent?.includes('Ledger records retained: No affected ledgers.'))

  await act(async () => oldPreview.resolve({ removalPreview: [{ ledgerId: 'old-ledger', revision: 8, entryCount: 99 }] }))
  await flush()
  expect(dialog.textContent).not.toContain('old-ledger')
  expect(dialog.textContent).not.toContain('99 entries')
  expect(dialog.textContent).toContain('Ledger records retained: No affected ledgers.')
})

test('an obsolete group-list completion does not issue a ledger read for its former owner', async () => {
  const oldGroups = deferred<unknown>()
  let groupLists = 0
  const harness = makeHarness({
    onCall(method) {
      if (method === 'quirky.repo/groupList') {
        groupLists += 1
        return groupLists === 1 ? oldGroups.promise : [group('g2')]
      }
      if (method === 'quirky.ledger/request') return { removalPreview: [] }
      return undefined
    }
  })
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => record(harness, 'quirky.repo/groupList').length === 1)

  await mounted.render(createElement(DeleteGroupDialog, { context: harness.context, group: group('g2'), onClose() {} }))
  await waitFor(() => groupLists === 2 && record(harness, 'quirky.ledger/request').length === 1)
  expect(record(harness, 'quirky.ledger/request')[0]?.params.removal).toEqual({ groupIds: ['g2'] })

  await act(async () => oldGroups.resolve([group('g1')]))
  await flush()
  expect(groupLists).toBe(2)
  expect(record(harness, 'quirky.ledger/request')).toHaveLength(1)
})

test('a sent delete cannot close or hold busy state on the replacement section', async () => {
  const pendingDelete = deferred<unknown>()
  const harness = makeHarness({
    groups: [group('g1'), group('g2')],
    onCall(method, params) {
      if (method === 'quirky.ledger/request') return { removalPreview: [] }
      if (method === 'quirky.repo/groupDelete' && params.group === 'g1') return pendingDelete.promise
      return undefined
    }
  })
  let closes = 0
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() { closes += 1 } }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await waitFor(() => button(dialog, 'Delete section')?.disabled === false)
  await click(button(dialog, 'Delete section'))
  expect(record(harness, 'quirky.repo/groupDelete')).toHaveLength(1)

  await mounted.render(createElement(DeleteGroupDialog, { context: harness.context, group: group('g2'), onClose() { closes += 1 } }))
  const replacementDialog = mounted.host.querySelector<HTMLElement>('[role="dialog"]')!
  await waitFor(() => button(replacementDialog, 'Delete section')?.disabled === false)
  await act(async () => pendingDelete.resolve({ ok: true }))
  await flush()
  expect(closes).toBe(0)
  expect(replacementDialog.textContent).toContain('Delete the section g2?')
  expect(button(replacementDialog, 'Delete section')?.disabled).toBe(false)
})

test('renaming an unchanged section closes without a write; a changed name keeps its payload', async () => {
  const unchangedHarness = makeHarness()
  let unchangedCloses = 0
  const unchanged = await mount(createElement(RenameGroupDialog, {
    context: unchangedHarness.context, group: group('g1', 'backend'), onClose() { unchangedCloses += 1 }
  }))
  await click(button(unchanged.host, 'Rename'))
  expect(record(unchangedHarness, 'quirky.repo/groupRename')).toHaveLength(0)
  expect(unchangedCloses).toBe(1)

  const changedHarness = makeHarness()
  let changedCloses = 0
  const changed = await mount(createElement(RenameGroupDialog, {
    context: changedHarness.context, group: group('g1', 'backend'), onClose() { changedCloses += 1 }
  }))
  await setText(textField(changed.host), '  services  ')
  await click(button(changed.host, 'Rename'))
  expect(record(changedHarness, 'quirky.repo/groupRename').map((call) => call.params)).toEqual([{ group: 'g1', name: 'services' }])
  expect(changedCloses).toBe(1)
})

test('context replacement and close/reopen invalidate old name-form continuations', async () => {
  const oldCreate = deferred<unknown>()
  const oldHarness = makeHarness({ onCall: (method) => method === 'quirky.repo/groupCreate' ? oldCreate.promise : undefined })
  const newHarness = makeHarness({ connId: 9 })
  let closes = 0
  const mounted = await mount(createElement(NewGroupDialog, {
    context: oldHarness.context, repo: repo(), onClose() { closes += 1 }
  }))
  await setText(textField(mounted.host), 'old draft')
  await click(button(mounted.host, 'Create'))
  await mounted.render(createElement(NewGroupDialog, {
    context: newHarness.context, repo: repo(), onClose() { closes += 1 }
  }))
  expect(textField(mounted.host).value).toBe('')

  await act(async () => oldCreate.resolve(group('g-old', 'old draft')))
  await flush()
  expect(record(oldHarness, 'quirky.repo/groupAdd')).toHaveLength(0)
  expect(record(newHarness, 'quirky.repo/groupAdd')).toHaveLength(0)
  expect(closes).toBe(0)

  await mounted.unmount()
  const reopened = await mount(createElement(NewGroupDialog, {
    context: newHarness.context, repo: repo(), onClose() { closes += 1 }
  }))
  expect(textField(reopened.host).value).toBe('')
})

test('malformed retry guards throw the scope error; stale and ineligible controls deliver zero', async () => {
  const harness = makeHarness({ onCall: (method) => method === 'quirky.ledger/request' ? Promise.reject(new Error('Ledger offline')) : undefined })
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  const dialog = mounted.host.querySelector('[role="dialog"]')!
  await waitFor(() => errorText(dialog))
  const control = (payload: Record<string, unknown>, target = 'g1', operation = 'retry-preview') => ({
    action: 'control', scope: 'group-dialog', target, operation, payload
  })
  const malformed = [
    { extra: true },
    { owner: '' },
    { owner: 7 },
    { revision: -1 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: null },
    { owner: 'valid', revision: 2, extra: true }
  ]
  for (const payload of malformed) {
    expect(() => dispatchUiControl(harness.context, control(payload))).toThrow('Invalid group-dialog control.')
  }
  expect(dispatchUiControl(harness.context, control({ owner: 'expired-owner', revision: 0 })).delivered).toBe(0)
  expect(dispatchUiControl(harness.context, control({ revision: 0 }, 'not-mounted', 'unknown')).delivered).toBe(0)
  expect(record(harness, 'quirky.ledger/request')).toHaveLength(1)

  const readyHarness = makeHarness()
  const ready = await mount(createElement(DeleteGroupDialog, { context: readyHarness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => button(ready.host, 'Delete section')?.disabled === false)
  expect(dispatchUiControl(readyHarness.context, control({})).delivered).toBe(0)
  expect(record(readyHarness, 'quirky.ledger/request')).toHaveLength(1)
})

test('the Retry click is mount-exact while explicit unguarded commands fan out and clean up', async () => {
  const harness = makeHarness({ onCall: (method) => method === 'quirky.ledger/request' ? Promise.reject(new Error('Ledger offline')) : undefined })
  const first = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  const second = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => errorText(first.host))
  await waitFor(() => errorText(second.host))
  expect(record(harness, 'quirky.repo/groupList')).toHaveLength(2)

  await click(button(first.host, 'Retry'))
  await waitFor(() => record(harness, 'quirky.repo/groupList').length === 3)
  await waitFor(() => errorText(first.host))
  expect(record(harness, 'quirky.repo/groupList')).toHaveLength(3)

  const explicit = { action: 'control', scope: 'group-dialog', target: 'g1', operation: 'retry-preview', payload: {} }
  expect((await dispatchControlAndSettle(harness.context, explicit)).delivered).toBe(2)
  await waitFor(() => record(harness, 'quirky.repo/groupList').length === 5)
  await waitFor(() => errorText(first.host) && errorText(second.host))
  await first.unmount()
  expect((await dispatchControlAndSettle(harness.context, explicit)).delivered).toBe(1)
  await waitFor(() => record(harness, 'quirky.repo/groupList').length === 6)
  await second.unmount()
  expect((await dispatchControlAndSettle(harness.context, explicit)).delivered).toBe(0)
})

test('stale same-target controls are rejected after close and reopen while self identity is pending', async () => {
  const pendingSelf = deferred<unknown>()
  let selfRequests = 0
  const harness = makeHarness({
    onCall(method) {
      if (method === 'ui.window.self') {
        selfRequests += 1
        return pendingSelf.promise
      }
      if (method === 'quirky.ledger/request') return Promise.reject(new Error('Ledger offline'))
      return undefined
    }
  })
  const old = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => errorText(old.host))
  await click(button(old.host, 'Retry'))
  expect(selfRequests).toBe(1)
  await old.unmount()

  const replacement = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => errorText(replacement.host))
  const readsBeforeRelease = record(harness, 'quirky.ledger/request').length
  await act(async () => pendingSelf.resolve({ connId: 7 }))
  await flush()
  expect(record(harness, 'ui.window.command.run')).toHaveLength(1)
  expect(record(harness, 'ui.window.command.run')[0]?.params.args).toMatchObject({
    action: 'control', scope: 'group-dialog', target: 'g1', operation: 'retry-preview',
    payload: { owner: expect.any(String), revision: expect.any(Number) }
  })
  expect(record(harness, 'quirky.ledger/request')).toHaveLength(readsBeforeRelease)
  expect(errorText(replacement.host)).toBe('Could not check retained ledger records: Ledger offline')
  expect(harness.toasts).toEqual([])
})

test('window-routing failures and malformed control replies never retry locally', async () => {
  let selfRequests = 0
  let commandRequests = 0
  const harness = makeHarness({
    onCall(method, params) {
      if (method === 'quirky.ledger/request') return Promise.reject(new Error('Ledger offline'))
      if (method === 'ui.window.self') {
        selfRequests += 1
        return selfRequests === 1 ? {} : { connId: 7 }
      }
      if (method === 'ui.window.command.run') {
        commandRequests += 1
        if (commandRequests === 1) throw new Error('no live UI window 7')
        if (commandRequests === 2) return { result: null }
        const args = params.args as Record<string, unknown>
        if (commandRequests === 3) return { result: { ...args, delivered: 0 } }
        if (commandRequests === 4) return { result: { ...args, delivered: -1 } }
        if (commandRequests === 5) return { result: { ...args, delivered: Number.NaN } }
        if (commandRequests === 6) return { result: { ...args, target: 'g2', delivered: 1 } }
        return { result: { delivered: 1 } }
      }
      return undefined
    }
  })
  const mounted = await mount(createElement(DeleteGroupDialog, { context: harness.context, group: group('g1'), onClose() {} }))
  await waitFor(() => errorText(mounted.host))
  await click(button(mounted.host, 'Retry'))
  expect(harness.toasts).toHaveLength(1)
  expect(harness.toasts.at(-1)).toEqual({
    title: 'Could not update section dialog', body: 'ui.window.self returned an invalid connection identity.'
  })
  await click(button(mounted.host, 'Retry'))
  expect(harness.toasts).toHaveLength(2)
  expect(harness.toasts.at(-1)).toEqual({ title: 'Could not update section dialog', body: 'no live UI window 7' })
  await click(button(mounted.host, 'Retry'))
  expect(harness.toasts).toHaveLength(3)
  expect(harness.toasts.at(-1)).toEqual({
    title: 'Could not update section dialog', body: 'The window returned no UI control result.'
  })
  await click(button(mounted.host, 'Retry'))
  expect(harness.logs).toContain('worktree: retry-preview reached no mounted target')
  expect(harness.toasts).toHaveLength(3)
  for (const expectedCount of [4, 5, 6, 7]) {
    await click(button(mounted.host, 'Retry'))
    expect(harness.toasts).toHaveLength(expectedCount)
    expect(harness.toasts.at(-1)).toEqual({
      title: 'Could not update section dialog', body: 'The window returned no UI control result.'
    })
  }
  expect(record(harness, 'ui.window.command.run')).toHaveLength(7)
  expect(record(harness, 'quirky.ledger/request')).toHaveLength(1)
  expect(harness.executeCommands).toEqual([])
  expect(errorText(mounted.host)).toBe('Could not check retained ledger records: Ledger offline')
})

test('the other accumulated trust choices and cancel/hash guards stay unchanged', async () => {
  const rejection = (kind: 'setup' | 'issue', hash = `${kind}-hash`) => Object.assign(new Error('untrusted'), {
    data: { reason: 'hooks-untrusted', repo: 'r1', kind, script: `echo ${kind}`, ...(hash ? { hash } : {}) }
  })
  async function run(failures: Error[], answers: Array<'skip' | 'run' | 'always' | 'cancel'>) {
    const creates: Array<Record<string, unknown>> = []
    const toasts: Toast[] = []
    let failureIndex = 0
    const context = {
      async call(method: string, params: Record<string, unknown> = {}) {
        if (method === 'ui.window.self') return { connId: 7 }
        if (method === 'quirky.worktree/create') {
          creates.push(params)
          const failure = failures[failureIndex++]
          if (failure) throw failure
          return { worktree: { id: 'wt', name: 'main', path: '/repos/api' } }
        }
        if (method === 'quirky.repo/trustHooks' || method === 'quirky.worktree/navigate') return { ok: true }
        throw new Error(`Unexpected call ${method}`)
      },
      getLayout: () => ({ view: null }),
      toast(title: string, body: string) { toasts.push({ title, body }) },
      log() {}
    } as unknown as UiPluginContext
    const result = await createWorkspace(context, { repo: 'r1' }, {
      async askTrust() { return answers.shift() ?? 'cancel' },
      showFallback() {}
    })
    return { creates, result, toasts }
  }

  const skipRun = await run([rejection('setup'), rejection('issue')], ['skip', 'run'])
  expect(skipRun.creates.at(-1)).toEqual({
    repo: 'r1', setup: 'skip', trustIssueCommand: true, trustIssueCommandHash: 'issue-hash', createdBy: 'window'
  })
  const runSkip = await run([rejection('setup'), rejection('issue')], ['run', 'skip'])
  expect(runSkip.creates.at(-1)).toEqual({
    repo: 'r1', trustSetup: true, trustSetupHash: 'setup-hash', issueCommand: 'skip', createdBy: 'window'
  })
  const cancelled = await run([rejection('setup')], ['cancel'])
  expect(cancelled.result).toBeNull()
  expect(cancelled.creates).toHaveLength(1)
  const missingHash = await run([rejection('setup', '')], ['run'])
  expect(missingHash.result).toBeNull()
  expect(missingHash.creates).toHaveLength(1)
  expect(missingHash.toasts[0]?.title).toBe('Could not run setup once')
})
