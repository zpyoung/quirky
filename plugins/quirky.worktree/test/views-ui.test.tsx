import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, Repo, UiLayout, UiPluginContext } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import type * as React from 'react'
import type { Root } from 'react-dom/client'
import type { ToolPanelFrame as ToolPanelFrameComponent } from '@quirky/ui'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, DEFAULT_VIEWS_STATE, type SavedView, type Tag, type ViewId, type ViewsState } from '../src/view-types'
import { sectionHeading } from './window/dom'

const SLOT = 'sidebar-section:quirky.worktree/worktrees'

type Mount = (element: HTMLElement, props: { report?(state: unknown): void }) => () => void
type Call = { method: string; params: Record<string, unknown> }

let act: (callback: () => unknown) => Promise<void>
let createElement: typeof React.createElement
let createRoot: (container: HTMLElement) => Root
let ToolPanelFrame: typeof ToolPanelFrameComponent
let activate: (context: UiPluginContext) => void

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const react = await import('react')
  act = react.act as typeof act
  createElement = react.createElement
  createRoot = (await import('react-dom/client')).createRoot
  ToolPanelFrame = (await import('@quirky/ui')).ToolPanelFrame
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const WORKTREE_DEFAULTS = {
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false, parentId: null,
  createdAt: 0, createdBy: 'external', baseRef: null, keepBranch: false, removing: false, groupId: null,
  projectGroupId: null, lastActivityAt: 0, sleeping: false, manualOrder: 0, sleepChangedAt: null, references: [],
  archivedAt: null, cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null }, externalVisible: true,
  externalVisibility: 'show', externalInboxSuppressed: false
} as const

const wt = (id: string, repoId: string, name: string, extra: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id, repoId, path: `/w/${name}`, branch: name, head: 'abc', isMain: false, name, ...WORKTREE_DEFAULTS, instanceId: id, tagIds: [], ...extra
}) as WorktreeControl

const REPOS: Repo[] = [
  { id: 'r-harbor', name: 'harbor-api', path: '/r/harbor', addedAt: 0, kind: 'git', displayName: null, groupId: null },
  { id: 'r-quirky', name: 'quirky', path: '/r/quirky', addedAt: 0, kind: 'git', displayName: null, groupId: null }
]

class RpcLike extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
  }
}

type World = {
  worktrees: WorktreeControl[]
  tags: Tag[]
  assignments: Record<string, string[]>
  views: ViewsState
  active: Map<number, ViewId>
  setActiveCalls: Array<{ window: number; viewId: string }>
  setViewsCalls: ViewsState[]
  cleanup: Array<{ worktreeId: string; name: string; fingerprint: string; reason: string; ignored: boolean; eligible: boolean; blockers: unknown[] }>
}

function setup() {
  const world: World = {
    worktrees: [
      wt('w-harbor-main', 'r-harbor', 'main', { isMain: true }),
      wt('w-retry', 'r-harbor', 'retry-queue', { lastActivityAt: 3 }),
      wt('w-quirky-main', 'r-quirky', 'main', { isMain: true }),
      wt('w-tags', 'r-quirky', 'sidebar-tags', { lastActivityAt: 2 }),
      wt('w-docs', 'r-quirky', 'docs-refresh', { lastActivityAt: 1 })
    ],
    tags: [],
    assignments: {},
    views: { ...DEFAULT_VIEWS_STATE, views: [] },
    active: new Map(),
    setActiveCalls: [],
    setViewsCalls: [],
    cleanup: []
  }
  const calls: Call[] = []
  const reports: unknown[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  let layout: UiLayout = { worktree: null, view: null, panel: null, sidebar: true, focus: null }
  const emit = (type: string) => act(async () => {
    await Promise.all([...listeners].map((listener) => listener({ type, data: {} } as QuirkyEvent)))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const listed = () => world.worktrees.map((worktree) => ({ ...worktree, tagIds: [...(world.assignments[worktree.id] ?? [])] }))

  const context = {
    pluginId: 'quirky.worktree',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      switch (method) {
        case 'ui.window.self':
          return { connId: 1 }
        case 'quirky.repo/list':
          return [...REPOS]
        case 'quirky.repo/groupList':
          return [] as ProjectGroup[]
        case 'quirky.worktree/list':
          return listed()
        case 'quirky.worktree/origins':
          return []
        case 'quirky.worktree/options':
          return { ...DEFAULT_STOCK_OPTIONS, filterRepoIds: [], showProperties: [...DEFAULT_STOCK_OPTIONS.showProperties] }
        case 'quirky.worktree/projectOrder':
          return REPOS.map((repo) => repo.id)
        case 'quirky.worktree/statusDefinitions':
          return [
            { id: 'todo', label: 'Todo', color: '#8b8b8b' },
            { id: 'in-progress', label: 'In progress', color: '#3478c5' },
            { id: 'in-review', label: 'In review', color: '#a57de8' },
            { id: 'done', label: 'Done', color: '#48a878' }
          ]
        case 'quirky.worktree/projectMetadataList':
          return []
        case 'quirky.session/list':
          return []
        case 'quirky.ask/list':
          return []
        case 'quirky.sidebar-extras/state':
          throw new RpcLike('method not found', RpcErrorCode.MethodNotFound)
        case 'quirky.worktree/cleanupPreview':
          return { generatedAt: 0, candidates: [...world.cleanup] }
        case 'quirky.worktree/tags':
          return { tags: world.tags.map((tag) => ({ ...tag })), assignments: Object.fromEntries(Object.entries(world.assignments).map(([id, tagIds]) => [id, [...tagIds]])) }
        case 'quirky.worktree/tagCreate': {
          const name = String(params.name)
          const existing = world.tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
          const tag = existing ?? { id: `tag_${world.tags.length + 1}`, name, color: null }
          if (!existing) world.tags.push(tag)
          return { tag }
        }
        case 'quirky.worktree/tagAssign': {
          const ids = params.worktreeIds as string[]
          for (const id of ids) {
            const current = new Set(world.assignments[id] ?? [])
            if (params.assigned) current.add(String(params.tagId))
            else current.delete(String(params.tagId))
            world.assignments[id] = [...current]
          }
          void emit('quirky.worktree/tagsChanged')
          return {}
        }
        case 'quirky.worktree/views':
          return structuredClone(world.views)
        case 'quirky.worktree/setViews': {
          world.views = structuredClone(params.state as ViewsState)
          world.setViewsCalls.push(structuredClone(world.views))
          void emit('quirky.worktree/viewsChanged')
          return structuredClone(world.views)
        }
        case 'quirky.worktree/activeView': {
          const id = world.active.get(Number(params.window)) ?? 'all'
          const known = id === 'all' || (id === 'needs-you' && !world.views.needsYouHidden) || world.views.views.some((view) => view.id === id)
          return { viewId: known ? id : 'all' }
        }
        case 'quirky.worktree/setActiveView':
          world.active.set(Number(params.window), String(params.viewId))
          world.setActiveCalls.push({ window: Number(params.window), viewId: String(params.viewId) })
          return {}
        case 'quirky.worktree/set': {
          const target = world.worktrees.find((worktree) => worktree.id === params.worktree)
          if (target && typeof params.status === 'string') target.status = params.status as WorktreeControl['status']
          return target
        }
        case 'quirky.worktree/sleepPreview':
          return { worktrees: [{ worktreeId: String(params.worktree), name: 'x', sleeping: false, allowed: true, blockers: [] }] }
        case 'quirky.worktree/sleep': {
          const target = world.worktrees.find((worktree) => worktree.id === params.worktree)
          if (target) target.sleeping = true
          return {}
        }
        default:
          throw new Error(`unexpected call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    getSetting: () => undefined,
    executeCommand: async () => {},
    openView() {},
    closeView() {},
    togglePanel() {},
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => void layoutListeners.delete(listener)
    },
    onStream: () => () => {},
    onConnection: () => () => {},
    async confirm() {
      return true
    },
    toast() {},
    setPanelBadge() {}
  } as unknown as UiPluginContext

  activate(context)
  const mount = provided.get(SLOT) as Mount
  return {
    world,
    calls,
    reports,
    emit,
    async mountInto(element: HTMLElement) {
      const frameRoot = createRoot(element)
      const bodyRef = { current: null as HTMLDivElement | null }
      await act(async () => {
        frameRoot.render(createElement(ToolPanelFrame, {
          title: 'Worktrees',
          children: createElement('div', { ref: (node: HTMLDivElement | null) => { bodyRef.current = node } })
        }))
      })
      let cleanup: () => void = () => {}
      await act(async () => {
        cleanup = mount(bodyRef.current!, { report: (state) => void reports.push(state) })
      })
      await settle()
      mounts.add(async () => act(async () => {
        cleanup()
        frameRoot.unmount()
      }))
    }
  }
}

const mounts = new Set<() => Promise<void>>()
let host: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(async () => {
  for (const unmount of [...mounts].reverse()) await unmount()
  mounts.clear()
  document.body.replaceChildren()
})

const settle = () => act(async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
})
const click = async (element: Element | null | undefined, init: MouseEventInit = {}) => {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
  await settle()
}
const typeInto = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const pressEscape = async () => {
  await act(async () => {
    const active = document.activeElement
    const target = active instanceof HTMLElement && active.closest('[role="menu"], [role="dialog"]') ? active : window
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await settle()
}
const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === name || norm(button.textContent) === name)
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
const itemText = (item: Element) => norm(item.textContent).replace(/\s*✓$/, '')
const menuItem = (label: string) => menuItems().find((item) => itemText(item) === label)
const chooseDisplay = async (section: string | null, label: string) => {
  await click(buttonNamed(host, 'Display'))
  let heading: string | null = null
  for (const entry of document.body.querySelectorAll<HTMLElement>('[role="menu"] .qt-menu-heading, [role="menu"] [role="menuitem"]')) {
    if (entry.classList.contains('qt-menu-heading')) {
      heading = norm(entry.textContent)
      continue
    }
    if (itemText(entry) === label && (section === null || heading === section)) return click(entry)
  }
  throw new Error(`no Display item ${label}`)
}
const rowOf = (name: string, within: ParentNode = host) =>
  [...within.querySelectorAll<HTMLElement>('li[data-worktree-id]')].find((row) => norm(row.querySelector('.worktree-name')?.textContent) === name)
const rowNames = () => [...host.querySelectorAll<HTMLElement>('li[data-worktree-id]')].map((row) => norm(row.querySelector('.worktree-name')?.textContent))
const openButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('.worktree-row__main')!
const groupHeadings = () => [...host.querySelectorAll<HTMLElement>('section')].map((section) => sectionHeading(section)).filter((title): title is string => title !== undefined)
const groupRows = (title: string) => {
  const section = [...host.querySelectorAll<HTMLElement>('section')].find((candidate) => sectionHeading(candidate) === title)
  return section ? [...section.querySelectorAll<HTMLElement>('li[data-worktree-id]')].map((row) => norm(row.querySelector('.worktree-name')?.textContent)) : []
}
const rowMenu = async (name: string, label: string) => {
  await click(buttonNamed(rowOf(name)!, `Actions for ${name}`))
  await click(menuItem(label))
}
const tab = (id: string) => host.querySelector<HTMLElement>(`[role="tab"][data-view-id="${id}"]`)
const hasDot = (id: string) => tab(id)?.querySelector('[aria-label="Changed"]') != null
const noticeLines = () => [...host.querySelectorAll<HTMLElement>('.ui-notice-line')]
const noticeWith = (text: string) => noticeLines().find((line) => norm(line.textContent).startsWith(text))
const noticeAction = (line: Element | undefined, label: string) => buttonNamed(line!, label)
const filterPopover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Filter"]')
const checkbox = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLLabelElement>('label.ui-checkbox')].find((item) => norm(item.textContent) === label)?.querySelector<HTMLInputElement>('input') ?? null
const tagsPopover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Tags"]')!

const tagWorktree = async (name: string, tag: string, create: boolean) => {
  await rowMenu(name, 'Tags…')
  const popover = tagsPopover()
  if (create) {
    await typeInto(popover.querySelector<HTMLInputElement>('input')!, tag)
    await click(buttonNamed(popover, `Create "${tag}"`))
  } else {
    await click(checkbox(popover, tag))
  }
  await pressEscape()
}
const filterByTag = async (tag: string) => {
  await click(buttonNamed(host, 'Filter'))
  await click(checkbox(filterPopover()!, tag))
  await pressEscape()
}

test('SC-5: tag two worktrees, then filter to the tag from Filter › Tags', async () => {
  const h = setup()
  await h.mountInto(host)
  expect(rowNames()).toContain('docs-refresh')

  await tagWorktree('retry-queue', 'urgent', true)
  expect(h.world.tags).toEqual([{ id: 'tag_1', name: 'urgent', color: null }])
  expect(h.world.assignments['w-retry']).toEqual(['tag_1'])
  await tagWorktree('sidebar-tags', 'urgent', false)
  expect(h.world.assignments['w-tags']).toEqual(['tag_1'])

  await click(buttonNamed(host, 'Filter'))
  const popover = filterPopover()!
  expect(popover.textContent).toContain('urgent')
  expect(buttonNamed(popover, 'Apply')).toBeUndefined()
  await click(checkbox(popover, 'urgent'))
  expect(rowNames().sort()).toEqual(['retry-queue', 'sidebar-tags'])
  const line = noticeWith('Filtered:')
  expect(norm(line?.textContent)).toContain('Filtered: tag: urgent')
  expect(buttonNamed(line!, 'Remove filter tag: urgent')).toBeDefined()
  expect(noticeAction(line, 'Clear')).toBeDefined()
  expect(hasDot('all')).toBe(true)
  expect(h.calls.filter((call) => call.method === 'quirky.worktree/setOptions')).toEqual([])
  expect(h.world.setViewsCalls).toEqual([])
})

test('SC-5: removing the filter chip or clearing restores the whole list and the hidden count names what is left out', async () => {
  const h = setup()
  h.world.worktrees.push(wt('w-old', 'r-quirky', 'old-experiment', { archivedAt: 1 }))
  await h.mountInto(host)
  expect(rowOf('old-experiment')).toBeUndefined()
  expect(norm(noticeWith('1 hidden')?.textContent)).toContain('1 hidden: archived')

  await tagWorktree('retry-queue', 'urgent', true)
  await filterByTag('urgent')
  expect(rowNames()).toEqual(['retry-queue'])
  await click(buttonNamed(noticeWith('Filtered:')!, 'Remove filter tag: urgent'))
  expect(noticeWith('Filtered:')).toBeUndefined()
  expect(rowNames()).toContain('docs-refresh')
  expect(hasDot('all')).toBe(false)
})

test('SC-6: Group by › Tag lists a worktree under each tag, Untagged last, and marks All changed', async () => {
  const h = setup()
  h.world.tags = [{ id: 'tag_u', name: 'urgent', color: null }, { id: 'tag_r', name: 'release-2.4', color: 'blue' }]
  h.world.assignments = { 'w-retry': ['tag_u', 'tag_r'] }
  await h.mountInto(host)
  expect(hasDot('all')).toBe(false)

  await chooseDisplay('Group by', 'Tag')
  expect(groupRows('urgent')).toEqual(['retry-queue'])
  expect(groupRows('release-2.4')).toEqual(['retry-queue'])
  const untagged = groupRows('Untagged')
  expect(untagged).toContain('docs-refresh')
  expect(untagged).not.toContain('retry-queue')
  const headings = groupHeadings()
  expect(headings.at(-1)).toBe('Untagged')
  expect(headings.indexOf('urgent')).toBeLessThan(headings.indexOf('Untagged'))
  expect(hasDot('all')).toBe(true)
  const line = noticeWith('Changed:')
  expect(norm(line?.textContent)).toContain('grouping')
  expect(noticeAction(line, 'Save')).toBeUndefined()
  expect(noticeAction(line, 'Save as new')).toBeDefined()
  expect(noticeAction(line, 'Revert')).toBeDefined()
})

test('SC-7: Save as new makes an active tab and sends All back to its saved state', async () => {
  const h = setup()
  h.world.tags = [{ id: 'tag_u', name: 'urgent', color: null }]
  h.world.assignments = { 'w-retry': ['tag_u'], 'w-tags': ['tag_u'] }
  await h.mountInto(host)

  await filterByTag('urgent')
  await chooseDisplay('Group by', 'Project')
  expect(hasDot('all')).toBe(true)

  await click(noticeAction(noticeWith('Changed:'), 'Save as new'))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(norm(dialog.textContent)).toContain('Show as a tab')
  expect(norm(dialog.textContent)).toContain('grouped by project')
  const show = checkbox(dialog, 'Show as a tab')!
  expect(show.checked).toBe(true)
  const save = buttonNamed(dialog, 'Save view')!
  expect(save.disabled).toBe(true)
  await typeInto(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, 'Release 2.4')
  await click(save)

  expect(h.world.views.views).toHaveLength(1)
  const saved = h.world.views.views[0]!
  expect(saved).toMatchObject({ name: 'Release 2.4', starred: true })
  expect(saved.spec.filter.tagIds).toEqual(['tag_u'])
  expect(saved.spec.display.groupBy).toBe('project')
  expect(h.world.setActiveCalls.at(-1)).toEqual({ window: 1, viewId: saved.id })
  expect(tab(saved.id)?.getAttribute('aria-selected')).toBe('true')
  expect(norm(tab(saved.id)?.textContent)).toBe('Release 2.4')
  expect(hasDot('all')).toBe(false)
  expect(hasDot(saved.id)).toBe(false)
  expect(rowNames().sort()).toEqual(['retry-queue', 'sidebar-tags'])

  await click(tab('all'))
  expect(h.world.setActiveCalls.at(-1)).toEqual({ window: 1, viewId: 'all' })
  expect(rowNames()).toContain('docs-refresh')
  expect(noticeWith('Filtered:')).toBeUndefined()
})

test('SC-7: a saved view shows a dot when changed and Revert restores its saved filter, grouping and sort', async () => {
  const h = setup()
  h.world.tags = [{ id: 'tag_u', name: 'urgent', color: null }]
  h.world.assignments = { 'w-retry': ['tag_u'], 'w-tags': ['tag_u'] }
  const spec = allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
  const view: SavedView = { id: 'view_a', name: 'Release 2.4', starred: true, spec: { ...spec, filter: { ...spec.filter, tagIds: ['tag_u'] } } }
  h.world.views = { ...h.world.views, views: [view] }
  h.world.active.set(1, 'view_a')
  await h.mountInto(host)
  expect(tab('view_a')?.getAttribute('aria-selected')).toBe('true')
  expect(rowNames().sort()).toEqual(['retry-queue', 'sidebar-tags'])
  expect(hasDot('view_a')).toBe(false)

  await chooseDisplay('Sort by', 'Name')
  expect(hasDot('view_a')).toBe(true)
  const line = noticeWith('Changed:')
  expect(noticeAction(line, 'Save')).toBeDefined()
  expect(noticeAction(line, 'Save as new')).toBeDefined()
  expect(noticeAction(line, 'Revert')).toBeDefined()

  await click(noticeAction(line, 'Revert'))
  expect(hasDot('view_a')).toBe(false)
  expect(noticeWith('Changed:')).toBeUndefined()
  expect(h.world.views.views[0]!.spec.display.sortBy).toBe('recent')
  expect(rowNames()).toEqual(['retry-queue', 'sidebar-tags'])

  await chooseDisplay('Sort by', 'Name')
  await click(noticeAction(noticeWith('Changed:'), 'Save'))
  expect(h.world.views.views[0]!.spec.display.sortBy).toBe('name')
  expect(hasDot('view_a')).toBe(false)
  expect(rowNames()).toEqual(['retry-queue', 'sidebar-tags'])
})

test('SC-7: Esc clears the filters first and a second Esc returns to All', async () => {
  const h = setup()
  h.world.tags = [{ id: 'tag_u', name: 'urgent', color: null }]
  h.world.assignments = { 'w-retry': ['tag_u'] }
  const spec = allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
  const view: SavedView = { id: 'view_a', name: 'Release 2.4', starred: true, spec: { ...spec, filter: { ...spec.filter, tagIds: ['tag_u'] } } }
  h.world.views = { ...h.world.views, views: [view] }
  h.world.active.set(1, 'view_a')
  await h.mountInto(host)
  expect(rowNames()).toEqual(['retry-queue'])
  expect(norm(noticeWith('Filtered:')?.textContent)).toContain('tag: urgent')

  await pressEscape()
  expect(noticeWith('Filtered:')).toBeUndefined()
  expect(tab('view_a')?.getAttribute('aria-selected')).toBe('true')
  expect(hasDot('view_a')).toBe(true)
  expect(rowNames()).toContain('docs-refresh')

  await pressEscape()
  expect(tab('all')?.getAttribute('aria-selected')).toBe('true')
  expect(h.world.setActiveCalls.at(-1)).toEqual({ window: 1, viewId: 'all' })

  await pressEscape()
  expect(tab('all')?.getAttribute('aria-selected')).toBe('true')
  expect(h.world.setActiveCalls).toHaveLength(1)
})

test('SC-7: another window adding a view shows in this strip without moving this window off its view', async () => {
  const h = setup()
  await h.mountInto(host)
  expect(tab('all')?.getAttribute('aria-selected')).toBe('true')
  const spec = allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
  h.world.views = { ...h.world.views, views: [{ id: 'view_b', name: 'Elsewhere', starred: true, spec }] }
  h.world.active.set(2, 'view_b')
  await h.emit('quirky.worktree/viewsChanged')
  await settle()
  expect(norm(tab('view_b')?.textContent)).toBe('Elsewhere')
  expect(tab('view_b')?.getAttribute('aria-selected')).toBe('false')
  expect(tab('all')?.getAttribute('aria-selected')).toBe('true')
})

test('the view strip holds All, Needs you with its count, starred views, and a chevron menu listing every view', async () => {
  const h = setup()
  h.world.worktrees[1] = { ...h.world.worktrees[1]!, unread: true }
  const spec = allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES)
  h.world.views = {
    ...h.world.views,
    views: [
      { id: 'view_s', name: 'Starred', starred: true, spec },
      { id: 'view_q', name: 'Quiet', starred: false, spec }
    ]
  }
  await h.mountInto(host)
  const tabs = [...host.querySelectorAll('[role="tablist"] [role="tab"]')].map((item) => norm(item.textContent))
  expect(tabs).toEqual(['All', 'Needs you1', 'Starred'])
  const count = tab('needs-you')!.querySelector<HTMLElement>('.worktree-tree-view-tab__count')!
  expect(count.dataset.tone).toBe('waiting')

  await click(buttonNamed(host, 'All views'))
  expect(menuItems().map(itemText).map((label) => label.replace(/(?<=[a-z])\d+$/, ''))).toEqual(['All', 'Needs you', 'Starred', 'Quiet', 'Hide Needs you'])
  await click(menuItem('Quiet'))
  expect(h.world.setActiveCalls.at(-1)).toEqual({ window: 1, viewId: 'view_q' })
  expect(tab('view_q')?.getAttribute('aria-selected')).toBe('true')

  await click(tab('needs-you'))
  expect(rowNames()).toEqual(['retry-queue'])
  await click(buttonNamed(host, 'All views'))
  await click(menuItem('Hide Needs you'))
  expect(h.world.views.needsYouHidden).toBe(true)
  expect(tab('needs-you')).toBeNull()
  expect(tab('all')?.getAttribute('aria-selected')).toBe('true')
})

test('Needs you with nothing waiting offers Show all worktrees', async () => {
  const h = setup()
  await h.mountInto(host)
  await click(tab('needs-you'))
  expect(host.textContent).toContain('Nothing needs you')
  await click(buttonNamed(host, 'Show all worktrees'))
  expect(tab('all')?.getAttribute('aria-selected')).toBe('true')
  expect(rowNames()).toContain('docs-refresh')
})

test('Display › Right side shows is panel-wide and saved with the views', async () => {
  const h = setup()
  await h.mountInto(host)
  await chooseDisplay('Right side shows', 'Branch')
  expect(h.world.views.rowFact).toBe('branch')
  expect(hasDot('all')).toBe(false)
  expect(host.querySelector('.worktree-fact')?.textContent).toBeTruthy()
})

test('SC-11: three selected rows show the bulk bar, Tag shows a mixed checkbox, and Esc or Clear dismisses it', async () => {
  const h = setup()
  h.world.tags = [{ id: 'tag_u', name: 'urgent', color: null }]
  h.world.assignments = { 'w-retry': ['tag_u'] }
  await h.mountInto(host)
  expect(host.querySelector('[aria-label="Bulk actions"]')).toBeNull()

  await click(openButton(rowOf('retry-queue')!), { metaKey: true })
  expect(host.querySelector('[aria-label="Bulk actions"]')).toBeNull()
  await click(openButton(rowOf('sidebar-tags')!), { metaKey: true })
  await click(openButton(rowOf('docs-refresh')!), { metaKey: true })
  const bar = host.querySelector<HTMLElement>('[aria-label="Bulk actions"]')!
  expect(bar).not.toBeNull()
  expect(norm(bar.textContent)).toContain('3 selected')
  expect([...bar.querySelectorAll('button')].map((button) => norm(button.textContent))).toEqual(['Tag', 'Section', 'Status', 'Sleep', 'Clear'])

  await click(buttonNamed(bar, 'Tag'))
  const popover = tagsPopover()
  const urgent = checkbox(popover, 'urgent')!
  expect(urgent.indeterminate).toBe(true)
  expect(urgent.getAttribute('aria-checked')).toBe('mixed')
  await click(urgent)
  expect(h.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toMatchObject({ tagId: 'tag_u', assigned: true })
  expect([...(h.calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params.worktreeIds as string[])].sort()).toEqual(['w-docs', 'w-retry', 'w-tags'])
  await pressEscape()
  expect(tagsPopover()).toBeNull()

  await click(buttonNamed(host.querySelector('[aria-label="Bulk actions"]')!, 'Status'))
  await click(menuItem('Done'))
  expect(h.world.worktrees.filter((worktree) => ['w-retry', 'w-tags', 'w-docs'].includes(worktree.id)).map((worktree) => worktree.status)).toEqual(['done', 'done', 'done'])

  await pressEscape()
  expect(host.querySelector('[aria-label="Bulk actions"]')).toBeNull()

  await click(openButton(rowOf('retry-queue')!), { metaKey: true })
  await click(openButton(rowOf('sidebar-tags')!), { metaKey: true })
  expect(host.querySelector('[aria-label="Bulk actions"]')).not.toBeNull()
  await click(buttonNamed(host.querySelector('[aria-label="Bulk actions"]')!, 'Clear'))
  expect(host.querySelector('[aria-label="Bulk actions"]')).toBeNull()
})

test('the cleanup footer line names the count and appears only when candidates exist', async () => {
  const h = setup()
  await h.mountInto(host)
  expect(noticeLines().some((line) => /can be deleted/.test(line.textContent ?? ''))).toBe(false)
  await act(async () => {
    const { unmount } = { unmount: mounts.values().next().value as () => Promise<void> }
    await unmount()
  })
  mounts.clear()
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)

  const withCandidate = setup()
  withCandidate.world.cleanup = [
    { worktreeId: 'w-docs', name: 'docs-refresh', fingerprint: 'f', reason: 'archived-7day', ignored: false, eligible: true, blockers: [] },
    { worktreeId: 'w-tags', name: 'sidebar-tags', fingerprint: 'g', reason: 'idle-clean', ignored: true, eligible: false, blockers: [] }
  ]
  await withCandidate.mountInto(host)
  const line = noticeWith('1 archived worktree can be deleted')
  expect(line).toBeDefined()
  await click(noticeAction(line, 'Review'))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(withCandidate.calls.filter((call) => call.method === 'quirky.worktree/cleanupPreview').length).toBeGreaterThan(1)
})
