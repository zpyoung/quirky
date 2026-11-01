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

async function mountTasks() {
  const provided = new Map<string, unknown>()
  const calls: { method: string; params: unknown }[] = []
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params: unknown) {
      calls.push({ method, params })
      if (method === 'quirky.tasks/state') return state
      if (method === 'quirky.tasks/navigate') return state
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
    cleanup = (provided.get('view:quirky.tasks/tasks') as Mount)(element, {})
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  return { element, calls }
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
