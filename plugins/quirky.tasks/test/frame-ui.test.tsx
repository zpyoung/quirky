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

async function mountTasks(
  initialState: TasksState = state,
  viewId = 'view:quirky.tasks/tasks',
  options: { preferenceError?: Error } = {},
) {
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
        if (options.preferenceError) throw options.preferenceError
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
function inlineCheckbox(container: ParentNode, id: string, label: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)
  expect(input?.type).toBe('checkbox')
  expect(input?.classList.contains('ui-checkbox__input')).toBe(true)
  expect(input?.getAttribute('aria-label')).toBe(label)
  const row = input?.closest('.ui-form-row')
  expect(row?.classList.contains('ui-form-row--inline')).toBe(true)
  const visibleLabel = row?.querySelector<HTMLLabelElement>(`.ui-form-row__label[for="${id}"]`)
  expect(visibleLabel?.textContent).toBe(label)
  return { input: input!, label: visibleLabel! }
}

async function clickAndSettle(element: HTMLElement) {
  const { promise, resolve } = Promise.withResolvers<void>()
  await act(async () => {
    element.click()
    setTimeout(resolve, 20)
    await promise
  })
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

test('Task Sources keeps the Show Tasks button preference available through its native label', async () => {
  const { element, calls } = await mountTasks(state, 'view:quirky.tasks/settings')
  const setting = inlineCheckbox(element, 'tasks-show-button', 'Show Tasks button')
  expect(setting.input.checked).toBe(true)
  await clickAndSettle(setting.label)
  expect(calls.filter((call) => call.method === 'quirky.tasks/preferences').map((call) => call.params)).toEqual([
    { showTasksButton: false },
  ])
  const saveIndex = calls.findIndex((call) => call.method === 'quirky.tasks/preferences')
  expect(calls[saveIndex + 1]).toEqual({ method: 'quirky.tasks/state', params: {} })
  expect(setting.input.checked).toBe(false)
})

test('Task provider checkboxes save exact visible-provider booleans and protect the last provider', async () => {
  const { element, calls, current } = await mountTasks(state, 'view:quirky.tasks/settings')
  const github = inlineCheckbox(element, 'tasks-provider-github', 'GitHub')
  expect(github.input.checked).toBe(true)
  expect(github.input.disabled).toBe(true)
  await act(async () => {
    github.label.click()
    github.input.focus()
    github.input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    github.input.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
  })
  expect(github.input.checked).toBe(true)
  expect(calls.filter((call) => call.method === 'quirky.tasks/preferences')).toHaveLength(0)

  const gitlab = inlineCheckbox(element, 'tasks-provider-gitlab', 'GitLab')
  expect(gitlab.input.checked).toBe(false)
  await clickAndSettle(gitlab.label)
  expect(gitlab.input.checked).toBe(true)
  await clickAndSettle(gitlab.label)
  expect(gitlab.input.checked).toBe(false)
  expect(calls.filter((call) => call.method === 'quirky.tasks/preferences').map((call) => call.params)).toEqual([
    { visibleTaskProviders: ['github', 'gitlab'] },
    { visibleTaskProviders: ['github'] },
  ])
  expect(current().preferences.visibleTaskProviders).toEqual(['github'])
})

test('rejected Task provider checkbox saves retain the current provider set and show an error', async () => {
  const { element, calls, current } = await mountTasks(state, 'view:quirky.tasks/settings', {
    preferenceError: new Error('Preferences are read-only.'),
  })
  const gitlab = inlineCheckbox(element, 'tasks-provider-gitlab', 'GitLab')
  await clickAndSettle(gitlab.label)

  expect(calls.filter((call) => call.method === 'quirky.tasks/preferences').map((call) => call.params)).toEqual([
    { visibleTaskProviders: ['github', 'gitlab'] },
  ])
  expect(gitlab.input.checked).toBe(false)
  expect(current().preferences.visibleTaskProviders).toEqual(['github'])
  expect([...element.querySelectorAll('.ui-inline-error__message')].some((message) => message.textContent === 'Preferences are read-only.')).toBe(true)
})
