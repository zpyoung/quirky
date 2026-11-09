import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, Repo, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import type { TreeProps } from '../src/Tree'
import { buildTree } from '../src/view-model'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, type ActivityMarkState, type RowFact, type Tag } from '../src/view-types'

const NOW = 10_000_000
const REPO: Repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }

const worktree = (id: string, name: string, extra: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id, repoId: 'r1', path: `/repo/QuirkyApp/${id}`, branch: id, head: 'abc', isMain: false, name, instanceId: id,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: NOW - 5 * 60_000, manualOrder: 0, sleeping: false, sleepChangedAt: null,
  references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false, tagIds: [],
  ...extra
}) as WorktreeControl

const tag = (id: string, name: string, color: Tag['color'] = null): Tag => ({ id, name, color })

type Call = { method: string; params: Record<string, unknown> }
type Listener = (event: QuirkyEvent) => void
let calls: Call[]
let toasts: string[]
let listeners: Set<Listener>
let tagReply: { tags: Tag[]; assignments: Record<string, string[]> }
const context = {
  call: async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    if (method === 'quirky.worktree/tags') return tagReply
    if (method === 'quirky.worktree/tagCreate') return { tag: { id: 'tag_new', name: params.name, color: null } }
    return []
  },
  toast: (title: string) => { toasts.push(title) },
  log: () => {},
  subscribe: (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  onConnection: () => () => {},
  openView: () => {}
} as unknown as UiPluginContext

let Tree: typeof import('../src/Tree').Tree
let TagsPopover: typeof import('../src/TagsPopover').TagsPopover
let createRoot: typeof import('react-dom/client').createRoot
let root: Root | null = null
let host: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Tree = (await import('../src/Tree')).Tree
  TagsPopover = (await import('../src/TagsPopover')).TagsPopover
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

type Spy = {
  opened: string[]
  toggles: Array<[string, string]>
  renames: Array<[string, string]>
  dialogs: unknown[]
  deletes: Array<[string, number]>
  tagsOpened: string[][]
  collapsed: string[]
}

async function mount(options: {
  worktrees: WorktreeControl[]
  marks?: Record<string, ActivityMarkState>
  tags?: Tag[]
  groups?: ProjectGroup[]
  repos?: Repo[]
  rowFact?: RowFact
  selectedId?: string | null
  props?: Partial<TreeProps>
  stock?: Partial<typeof DEFAULT_STOCK_OPTIONS>
}): Promise<Spy> {
  const spy: Spy = { opened: [], toggles: [], renames: [], dialogs: [], deletes: [], tagsOpened: [], collapsed: [] }
  const repos = options.repos ?? [REPO]
  const tags = options.tags ?? []
  const groups = options.groups ?? []
  host = document.createElement('div')
  document.body.append(host)
  const model = buildTree({
    worktrees: options.worktrees,
    repos,
    groups,
    tags,
    spec: allSpecFromStock({ ...DEFAULT_STOCK_OPTIONS, ...options.stock }, DEFAULT_ACTIVITY_PREFERENCES),
    viewId: 'all',
    projection: null,
    marks: new Map(Object.entries(options.marks ?? {})),
    checks: new Map()
  })
  const props: TreeProps = {
    context,
    model,
    tagsById: new Map(tags.map((item) => [item.id, item])),
    rowFact: options.rowFact ?? 'last-activity',
    repos,
    groups,
    sessions: [],
    selectedId: options.selectedId ?? null,
    automationExpandedId: null,
    automationAvailability: null,
    onToggleAutomationDetails: () => {},
    now: NOW,
    separatorEnabled: false,
    allWorktrees: options.worktrees,
    canShowSleeping: () => true,
    statusDefinitions: [
      { id: 'todo', label: 'Todo' }, { id: 'in-progress', label: 'In progress' },
      { id: 'in-review', label: 'In review' }, { id: 'done', label: 'Done' }
    ] as TreeProps['statusDefinitions'],
    projectIdentities: {},
    openDialog: (dialog) => { spy.dialogs.push(dialog) },
    requestDelete: (target, descendants) => { spy.deletes.push([target.id, descendants]) },
    onDropPreviewChange: () => {},
    onSeparatorStateChange: () => {},
    onOpen: (id) => { spy.opened.push(id) },
    onSelectToggle: (id, mode) => { spy.toggles.push([id, mode]) },
    onTagsOpen: (ids) => { spy.tagsOpened.push(ids) },
    onToggleCollapsed: undefined,
    ...options.props
  }
  root = createRoot(host)
  await act(async () => root!.render(createElement(Tree, props)))
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
  return spy
}

beforeEach(() => {
  calls = []
  toasts = []
  listeners = new Set()
  tagReply = { tags: [], assignments: {} }
})

const rowOf = (id: string) => host.querySelector<HTMLElement>(`[data-worktree-id="${id}"]`)!
const buttonLabelled = (within: ParentNode, label: string) => within.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const click = (element: Element, init: MouseEventInit = {}) =>
  act(async () => void element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })))
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const visibleText = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
  return [...node.childNodes].map(visibleText).join('')
}
const labelOf = (item: Element) => visibleText(item).replace(/\s+/g, ' ').trim()
const menuLabels = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(labelOf)
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => labelOf(item) === label)!
const pressKey = (element: Element, key: string) =>
  act(async () => void element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
const typeInto = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

test('each agent state has its own mark shape and an accessible name', async () => {
  const states: ActivityMarkState[] = ['running', 'waiting', 'error', 'idle', 'asleep']
  const worktrees = states.map((state) => worktree(state, `wt-${state}`))
  await mount({ worktrees, marks: Object.fromEntries(states.map((state) => [state, state])) })
  const labels: Record<ActivityMarkState, string> = {
    running: 'Running', waiting: 'Waiting on you', error: 'Error', idle: 'Idle', asleep: 'Asleep'
  }
  for (const state of states) {
    const mark = rowOf(state).querySelector<HTMLElement>('.ui-activity-mark')!
    expect(mark.dataset.state).toBe(state)
    expect(mark.classList.contains(`ui-activity-mark--${state}`)).toBe(true)
    expect(mark.getAttribute('role')).toBe('img')
    expect(mark.getAttribute('aria-label')).toBe(labels[state])
  }
})

test('a row stays on one line: mark, name, tag chips and one muted fact', async () => {
  await mount({ worktrees: [worktree('a', 'alpha')] })
  const row = rowOf('a')
  expect(row.querySelectorAll('.worktree-row')).toHaveLength(1)
  expect(row.querySelector('.ui-list-row__description')).toBeNull()
  expect(row.querySelector('.worktree-row__main')?.firstElementChild?.classList.contains('ui-activity-mark')).toBe(true)
  expect(row.querySelector('.worktree-name')?.textContent).toBe('alpha')
  expect(row.querySelectorAll('.worktree-fact')).toHaveLength(1)
})

test('two tags show as whole chips and a third becomes +N', async () => {
  const tags = [tag('t1', 'urgent', 'coral'), tag('t2', 'release-2.4'), tag('t3', 'docs')]
  await mount({
    worktrees: [worktree('a', 'alpha', { tagIds: ['t1', 't2'] }), worktree('b', 'beta', { tagIds: ['t1', 't2', 't3'] })],
    tags
  })
  const two = rowOf('a')
  expect([...two.querySelectorAll('.ui-tag-chip')].map((chip) => chip.textContent)).toEqual(['urgent', 'release-2.4'])
  expect(two.querySelector('.ui-tag-chips__more')).toBeNull()
  const three = rowOf('b')
  expect([...three.querySelectorAll('.ui-tag-chip')].map((chip) => chip.textContent)).toEqual(['urgent', 'release-2.4'])
  expect(three.querySelector('.ui-tag-chips__more')?.textContent).toBe('+1')
  expect(three.querySelector('.ui-tag-chip')?.getAttribute('data-color')).toBe('coral')
})

test('the right-side fact follows the Display choice, and the row menu sits in the same slot', async () => {
  const withPr = worktree('a', 'alpha', {
    branch: 'feature/alpha',
    linkedPR: { provider: 'github', kind: 'pullRequest', number: 42, title: 'Add route', url: 'https://example.test/42', repository: { host: 'github.com', owner: 'o', repo: 'r' } }
  })
  const facts: Array<[RowFact, string]> = [['last-activity', '5m'], ['branch', 'feature/alpha'], ['status', 'In progress'], ['pr', '#42']]
  for (const [fact, text] of facts) {
    await mount({ worktrees: [withPr], rowFact: fact })
    const trail = rowOf('a').querySelector('.worktree-trail')!
    expect(trail.querySelector('.worktree-fact')?.textContent).toBe(text)
    expect(trail.querySelector('.worktree-reveal button[aria-label="Actions for alpha"]')).not.toBeNull()
    await act(async () => root!.unmount())
    root = null
    document.body.innerHTML = ''
  }
})

test('a worktree moved into a section shows its project as the fact', async () => {
  const section: ProjectGroup = { id: 'g1', name: 'Release 2.4', parentPath: null, collapsed: false, order: 0, createdFrom: 'manual', repoIds: [], parentId: null }
  await mount({ worktrees: [worktree('a', 'alpha', { projectGroupId: 'g1' })], groups: [section] })
  expect(rowOf('a').querySelector('.worktree-fact')?.textContent).toBe('QuirkyApp')
})

test('an unread worktree carries a small accent dot', async () => {
  await mount({ worktrees: [worktree('a', 'alpha', { unread: true }), worktree('b', 'beta')] })
  expect(rowOf('a').querySelector('.worktree-unread-dot')?.getAttribute('aria-label')).toBe('Unread')
  expect(rowOf('b').querySelector('.worktree-unread-dot')).toBeNull()
})

test('a parent folds its children behind a chevron and count, amber when a folded child waits', async () => {
  await mount({
    worktrees: [worktree('p', 'parent'), worktree('c1', 'child-one', { parentId: 'p' }), worktree('c2', 'child-two', { parentId: 'p' })],
    marks: { c2: 'waiting' }
  })
  const parentRow = rowOf('p')
  expect(parentRow.querySelectorAll('.worktree-row')).toHaveLength(1)
  const toggle = parentRow.querySelector<HTMLButtonElement>('.worktree-child-toggle')!
  expect(toggle.querySelector('.worktree-child-count')?.textContent).toBe('2')
  expect(toggle.dataset.attention).toBe('waiting')
  expect(toggle.getAttribute('aria-label')).toContain('one waiting on you')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(rowOf('c1')).not.toBeNull()
  expect(rowOf('c1').style.getPropertyValue('--depth')).toBe('1')

  await click(toggle)
  expect(rowOf('c1')).toBeNull()
  expect(rowOf('c2')).toBeNull()
  expect(rowOf('p').querySelector('.worktree-child-toggle')?.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('.repo-header .worktree-attention')?.textContent).toBe('1')

  await click(rowOf('p').querySelector('.worktree-child-toggle')!)
  expect(rowOf('c2')).not.toBeNull()
})

test('an errored child colors the folded count red', async () => {
  await mount({ worktrees: [worktree('p', 'parent'), worktree('c', 'child', { parentId: 'p' })], marks: { c: 'error' } })
  expect(rowOf('p').querySelector<HTMLElement>('.worktree-child-toggle')?.dataset.attention).toBe('error')
  expect(host.querySelector<HTMLElement>('.repo-header .worktree-attention')?.dataset.attention).toBe('error')
})

test('a pinned worktree shows once, under Pinned, and never under its project', async () => {
  await mount({ worktrees: [worktree('a', 'alpha', { pinned: true }), worktree('b', 'beta')] })
  expect(host.querySelectorAll('[data-worktree-id="a"]')).toHaveLength(1)
  expect(rowOf('a').closest('[data-top-level-section="pinned"]')).not.toBeNull()
  expect(rowOf('b').closest('[data-top-level-section="pinned"]')).toBeNull()
  const headings = [...host.querySelectorAll('.repo-header .project-name')].map((name) => name.textContent)
  expect(headings).toEqual(['Pinned', 'QuirkyApp'])
})

test('headers fold, and carry an always-visible plus and menu button', async () => {
  const section: ProjectGroup = { id: 'g1', name: 'Release 2.4', parentPath: null, collapsed: false, order: 0, createdFrom: 'manual', repoIds: ['r1'], parentId: null }
  const repo: Repo = { ...REPO, groupId: 'g1' }
  const spy = await mount({ worktrees: [worktree('a', 'alpha')], groups: [section], repos: [repo], marks: { a: 'waiting' } })
  const sectionBlock = host.querySelector<HTMLElement>('section.group')!
  expect(sectionBlock.querySelector(':scope > header .project-name')?.textContent).toBe('Release 2.4')
  expect(sectionBlock.querySelector(':scope > header .worktree-attention')?.textContent).toBe('1')
  expect(sectionBlock.querySelector('section.repo')).not.toBeNull()
  expect(buttonLabelled(sectionBlock, 'New section')).not.toBeNull()
  expect(buttonLabelled(sectionBlock, 'Actions for group Release 2.4')).not.toBeNull()
  expect(buttonLabelled(sectionBlock, 'New worktree in QuirkyApp')).not.toBeNull()

  await click(buttonLabelled(sectionBlock, 'New section'))
  expect(spy.dialogs).toEqual([{ kind: 'group', action: 'new-section' }])
  await click(buttonLabelled(sectionBlock, 'New worktree in QuirkyApp'))
  expect(spy.dialogs.at(-1)).toEqual({ kind: 'create', repoId: 'r1' })

  await click(buttonLabelled(sectionBlock, 'Collapse group Release 2.4'))
  expect(calls.filter((call) => call.method === 'quirky.repo/groupCollapse')).toEqual([
    { method: 'quirky.repo/groupCollapse', params: { group: 'g1', collapsed: true } }
  ])

  const project = sectionBlock.querySelector<HTMLElement>('section.repo')!
  await click(buttonLabelled(project, 'Collapse project QuirkyApp'))
  expect(project.querySelector('[data-worktree-id]')).toBeNull()
  expect(project.querySelector('header .worktree-attention')?.textContent).toBe('1')
  await click(buttonLabelled(project, 'Expand project QuirkyApp'))
  expect(project.querySelector('[data-worktree-id="a"]')).not.toBeNull()
})

test('selection tints the row, and Cmd, Ctrl and Shift clicks ask for a multi-selection', async () => {
  const spy = await mount({ worktrees: [worktree('a', 'alpha'), worktree('b', 'beta')], selectedId: 'a' })
  expect(rowOf('a').classList.contains('selected')).toBe(true)
  expect(rowOf('a').querySelector('.worktree-row__main')?.getAttribute('aria-pressed')).toBe('true')
  expect(rowOf('b').classList.contains('selected')).toBe(false)

  const open = rowOf('b').querySelector<HTMLButtonElement>('.worktree-row__main')!
  await click(open, { metaKey: true })
  await click(open, { ctrlKey: true })
  await click(open, { shiftKey: true })
  expect(spy.toggles).toEqual([['b', 'toggle'], ['b', 'toggle'], ['b', 'range']])
  expect(calls.some((call) => call.method === 'quirky.worktree/navigate')).toBe(false)

  await click(open)
  expect(spy.opened).toEqual(['b'])
  expect(calls.find((call) => call.method === 'quirky.worktree/navigate')?.params).toEqual({ worktree: 'b' })
})

test('the row menu lists its actions in the fixed order with Delete set apart in danger text', async () => {
  const section: ProjectGroup = { id: 'g1', name: 'Release 2.4', parentPath: null, collapsed: false, order: 0, createdFrom: 'manual', repoIds: [], parentId: null }
  await mount({ worktrees: [worktree('a', 'alpha')], groups: [section] })
  await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  expect(menu()).not.toBeNull()
  const labels = menuLabels()
  expect(labels.slice(0, 9)).toEqual(['Rename', 'Tags…', 'Move to section', 'Move to status', 'Sleep', 'Open in', 'Copy', 'More', 'Delete…'])
  const destroy = menuItem('Delete…')
  expect(destroy.classList.contains('qt-danger')).toBe(true)
  expect(destroy.previousElementSibling?.getAttribute('role')).toBe('separator')
  expect(menuItem('Open in').previousElementSibling?.getAttribute('role')).toBe('separator')

  await click(menuItem('More'))
  expect(['Set parent…', 'Remove from parent', 'Mark unread', 'Pin', 'Archive', 'Details…'].every((label) => menuLabels().includes(label))).toBe(true)
  await click(menuItem('Details…'))
  expect(menu()).toBeNull()
})

test('right-clicking a row opens the same menu at the pointer', async () => {
  await mount({ worktrees: [worktree('a', 'alpha')] })
  await act(async () => void rowOf('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })))
  const opened = menu()
  expect(opened).not.toBeNull()
  expect(opened?.getAttribute('aria-label')).toBe('Actions for alpha')
  expect(menuLabels()).toContain('Rename')
  expect(menuLabels()).toContain('Tags…')
})

test('Sleep becomes Wake on a sleeping row, and Delete is blocked on the primary worktree', async () => {
  await mount({ worktrees: [worktree('m', 'main', { isMain: true }), worktree('s', 'sleepy', { sleeping: true })] })
  await click(buttonLabelled(rowOf('s'), 'Actions for sleepy'))
  expect(menuLabels()).toContain('Wake')
  expect(menuLabels()).not.toContain('Sleep')
  await pressKey(menu()!, 'Escape')
  await click(buttonLabelled(rowOf('m'), 'Actions for main'))
  expect((menuItem('Delete…') as HTMLButtonElement).disabled || menuItem('Delete…').getAttribute('aria-disabled') === 'true').toBe(true)
})

test('menu actions reach the existing handlers: status, pin, parent, details, delete and tags', async () => {
  const spy = await mount({ worktrees: [worktree('a', 'alpha'), worktree('c', 'child', { parentId: 'a' })] })
  const open = async () => click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  await open()
  await click(menuItem('Move to status'))
  await click(menuItem('In review'))
  await open()
  await click(menuItem('More'))
  await click(menuItem('Pin'))
  await open()
  await click(menuItem('More'))
  await click(menuItem('Set parent…'))
  await open()
  await click(menuItem('More'))
  await click(menuItem('Details…'))
  await open()
  await click(menuItem('Tags…'))
  await open()
  await click(menuItem('Delete with descendants (1)…'))
  expect(calls.filter((call) => call.method === 'quirky.worktree/set').map((call) => call.params)).toEqual([
    { worktree: 'a', status: 'in-review' },
    { worktree: 'a', pinned: true }
  ])
  expect(spy.dialogs).toEqual([{ kind: 'parent', worktreeId: 'a' }, { kind: 'update', worktreeId: 'a' }])
  expect(spy.tagsOpened).toEqual([['a']])
  expect(spy.deletes).toEqual([['a', 1]])
})

test('Move to section uses the group membership call and offers a new section', async () => {
  const section: ProjectGroup = { id: 'g1', name: 'Release 2.4', parentPath: null, collapsed: false, order: 0, createdFrom: 'manual', repoIds: [], parentId: null }
  const spy = await mount({ worktrees: [worktree('a', 'alpha')], groups: [section] })
  await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  await click(menuItem('Move to section'))
  expect(menuLabels()).toEqual(expect.arrayContaining(['Release 2.4', 'New section…']))
  await click(menuItem('Release 2.4'))
  expect(calls.find((call) => call.method === 'quirky.worktree/set')?.params).toEqual({
    worktree: 'a', projectGroupId: 'g1', expectedInstanceId: 'a', expectedProjectGroupId: null
  })
  await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  await click(menuItem('Move to section'))
  await click(menuItem('New section…'))
  expect(spy.dialogs.at(-1)).toMatchObject({ kind: 'group', action: 'new-worktree', worktreeId: 'a' })
})

test('Rename swaps the row for an input the size of the row; Enter saves and the branch is untouched', async () => {
  const spy = await mount({ worktrees: [worktree('a', 'walk-new', { branch: 'walk-new' })], props: { onRename: (id, name) => { spy.renames.push([id, name]) } } })
  await click(buttonLabelled(rowOf('a'), 'Actions for walk-new'))
  await click(menuItem('Rename'))
  const input = rowOf('a').querySelector<HTMLInputElement>('input.worktree-rename')!
  expect(input.value).toBe('walk-new')
  expect(input.getAttribute('aria-label')).toBe('Rename walk-new')
  expect(rowOf('a').querySelector('.worktree-row__main')).toBeNull()
  expect(rowOf('a').querySelectorAll('.worktree-row')).toHaveLength(1)
  await typeInto(input, 'walk-renamed')
  await pressKey(input, 'Enter')
  expect(spy.renames).toEqual([['a', 'walk-renamed']])
  expect(rowOf('a').querySelector('input.worktree-rename')).toBeNull()
  expect(calls.some((call) => call.method === 'quirky.worktree/set')).toBe(false)
})

test('Escape cancels a rename and blur saves it', async () => {
  const spy = await mount({ worktrees: [worktree('a', 'alpha')], props: { onRename: (id, name) => { spy.renames.push([id, name]) } } })
  const startRename = async () => {
    await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
    await click(menuItem('Rename'))
    return rowOf('a').querySelector<HTMLInputElement>('input.worktree-rename')!
  }
  let input = await startRename()
  await typeInto(input, 'discarded')
  await pressKey(input, 'Escape')
  expect(spy.renames).toEqual([])
  expect(rowOf('a').querySelector('input.worktree-rename')).toBeNull()
  expect(rowOf('a').querySelector('.worktree-name')?.textContent).toBe('alpha')

  input = await startRename()
  await typeInto(input, 'kept')
  await act(async () => void input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(spy.renames).toEqual([['a', 'kept']])
})

test('an unchanged or empty rename saves nothing', async () => {
  const spy = await mount({ worktrees: [worktree('a', 'alpha')], props: { onRename: (id, name) => { spy.renames.push([id, name]) } } })
  await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  await click(menuItem('Rename'))
  await pressKey(rowOf('a').querySelector('input.worktree-rename')!, 'Enter')
  await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  await click(menuItem('Rename'))
  const input = rowOf('a').querySelector<HTMLInputElement>('input.worktree-rename')!
  await typeInto(input, '   ')
  await pressKey(input, 'Enter')
  expect(spy.renames).toEqual([])
})

test('without a rename callback the display name is saved through set', async () => {
  await mount({ worktrees: [worktree('a', 'alpha')] })
  await click(buttonLabelled(rowOf('a'), 'Actions for alpha'))
  await click(menuItem('Rename'))
  const input = rowOf('a').querySelector<HTMLInputElement>('input.worktree-rename')!
  await typeInto(input, 'beta')
  await pressKey(input, 'Enter')
  expect(calls.find((call) => call.method === 'quirky.worktree/set')?.params).toEqual({ worktree: 'a', displayName: 'beta' })
})

test('a focused row shows its hover card after a short delay with every tag and the review', async () => {
  const tags = [tag('t1', 'urgent'), tag('t2', 'release-2.4'), tag('t3', 'docs')]
  await mount({
    worktrees: [worktree('a', 'alpha', {
      branch: 'feature/alpha',
      tagIds: ['t1', 't2', 't3'],
      linkedPR: { provider: 'github', kind: 'pullRequest', number: 42, title: 'Add route', url: 'https://example.test/42', repository: { host: 'github.com', owner: 'o', repo: 'r' } }
    })],
    tags,
    props: { checks: new Map([['a', 'failure' as const]]) }
  })
  const trigger = rowOf('a').querySelector<HTMLButtonElement>('.worktree-row__main')!
  await act(async () => trigger.focus())
  expect(document.querySelector('.worktree-hover')).toBeNull()
  await act(async () => { await Bun.sleep(450) })
  const card = document.querySelector<HTMLElement>('.worktree-hover')!
  expect(card).not.toBeNull()
  expect(card.closest('[role="tooltip"]')).not.toBeNull()
  expect(card.querySelector('strong')?.textContent).toBe('alpha')
  expect(card.querySelector('code')?.textContent).toBe('feature/alpha')
  const facts = Object.fromEntries([...card.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]))
  expect(facts.Project).toBe('QuirkyApp')
  expect(facts.Status).toBe('In progress')
  expect(facts.Agent).toBe('Idle')
  expect(facts.Review).toBe('#42 Add route · checks failing')
  expect(facts['Last activity']).toBe('5m ago')
  expect([...card.querySelectorAll('.ui-tag-chip')].map((chip) => chip.textContent)).toEqual(['urgent', 'release-2.4', 'docs'])
  await act(async () => trigger.blur())
  expect(document.querySelector('.worktree-hover')).toBeNull()
})

test('the tags popover checks, mixes, creates and recolors tags for the selected worktrees', async () => {
  tagReply = {
    tags: [tag('t1', 'urgent'), tag('t2', 'docs', 'blue')],
    assignments: { a: ['t1'], b: ['t1', 't2'] }
  }
  host = document.createElement('div')
  const anchor = document.createElement('button')
  document.body.append(host, anchor)
  root = createRoot(host)
  await act(async () => root!.render(createElement(TagsPopover, { context, worktreeIds: ['a', 'b'], anchor, onClose: () => {} })))
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })

  const box = (name: string) => [...document.querySelectorAll<HTMLLabelElement>('.ui-checkbox')]
    .find((label) => label.textContent === name)!.querySelector<HTMLInputElement>('input')!
  expect(box('urgent').checked).toBe(true)
  expect(box('urgent').indeterminate).toBe(false)
  expect(box('docs').checked).toBe(false)
  expect(box('docs').indeterminate).toBe(true)
  expect(box('docs').getAttribute('aria-checked')).toBe('mixed')

  await click(box('docs'))
  expect(calls.find((call) => call.method === 'quirky.worktree/tagAssign')?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 't2', assigned: true })

  const search = document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!
  await typeInto(search, 'release')
  const create = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Create "release"')!
  expect(create).toBeDefined()
  await click(create)
  expect(calls.find((call) => call.method === 'quirky.worktree/tagCreate')?.params).toEqual({ name: 'release' })
  expect(calls.filter((call) => call.method === 'quirky.worktree/tagAssign').at(-1)?.params).toEqual({ worktreeIds: ['a', 'b'], tagId: 'tag_new', assigned: true })

  await typeInto(search, '')
  await click(document.querySelector('button[aria-label="Color for urgent"]')!)
  const swatches = document.querySelector('[role="radiogroup"][aria-label="Color for urgent"]')!
  expect(swatches.querySelectorAll('[role="radio"]')).toHaveLength(9)
  await click(swatches.querySelector('[data-color="teal"]')!)
  expect(calls.find((call) => call.method === 'quirky.worktree/tagUpdate')?.params).toEqual({ id: 't1', color: 'teal' })

  const before = calls.filter((call) => call.method === 'quirky.worktree/tags').length
  tagReply = { tags: [tag('t1', 'urgent', 'teal')], assignments: {} }
  await act(async () => {
    for (const listener of listeners) listener({ type: 'quirky.worktree/tagsChanged', data: {} } as QuirkyEvent)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  expect(calls.filter((call) => call.method === 'quirky.worktree/tags').length).toBeGreaterThan(before)
  expect(document.querySelector('.ui-checkbox')?.textContent).toBe('urgent')
  expect(document.querySelectorAll('.ui-checkbox')).toHaveLength(1)
})

test('a project menu offers Move up and Move down only under a manual project order', async () => {
  const second: Repo = { ...REPO, id: 'r2', name: 'Zeta', path: '/repo/Zeta' }
  const worktrees = [worktree('a', 'alpha'), worktree('z', 'zed', { repoId: 'r2' })]
  const reorders: string[][] = []
  const props = { projectOrder: ['r1', 'r2'], onReorderProjects: (ids: string[]) => { reorders.push(ids) } }
  await mount({ worktrees, repos: [REPO, second], props })

  await click(buttonLabelled(host, 'Actions for Zeta'))
  expect(menuLabels()).toEqual(expect.arrayContaining(['Move up', 'Move down']))
  expect((menuItem('Move down') as HTMLButtonElement).disabled).toBe(true)
  await click(menuItem('Move up'))
  expect(reorders).toEqual([['r2', 'r1']])

  await click(buttonLabelled(host, 'Actions for QuirkyApp'))
  expect((menuItem('Move up') as HTMLButtonElement).disabled).toBe(true)
  await click(menuItem('Move down'))
  expect(reorders.at(-1)).toEqual(['r2', 'r1'])
  await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''

  await mount({ worktrees, repos: [REPO, second], props: { ...props, options: { ...DEFAULT_STOCK_OPTIONS, projectOrderBy: 'recent' } } })
  await click(buttonLabelled(host, 'Actions for Zeta'))
  expect(menuLabels()).not.toContain('Move up')
  expect(menuLabels()).not.toContain('Move down')
})

test('a shift-click range covers only the rows on screen, not rows folded behind a parent', async () => {
  const ranges: Array<readonly string[] | undefined> = []
  await mount({
    worktrees: [
      worktree('p', 'parent', { lastActivityAt: NOW - 1_000 }),
      worktree('c1', 'child-one', { parentId: 'p' }),
      worktree('c2', 'child-two', { parentId: 'p' }),
      worktree('z', 'zeta', { lastActivityAt: NOW - 9_000_000 })
    ],
    props: { onSelectToggle: (_id, _mode, rendered) => { ranges.push(rendered) } }
  })
  const shiftClick = (id: string) => click(rowOf(id).querySelector('.worktree-row__main')!, { shiftKey: true })

  await shiftClick('z')
  expect(ranges.at(-1)).toEqual(['p', 'c1', 'c2', 'z'])

  await click(rowOf('p').querySelector('.worktree-child-toggle')!)
  await shiftClick('z')
  expect(ranges.at(-1)).toEqual(['p', 'z'])
})

test('a shift-click range leaves out the rows of a folded project', async () => {
  const other: Repo = { ...REPO, id: 'r2', name: 'Other', path: '/repo/Other' }
  const ranges: Array<readonly string[] | undefined> = []
  await mount({
    repos: [REPO, other],
    worktrees: [worktree('a', 'alpha'), worktree('b', 'beta', { repoId: 'r2' }), worktree('c', 'gamma', { repoId: 'r2' })],
    props: { onSelectToggle: (_id, _mode, rendered) => { ranges.push(rendered) } }
  })
  const header = [...host.querySelectorAll<HTMLElement>('.project-header')].find((node) => node.textContent?.includes('Other'))!
  await click(header.querySelector<HTMLButtonElement>('.worktree-fold')!)
  await click(rowOf('a').querySelector('.worktree-row__main')!, { shiftKey: true })
  expect(ranges.at(-1)).toEqual(['a'])
})

for (const groupBy of ['status', 'pr'] as const) {
  test(`a pending creation still shows when grouping by ${groupBy}`, async () => {
    await mount({
      worktrees: [worktree('a', 'alpha')],
      stock: { groupBy },
      props: { pending: [{ repoId: 'r1', name: 'brand-new' }] }
    })
    const pending = host.querySelectorAll('.worktree.pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.textContent).toContain('brand-new')
  })
}

test('a pending creation shows once under its project when grouping by project', async () => {
  await mount({ worktrees: [worktree('a', 'alpha')], props: { pending: [{ repoId: 'r1', name: 'brand-new' }] } })
  expect(host.querySelectorAll('.worktree.pending')).toHaveLength(1)
  expect(host.querySelector('.repo .worktree.pending')).not.toBeNull()
})
