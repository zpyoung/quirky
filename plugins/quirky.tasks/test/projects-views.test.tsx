import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ProjectTarget, TasksState } from '../src/contracts'
import { ProjectsSurface } from '../src/projects/ProjectsSurface'
import { projectIdentity, projectViewIdentity } from '../src/projects/model'
import {
  PROJECTS_CONTROL_COMMAND,
  parseProjectsControlRequest,
  runProjectsControl
} from '../src/projects/control'

type Handler = (params: Record<string, unknown>) => unknown
type HarnessContext = {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  executeCommand(id: string, args?: unknown): Promise<void>
  toast(title: string, detail?: string): void
  log(message: string): void
  onConnection(listener: (status: 'connected' | 'reconnecting') => void): () => void
  provide(id: string, implementation: (input: unknown) => unknown): void
}

type ProjectItemFixture = {
  id: string
  type?: string
  content: Record<string, unknown> | null
  fieldValues: Array<Record<string, unknown>>
}

type ViewFixture = {
  view: Record<string, unknown> & { id: string }
  layout: string
  fields: Array<Record<string, unknown> & { id: string }>
  items: ProjectItemFixture[]
  projectId?: string
}

type Harness = {
  context: HarnessContext
  calls: Array<{ method: string; params: Record<string, unknown> }>
  commands: Array<{ id: string; args: unknown }>
  toasts: Array<{ title: string; detail?: string }>
  logs: string[]
  handlers: Map<string, Handler>
  fixtures: Map<string, ViewFixture>
  viewsByProject: Map<string, Array<Record<string, unknown> & { id: string }>>
  connections: Set<(status: 'connected' | 'reconnecting') => void>
}

let createRoot: (element: HTMLElement) => Root
const mounted: Array<{ root: Root; container: HTMLElement }> = []
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
const NativeDate = globalThis.Date
let restoreClock = () => {}

beforeAll(async () => {
  GlobalRegistrator.register()
  // React DOM binds its scheduler at import, so happy-dom has to be registered first.
  createRoot = (await import('react-dom/client')).createRoot
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
  restoreClock()
  localStorage.clear()
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const PROJECT: ProjectTarget = {
  id: 'PVT_1',
  owner: 'acme',
  ownerType: 'organization',
  number: 4,
  url: 'https://github.com/orgs/acme/projects/4',
  host: 'github.com',
  title: 'Roadmap'
}
const OTHER_PROJECT: ProjectTarget = {
  id: 'PVT_2',
  owner: 'acme',
  ownerType: 'organization',
  number: 5,
  url: 'https://github.com/orgs/acme/projects/5',
  host: 'github.com',
  title: 'Next roadmap'
}
const STATUS = {
  id: 'STATUS',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [{ id: 'TODO', name: 'Todo' }, { id: 'DONE', name: 'Done' }]
}
const NOTES = { id: 'TEXT', name: 'Notes', dataType: 'TEXT' }

function item(
  id = 'I1',
  title = 'Improve project table',
  values: Record<string, unknown> = { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' } },
  contentPatch: Record<string, unknown> = {}
): ProjectItemFixture {
  return {
    id,
    content: {
      kind: 'issue',
      number: id === 'I1' ? 7 : Number(id.replace(/^I/, '')) + 6,
      title,
      repository: 'acme/quirky',
      url: `https://github.com/acme/quirky/issues/${id === 'I1' ? 7 : Number(id.replace(/^I/, '')) + 6}`,
      labels: [],
      assignees: [],
      ...contentPatch
    },
    fieldValues: Object.entries(values).map(([fieldId, value]) => ({ fieldId, value }))
  }
}

function defaultFixture(): ViewFixture {
  const view = { id: 'V1', number: 1, name: 'Table', layout: 'TABLE', fields: [STATUS, NOTES] }
  return { view, layout: 'TABLE', fields: [STATUS, NOTES], items: [item()] }
}

function addFixture(h: Harness, project: ProjectTarget, fixture: ViewFixture): void {
  fixture.projectId = project.id
  h.fixtures.set(projectViewIdentity(project, fixture.view.id), fixture)
  const identity = projectIdentity(project)
  const views = h.viewsByProject.get(identity) ?? []
  h.viewsByProject.set(identity, [...views.filter((view) => view.id !== fixture.view.id), fixture.view])
}

function defaultProjectView(h: Harness, params: Record<string, unknown>): unknown {
  const action = String(params.action)
  const project = params.project as ProjectTarget
  if (action === 'list') return { result: { views: h.viewsByProject.get(projectIdentity(project)) ?? [] } }
  if (action === 'select') return { result: {} }
  const fixture = h.fixtures.get(projectViewIdentity(project, String(params.viewId)))
  if (!fixture) throw new Error(`no saved view ${String(params.viewId)}`)
  return {
    result: {
      view: fixture.view,
      layout: fixture.layout,
      fields: fixture.fields,
      items: fixture.items,
      totalCount: fixture.items.length
    }
  }
}

function persistMutation(h: Harness, params: Record<string, unknown>): void {
  const projectId = params.projectId
  const itemId = params.itemId
  for (const fixture of h.fixtures.values()) {
    if (projectId !== undefined && fixture.projectId !== projectId) continue
    fixture.items = fixture.items.map((candidate) => {
      if (candidate.id !== itemId) return candidate
      if (params.action === 'field') {
        const fieldId = String(params.fieldId)
        const existing = candidate.fieldValues.filter((entry) => entry.fieldId !== fieldId)
        return {
          ...candidate,
          fieldValues: params.clear === true ? existing : [...existing, { fieldId, value: params.value }]
        }
      }
      if (params.action === 'issue') {
        const prop = Array.isArray(params.labels) ? 'labels' : 'assignees'
        return { ...candidate, content: { ...candidate.content, [prop]: params[prop] } }
      }
      if (params.action === 'issueType' && params.issueTypeId !== undefined) {
        return {
          ...candidate,
          content: { ...candidate.content, issueType: { id: params.issueTypeId, name: params.issueTypeId } }
        }
      }
      return candidate
    })
  }
}

function harness(): Harness {
  const h: Harness = {
    context: {} as HarnessContext,
    calls: [],
    commands: [],
    toasts: [],
    logs: [],
    handlers: new Map(),
    fixtures: new Map(),
    viewsByProject: new Map(),
    connections: new Set()
  }
  addFixture(h, PROJECT, defaultFixture())
  h.context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      h.calls.push({ method, params })
      const handler = h.handlers.get(method)
      if (!handler) throw new Error(`Unexpected method: ${method}`)
      return await handler(params)
    },
    async executeCommand(id: string, args?: unknown) {
      h.commands.push({ id, args })
    },
    toast(title: string, detail?: string) {
      h.toasts.push({ title, ...(detail === undefined ? {} : { detail }) })
    },
    log(message: string) {
      h.logs.push(message)
    },
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      h.connections.add(listener)
      return () => { h.connections.delete(listener) }
    },
    provide() {}
  }
  h.handlers.set('ui.window.self', () => ({ connId: 7 }))
  h.handlers.set('ui.window.command.run', (params) => ({ result: runProjectsControl(h.context as never, params.args) }))
  h.handlers.set('quirky.tasks/projectView', (params) => defaultProjectView(h, params))
  h.handlers.set('quirky.tasks/projectEdit', (params) => {
    if (params.action === 'issueType' && params.issueTypeId === undefined) {
      return { result: { issueTypes: [{ id: 'BUG', name: 'Bug' }, { id: 'FEATURE', name: 'Feature' }] } }
    }
    persistMutation(h, params)
    return {}
  })
  return h
}

function holdNextControl(h: Harness): (error: Error) => void {
  const { promise, reject } = Promise.withResolvers<never>()
  const original = h.handlers.get('ui.window.command.run')!
  h.handlers.set('ui.window.command.run', (params) => {
    h.handlers.set('ui.window.command.run', original)
    return promise
  })
  return reject
}

function tasksState(project: ProjectTarget | null = PROJECT, savedView: string | null = 'V1'): TasksState {
  return {
    revision: 1,
    navigation: { source: 'github', mode: 'projects', repoIds: null, query: '', page: 1, scrollTop: 0, detail: null, newIssue: false, project, lastList: { mode: 'prs', query: '', page: 1 } },
    preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'mine', defaultRepoSelection: null },
    issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
    projects: { pinned: [], recent: [], lastViewByProject: project && savedView ? { [projectIdentity(project)]: savedView } : {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
    links: {}
  } as TasksState
}

async function mount(h: Harness, state: TasksState = tasksState()): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => root.render(createElement(ProjectsSurface, { context: h.context as never, state, refresh: async () => {} })))
  await settle()
  return container
}

async function rerender(container: HTMLElement, h: Harness, state: TasksState): Promise<void> {
  const entry = mounted.find((candidate) => candidate.container === container)
  if (!entry) throw new Error('cannot rerender an unmounted Projects surface')
  await act(async () => entry.root.render(createElement(ProjectsSurface, { context: h.context as never, state, refresh: async () => {} })))
  await settle()
}

async function unmount(container: HTMLElement): Promise<void> {
  const index = mounted.findIndex((entry) => entry.container === container)
  if (index < 0) return
  const [entry] = mounted.splice(index, 1)
  await act(async () => entry!.root.unmount())
  entry!.container.remove()
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
  }
}

function calls(h: Harness, method: string, action?: string): Array<{ method: string; params: Record<string, unknown> }> {
  return h.calls.filter((call) => call.method === method && (action === undefined || call.params.action === action))
}

function controlArgs(h: Harness): unknown[] {
  return calls(h, 'ui.window.command.run').map((call) => call.params.args)
}

function expectBridgeRequests(h: Harness, expected: unknown[]): void {
  const requests = calls(h, 'ui.window.command.run')
  expect(requests.map((call) => call.params)).toEqual(expected.map((args) => ({ connId: 7, id: PROJECTS_CONTROL_COMMAND, args })))
  expect(calls(h, 'ui.window.self')).toHaveLength(expected.length)
  expect(h.commands.filter((call) => call.id === PROJECTS_CONTROL_COMMAND)).toEqual([])
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${JSON.stringify(label)}`)
  return found
}

function headerButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('th button')].find((candidate) => candidate.textContent?.trim().startsWith(label))
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no table header button ${JSON.stringify(label)}`)
  return found
}

function groupButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.quirky-tasks-project-table__group-toggle')].find((candidate) => candidate.textContent?.includes(label))
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no group button ${JSON.stringify(label)}`)
  return found
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click())
  await settle()
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('input value setter is unavailable')
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (!setter) throw new Error('select value setter is unavailable')
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

async function changeMultiSelect(select: HTMLSelectElement, values: string[]): Promise<void> {
  await act(async () => {
    const previous = Object.getOwnPropertyDescriptor(select, 'selectedOptions')
    Object.defineProperty(select, 'selectedOptions', {
      configurable: true,
      get: () => [...select.options].filter((option) => option.selected)
    })
    try {
      const selected = new Set(values)
      for (const option of [...select.options]) option.selected = selected.has(option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    } finally {
      if (previous) Object.defineProperty(select, 'selectedOptions', previous)
      else Reflect.deleteProperty(select, 'selectedOptions')
    }
  })
  await settle()
}

async function press(input: HTMLInputElement, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => input.dispatchEvent(event))
  await settle()
  return event
}

function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.quirky-tasks-project-table__row')].map((row) => row.querySelector('.quirky-tasks-project-table__title')?.textContent?.trim() ?? '')
}

async function dispatch(h: Harness, request: unknown): Promise<{ delivered: number }> {
  let result = { delivered: 0 }
  await act(async () => { result = runProjectsControl(h.context as never, request) })
  await settle()
  return result
}

function roadmapFixture(options: { viewId?: string; name?: string; layout?: string; fields?: Array<Record<string, unknown> & { id: string }>; items?: ProjectItemFixture[] } = {}): ViewFixture {
  const fields = options.fields ?? [{ id: 'DATE', name: 'Due date', dataType: 'DATE' }, NOTES]
  const view = {
    id: options.viewId ?? 'V1',
    number: options.viewId === 'V2' ? 2 : 1,
    name: options.name ?? 'Roadmap',
    layout: options.layout ?? 'ROADMAP',
    fields
  }
  return {
    view,
    layout: options.layout ?? 'ROADMAP',
    fields,
    items: options.items ?? [item('I1', 'Improve project table', { DATE: '2026-01-14', TEXT: { text: 'Original' } })]
  }
}

function freezeClock(value: string | number | null): void {
  const timestamp = value === null ? Number.NaN : typeof value === 'number' ? value : new NativeDate(value).getTime()
  const fixedDate = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [timestamp] : args, newTarget)
    },
    get(target, property, receiver) {
      if (property === 'now') return () => timestamp
      return Reflect.get(target, property, receiver)
    }
  }) as DateConstructor
  globalThis.Date = fixedDate
  restoreClock = () => {
    globalThis.Date = NativeDate
    restoreClock = () => {}
  }
}

function validationError(input: unknown, message: string): void {
  let error: unknown
  try {
    parseProjectsControlRequest(input)
  } catch (failure) {
    error = failure
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(message)
}

test('1. Title sorting routes and cycles ascending, descending, and back to view order', async () => {
  const h = harness()
  const fixture = h.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!
  fixture.items = [
    item('I1', 'Zulu', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Zeta' } }),
    item('I2', 'Alpha', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Alpha' } })
  ]
  const container = await mount(h)


  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title ↑')
  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Zulu', 'Alpha'])
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title ↓')
  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Zulu', 'Alpha'])
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title')

  await click(headerButton(container, 'Notes'))
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  expect(headerButton(container, 'Notes').textContent?.trim()).toBe('Notes ↑')
  expect(controlArgs(h)).toEqual([
    { action: 'sort', fieldId: 'title' },
    { action: 'sort', fieldId: 'title' },
    { action: 'sort', fieldId: 'title' },
    { action: 'sort', fieldId: 'TEXT' }
  ])
  expectBridgeRequests(h, controlArgs(h))
  expect(headerButton(container, 'Notes').textContent?.trim()).toBe('Notes ↑')
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title')
  const routedBeforeCommand = controlArgs(h)
  const rowsBeforeCommand = rowTitles(container)
  await h.context.executeCommand(PROJECTS_CONTROL_COMMAND, { action: 'sort', fieldId: 'title' })
  await settle()
  expect(controlArgs(h)).toEqual(routedBeforeCommand)
  expect(rowTitles(container)).toEqual(rowsBeforeCommand)
  expect(headerButton(container, 'Notes').textContent?.trim()).toBe('Notes ↑')
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title')

  expect(await dispatch(h, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 1 })
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  expect(await dispatch(h, { action: 'column', fieldId: 'TEXT', visible: false })).toEqual({ delivered: 1 })
  expect(await dispatch(h, { action: 'sort', fieldId: 'TEXT' })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'sort', fieldId: 'missing' })).toEqual({ delivered: 0 })
})

test('1b. Sort rejects an unloaded table and actual board or roadmap layouts', async () => {
  const loading = harness()
  const normalProjectView = loading.handlers.get('quirky.tasks/projectView')!
  loading.handlers.set('quirky.tasks/projectView', (params) => params.action === 'load' ? new Promise(() => {}) : normalProjectView(params))
  const loadingContainer = await mount(loading)
  expect(await dispatch(loading, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 0 })
  await unmount(loadingContainer)

  const board = harness()
  const boardFixture = defaultFixture()
  boardFixture.view = { ...boardFixture.view, layout: 'BOARD', groupByFields: [STATUS] }
  boardFixture.layout = 'BOARD'
  addFixture(board, PROJECT, boardFixture)
  await mount(board)
  expect(await dispatch(board, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 0 })

  const roadmap = harness()
  addFixture(roadmap, PROJECT, roadmapFixture())
  await mount(roadmap)
  expect(await dispatch(roadmap, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 0 })
})

test('2. Group toggles route raw values and privately prefix the collapsed key', async () => {
  const h = harness()
  const base = defaultFixture()
  base.view = { ...base.view, groupByFields: [STATUS] }
  base.items = [
    item('I1', 'Todo item', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' } }),
    item('I2', 'Unassigned item', { TEXT: { text: 'Other' } })
  ]
  addFixture(h, PROJECT, base)
  const container = await mount(h)
  const todo = groupButton(container, 'Todo')
  expect(todo.getAttribute('aria-expanded')).toBe('true')
  expect(rowTitles(container)).toEqual(['Todo item', 'Unassigned item'])

  await click(todo)
  expect(groupButton(container, 'Todo').getAttribute('aria-expanded')).toBe('false')
  expect(rowTitles(container)).toEqual(['Unassigned item'])
  await click(groupButton(container, 'Todo'))
  expect(groupButton(container, 'Todo').getAttribute('aria-expanded')).toBe('true')
  expect(rowTitles(container)).toEqual(['Todo item', 'Unassigned item'])
  expect(controlArgs(h)).toEqual([{ action: 'group', group: 'TODO' }, { action: 'group', group: 'TODO' }])
  expectBridgeRequests(h, controlArgs(h))

  expect(await dispatch(h, { action: 'group', group: '__no_value__' })).toEqual({ delivered: 1 })
  expect(groupButton(container, 'No Status').getAttribute('aria-expanded')).toBe('false')
  expect(await dispatch(h, { action: 'group', group: 'MISSING' })).toEqual({ delivered: 0 })
})

test('2b. Group rejects ungrouped tables and actual non-table layouts', async () => {
  const table = harness()
  await mount(table)
  expect(await dispatch(table, { action: 'group', group: 'TODO' })).toEqual({ delivered: 0 })

  const board = harness()
  const fixture = defaultFixture()
  fixture.view = { ...fixture.view, layout: 'BOARD', groupByFields: [STATUS] }
  fixture.layout = 'BOARD'
  addFixture(board, PROJECT, fixture)
  await mount(board)
  expect(await dispatch(board, { action: 'group', group: 'TODO' })).toEqual({ delivered: 0 })
})

test('3. Roadmap zoom routes, persists raw values, and restores the last zoom on remount', async () => {
  const h = harness()
  addFixture(h, PROJECT, roadmapFixture())
  let container = await mount(h)

  await click(button(container, 'Quarter'))
  expect(button(container, 'Quarter').getAttribute('aria-pressed')).toBe('true')
  expect(button(container, 'Year').getAttribute('aria-pressed')).toBe('false')
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('quarter')
  await click(button(container, 'Year'))
  expect(button(container, 'Quarter').getAttribute('aria-pressed')).toBe('false')
  expect(button(container, 'Year').getAttribute('aria-pressed')).toBe('true')
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('year')
  expect(controlArgs(h)).toEqual([{ action: 'zoom', zoom: 'quarter' }, { action: 'zoom', zoom: 'year' }])
  expectBridgeRequests(h, controlArgs(h))

  await unmount(container)
  container = await mount(h)
  expect(button(container, 'Year').getAttribute('aria-pressed')).toBe('true')
  expect(await dispatch(h, { action: 'zoom', zoom: 'month' })).toEqual({ delivered: 1 })
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('month')
})

test('3b. Zoom rejects tables and roadmap table fallbacks without changing storage', async () => {
  localStorage.setItem('quirky.tasks.projects.roadmapZoom', 'year')
  const table = harness()
  await mount(table)
  expect(await dispatch(table, { action: 'zoom', zoom: 'quarter' })).toEqual({ delivered: 0 })
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('year')

  const fallback = harness()
  const fixture = roadmapFixture({ fields: [NOTES], items: [item('I1', 'No date', { TEXT: { text: 'Original' } })] })
  addFixture(fallback, PROJECT, fixture)
  await mount(fallback)
  expect(await dispatch(fallback, { action: 'zoom', zoom: 'quarter' })).toEqual({ delivered: 0 })
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('year')
})

test('4. Today routes to this roadmap scroller with the existing smooth-scroll calculation', async () => {
  freezeClock('2026-11-14T12:00:00Z')
  const h = harness()
  addFixture(h, PROJECT, roadmapFixture())
  const container = await mount(h)
  const scroller = container.querySelector<HTMLDivElement>('.quirky-tasks-project-roadmap__scroller')
  if (!scroller) throw new Error('roadmap scroller was not rendered')
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 })
  const scrollCalls: unknown[] = []
  Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: (options: unknown) => scrollCalls.push(options) })

  await click(button(container, 'Today'))
  expect(scrollCalls).toEqual([{ left: 1480, behavior: 'smooth' }])
  expect(controlArgs(h)).toEqual([{ action: 'today' }])
  expectBridgeRequests(h, controlArgs(h))
  expect(await dispatch(h, { action: 'today' })).toEqual({ delivered: 1 })
  expect(scrollCalls).toEqual([{ left: 1480, behavior: 'smooth' }, { left: 1480, behavior: 'smooth' }])
})

test('4b. Today does nothing without a usable scroller or a valid roadmap date index', async () => {
  const table = harness()
  await mount(table)
  expect(await dispatch(table, { action: 'today' })).toEqual({ delivered: 0 })

  const fallback = harness()
  addFixture(fallback, PROJECT, roadmapFixture({ fields: [NOTES], items: [item('I1', 'No date', { TEXT: { text: 'Original' } })] }))
  await mount(fallback)
  expect(await dispatch(fallback, { action: 'today' })).toEqual({ delivered: 0 })

  freezeClock(null)
  const invalidToday = harness()
  addFixture(invalidToday, PROJECT, roadmapFixture())
  const container = await mount(invalidToday)
  const scroller = container.querySelector<HTMLDivElement>('.quirky-tasks-project-roadmap__scroller')!
  const scrollCalls: unknown[] = []
  Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: (options: unknown) => scrollCalls.push(options) })
  expect(await dispatch(invalidToday, { action: 'today' })).toEqual({ delivered: 0 })
  expect(scrollCalls).toEqual([])
})

test('5. Inline edit begin and cancel route by item and field without writing', async () => {
  const h = harness()
  const fixture = defaultFixture()
  fixture.fields = [STATUS, NOTES, { id: 'SUMMARY', name: 'Summary', dataType: 'TEXT' }]
  fixture.view = { ...fixture.view, fields: fixture.fields }
  fixture.items = [item('I1', 'Improve project table', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' }, SUMMARY: { text: 'Second cell' } })]
  addFixture(h, PROJECT, fixture)
  const container = await mount(h)

  await click(button(container, 'Edit Notes'))
  let notes = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
  expect(notes?.value).toBe('Original')
  expect(document.activeElement).toBe(notes)
  await changeInput(notes!, 'Discard me')
  await click(button(container, 'Cancel Notes edit'))
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(calls(h, 'quirky.tasks/projectEdit')).toEqual([])
  expect(controlArgs(h)).toEqual([
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false }
  ])
  expectBridgeRequests(h, controlArgs(h))

  await click(button(container, 'Edit Notes'))
  notes = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
  expect(notes?.value).toBe('Original')
  expect(container.querySelector('.ui-inline-error')).toBeNull()
  await changeInput(notes!, 'Keep this draft')
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Keep this draft')
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'SUMMARY', open: true })).toEqual({ delivered: 1 })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Summary"]')?.value).toBe('Second cell')
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Keep this draft')
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'SUMMARY', open: false })).toEqual({ delivered: 1 })
  expect(container.querySelector('input[aria-label="Summary"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Keep this draft')
})

test('5b. Inline edit rejects missing, hidden, collapsed, read-only, restricted, draft, and non-inline cells', async () => {
  const h = harness()
  const locked = { id: 'PARENT', name: 'Parent', dataType: 'PARENT_ISSUE' }
  const fixture = defaultFixture()
  fixture.fields = [STATUS, NOTES, locked]
  fixture.view = { ...fixture.view, fields: fixture.fields, groupByFields: [STATUS] }
  fixture.items = [
    item('I1', 'Todo issue', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' }, PARENT: { id: 'parent' } }),
    { id: 'I2', content: null, fieldValues: [{ fieldId: 'TEXT', value: { text: 'Restricted' } }] },
    { id: 'I3', type: 'DRAFT_ISSUE', content: { kind: 'draft', title: 'Draft' }, fieldValues: [{ fieldId: 'TEXT', value: { text: 'Draft' } }] }
  ]
  addFixture(h, PROJECT, fixture)
  await mount(h)

  expect(await dispatch(h, { action: 'edit', itemId: 'missing', fieldId: 'TEXT', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'missing', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'STATUS', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'PARENT', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I3', fieldId: 'TEXT', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false })).toEqual({ delivered: 0 })

  expect(await dispatch(h, { action: 'group', group: 'TODO' })).toEqual({ delivered: 1 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'group', group: 'TODO' })).toEqual({ delivered: 1 })
  expect(await dispatch(h, { action: 'column', fieldId: 'TEXT', visible: false })).toEqual({ delivered: 1 })
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 0 })
})

test('6. Scalar and collection saves retain their projectEdit routes and server values', async () => {
  const h = harness()
  const numberField = { id: 'NUMBER', name: 'Estimate', dataType: 'NUMBER' }
  const dateField = { id: 'DATE', name: 'Due date', dataType: 'DATE' }
  const labelsField = { id: 'LABELS', name: 'Labels', dataType: 'LABELS' }
  const assigneesField = { id: 'USERS', name: 'Assignees', dataType: 'USERS' }
  const fixture = defaultFixture()
  fixture.fields = [STATUS, NOTES, numberField, dateField, labelsField, assigneesField]
  fixture.view = { ...fixture.view, fields: fixture.fields }
  fixture.items = [item('I1', 'Improve project table', {
    STATUS: { singleSelectOptionId: 'TODO' },
    TEXT: { text: 'Original' },
    NUMBER: { number: 2.5 },
    DATE: { date: '2026-01-14' }
  }, { labels: ['old'], assignees: ['old-user'] })]
  addFixture(h, PROJECT, fixture)
  const container = await mount(h)

  await click(button(container, 'Edit Notes'))
  const escapeInput = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
  await changeInput(escapeInput, 'Discard with Escape')
  await press(escapeInput, 'Escape')
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(calls(h, 'quirky.tasks/projectEdit', 'field')).toEqual([])
  await click(button(container, 'Edit Notes'))
  let input = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
  expect(input.value).toBe('Original')
  await click(button(container, 'Save Notes'))
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(calls(h, 'quirky.tasks/projectEdit', 'field')).toEqual([])

  await click(button(container, 'Edit Notes'))
  input = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
  await changeInput(input, 'hello')
  const enter = await press(input, 'Enter')
  expect(enter.defaultPrevented).toBe(true)
  expect(calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'TEXT', host: 'github.com', value: { text: 'hello' }
  })
  expect(button(container, 'Edit Notes').textContent?.trim()).toBe('hello')

  await click(button(container, 'Edit Estimate'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Estimate"]')!, '12.5')
  await click(button(container, 'Save Estimate'))
  expect(calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'NUMBER', host: 'github.com', value: { number: 12.5 }
  })
  expect(button(container, 'Edit Estimate').textContent?.trim()).toBe('12.5')

  await click(button(container, 'Edit Due date'))
  const dateInput = container.querySelector<HTMLInputElement>('input[aria-label="Due date"]')!
  expect(dateInput.type).toBe('date')
  await changeInput(dateInput, '2026-11-14')
  await click(button(container, 'Save Due date'))
  expect(calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'DATE', host: 'github.com', value: { date: '2026-11-14' }
  })

  await click(button(container, 'Edit Notes'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, '')
  await click(button(container, 'Save Notes'))
  const clear = calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)!.params
  expect(clear).toEqual({ action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'TEXT', host: 'github.com', clear: true })
  expect(Object.hasOwn(clear, 'value')).toBe(false)

  await click(button(container, 'Edit Labels for issue 7'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Labels for issue 7"]')!, 'bug, help wanted')
  await click(button(container, 'Save Labels for issue 7'))
  expect(calls(h, 'quirky.tasks/projectEdit', 'issue').at(-1)?.params).toEqual({
    action: 'issue', projectId: 'PVT_1', itemId: 'I1', kind: 'issue', number: 7, host: 'github.com', labels: ['bug', 'help wanted']
  })
  expect(button(container, 'Edit Labels for issue 7').textContent?.trim()).toBe('bug, help wanted')

  await click(button(container, 'Edit Assignees for issue 7'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Assignees for issue 7"]')!, '@alice, bob')
  await click(button(container, 'Save Assignees for issue 7'))
  expect(calls(h, 'quirky.tasks/projectEdit', 'issue').at(-1)?.params).toEqual({
    action: 'issue', projectId: 'PVT_1', itemId: 'I1', kind: 'issue', number: 7, host: 'github.com', assignees: ['alice', 'bob']
  })
  expect(button(container, 'Edit Assignees for issue 7').textContent?.trim()).toBe('alice, bob')
  expect(controlArgs(h).filter((args) => (args as { action?: string }).action === 'edit')).toEqual([
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'NUMBER', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'DATE', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'LABELS', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'USERS', open: true }
  ])
  expect(calls(h, 'quirky.tasks/projectEdit').every((call) => call.params.action !== 'projects-control')).toBe(true)
  expect(fixture.items[0]?.fieldValues.find((field) => field.fieldId === 'DATE')?.value).toEqual({ date: '2026-11-14' })
})

test('6b. Pending saves deduplicate, remain cancellable, and cannot overwrite reopened cell sessions', async () => {
  const h = harness()
  const summary = { id: 'SUMMARY', name: 'Summary', dataType: 'TEXT' }
  const fixture = defaultFixture()
  fixture.fields = [STATUS, NOTES, summary]
  fixture.view = { ...fixture.view, fields: fixture.fields }
  fixture.items = [item('I1', 'Improve project table', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' }, SUMMARY: { text: 'Second cell' } })]
  addFixture(h, PROJECT, fixture)
  const pending: Array<{ params: Record<string, unknown>; finish(): void }> = []
  h.handlers.set('quirky.tasks/projectEdit', (params) => new Promise((resolve) => {
    pending.push({
      params,
      finish() {
        persistMutation(h, params)
        resolve({})
      }
    })
  }))
  const container = await mount(h)

  await click(button(container, 'Edit Notes'))
  const notes = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
  await changeInput(notes, 'Older value')
  await click(button(container, 'Save Notes'))
  expect(button(container, 'Save Notes').disabled).toBe(true)
  expect(button(container, 'Save Notes').textContent?.trim()).toBe('…')
  const secondEnter = await press(notes, 'Enter')
  expect(secondEnter.defaultPrevented).toBe(true)
  expect(pending).toHaveLength(1)
  expect(calls(h, 'quirky.tasks/projectEdit', 'field')).toHaveLength(1)

  await click(button(container, 'Cancel Notes edit'))
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Newer draft')
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'SUMMARY', open: true })).toEqual({ delivered: 1 })
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Summary"]')!, 'Other field draft')

  pending[0]!.finish()
  await settle()
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Newer draft')
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Summary"]')?.value).toBe('Other field draft')
  expect(button(container, 'Save Notes').disabled).toBe(false)
  expect(button(container, 'Save Summary').disabled).toBe(false)
})

test('6c. A stale save cannot close or replace an editor on a different saved view', async () => {
  const h = harness()
  const original = h.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!
  const nextView: ViewFixture = {
    view: { id: 'V2', number: 2, name: 'Second view', layout: 'TABLE', fields: [STATUS, NOTES] },
    layout: 'TABLE',
    fields: [STATUS, NOTES],
    items: [item('I1', 'Second view item', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'View two' } })]
  }
  addFixture(h, PROJECT, nextView)
  const pending: Array<{ params: Record<string, unknown>; finish(): void }> = []
  h.handlers.set('quirky.tasks/projectEdit', (params) => new Promise((resolve) => pending.push({ params, finish() { persistMutation(h, params); resolve({}) } })))
  const container = await mount(h)

  await click(button(container, 'Edit Notes'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Old view save')
  await click(button(container, 'Save Notes'))
  const nextTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Second view'))
  if (!nextTab) throw new Error('second saved view tab was not rendered')
  await click(nextTab)
  expect(rowTitles(container)).toEqual(['Second view item'])
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'New view draft')

  pending[0]!.finish()
  await settle()
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('New view draft')
  expect(container.textContent).toContain('Second view item')
  expect(original.items[0]?.fieldValues.find((field) => field.fieldId === 'TEXT')?.value).toEqual({ text: 'Old view save' })
})

test('6d. A stale save cannot close or replace an editor on a replacement project', async () => {
  const h = harness()
  const otherFixture = defaultFixture()
  otherFixture.items = [item('I1', 'Other project item', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Other project value' } })]
  addFixture(h, OTHER_PROJECT, otherFixture)
  const pending: Array<{ params: Record<string, unknown>; finish(): void }> = []
  h.handlers.set('quirky.tasks/projectEdit', (params) => new Promise((resolve) => pending.push({ params, finish() { persistMutation(h, params); resolve({}) } })))
  const container = await mount(h)

  await click(button(container, 'Edit Notes'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Old project save')
  await click(button(container, 'Save Notes'))
  await rerender(container, h, tasksState(OTHER_PROJECT, 'V1'))
  expect(container.textContent).toContain('Next roadmap')
  expect(rowTitles(container)).toEqual(['Other project item'])
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Replacement project draft')

  pending[0]!.finish()
  await settle()
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Replacement project draft')
  expect(rowTitles(container)).toEqual(['Other project item'])
})

test('6e. A remote field failure stays owned by the shared rollback error and appears once', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectEdit', () => { throw new Error('write rejected') })
  const container = await mount(h)
  await click(button(container, 'Edit Notes'))
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Rejected value')
  await click(button(container, 'Save Notes'))
  expect(container.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(container.querySelector('.ui-inline-error__message')?.textContent).toContain('GitHub did not confirm the change.')
  expect(button(container, 'Edit Notes').textContent?.trim()).toBe('Original')
})

test('7. A non-finite number uses one shared inline error and can be corrected', async () => {
  const h = harness()
  const numberNotes = { id: 'TEXT', name: 'Notes', dataType: 'NUMBER' }
  const fixture = defaultFixture()
  fixture.fields = [STATUS, numberNotes]
  fixture.view = { ...fixture.view, fields: fixture.fields }
  fixture.items = [item('I1', 'Improve project table', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { number: 3 } })]
  addFixture(h, PROJECT, fixture)
  const container = await mount(h)
  expect(await dispatch(h, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
  expect(input.type).toBe('number')
  await changeInput(input, '1e309')
  await click(button(container, 'Save Notes'))
  expect(container.querySelectorAll('.ui-inline-error[role="alert"] .ui-inline-error__message')).toHaveLength(1)
  expect(container.querySelector('.ui-inline-error[role="alert"] .ui-inline-error__message')?.textContent).toBe('Enter a finite number.')
  expect(button(container, 'Save Notes').disabled).toBe(false)
  expect(calls(h, 'quirky.tasks/projectEdit')).toEqual([])

  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, '12.5')
  await click(button(container, 'Save Notes'))
  expect(calls(h, 'quirky.tasks/projectEdit', 'field')).toHaveLength(1)
  expect(calls(h, 'quirky.tasks/projectEdit', 'field')[0]?.params.value).toEqual({ number: 12.5 })
  expect(container.querySelector('.ui-inline-error')).toBeNull()
})

test('10. Failed window commands preserve local sort, group, and editor actions', async () => {
  const h = harness()
  const fixture = defaultFixture()
  fixture.view = { ...fixture.view, groupByFields: [STATUS] }
  fixture.items = [
    item('I1', 'Zulu', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' } }),
    item('I2', 'Alpha', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Second' } })
  ]
  addFixture(h, PROJECT, fixture)
  h.handlers.set('ui.window.command.run', () => { throw new Error('No window') })
  const container = await mount(h)

  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  await click(groupButton(container, 'Todo'))
  expect(groupButton(container, 'Todo').getAttribute('aria-expanded')).toBe('false')
  await click(groupButton(container, 'Todo'))
  expect(groupButton(container, 'Todo').getAttribute('aria-expanded')).toBe('true')
  await click(button(container, 'Edit Notes'))
  expect(container.querySelector('input[aria-label="Notes"]')).not.toBeNull()
  await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Discarded')
  await click(button(container, 'Cancel Notes edit'))
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()

  expect(controlArgs(h)).toEqual([
    { action: 'sort', fieldId: 'title' },
    { action: 'group', group: 'TODO' },
    { action: 'group', group: 'TODO' },
    { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: false }
  ])
  expect(calls(h, 'ui.window.self')).toHaveLength(5)
  expect(h.logs).toEqual(Array(5).fill('tasks: projects control failed: No window'))
  expect(calls(h, 'quirky.tasks/projectEdit')).toEqual([])
})
test('10b. Failed window commands preserve local zoom and Today effects', async () => {
  freezeClock('2026-11-14T12:00:00Z')
  const h = harness()
  addFixture(h, PROJECT, roadmapFixture())
  h.handlers.set('ui.window.command.run', () => { throw new Error('No window') })
  const container = await mount(h)
  const scroller = container.querySelector<HTMLDivElement>('.quirky-tasks-project-roadmap__scroller')!
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 })
  const scrollCalls: unknown[] = []
  Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: (options: unknown) => scrollCalls.push(options) })

  await click(button(container, 'Year'))
  expect(button(container, 'Year').getAttribute('aria-pressed')).toBe('true')
  await click(button(container, 'Month'))
  await click(button(container, 'Today'))
  expect(button(container, 'Month').getAttribute('aria-pressed')).toBe('true')
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('month')
  expect(scrollCalls).toEqual([{ left: 1480, behavior: 'smooth' }])
  expect(controlArgs(h)).toEqual([{ action: 'zoom', zoom: 'year' }, { action: 'zoom', zoom: 'month' }, { action: 'today' }])
  expect(calls(h, 'ui.window.self')).toHaveLength(3)
  expect(h.logs).toEqual(Array(3).fill('tasks: projects control failed: No window'))
})
test('10c. A failed window identity lookup is retried on the next control request', async () => {
  const h = harness()
  const fixture = h.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!
  fixture.items = [
    item('I1', 'Zulu', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Z' } }),
    item('I2', 'Alpha', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'A' } })
  ]
  let lookups = 0
  h.handlers.set('ui.window.self', () => {
    lookups += 1
    if (lookups === 1) throw new Error('No window')
    return { connId: 7 }
  })
  const container = await mount(h)

  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  await click(headerButton(container, 'Notes'))
  expect(headerButton(container, 'Notes').textContent?.trim()).toBe('Notes ↑')
  expect(lookups).toBe(2)
  expect(calls(h, 'ui.window.self')).toHaveLength(2)
  expect(controlArgs(h)).toEqual([{ action: 'sort', fieldId: 'TEXT' }])
  expect(calls(h, 'ui.window.command.run').map((call) => call.params.connId)).toEqual([7])
  expect(h.logs).toEqual(['tasks: projects control failed: No window'])
})
test('10d. Delayed control rejection cannot change a replacement context', async () => {
  const first = harness()
  const next = harness()
  for (const h of [first, next]) {
    h.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!.items = [item('I1', 'Zulu'), item('I2', 'Alpha')]
  }
  const reject = holdNextControl(first)
  const container = await mount(first)
  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Zulu', 'Alpha'])
  await rerender(container, next, tasksState())
  await act(async () => reject(new Error('No window')))
  await settle()
  expect(rowTitles(container)).toEqual(['Zulu', 'Alpha'])
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title')
  expect(controlArgs(next)).toEqual([])
})

test('10e. Returning to the same context does not revive an expired request', async () => {
  const first = harness()
  const next = harness()
  for (const h of [first, next]) {
    h.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!.items = [item('I1', 'Zulu'), item('I2', 'Alpha')]
  }
  const reject = holdNextControl(first)
  const container = await mount(first)
  await click(headerButton(container, 'Title'))
  await rerender(container, next, tasksState())
  await rerender(container, first, tasksState())
  await act(async () => reject(new Error('No window')))
  await settle()
  expect(rowTitles(container)).toEqual(['Zulu', 'Alpha'])
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title')
  expect(controlArgs(first)).toEqual([{ action: 'sort', fieldId: 'title' }])
  expect(controlArgs(next)).toEqual([])
})

test('10f. Disposed roadmap requests cannot overwrite a replacement mount zoom', async () => {
  const h = harness()
  addFixture(h, PROJECT, roadmapFixture())
  localStorage.setItem('quirky.tasks.projects.roadmapZoom', 'month')
  const reject = holdNextControl(h)
  const original = await mount(h)
  await click(button(original, 'Year'))
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('month')
  await unmount(original)
  const replacement = await mount(h)
  await click(button(replacement, 'Quarter'))
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('quarter')
  await act(async () => reject(new Error('No window')))
  await settle()
  expect(localStorage.getItem('quirky.tasks.projects.roadmapZoom')).toBe('quarter')
  expect(button(replacement, 'Quarter').getAttribute('aria-pressed')).toBe('true')
  expect(controlArgs(h)).toEqual([{ action: 'zoom', zoom: 'year' }, { action: 'zoom', zoom: 'quarter' }])
})

test('10g. Delayed rejection still falls back after rerendering the same live context', async () => {
  const h = harness()
  h.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!.items = [item('I1', 'Zulu'), item('I2', 'Alpha')]
  const reject = holdNextControl(h)
  const container = await mount(h)
  await click(headerButton(container, 'Title'))
  await rerender(container, h, tasksState())
  await act(async () => reject(new Error('No window')))
  await settle()
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  expect(headerButton(container, 'Title').textContent?.trim()).toBe('Title ↑')
  expect(h.logs).toEqual(['tasks: projects control failed: No window'])
  expectBridgeRequests(h, [{ action: 'sort', fieldId: 'title' }])
})

test('11. Control delivery is scoped to eligible mounted surfaces, contexts, and lifetimes', async () => {
  const firstHarness = harness()
  const firstFixture = firstHarness.fixtures.get(projectViewIdentity(PROJECT, 'V1'))!
  firstFixture.items = [
    item('I1', 'Zulu', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Z' } }),
    item('I2', 'Alpha', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'A' } })
  ]
  const otherHarness = harness()
  const first = await mount(firstHarness)
  const other = await mount(otherHarness)

  expect(await dispatch(firstHarness, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  expect(first.querySelector('input[aria-label="Notes"]')).not.toBeNull()
  expect(other.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(await dispatch(otherHarness, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 1 })
  expect(rowTitles(other)).toEqual(['Improve project table'])

  let commandReply: unknown
  await act(async () => {
    commandReply = await firstHarness.context.call('ui.window.command.run', {
      connId: 7,
      id: PROJECTS_CONTROL_COMMAND,
      args: { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false }
    })
  })
  await settle()
  expect(commandReply).toEqual({ result: { delivered: 1 } })
  expect(first.querySelector('input[aria-label="Notes"]')).toBeNull()
  await expect(firstHarness.context.call('method.not.registered', {})).rejects.toThrow('Unexpected method: method.not.registered')
  await firstHarness.context.executeCommand(PROJECTS_CONTROL_COMMAND, { action: 'sort', fieldId: 'title' })
  expect(firstHarness.commands).toEqual([{ id: PROJECTS_CONTROL_COMMAND, args: { action: 'sort', fieldId: 'title' } }])
  expect(rowTitles(first)).toEqual(['Zulu', 'Alpha'])

  await unmount(first)
  expect(await dispatch(firstHarness, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 0 })
  const firstAgain = await mount(firstHarness)
  const secondAgain = await mount(firstHarness)
  expect(await dispatch(firstHarness, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 2 })
  expect(await dispatch(otherHarness, { action: 'group', group: 'TODO' })).toEqual({ delivered: 0 })
  await unmount(firstAgain)
  expect(await dispatch(firstHarness, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 1 })
  await unmount(secondAgain)
  expect(await dispatch(firstHarness, { action: 'sort', fieldId: 'title' })).toEqual({ delivered: 0 })
})
test('11b. The five new request variants parse exact addresses and reject malformed fields exactly', () => {
  const generic = 'projects-control needs an action of picker, column-panel, back-to-picker, column, sort, group, zoom, today or edit.'
  const sortError = 'projects-control sort needs a nonempty fieldId and no other fields.'
  const groupError = 'projects-control group needs a nonempty group and no other fields.'
  const zoomError = 'projects-control zoom needs month, quarter or year and no other fields.'
  const todayError = 'projects-control today takes no other fields.'
  const editError = 'projects-control edit needs nonempty itemId and fieldId strings, a boolean open and no other fields.'

  expect(parseProjectsControlRequest({ action: 'sort', fieldId: ' title ' })).toEqual({ action: 'sort', fieldId: ' title ' })
  expect(parseProjectsControlRequest({ action: 'group', group: ' TODO ' })).toEqual({ action: 'group', group: ' TODO ' })
  expect(parseProjectsControlRequest({ action: 'zoom', zoom: 'month' })).toEqual({ action: 'zoom', zoom: 'month' })
  expect(parseProjectsControlRequest({ action: 'zoom', zoom: 'quarter' })).toEqual({ action: 'zoom', zoom: 'quarter' })
  expect(parseProjectsControlRequest({ action: 'zoom', zoom: 'year' })).toEqual({ action: 'zoom', zoom: 'year' })
  expect(parseProjectsControlRequest({ action: 'today' })).toEqual({ action: 'today' })
  expect(parseProjectsControlRequest({ action: 'edit', itemId: ' I1 ', fieldId: ' TEXT ', open: true })).toEqual({ action: 'edit', itemId: ' I1 ', fieldId: ' TEXT ', open: true })
  expect(parseProjectsControlRequest({ action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false })).toEqual({ action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false })

  for (const input of [null, [], 'sort', {}, { action: 'unknown' }]) validationError(input, generic)
  for (const input of [
    { action: 'sort' },
    { action: 'sort', fieldId: '' },
    { action: 'sort', fieldId: '   ' },
    { action: 'sort', fieldId: 1 },
    { action: 'sort', fieldId: 'title', extra: true }
  ]) validationError(input, sortError)
  for (const input of [
    { action: 'group' },
    { action: 'group', group: '' },
    { action: 'group', group: '  ' },
    { action: 'group', group: false },
    { action: 'group', group: 'TODO', fieldId: 'STATUS' }
  ]) validationError(input, groupError)
  for (const input of [
    { action: 'zoom' },
    { action: 'zoom', zoom: 1 },
    { action: 'zoom', zoom: 'week' },
    { action: 'zoom', zoom: '   ' },
    { action: 'zoom', zoom: 'year', fieldId: 'DATE' }
  ]) validationError(input, zoomError)
  validationError({ action: 'today', zoom: 'month' }, todayError)
  for (const input of [
    { action: 'edit', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', open: true },
    { action: 'edit', itemId: '', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: '   ', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 1, fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I1', fieldId: '', open: true },
    { action: 'edit', itemId: 'I1', fieldId: '  ', open: true },
    { action: 'edit', itemId: 'I1', fieldId: 1, open: true },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT' },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: 'false' },
    { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true, zoom: 'month' }
  ]) validationError(input, editError)

  expect(parseProjectsControlRequest({ action: 'picker', open: true })).toEqual({ action: 'picker', open: true })
  expect(parseProjectsControlRequest({ action: 'column-panel', open: false })).toEqual({ action: 'column-panel', open: false })
  expect(parseProjectsControlRequest({ action: 'back-to-picker' })).toEqual({ action: 'back-to-picker' })
  expect(parseProjectsControlRequest({ action: 'column', fieldId: 'STATUS', visible: true })).toEqual({ action: 'column', fieldId: 'STATUS', visible: true })
  const booleanError = 'projects-control open must be a boolean.'
  const columnError = 'projects-control column needs a fieldId and a visible boolean or a width from 60 to 800.'
  validationError({ action: 'picker', open: 'yes' }, booleanError)
  validationError({ action: 'column-panel', open: 1 }, booleanError)
  validationError({ action: 'back-to-picker', open: true }, 'projects-control back-to-picker takes no other fields.')
  validationError({ action: 'column' }, columnError)
  validationError({ action: 'column', fieldId: '', visible: true }, columnError)
  validationError({ action: 'column', fieldId: 'STATUS', width: 59 }, columnError)
  validationError({ action: 'column', fieldId: 'title', visible: false }, 'The Title column cannot be hidden.')
})
test('11c. Invalid requests change no state and inapplicable controls report zero delivery', async () => {
  const h = harness()
  const container = await mount(h)
  const before = rowTitles(container)
  expect(() => runProjectsControl(h.context as never, { action: 'sort', fieldId: ' ' })).toThrow('projects-control sort needs a nonempty fieldId and no other fields.')
  expect(() => runProjectsControl(h.context as never, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: 'false' })).toThrow('projects-control edit needs nonempty itemId and fieldId strings, a boolean open and no other fields.')
  expect(rowTitles(container)).toEqual(before)
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(await dispatch(h, { action: 'zoom', zoom: 'year' })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'today' })).toEqual({ delivered: 0 })
  expect(await dispatch(h, { action: 'edit', itemId: 'unknown', fieldId: 'TEXT', open: true })).toEqual({ delivered: 0 })
})

type HarnessDataTransfer = {
  effectAllowed: string
  setData(format: string, value: string): void
  getData(format: string): string
}

function projectRow(container: HTMLElement, title: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.quirky-tasks-project-table__row')].find((row) =>
    row.querySelector('.quirky-tasks-project-table__title')?.textContent?.trim() === title
  )
  if (!found) throw new Error(`no project row titled ${JSON.stringify(title)}`)
  return found
}

function boardColumn(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`.quirky-tasks-project-board__column[aria-label=${JSON.stringify(label)}]`)
  if (!found) throw new Error(`no board column ${JSON.stringify(label)}`)
  return found
}

function makeDataTransfer(): HarnessDataTransfer {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'none',
    setData(format, value) { values.set(format, value) },
    getData(format) { return values.get(format) ?? '' }
  }
}

function dragEvent(type: string, transfer: HarnessDataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  return event
}

async function startDrag(card: HTMLElement): Promise<HarnessDataTransfer> {
  const transfer = makeDataTransfer()
  await act(async () => card.dispatchEvent(dragEvent('dragstart', transfer)))
  await settle()
  return transfer
}

async function dropTransfer(target: HTMLElement, transfer: HarnessDataTransfer): Promise<Event> {
  const event = dragEvent('drop', transfer)
  await act(async () => target.dispatchEvent(event))
  await settle()
  return event
}

async function dropItem(target: HTMLElement, itemId: string): Promise<Event> {
  const transfer = makeDataTransfer()
  transfer.setData('text/quirky-project-item', itemId)
  return await dropTransfer(target, transfer)
}

function installRepositoryMatch(h: Harness, identity = { host: 'github.com', owner: 'acme', repo: 'quirky' }): void {
  h.handlers.set('quirky.repo/list', () => [{ id: 'repo-1', kind: 'git', name: 'quirky', path: '/tmp/quirky' }])
  h.handlers.set('quirky.worktree/list', () => [{ id: 'worktree-1', repoId: 'repo-1', isMain: true }])
  h.handlers.set('quirky.hosting/repository', () => ({ origin: identity }))
  h.handlers.set('quirky.tasks/navigate', () => ({}))
  h.handlers.set('quirky.reviews/open', () => ({}))
}

test('8. Board table fallback renders one advisory and routes sort and inline edit', async () => {
  const h = harness()
  const fixture = defaultFixture()
  fixture.view = { ...fixture.view, layout: 'BOARD', fields: [NOTES] }
  fixture.layout = 'BOARD'
  fixture.fields = [NOTES]
  fixture.items = [
    item('I1', 'Zulu', { TEXT: { text: 'Zulu notes' } }),
    item('I2', 'Alpha', { TEXT: { text: 'Alpha notes' } })
  ]
  addFixture(h, PROJECT, fixture)
  const container = await mount(h)
  const noticeText = 'This board view has no single-select or iteration field to group by, so Quirky is listing items instead.'

  expect(container.querySelectorAll('[role="status"] .ui-notice-line')).toHaveLength(1)
  expect(container.querySelector('[role="status"] .ui-notice-line .ui-notice-line__text')?.textContent).toBe(noticeText)
  expect(rowTitles(container)).toEqual(['Zulu', 'Alpha'])
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
  expect(container.querySelector('.ui-empty-state')).toBeNull()

  await click(headerButton(container, 'Title'))
  expect(rowTitles(container)).toEqual(['Alpha', 'Zulu'])
  await click(button(container, 'Edit Notes'))
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Alpha notes')
  await click(button(container, 'Cancel Notes edit'))
  expect(container.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(controlArgs(h)).toEqual([
    { action: 'sort', fieldId: 'title' },
    { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: false }
  ])
  expectBridgeRequests(h, controlArgs(h))
  expect(calls(h, 'quirky.tasks/projectEdit')).toEqual([])
})

test('9. Roadmap fallback stays usable and unsupported layouts use one shared error with existing routes', async () => {
  const fallback = harness()
  const fixture = roadmapFixture({
    fields: [NOTES],
    items: [
      item('I1', 'Zulu', { TEXT: { text: 'Zulu notes' } }),
      item('I2', 'Alpha', { TEXT: { text: 'Alpha notes' } })
    ]
  })
  addFixture(fallback, PROJECT, fixture)
  const fallbackContainer = await mount(fallback)
  const noticeText = 'This roadmap view has no date or iteration field to place items on, so Quirky is listing items instead.'
  expect(fallbackContainer.querySelectorAll('[role="status"] .ui-notice-line')).toHaveLength(1)
  expect(fallbackContainer.querySelector('[role="status"] .ui-notice-line .ui-notice-line__text')?.textContent).toBe(noticeText)
  await click(headerButton(fallbackContainer, 'Title'))
  expect(rowTitles(fallbackContainer)).toEqual(['Alpha', 'Zulu'])
  await click(button(fallbackContainer, 'Edit Notes'))
  expect(fallbackContainer.querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value).toBe('Alpha notes')
  await click(button(fallbackContainer, 'Cancel Notes edit'))
  expect(controlArgs(fallback)).toEqual([
    { action: 'sort', fieldId: 'title' },
    { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: true },
    { action: 'edit', itemId: 'I2', fieldId: 'TEXT', open: false }
  ])
  expectBridgeRequests(fallback, controlArgs(fallback))

  const unsupported = harness()
  const calendar = defaultFixture()
  calendar.view = { ...calendar.view, layout: 'CALENDAR', fields: [NOTES] }
  calendar.layout = 'CALENDAR'
  calendar.fields = [NOTES]
  addFixture(unsupported, PROJECT, calendar)
  const container = await mount(unsupported)
  const errorMessage = 'This project view layout is unsupported. Choose a table, board, or roadmap view. The original view remains available on GitHub.'
  expect(container.querySelectorAll('.ui-inline-error[role="alert"] .ui-inline-error__message')).toHaveLength(1)
  expect(container.querySelector('.ui-inline-error[role="alert"] .ui-inline-error__message')?.textContent).toBe(errorMessage)
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)

  const previousCalls = calls(unsupported, 'quirky.tasks/projectView').length
  await click(button(container, 'Retry'))
  const retryCalls = calls(unsupported, 'quirky.tasks/projectView').slice(previousCalls)
  expect(retryCalls.some((call) => call.params.action === 'refresh' && call.params.viewId === 'V1')).toBe(true)
  await click(button(container, 'Open in GitHub'))
  expect(unsupported.commands).toEqual([{
    id: 'command:quirky.tasks/open-link',
    args: { url: PROJECT.url }
  }])
  expect(container.querySelectorAll('.ui-inline-error[role="alert"] .ui-inline-error__message')).toHaveLength(1)
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
})

test('12a. Table fields preserve single-select, iteration, and multi-select write shapes', async () => {
  const h = harness()
  const iteration = {
    id: 'ITERATION',
    name: 'Sprint',
    dataType: 'ITERATION',
    options: [{ id: 'SPRINT_1', name: 'Sprint 1' }, { id: 'SPRINT_2', name: 'Sprint 2' }]
  }
  const multi = {
    id: 'MULTI',
    name: 'Tags',
    dataType: 'MULTI_SELECT',
    options: [{ id: 'TAG_A', name: 'A' }, { id: 'TAG_B', name: 'B' }]
  }
  const fixture = defaultFixture()
  fixture.fields = [STATUS, NOTES, iteration, multi]
  fixture.view = { ...fixture.view, fields: fixture.fields }
  fixture.items = [item('I1', 'Improve project table', {
    STATUS: { singleSelectOptionId: 'TODO' },
    TEXT: { text: 'Original' },
    ITERATION: { iterationId: 'SPRINT_1' },
    MULTI: { multiSelectOptionIds: ['TAG_A'] }
  })]
  addFixture(h, PROJECT, fixture)
  const container = await mount(h)

  await changeSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!, 'DONE')
  await changeSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!, '')
  await changeSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Sprint"]')!, 'SPRINT_2')
  await changeSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Sprint"]')!, '')
  await changeMultiSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Tags"]')!, ['TAG_B'])
  await changeMultiSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Tags"]')!, [])

  expect(calls(h, 'quirky.tasks/projectEdit', 'field').map((call) => call.params)).toEqual([
    { action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'STATUS', host: 'github.com', value: { singleSelectOptionId: 'DONE' } },
    { action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'STATUS', host: 'github.com', clear: true },
    { action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'ITERATION', host: 'github.com', value: { iterationId: 'SPRINT_2' } },
    { action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'ITERATION', host: 'github.com', clear: true },
    { action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'MULTI', host: 'github.com', value: { multiSelectOptionIds: ['TAG_B'] } },
    { action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'MULTI', host: 'github.com', clear: true }
  ])
  for (const call of calls(h, 'quirky.tasks/projectEdit', 'field')) expect(Object.hasOwn(call.params, 'value')).toBe(call.params.clear !== true)
})

test('12b. Issue types load on both focus and click, and unknown choices do not write', async () => {
  const h = harness()
  const issueType = { id: 'ISSUE_TYPE', name: 'Issue type', dataType: 'ISSUE_TYPE', options: [] }
  const fixture = defaultFixture()
  fixture.fields = [STATUS, NOTES, issueType]
  fixture.view = { ...fixture.view, fields: fixture.fields }
  fixture.items = [
    item('I1', 'First issue', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'One' } }),
    item('I2', 'Second issue', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Two' } })
  ]
  addFixture(h, PROJECT, fixture)
  const container = await mount(h)
  const firstRow = projectRow(container, 'First issue')
  const focusButton = firstRow.querySelector<HTMLButtonElement>('.quirky-tasks-projects__field-action')!
  await act(async () => focusButton.focus())
  await settle()
  expect(calls(h, 'quirky.tasks/projectEdit', 'issueType').some((call) => call.params.itemId === 'I1' && call.params.issueTypeId === undefined)).toBe(true)

  const secondRow = projectRow(container, 'Second issue')
  const clickButton = secondRow.querySelector<HTMLButtonElement>('.quirky-tasks-projects__field-action')!
  await act(async () => clickButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await settle()
  expect(calls(h, 'quirky.tasks/projectEdit', 'issueType').some((call) => call.params.itemId === 'I2' && call.params.issueTypeId === undefined)).toBe(true)

  const firstSelect = projectRow(container, 'First issue').querySelector<HTMLSelectElement>('select[aria-label="Issue type"]')!
  const unknown = document.createElement('option')
  unknown.value = 'UNKNOWN'
  unknown.textContent = 'Unknown'
  firstSelect.add(unknown)
  await changeSelect(firstSelect, 'UNKNOWN')
  expect(calls(h, 'quirky.tasks/projectEdit', 'issueType').filter((call) => call.params.issueTypeId !== undefined)).toEqual([])
  await changeSelect(projectRow(container, 'First issue').querySelector<HTMLSelectElement>('select[aria-label="Issue type"]')!, 'BUG')
  await changeSelect(projectRow(container, 'Second issue').querySelector<HTMLSelectElement>('select[aria-label="Issue type"]')!, 'FEATURE')

  expect(calls(h, 'quirky.tasks/projectEdit', 'issueType').filter((call) => call.params.issueTypeId !== undefined).map((call) => call.params)).toEqual([
    { action: 'issueType', projectId: 'PVT_1', itemId: 'I1', kind: 'issue', number: 7, host: 'github.com', issueTypeId: 'BUG' },
    { action: 'issueType', projectId: 'PVT_1', itemId: 'I2', kind: 'issue', number: 8, host: 'github.com', issueTypeId: 'FEATURE' }
  ])
})

test('12c. Board dropdown and drag-drop share move shaping, including clear and iteration targets', async () => {
  const h = harness()
  const board = defaultFixture()
  board.view = { ...board.view, layout: 'BOARD' }
  board.layout = 'BOARD'
  board.items = [item('I1', 'Move card', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' } })]
  addFixture(h, PROJECT, board)
  const container = await mount(h)

  await changeSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Move Move card"]')!, 'DONE')
  expect(calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'STATUS', host: 'github.com', value: { singleSelectOptionId: 'DONE' }
  })
  await changeSelect(container.querySelector<HTMLSelectElement>('select[aria-label="Move Move card"]')!, '')
  expect(calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'STATUS', host: 'github.com', clear: true
  })

  const card = boardColumn(container, 'No Status').querySelector<HTMLElement>('.quirky-tasks-project-board__card')!
  const transfer = await startDrag(card)
  expect(transfer.getData('text/quirky-project-item')).toBe('I1')
  expect(transfer.effectAllowed).toBe('move')
  const drop = await dropTransfer(boardColumn(container, 'Done'), transfer)
  expect(drop.defaultPrevented).toBe(true)
  expect(calls(h, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'STATUS', host: 'github.com', value: { singleSelectOptionId: 'DONE' }
  })

  const iteration = { id: 'ITERATION', name: 'Sprint', dataType: 'ITERATION', options: [{ id: 'SPRINT_1', name: 'Sprint 1' }, { id: 'SPRINT_2', name: 'Sprint 2' }] }
  const iterationBoard: ViewFixture = {
    view: { id: 'V1', number: 1, name: 'Iteration board', layout: 'BOARD', fields: [iteration], verticalGroupByFields: [iteration] },
    layout: 'BOARD',
    fields: [iteration],
    items: [item('I1', 'Iteration issue', { ITERATION: { iterationId: 'SPRINT_1' } })]
  }
  const iterationHarness = harness()
  addFixture(iterationHarness, PROJECT, iterationBoard)
  const iterationContainer = await mount(iterationHarness)
  const iterationCard = boardColumn(iterationContainer, 'Sprint 1').querySelector<HTMLElement>('.quirky-tasks-project-board__card')!
  const iterationTransfer = await startDrag(iterationCard)
  await dropTransfer(boardColumn(iterationContainer, 'Sprint 2'), iterationTransfer)
  expect(calls(iterationHarness, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'ITERATION', host: 'github.com', value: { iterationId: 'SPRINT_2' }
  })
  await changeSelect(iterationContainer.querySelector<HTMLSelectElement>('select[aria-label="Move Iteration issue"]')!, '')
  expect(calls(iterationHarness, 'quirky.tasks/projectEdit', 'field').at(-1)?.params).toEqual({
    action: 'field', projectId: 'PVT_1', itemId: 'I1', fieldId: 'ITERATION', host: 'github.com', clear: true
  })
})

test('12d. Fabricated board drops reject unknown, restricted, draft, readonly destination, and readonly source cards', async () => {
  const h = harness()
  const board = defaultFixture()
  board.view = { ...board.view, layout: 'BOARD' }
  board.layout = 'BOARD'
  board.fields = [STATUS]
  board.view = { ...board.view, fields: board.fields }
  board.items = [
    item('I1', 'Todo issue', { STATUS: { singleSelectOptionId: 'TODO' } }),
    item('I2', 'Deleted-option issue', { STATUS: { singleSelectOptionId: 'GONE' } }),
    { id: 'I3', content: null, fieldValues: [{ fieldId: 'STATUS', value: { singleSelectOptionId: 'TODO' } }] },
    { id: 'I4', type: 'DRAFT_ISSUE', content: { kind: 'draft', title: 'Draft issue' }, fieldValues: [{ fieldId: 'STATUS', value: { singleSelectOptionId: 'TODO' } }] }
  ]
  addFixture(h, PROJECT, board)
  const container = await mount(h)
  const done = boardColumn(container, 'Done')
  const deleted = boardColumn(container, 'Deleted: GONE')
  const noStatus = boardColumn(container, 'No Status')

  await dropItem(done, 'UNKNOWN_ITEM')
  await dropItem(deleted, 'I1')
  await dropItem(done, 'I3')
  await dropItem(done, 'I4')
  await dropItem(noStatus, 'I2')
  expect(calls(h, 'quirky.tasks/projectEdit')).toEqual([])
})

test('12e. Table, board, and dated or undated roadmap titles delegate to issue and PR routes', async () => {
  const tableHarness = harness()
  installRepositoryMatch(tableHarness)
  const tableFixture = defaultFixture()
  tableFixture.items = [
    item('I1', 'Improve project table', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' } }),
    item('I2', 'Fix pull request', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'PR' } }, {
      kind: 'pullRequest',
      number: 8,
      url: 'https://github.com/acme/quirky/pull/8'
    })
  ]
  addFixture(tableHarness, PROJECT, tableFixture)
  const table = await mount(tableHarness)
  const issueRow = projectRow(table, 'Improve project table')
  await click(issueRow.querySelector<HTMLElement>('.quirky-tasks-project-table__title')!)
  const cells = issueRow.querySelectorAll('td')
  expect(cells[0]?.style.left).toBe('0px')
  expect(cells[1]?.style.left).toBe('360px')
  await act(async () => issueRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))
  await settle()
  await click(projectRow(table, 'Fix pull request').querySelector<HTMLElement>('.quirky-tasks-project-table__title')!)
  expect(calls(tableHarness, 'quirky.tasks/navigate')).toHaveLength(2)
  expect(calls(tableHarness, 'quirky.tasks/navigate')[0]?.params.detail).toMatchObject({
    kind: 'issue', number: 7, worktree: 'worktree-1'
  })
  expect(calls(tableHarness, 'quirky.reviews/open')).toEqual([{
    method: 'quirky.reviews/open',
    params: { worktree: 'worktree-1', number: 8, tab: 'conversation', prRepo: { host: 'github.com', owner: 'acme', repo: 'quirky' } }
  }])

  const boardHarness = harness()
  installRepositoryMatch(boardHarness)
  const boardFixture = defaultFixture()
  boardFixture.view = { ...boardFixture.view, layout: 'BOARD' }
  boardFixture.layout = 'BOARD'
  boardFixture.items = [item('I1', 'Board issue', { STATUS: { singleSelectOptionId: 'TODO' }, TEXT: { text: 'Original' } })]
  addFixture(boardHarness, PROJECT, boardFixture)
  const board = await mount(boardHarness)
  await click(boardColumn(board, 'Todo').querySelector<HTMLElement>('.quirky-tasks-project-board__card-title')!)
  expect(calls(boardHarness, 'quirky.tasks/navigate')).toHaveLength(1)

  const datedHarness = harness()
  installRepositoryMatch(datedHarness)
  addFixture(datedHarness, PROJECT, roadmapFixture({ items: [item('I1', 'Dated roadmap issue', { DATE: '2026-01-14', TEXT: { text: 'Original' } })] }))
  const dated = await mount(datedHarness)
  await click(dated.querySelector<HTMLElement>('.quirky-tasks-project-roadmap__item-title')!)
  expect(calls(datedHarness, 'quirky.tasks/navigate')).toHaveLength(1)

  const undatedHarness = harness()
  installRepositoryMatch(undatedHarness)
  addFixture(undatedHarness, PROJECT, roadmapFixture({ items: [item('I1', 'Undated roadmap issue', { TEXT: { text: 'Original' } })] }))
  const undated = await mount(undatedHarness)
  const undatedDetails = undated.querySelector('details')
  if (!undatedDetails) throw new Error('undated roadmap items were not rendered')
  await click(undatedDetails.querySelector('summary')!)
  await click(button(undated, 'Undated roadmap issue'))
  expect(calls(undatedHarness, 'quirky.tasks/navigate')).toHaveLength(1)
})

test('12f. Restricted, draft, and unmatched project titles keep preview and guidance behavior', async () => {
  const restrictedHarness = harness()
  const restricted = defaultFixture()
  restricted.fields = [NOTES]
  restricted.view = { ...restricted.view, fields: restricted.fields }
  restricted.items = [{ id: 'I1', content: null, fieldValues: [] }]
  addFixture(restrictedHarness, PROJECT, restricted)
  const restrictedContainer = await mount(restrictedHarness)
  await click(button(restrictedContainer, 'Restricted item'))
  expect(restrictedContainer.querySelector('[role="dialog"]')?.textContent).toContain('Restricted project content cannot be opened or edited.')
  expect(calls(restrictedHarness, 'quirky.tasks/navigate')).toEqual([])

  const draftHarness = harness()
  const draft = defaultFixture()
  draft.fields = [NOTES]
  draft.view = { ...draft.view, fields: draft.fields }
  draft.items = [{ id: 'I1', type: 'DRAFT_ISSUE', content: { kind: 'draft', title: 'Draft project card' }, fieldValues: [] }]
  addFixture(draftHarness, PROJECT, draft)
  const draftContainer = await mount(draftHarness)
  await click(button(draftContainer, 'Draft project card'))
  expect(draftContainer.querySelector('[role="dialog"]')?.textContent).toContain('Draft project cards do not have an issue or pull-request detail page.')
  expect(calls(draftHarness, 'quirky.tasks/navigate')).toEqual([])

  const unmatchedHarness = harness()
  const unmatched = defaultFixture()
  unmatched.fields = [NOTES]
  unmatched.view = { ...unmatched.view, fields: unmatched.fields }
  unmatched.items = [item('I1', 'Unmatched issue', { TEXT: { text: 'Original' } }, {
    repository: 'another/project',
    url: 'https://github.com/another/project/issues/7'
  })]
  addFixture(unmatchedHarness, PROJECT, unmatched)
  unmatchedHarness.handlers.set('quirky.repo/list', () => [])
  const unmatchedContainer = await mount(unmatchedHarness)
  await click(button(unmatchedContainer, 'Unmatched issue'))
  expect(unmatchedContainer.querySelector('[role="dialog"]')?.textContent).toContain('No registered local worktree is available for the Project item detail route.')
  expect(calls(unmatchedHarness, 'quirky.tasks/navigate')).toEqual([])
})
test('5c. Closing an editor stops delivering after its column or group row disappears', async () => {
  const hiddenHarness = harness()
  const hiddenContainer = await mount(hiddenHarness)
  expect(await dispatch(hiddenHarness, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  expect(await dispatch(hiddenHarness, { action: 'column', fieldId: 'TEXT', visible: false })).toEqual({ delivered: 1 })
  expect(hiddenContainer.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(await dispatch(hiddenHarness, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false })).toEqual({ delivered: 0 })
  localStorage.clear()

  const collapsedHarness = harness()
  const fixture = defaultFixture()
  fixture.view = { ...fixture.view, groupByFields: [STATUS] }
  addFixture(collapsedHarness, PROJECT, fixture)
  const collapsedContainer = await mount(collapsedHarness)
  expect(await dispatch(collapsedHarness, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: true })).toEqual({ delivered: 1 })
  expect(await dispatch(collapsedHarness, { action: 'group', group: 'TODO' })).toEqual({ delivered: 1 })
  expect(collapsedContainer.querySelector('input[aria-label="Notes"]')).toBeNull()
  expect(await dispatch(collapsedHarness, { action: 'edit', itemId: 'I1', fieldId: 'TEXT', open: false })).toEqual({ delivered: 0 })
})
