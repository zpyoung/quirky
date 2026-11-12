import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import type { TasksState } from '../src/contracts'

type Mount = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void
let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
let cleanup: (() => void) | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterEach(async () => {
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const state: TasksState = {
  revision: 1,
  navigation: { source: 'github', mode: 'prs', repoIds: null, query: '', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: '', page: 1 } },
  preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
  issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
  projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
  links: {}
}

async function mountTasks(initialState: TasksState = state, viewId = 'view:quirky.tasks/tasks') {
  const provided = new Map<string, unknown>()
  const calls: { method: string; params: unknown }[] = []
  let current = initialState
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params: unknown) {
      calls.push({ method, params })
      if (method === 'quirky.tasks/state' || method === 'quirky.tasks/prepare') return current
      if (method === 'quirky.tasks/navigate') {
        current = { ...current, revision: current.revision + 1, navigation: { ...current.navigation, ...(params as Partial<TasksState['navigation']>) } }
        return current
      }
      if (method === 'quirky.tasks/preferences') {
        current = { ...current, revision: current.revision + 1, preferences: { ...current.preferences, ...(params as Partial<TasksState['preferences']>) } }
        return current
      }
      if (method === 'ui.tool.open') return {}
      throw new Error('offline')
    },
    subscribe: () => () => {},
    toast() {},
    executeCommand: async () => undefined
  } as unknown as UiPluginContext
  activate(context)
  const element = document.createElement('div')
  document.body.append(element)
  await act(async () => {
    cleanup = (provided.get(viewId) as Mount)(element, {})
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  return { element, calls, current: () => current }
}

test('Tasks puts its mode tabs in the frame header next to one title and keeps them working', async () => {
  const { element, calls } = await mountTasks()
  const tabs = element.querySelector('.ui-tool-panel-frame__header [role="tablist"]')
  expect(tabs).not.toBeNull()
  expect([...element.querySelectorAll('h2')].filter((heading) => heading.textContent === 'Tasks')).toHaveLength(1)
  expect(element.querySelector('.ui-tool-panel-frame__body [role="tablist"]')).toBeNull()
  const issues = [...tabs!.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Issues'))!
  await act(async () => issues.click())
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toMatchObject({ mode: 'issues' })
})

test('Tasks puts Collapse in the frame actions, opens the tool on press and has no Minimize', async () => {
  const { element, calls } = await mountTasks()
  const actions = element.querySelector('.ui-tool-panel-frame__actions')!
  const collapse = [...actions.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === 'Collapse Tasks')!
  expect(collapse).toBeDefined()
  expect([...element.querySelectorAll('button')].some((button) => button.getAttribute('aria-label') === 'Minimize Tasks')).toBe(false)
  await act(async () => collapse.click())
  expect(calls.find((call) => call.method === 'ui.tool.open')?.params).toEqual({ id: 'sidebar-section:quirky.tasks/tasks' })
})

test('collapsing from Projects keeps Projects selected when the expanded tab opens again', async () => {
  const projectsState = { ...state, navigation: { ...state.navigation, mode: 'projects' as const } }
  const first = await mountTasks(projectsState)
  const collapse = first.element.querySelector<HTMLButtonElement>('.ui-tool-panel-frame__actions button[aria-label="Collapse Tasks"]')!
  await act(async () => collapse.click())
  expect(first.calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(first.current().navigation.mode).toBe('projects')

  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
  const reopened = await mountTasks(first.current())
  const projectsTab = [...reopened.element.querySelectorAll('.ui-tool-panel-frame__header [role="tab"]')].find((tab) => tab.textContent?.trim() === 'Projects')
  expect(projectsTab?.getAttribute('aria-selected')).toBe('true')
})

test('Task Sources keeps the Show Tasks button preference available', async () => {
  const { element, calls } = await mountTasks(state, 'view:quirky.tasks/settings')
  const setting = element.querySelector<HTMLInputElement>('.tasks-settings input[type="checkbox"]')!
  expect(setting.checked).toBe(true)
  const { promise: preferenceSaved, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  await act(async () => { setting.click(); await preferenceSaved })
  expect(calls.find((call) => call.method === 'quirky.tasks/preferences')?.params).toEqual({ showTasksButton: false })
  expect(setting.checked).toBe(false)
})
