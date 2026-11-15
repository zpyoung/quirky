import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { Root } from 'react-dom/client'
import type { ProjectGroup, Repo, UiPluginContext } from '@quirky/protocol'
import { DEFAULT_STOCK_OPTIONS } from '../src/control-types'
import { dispatchUiControl, UI_CONTROL_COMMAND, type ScopedUiControlArgs } from '../src/ui-control'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, type RowFact, type SavedView, type Tag, type ViewDisplay, type ViewFilter, type ViewId } from '../src/view-types'

type Component<Props> = (props: Props) => ReactNode

type TabsProps = {
  context: UiPluginContext
  views: readonly SavedView[]
  needsYouHidden: boolean
  needsYouCount: number
  needsYouErrored: boolean
  activeId: ViewId
  changedIds: ReadonlySet<ViewId>
  writeBusy?: boolean
  onSelect(id: ViewId): void
  onHideNeedsYou(hidden: boolean): void
  onStar(id: string, starred: boolean): void
  onDelete(id: string): void
}
type FilterProps = {
  anchor: RefObject<HTMLElement | null>
  filter: ViewFilter
  activityError?: string | null
  tags: readonly Tag[]
  sections: readonly Pick<ProjectGroup, 'id' | 'name'>[]
  repos: readonly Repo[]
  statuses: readonly { id: string; label: string }[]
  onChange(next: ViewFilter): void
  onClear(): void
  onClose(): void
}
type DisplayProps = {
  anchor: HTMLElement
  display: ViewDisplay
  rowFact: RowFact
  writeBusy?: boolean
  onDisplay(patch: Partial<ViewDisplay>): void
  onRowFact(fact: RowFact): void
  onSaveAsView(): void
  onClose(): void
}
type SaveProps = {
  summary: string
  busy?: boolean
  onSave(name: string, starred: boolean): void
  onClose(): void
}


type Call = { method: string; params: Record<string, unknown> }
type PendingRequest = { args: unknown; resolve(reply: unknown): void }
type Mount = {
  render(node: ReactNode): Promise<void>
  unmount(): Promise<void>
}

const NO_REPLY = Symbol('no reply override')
const mounts = new Set<Mount>()
let host: HTMLElement
let createRoot: (container: Element) => Root
let ViewTabs: Component<TabsProps>
let FilterMenu: Component<FilterProps>
let DisplayMenu: Component<DisplayProps>
let SaveViewDialog: Component<SaveProps>


// Happy DOM must be installed before React DOM and its portaled UI components inspect window.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  ;({ ViewTabs } = await import('../src/ViewTabs'))
  ;({ FilterMenu } = await import('../src/FilterMenu'))
  ;({ DisplayMenu } = await import('../src/DisplayMenu'))
  ;({ SaveViewDialog } = await import('../src/SaveViewDialog'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.replaceChildren()
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  for (const mount of [...mounts].reverse()) await mount.unmount()
  mounts.clear()
  document.body.replaceChildren()
})

async function mount(container: Element, node: ReactNode): Promise<Mount> {
  const root = createRoot(container)
  let mounted = true
  const entry: Mount = {
    async render(next) {
      await act(async () => root.render(next))
    },
    async unmount() {
      if (!mounted) return
      mounted = false
      mounts.delete(entry)
      await act(async () => root.unmount())
    }
  }
  mounts.add(entry)
  await entry.render(node)
  return entry
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      const timer = Promise.withResolvers<void>()
      setTimeout(timer.resolve, 0)
      await timer.promise
    }
  })
}

function norm(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function buttonNamed(root: ParentNode, name: string): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.getAttribute('aria-label') === name || norm(button.textContent) === name
  ) ?? null
}

function menuItemsNamed(name: string, root: ParentNode = document.body): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((item) => norm(item.textContent).replace(/\s*✓$/, '') === name)
}

function menuItemNamed(name: string, root: ParentNode = document.body): HTMLButtonElement | null {
  return menuItemsNamed(name, root)[0] ?? null
}
function renderContainer(): HTMLDivElement {
  const container = document.createElement('div')
  host.append(container)
  return container
}


async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('Expected a clickable element.')
  await act(async () => {
    if (element instanceof HTMLButtonElement) element.click()
    else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function setText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await settle()
}

function defaultFilter(): ViewFilter {
  return structuredClone(allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES).filter)
}

function defaultView(id = 'view_a', starred = true): SavedView {
  return {
    id,
    name: id === 'view_a' ? 'Release 2.4' : id,
    starred,
    spec: allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
  }
}

function tabsProps(context: UiPluginContext, overrides: Partial<TabsProps> = {}): TabsProps {
  return {
    context,
    views: [defaultView()],
    needsYouHidden: false,
    needsYouCount: 0,
    needsYouErrored: false,
    activeId: 'all',
    changedIds: new Set(),
    onSelect() {},
    onHideNeedsYou() {},
    onStar() {},
    onDelete() {},
    ...overrides
  }
}

function tabsElement(props: TabsProps): ReactNode {
  return createElement(ViewTabs, props)
}

function isScopedArgs(value: unknown): value is ScopedUiControlArgs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return 'action' in value && value.action === 'control' &&
    'scope' in value && typeof value.scope === 'string' &&
    'target' in value && typeof value.target === 'string' &&
    'operation' in value && typeof value.operation === 'string' &&
    'payload' in value && typeof value.payload === 'object' && value.payload !== null && !Array.isArray(value.payload)
}

function scopedArgs(value: unknown): ScopedUiControlArgs {
  if (!isScopedArgs(value)) throw new Error('Expected a scoped UI control request.')
  return value
}

function createContextHarness() {
  const calls: Call[] = []
  const toasts: Array<{ title: string; message: string }> = []
  const logs: string[] = []
  const pending: PendingRequest[] = []
  let deferOperation: string | null = null
  let rejectOperation: string | null = null
  let replyOverride: unknown = NO_REPLY
  let context!: UiPluginContext

  const raw = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 7 }
      if (method !== 'ui.window.command.run') throw new Error(`Unexpected call ${method}`)

      const args = scopedArgs(params.args)
      if (replyOverride !== NO_REPLY) {
        const reply = replyOverride
        replyOverride = NO_REPLY
        return reply
      }
      if (args.operation === rejectOperation) {
        rejectOperation = null
        throw new Error('no live UI window 7')
      }
      if (args.operation === deferOperation) {
        deferOperation = null
        const deferred = Promise.withResolvers<unknown>()
        pending.push({ args, resolve: deferred.resolve })
        return deferred.promise
      }
      return { result: dispatchUiControl(context, args) }
    },
    toast(title: string, message: string) {
      toasts.push({ title, message })
    },
    log(message: string) {
      logs.push(message)
    },
    executeCommand() {
      throw new Error('View tabs must use the window-scoped UI control route.')
    }
  }
  context = raw as unknown as UiPluginContext

  return {
    context,
    calls,
    toasts,
    logs,
    defer(operation: string) {
      deferOperation = operation
    },
    reject(operation: string) {
      rejectOperation = operation
    },
    malformedReply(reply: unknown) {
      replyOverride = reply
    },
    pending,
    async releaseNext() {
      const request = pending.shift()
      if (!request) throw new Error('No deferred request is waiting.')
      await act(async () => request.resolve({ result: dispatchUiControl(context, request.args) }))
      await settle()
    }
  }
}

function controlArgs(
  operation: string,
  payload: Record<string, unknown>,
  target = 'views'
) {
  return { action: 'control', scope: 'view-tabs', target, operation, payload }
}

test('Filter renders the exact shared empty and activity-error states', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  await mount(renderContainer(), createElement(FilterMenu, {
    anchor: { current: anchor },
    filter: defaultFilter(),
    tags: [] as Tag[],
    sections: [] as Pick<ProjectGroup, 'id' | 'name'>[],
    repos: [] as Repo[],
    statuses: [],
    activityError: 'Projection offline',
    onChange() {},
    onClear() {},
    onClose() {}
  }))
  await settle()

  expect(norm(document.querySelector('.ui-empty-state__message')?.textContent)).toBe('No tags yet.')
  expect(document.querySelector('[role="group"][aria-label="Sections"]')).toBeNull()
  expect(document.querySelector('[role="group"][aria-label="Projects"]')).toBeNull()
  expect(norm(document.querySelector('.ui-inline-error__message')?.textContent)).toBe('Workspace activity filters unavailable: Projection offline')
  expect(document.querySelector('.ui-inline-error')).not.toBeNull()
})

test('Filter keeps every populated catalog choice visible', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  const tags: Tag[] = [{ id: 'tag_1', name: 'Urgent', color: null }]
  const sections = [{ id: 'section_1', name: 'Platform' }] as Pick<ProjectGroup, 'id' | 'name'>[]
  const repos = [{ id: 'repo_1', name: 'quirky', path: '/repo', addedAt: 0, kind: 'git', displayName: null, groupId: null }] as Repo[]
  await mount(renderContainer(), createElement(FilterMenu, {
    anchor: { current: anchor },
    filter: defaultFilter(),
    tags,
    sections,
    repos,
    statuses: [{ id: 'in-progress', label: 'In progress' }],
    onChange() {},
    onClear() {},
    onClose() {}
  }))
  await settle()

  const text = norm(document.body.textContent)
  expect(text).toContain('Urgent')
  expect(text).toContain('Platform')
  expect(text).toContain('quirky')
  expect(text).toContain('In progress')
  expect(document.querySelector('.ui-empty-state')).toBeNull()
})

test('Filter rejects custom days that are not positive safe whole numbers without changing the filter', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  const filter = defaultFilter()
  filter.activity.workspaceActivityWindow = 'custom'
  let changed = 0
  await mount(renderContainer(), createElement(FilterMenu, {
    anchor: { current: anchor }, filter,
    tags: [], sections: [], repos: [], statuses: [],
    onChange() { changed += 1 },
    onClear() {}, onClose() {}
  }))
  await settle()

  const input = document.querySelector<HTMLInputElement>('#worktree-tree-filter-custom-days')!
  for (const value of ['0', '-1', '1.5', '', 'nope', '9007199254740992']) {
    await setText(input, value)
    await act(async () => { input.focus(); input.blur() })
    expect(norm(document.body.textContent)).toContain('Enter a positive whole number of days.')
    expect(changed).toBe(0)
  }
})

test('Filter commits custom days on blur', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  const filter = defaultFilter()
  filter.activity.workspaceActivityWindow = 'custom'
  const changes: ViewFilter[] = []
  await mount(renderContainer(), createElement(FilterMenu, {
    anchor: { current: anchor }, filter,
    tags: [], sections: [], repos: [], statuses: [],
    onChange(next: ViewFilter) { changes.push(next) }, onClear() {}, onClose() {}
  }))
  await settle()

  const input = document.querySelector<HTMLInputElement>('#worktree-tree-filter-custom-days')!
  await setText(input, '7')
  await act(async () => { input.focus(); input.blur() })
  expect(changes.at(-1)?.activity.workspaceActivityCustomDays).toBe(7)
})

test('Filter remembers the activity window before live-only', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  const filter = defaultFilter()
  filter.activity.workspaceActivityWindow = 'week'
  const changes: ViewFilter[] = []
  await mount(renderContainer(), createElement(FilterMenu, {
    anchor: { current: anchor }, filter,
    tags: [], sections: [], repos: [], statuses: [],
    onChange(next: ViewFilter) { changes.push(next) }, onClear() {}, onClose() {}
  }))
  await settle()

  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Activity window"]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, 'live-only')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(changes.at(-1)?.activity.workspaceActivityWindowBeforeLiveOnly).toBe('week')
})

test('Filter commits custom days on Enter', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  const filter = defaultFilter()
  filter.activity.workspaceActivityWindow = 'custom'
  const changes: ViewFilter[] = []
  await mount(renderContainer(), createElement(FilterMenu, {
    anchor: { current: anchor }, filter,
    tags: [], sections: [], repos: [], statuses: [],
    onChange(next: ViewFilter) { changes.push(next) }, onClear() {}, onClose() {}
  }))
  await settle()

  const days = document.querySelector<HTMLInputElement>('#worktree-tree-filter-custom-days')!
  await setText(days, '7')
  await act(async () => days.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(changes.at(-1)?.activity.workspaceActivityCustomDays).toBe(7)
})

test('Display disables only row-fact choices while a view write is busy', async () => {
  const anchor = document.createElement('button')
  host.append(anchor)
  const spec = allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
  const onDisplay = (patch: Partial<typeof spec.display>) => { void patch }
  let displayCalls = 0
  let rowFactCalls = 0
  const onRowFact = () => { rowFactCalls += 1 }
  await mount(renderContainer(), createElement(DisplayMenu, {
    anchor,
    display: spec.display,
    rowFact: 'last-activity',
    writeBusy: true,
    onDisplay(patch: Partial<typeof spec.display>) { displayCalls += 1; onDisplay(patch) },
    onRowFact,
    onSaveAsView() {},
    onClose() {}
  }))
  await settle()

  const displayMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Display"]')!
  for (const label of ['Last activity', 'Branch']) {
    expect(menuItemNamed(label, displayMenu)?.disabled).toBe(true)
  }
  expect(menuItemsNamed('Pull request', displayMenu).map((item) => item.disabled)).toEqual([false, true])
  expect(menuItemsNamed('Status', displayMenu).map((item) => item.disabled)).toEqual([false, true])
  await click(menuItemNamed('Branch', displayMenu))
  expect(rowFactCalls).toBe(0)
  const groupByTag = menuItemNamed('Tag', displayMenu)
  expect(groupByTag?.disabled).toBe(false)
  await click(groupByTag)
  expect(displayCalls).toBe(1)
})

test('Save view prevents programmatic busy submits and forwards a trimmed name', async () => {
  const saved: Array<[string, boolean]> = []
  const busyMount = await mount(host, createElement(SaveViewDialog, {
    summary: 'grouped by project',
    busy: true,
    onSave(name: string, starred: boolean) { saved.push([name, starred]) },
    onClose() {}
  }))
  await settle()
  const input = document.querySelector<HTMLInputElement>('#worktree-view-name')!
  await setText(input, 'Release 2.4')
  const form = document.querySelector('form')!
  await submit(form)
  await submit(form)
  expect(buttonNamed(document.body, 'Save view')?.disabled).toBe(true)
  expect(saved).toEqual([])

  await busyMount.unmount()
  await mount(host, createElement(SaveViewDialog, {
    summary: 'grouped by project',
    onSave(name: string, starred: boolean) { saved.push([name, starred]) },
    onClose() {}
  }))
  await settle()
  const nextInput = document.querySelector<HTMLInputElement>('#worktree-view-name')!
  await setText(nextInput, '  Release 2.4  ')
  await submit(document.querySelector('form')!)
  expect(saved).toEqual([['Release 2.4', true]])
})

test('ViewTabs routes menu opening through the exact-window scoped command with a stable owner', async () => {
  const bridge = createContextHarness()
  const props = tabsProps(bridge.context)
  const mounted = await mount(host, tabsElement(props))
  await click(buttonNamed(host, 'All views'))

  const route = bridge.calls.find((call) => call.method === 'ui.window.command.run')!
  expect(route.params.connId).toBe(7)
  expect(route.params.id).toBe(UI_CONTROL_COMMAND)
  const routed = scopedArgs(route.params.args)
  expect(routed.action).toBe('control')
  expect(routed.scope).toBe('view-tabs')
  expect(routed.target).toBe('views')
  expect(routed.operation).toBe('open-list')
  const owner = routed.payload.owner
  expect(typeof owner).toBe('string')
  expect(owner).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).not.toBeNull()

  await act(async () => { dispatchUiControl(bridge.context, controlArgs('close-list', { owner })) })
  await settle()
  await mounted.render(tabsElement({ ...props, needsYouCount: 2 }))
  const reopened = await act(async () => dispatchUiControl(bridge.context, controlArgs('open-list', { owner })))
  expect(reopened.delivered).toBe(1)
})

test('ViewTabs ignores another target before operation validation and rejects malformed view controls', async () => {
  const bridge = createContextHarness()
  await mount(host, tabsElement(tabsProps(bridge.context)))

  expect(dispatchUiControl(bridge.context, controlArgs('not-an-operation', { extra: true }, 'elsewhere')).delivered).toBe(0)
  expect(() => dispatchUiControl(bridge.context, controlArgs('open-list', { extra: true }))).toThrow('Invalid view-tabs control.')
  expect(() => dispatchUiControl(bridge.context, controlArgs('close-list', { session: -1 }))).toThrow('Invalid view-tabs control.')
  expect(() => dispatchUiControl(bridge.context, controlArgs('open-view-menu', { id: 'view_a', x: 1, revision: 0 }))).toThrow('Invalid view-tabs control.')
  expect(dispatchUiControl(bridge.context, controlArgs('open-view-menu', { id: 'all' })).delivered).toBe(0)
})

test('ViewTabs catches bridge and malformed-reply failures without opening locally', async () => {
  const bridge = createContextHarness()
  await mount(host, tabsElement(tabsProps(bridge.context)))
  bridge.malformedReply({ result: { delivered: 0 } })
  await click(buttonNamed(host, 'All views'))
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).toBeNull()
  expect(bridge.logs.at(-1)).toBe('worktree: open-list reached no mounted target')
  expect(bridge.toasts).toEqual([])
  bridge.reject('open-list')
  await click(buttonNamed(host, 'All views'))
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).toBeNull()
  expect(bridge.toasts.at(-1)).toEqual({ title: 'Could not update view controls', message: 'no live UI window 7' })

  bridge.malformedReply({ result: { delivered: Number.NaN } })
  await click(buttonNamed(host, 'All views'))
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).toBeNull()
  expect(bridge.toasts.at(-1)).toEqual({ title: 'Could not update view controls', message: expect.any(String) })
})

test('ViewTabs keeps failed and zero-delivery close menus open for retry', async () => {
  const bridge = createContextHarness()
  await mount(host, tabsElement(tabsProps(bridge.context)))
  await click(buttonNamed(host, 'All views'))
  bridge.reject('close-list')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await settle()

  expect(document.querySelector('[role="menu"][aria-label="Views"]')).not.toBeNull()
  expect(bridge.toasts.at(-1)).toEqual({ title: 'Could not update view controls', message: 'no live UI window 7' })
  bridge.malformedReply({ result: { delivered: 0 } })
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await settle()
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).not.toBeNull()
  expect(bridge.logs.at(-1)).toBe('worktree: close-list reached no mounted target')

  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await settle()
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).toBeNull()
})

test('ViewTabs keeps a zero-delivery context menu open and retryable', async () => {
  const bridge = createContextHarness()
  await mount(host, tabsElement(tabsProps(bridge.context)))
  const tab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 14 })))
  await settle()

  bridge.malformedReply({ result: { delivered: 0 } })
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="View actions"]')!
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await settle()
  expect(document.querySelector('[role="menu"][aria-label="View actions"]')).not.toBeNull()
  expect(bridge.logs.at(-1)).toBe('worktree: close-view-menu reached no mounted target')

  const retry = document.querySelector<HTMLElement>('[role="menu"][aria-label="View actions"]')!
  await act(async () => retry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await settle()
  expect(document.querySelector('[role="menu"][aria-label="View actions"]')).toBeNull()
})

test('ViewTabs fences delayed closes by menu session and revisions by tab data', async () => {
  const bridge = createContextHarness()
  const props = tabsProps(bridge.context)
  const mounted = await mount(host, tabsElement(props))
  await click(buttonNamed(host, 'All views'))
  bridge.defer('close-list')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await settle()
  const oldClose = bridge.calls.filter((call) => call.method === 'ui.window.command.run').at(-1)!.params.args

  await act(async () => { dispatchUiControl(bridge.context, oldClose) })
  await settle()
  await click(buttonNamed(host, 'All views'))
  await bridge.releaseNext()
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).not.toBeNull()

  bridge.defer('open-view-menu')
  const tab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })))
  await settle()
  await mounted.render(tabsElement({ ...props, views: [{ ...defaultView(), name: 'Replacement' }] }))
  await bridge.releaseNext()
  expect(document.querySelector('[role="menu"][aria-label="View actions"]')).toBeNull()
})

test('ViewTabs replaces a context menu without letting its delayed close close the replacement', async () => {
  const bridge = createContextHarness()
  await mount(host, tabsElement(tabsProps(bridge.context)))
  const needsYou = host.querySelector<HTMLElement>('[role="tab"][data-view-id="needs-you"]')!
  await act(async () => needsYou.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 9 })))
  await settle()
  expect(menuItemNamed('Hide Needs you')).not.toBeNull()

  bridge.defer('close-view-menu')
  const saved = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => saved.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  await settle()
  expect(bridge.pending).toHaveLength(1)
  expect(scopedArgs(bridge.pending[0]!.args).operation).toBe('close-view-menu')

  await act(async () => saved.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 24 })))
  await settle()
  expect(menuItemNamed('Delete view')).not.toBeNull()
  expect(menuItemNamed('Hide Needs you')).toBeNull()

  await bridge.releaseNext()
  expect(menuItemNamed('Delete view')).not.toBeNull()
  expect(menuItemNamed('Hide Needs you')).toBeNull()
})

test('ViewTabs rejects an older delayed context-menu open after a newer one', async () => {
  const bridge = createContextHarness()
  await mount(host, tabsElement(tabsProps(bridge.context)))
  bridge.defer('open-view-menu')
  const needsYou = host.querySelector<HTMLElement>('[role="tab"][data-view-id="needs-you"]')!
  await act(async () => needsYou.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 9 })))
  await settle()
  expect(bridge.pending).toHaveLength(1)
  expect(menuItemNamed('Hide Needs you')).toBeNull()

  const saved = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => saved.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 24 })))
  await settle()
  expect(menuItemNamed('Delete view')).not.toBeNull()
  expect(menuItemNamed('Hide Needs you')).toBeNull()

  await bridge.releaseNext()
  expect(menuItemNamed('Delete view')).not.toBeNull()
  expect(menuItemNamed('Hide Needs you')).toBeNull()
  expect(bridge.logs.at(-1)).toBe('worktree: open-view-menu reached no mounted target')
})

test('ViewTabs preserves selection and roving keyboard focus while write actions are disabled', async () => {
  const bridge = createContextHarness()
  const selected: ViewId[] = []
  let starCalls = 0
  let deleteCalls = 0
  let hideCalls = 0
  const props = tabsProps(bridge.context, {
    writeBusy: true,
    onSelect(id) { selected.push(id) },
    onHideNeedsYou() { hideCalls += 1 },
    onStar() { starCalls += 1 },
    onDelete() { deleteCalls += 1 }
  })
  await mount(host, tabsElement(props))
  const all = host.querySelector<HTMLButtonElement>('[role="tab"][data-view-id="all"]')!
  await act(async () => {
    all.focus()
    all.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  expect(selected).toEqual(['needs-you'])
  expect(document.activeElement).toBe(host.querySelector('[role="tab"][data-view-id="needs-you"]'))

  await click(buttonNamed(host, 'All views'))
  expect(menuItemNamed('Hide Needs you')?.disabled).toBe(true)
  expect(menuItemNamed('Release 2.4')?.disabled).toBe(false)
  await click(menuItemNamed('Release 2.4'))
  expect(selected.at(-1)).toBe('view_a')

  const tab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 12 })))
  await settle()
  expect(menuItemNamed('Remove from tabs')?.disabled).toBe(true)
  expect(menuItemNamed('Delete view')?.disabled).toBe(true)
  await click(menuItemNamed('Remove from tabs'))
  await click(menuItemNamed('Delete view'))
  expect(starCalls).toBe(0)
  expect(deleteCalls).toBe(0)
  expect(hideCalls).toBe(0)

  await act(async () => document.querySelector<HTMLElement>('[role="menu"][aria-label="View actions"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await settle()
  expect(document.activeElement).toBe(tab)
})

test('ViewTabs does not refocus a tab removed while selection is unresolved', async () => {
  const bridge = createContextHarness()
  const selection = Promise.withResolvers<void>()
  const props = tabsProps(bridge.context, {
    async onSelect(id) {
      if (id === 'needs-you') await selection.promise
    }
  })
  const mounted = await mount(host, tabsElement(props))
  const all = host.querySelector<HTMLButtonElement>('[role="tab"][data-view-id="all"]')!
  await act(async () => {
    all.focus()
    all.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  const removedTab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="needs-you"]')!
  expect(document.activeElement).toBe(removedTab)

  await mounted.render(tabsElement({ ...props, needsYouHidden: true }))
  selection.resolve()
  await settle()
  expect(removedTab.isConnected).toBe(false)
  expect(document.activeElement).not.toBe(removedTab)
})

test('ViewTabs handles multiple registrations independently and cleanup removes only its own target', async () => {
  const bridge = createContextHarness()
  const secondHost = document.createElement('div')
  document.body.append(secondHost)
  const first = await mount(host, tabsElement(tabsProps(bridge.context)))
  await mount(secondHost, tabsElement(tabsProps(bridge.context)))
  const opened = await act(async () => dispatchUiControl(bridge.context, controlArgs('open-view-menu', { id: 'view_a' })))
  expect(opened.delivered).toBe(2)

  await first.unmount()
  const closed = await act(async () => dispatchUiControl(bridge.context, controlArgs('close-view-menu', {})))
  expect(closed.delivered).toBe(1)
})

test('ViewTabs invalidates pending controls when its plugin context is replaced', async () => {
  const firstBridge = createContextHarness()
  const secondBridge = createContextHarness()
  const initial = tabsProps(firstBridge.context)
  const mounted = await mount(host, tabsElement(initial))
  firstBridge.defer('open-list')
  await click(buttonNamed(host, 'All views'))
  const request = firstBridge.calls.find((call) => call.method === 'ui.window.command.run')!
  const owner = scopedArgs(request.params.args).payload.owner
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).toBeNull()

  await mounted.render(tabsElement(tabsProps(secondBridge.context)))
  await firstBridge.releaseNext()
  expect(document.querySelector('[role="menu"][aria-label="Views"]')).toBeNull()
  expect(dispatchUiControl(firstBridge.context, controlArgs('close-list', { owner })).delivered).toBe(0)
  expect(dispatchUiControl(secondBridge.context, controlArgs('open-list', { owner })).delivered).toBe(0)
  expect(buttonNamed(host, 'All views')).not.toBeNull()
})

test('ViewTabs forwards available hide, star and delete callbacks once', async () => {
  const bridge = createContextHarness()
  const actions: string[] = []
  const props = tabsProps(bridge.context, {
    onHideNeedsYou(hidden) { actions.push(`hide:${hidden}`) },
    onStar(id, starred) { actions.push(`star:${id}:${starred}`) },
    onDelete(id) { actions.push(`delete:${id}`) }
  })
  await mount(host, tabsElement(props))

  await click(buttonNamed(host, 'All views'))
  await click(menuItemNamed('Hide Needs you'))
  expect(actions).toEqual(['hide:true'])

  const tab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 12 })))
  await settle()
  await click(menuItemNamed('Remove from tabs'))
  expect(actions).toEqual(['hide:true', 'star:view_a:false'])

  await act(async () => tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 12 })))
  await settle()
  await click(menuItemNamed('Delete view'))
  expect(actions).toEqual(['hide:true', 'star:view_a:false', 'delete:view_a'])
})
