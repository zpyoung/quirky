import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ProjectTarget, TasksState } from '../src/contracts'
import type { activate as Activate } from '../src/ui'
import { ProjectsSurface } from '../src/projects/ProjectsSurface'
import { projectIdentity, projectViewIdentity } from '../src/projects/model'
import {
  PROJECTS_CONTROL_COMMAND,
  parseProjectsControlRequest,
  projectsControlDescriptor,
  registerProjectsControl,
  requestProjectsControl,
  runProjectsControl
} from '../src/projects/control'

type Handler = (params: Record<string, unknown>) => unknown
type Harness = {
  context: Record<string, unknown>
  calls: Array<{ method: string; params: Record<string, unknown> }>
  commands: Array<{ id: string; args: unknown }>
  toasts: Array<{ title: string; detail?: string }>
  logs: string[]
  handlers: Map<string, Handler>
  provided: Map<string, (input: unknown) => unknown>
  connections: Set<(status: 'connected' | 'reconnecting') => void>
}

let createRoot: (element: HTMLElement) => Root
let activate: typeof Activate
const mounted: Array<{ root: Root; container: HTMLElement }> = []
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT

beforeAll(async () => {
  GlobalRegistrator.register()
  // React DOM binds its scheduler at import, so happy-dom has to be registered first.
  createRoot = (await import('react-dom/client')).createRoot
  // ui imports React DOM, so loading it before registration disables input events.
  activate = (await import('../src/ui')).activate
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
  localStorage.clear()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const PROJECT: ProjectTarget = { id: 'PVT_1', owner: 'acme', ownerType: 'organization', number: 4, url: 'https://github.com/orgs/acme/projects/4', host: 'github.com', title: 'Roadmap' }
const STATUS = { id: 'PVTF_STATUS', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'OPT_TODO', name: 'Todo' }, { id: 'OPT_DONE', name: 'Done' }] }
const VIEW = { id: 'V1', number: 1, name: 'Table', layout: 'TABLE', fields: [STATUS] }
const ITEM = {
  id: 'PVTI_1',
  content: { kind: 'issue', number: 7, title: 'Improve project table', repository: 'acme/quirky', url: 'https://github.com/acme/quirky/issues/7' },
  fieldValues: [{ fieldId: 'PVTF_STATUS', value: { singleSelectOptionId: 'OPT_TODO' } }]
}
const TABLE = { result: { view: VIEW, layout: 'TABLE', fields: [STATUS], items: [ITEM], totalCount: 1 } }

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

function harness(): Harness {
  const h: Harness = { context: {}, calls: [], commands: [], toasts: [], logs: [], handlers: new Map(), provided: new Map(), connections: new Set() }
  h.context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      h.calls.push({ method, params })
      const handler = h.handlers.get(method)
      if (!handler) throw new Error('offline')
      return await handler(params)
    },
    async executeCommand(id: string, args?: unknown) { h.commands.push({ id, args }) },
    toast(title: string, detail?: string) { h.toasts.push({ title, ...(detail === undefined ? {} : { detail }) }) },
    log(message: string) { h.logs.push(message) },
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      h.connections.add(listener)
      return () => { h.connections.delete(listener) }
    },
    provide(id: string, implementation: (input: unknown) => unknown) { h.provided.set(id, implementation) }
  }
  return h
}

function never(): Promise<never> {
  return new Promise<never>(() => {})
}

function projectView(handlers: { list?: Handler; load?: Handler; select?: Handler }): Handler {
  return (params) => {
    const action = String(params.action)
    const handler = action === 'list' ? handlers.list : action === 'select' ? handlers.select : handlers.load
    if (!handler) throw new Error(`no ${action}`)
    return handler(params)
  }
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

function count(h: Harness, method: string, action?: string): number {
  return h.calls.filter((call) => call.method === method && (action === undefined || call.params.action === action)).length
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.ownerDocument.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute('aria-label') === text)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${JSON.stringify(text)}`)
  return found
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click())
  await settle()
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

function controlArgs(h: Harness): unknown[] {
  return h.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params.args)
}

function windowHandlers(h: Harness): void {
  h.handlers.set('ui.window.self', () => ({ connId: 7 }))
  h.handlers.set('ui.window.command.run', (params) => runProjectsControl(h.context as never, params.args))
}

const loaded = () => projectView({ list: () => ({ views: [VIEW] }), load: () => TABLE })

test('1. views loading draws one NoticeLine', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', projectView({ list: never }))
  const container = await mount(h)
  expect(container.querySelectorAll('[role="status"] .ui-notice-line').length).toBe(1)
  expect(container.querySelector('[role="status"] .ui-notice-line .ui-notice-line__text')?.textContent).toBe('Loading project views…')
})

test('2. a failed views read is one scoped InlineError with Retry and Open in GitHub', async () => {
  const h = harness()
  let lists = 0
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => { lists += 1; if (lists === 1) throw new Error('GitHub timed out.'); return never() } }))
  const container = await mount(h)
  expect(container.querySelectorAll('.ui-inline-error[role="alert"]').length).toBe(1)
  expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not load this GitHub project. GitHub timed out.')
  expect([...container.querySelectorAll('.ui-inline-error__action')].map((node) => node.textContent)).toEqual(['Retry'])
  expect(button(container, 'Open in GitHub')).toBeDefined()
  expect(container.textContent).not.toContain('No views found.')
  expect(container.querySelector('.ui-empty-state')).toBeNull()
  const retry = container.querySelector<HTMLButtonElement>('.ui-inline-error__action')!
  await click(retry)
  expect(lists).toBe(2)
  await click(button(container, 'Open in GitHub'))
  expect(h.commands).toEqual([{ id: 'command:quirky.tasks/open-link', args: { url: PROJECT.url } }])
})

test('2b. Not Found uses the removed-project copy', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => { throw new Error('Not Found') } }))
  const container = await mount(h)
  expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not find this project or view. It may have been removed, moved, or is not visible to the current GitHub account.')
})

test('3. zero views renders exactly one EmptyState and no error', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [] }) }))
  const container = await mount(h)
  expect([...container.querySelectorAll('.ui-empty-state__message')].map((node) => node.textContent)).toEqual(['No views found.'])
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('4. table loading keeps its skeleton and adds a NoticeLine first', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [VIEW] }), load: never }))
  const container = await mount(h)
  const loading = container.querySelector('.quirky-tasks-projects__skeletons[role="status"][aria-label="Loading project view"]')
  expect(loading?.querySelectorAll('.quirky-tasks-projects__skeleton').length).toBe(6)
  expect(loading?.firstElementChild?.classList.contains('ui-notice-line')).toBe(true)
  expect(loading?.firstElementChild?.textContent).toBe('Loading project items…')
})

test('5. an empty view keeps the existing EmptyState', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [VIEW] }), load: () => ({ result: { ...TABLE.result, items: [], totalCount: 0 } }) }))
  const container = await mount(h)
  expect(container.querySelector('.quirky-tasks-projects__empty-state[role="status"] .ui-empty-state__message')?.textContent).toBe('This view has no items yet. Recently added items can take a while to appear.')
})

test('6. a refresh failure keeps rows and shows a retry advisory, not InlineError', async () => {
  const h = harness()
  let fail = false
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [VIEW] }), load: () => { if (fail) throw new Error('temporary Project refresh failure'); return TABLE } }))
  const container = await mount(h)
  fail = true
  await click(button(container, 'Refresh project'))
  expect(container.querySelector('tbody tr')).not.toBeNull()
  expect(container.querySelector('[role="status"] .ui-notice-line__text')?.textContent).toBe("Couldn't load the latest items. Showing the last loaded items. temporary Project refresh failure")
  expect(container.querySelector('.ui-notice-line__action')?.textContent).toBe('Retry')
  expect(container.querySelector('.ui-inline-error')).toBeNull()
})

test('7. a failed field write is one InlineError with the rollback announcement', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', loaded())
  h.handlers.set('quirky.tasks/projectEdit', () => { throw new Error('board clear refused') })
  const container = await mount(h)
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'OPT_DONE')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(container.querySelectorAll('[role="alert"]').length).toBe(1)
  expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Project field update was rolled back locally; GitHub did not confirm the change. board clear refused')
  expect(container.querySelector('.quirky-tasks-projects__warning')).toBeNull()
})

test('8. missing scopes use InlineError with auth help outside the alert', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => { throw Object.assign(new Error('gh: missing scope project'), { data: { reason: 'scope_missing', host: 'github.com' } }) } }))
  const container = await mount(h)
  expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('GitHub Projects access is missing for github.com.')
  expect(container.querySelector('.ui-inline-error__action')?.textContent).toBe('Reload')
  expect(container.querySelector('.quirky-tasks-projects__auth-help')?.hasAttribute('role')).toBe(false)
  await click(button(container, 'Copy refresh command'))
  expect(h.commands).toContainEqual({ id: 'command:quirky.tasks/copy-text', args: { text: 'gh auth refresh -s project -s read:org -s repo' } })
  expect(h.toasts).toContainEqual({ title: 'Command copied', detail: 'Paste the GitHub command into a terminal.' })
})

test('9. issue type read failures toast instead of replacing the project', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', loaded())
  h.handlers.set('quirky.tasks/projectEdit', () => { throw new Error('gh failed') })
  const container = await mount(h)
  await click(button(container, 'Load issue types'))
  expect(h.toasts).toEqual([{ title: 'Could not load issue types', detail: 'gh failed' }])
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('10. a failed view switch toasts and restores the selected view and rows', async () => {
  const h = harness()
  const board = { id: 'V2', number: 2, name: 'Board', layout: 'BOARD', fields: [STATUS] }
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [VIEW, board] }), load: () => TABLE, select: () => { throw new Error('denied') } }))
  const container = await mount(h)
  const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) => candidate.textContent?.includes('Board'))!
  await click(tab)
  expect(h.toasts).toEqual([{ title: 'Could not switch project views', detail: 'denied' }])
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector('tbody tr')).not.toBeNull()
  expect([...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) => candidate.textContent?.includes('Table'))?.getAttribute('aria-selected')).toBe('true')
})

test('11. browsing projects shows a loading NoticeLine in the picker', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projects', never)
  const container = await mount(h, tasksState(null))
  await click(button(container, 'Choose a project'))
  await click(button(container, 'Browse all'))
  expect([...document.querySelectorAll('[role="dialog"] .ui-notice-line__text')].map((node) => node.textContent)).toContain('Loading projects…')
  expect(button(container, 'Browse all').textContent).toBe('Browse all')
})

test('12. a failed browse appears once as an InlineError inside the open picker', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projects', () => { throw new Error('rate limited') })
  const container = await mount(h, tasksState(null))
  await click(button(container, 'Choose a project'))
  await click(button(container, 'Browse all'))
  expect(document.querySelectorAll('.ui-inline-error').length).toBe(1)
  expect(document.querySelector('[role="dialog"] .ui-inline-error__message')?.textContent).toBe('Could not list GitHub projects. rate limited')
  expect(document.querySelectorAll('.quirky-tasks-projects__error-card').length).toBe(1)
  expect(container.querySelector('main > [role="alert"]')).toBeNull()
})

test('13. an empty partial browse uses EmptyState and advisory NoticeLine, then filters it', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projects', () => ({ projects: [], partialFailures: [{ owner: 'acme' }] }))
  const container = await mount(h, tasksState(null))
  await click(button(container, 'Choose a project'))
  await click(button(container, 'Browse all'))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect([...dialog.querySelectorAll('.ui-empty-state__message')].map((node) => node.textContent)).toEqual(['No additional projects were found. Add a project URL or owner/number below.'])
  expect(dialog.querySelector('.ui-empty-state')?.closest('[role="status"]')).not.toBeNull()
  expect([...dialog.querySelectorAll('.ui-notice-line__text')].map((node) => node.textContent)).toContain('Some organization projects could not be listed. Paste a project URL below to reach missing ones.')
  await changeInput(dialog.querySelector<HTMLInputElement>('input[placeholder="Search projects"]')!, 'zzz')
  expect(dialog.querySelector('.ui-empty-state__message')?.textContent).toBe('No projects match this search.')
  expect(dialog.querySelector('.ui-empty-state')?.closest('[role="status"]')).not.toBeNull()
})

test('14. Start work is busy from the click and guards duplicate repository matching', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', loaded())
  h.handlers.set('quirky.repo/list', never)
  const container = await mount(h)
  const start = button(container, 'Start work on Improve project table')
  await click(start)
  await click(start)
  expect(start.disabled).toBe(true)
  expect(start.textContent).toBe('Starting…')
  expect(count(h, 'quirky.repo/list')).toBe(1)
})

test('14b. interleaved row starts stay busy independently through workspace completion', async () => {
  const h = harness()
  const second = { ...ITEM, id: 'PVTI_2', content: { ...ITEM.content, number: 8, title: 'Second project item', url: 'https://github.com/acme/quirky/issues/8' } }
  h.handlers.set('quirky.tasks/projectView', projectView({
    list: () => ({ views: [VIEW] }),
    load: () => ({ result: { ...TABLE.result, items: [ITEM, second], totalCount: 2 } })
  }))
  const matching = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
  const workspaces = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
  const startedNumbers: number[] = []
  h.handlers.set('quirky.repo/list', () => matching[count(h, 'quirky.repo/list') - 1].promise)
  h.handlers.set('quirky.worktree/list', () => [{ id: 'wt-1', repoId: 'repo-1', isMain: true }])
  h.handlers.set('quirky.hosting/repository', () => ({ origin: { host: 'github.com', owner: 'acme', repo: 'quirky' } }))
  h.handlers.set('quirky.tasks/workspace', (params) => {
    const target = params.target as { number: number }
    startedNumbers.push(target.number)
    return workspaces[target.number === 7 ? 0 : 1].promise
  })
  const container = await mount(h)
  const firstStart = button(container, 'Start work on Improve project table')
  const secondStart = button(container, 'Start work on Second project item')
  await click(firstStart)
  await click(secondStart)
  expect(firstStart.disabled).toBe(true)
  expect(secondStart.disabled).toBe(true)
  await click(firstStart)
  expect(count(h, 'quirky.repo/list')).toBe(2)
  const repositories = [{ id: 'repo-1', kind: 'git', path: '/src/quirky', name: 'quirky' }]
  await act(async () => matching[1].resolve(repositories))
  await settle()
  await act(async () => matching[0].resolve(repositories))
  await settle()
  expect(startedNumbers).toEqual([8, 7])
  await act(async () => workspaces[1].resolve({ kind: 'composer' }))
  await settle()
  expect(firstStart.disabled).toBe(true)
  expect(secondStart.disabled).toBe(false)
  await click(firstStart)
  expect(count(h, 'quirky.repo/list')).toBe(2)
  expect(count(h, 'quirky.tasks/workspace')).toBe(2)
  await act(async () => workspaces[0].resolve({ kind: 'composer' }))
  await settle()
  expect(firstStart.disabled).toBe(false)
  expect(secondStart.disabled).toBe(false)
})

test('15. opening an item reports progress until its preview opens', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', loaded())
  const matching = Promise.withResolvers<unknown>()
  h.handlers.set('quirky.repo/list', () => matching.promise)
  const container = await mount(h)
  await click(container.querySelector<HTMLButtonElement>('.quirky-tasks-project-table__title')!)
  expect([...container.querySelectorAll('[role="status"] .ui-notice-line__text')].map((node) => node.textContent)).toContain('Opening Improve project table…')
  await act(async () => matching.resolve([]))
  await settle()
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  expect([...container.querySelectorAll('[role="status"] .ui-notice-line__text')].map((node) => node.textContent)).not.toContain('Opening Improve project table…')
})

test('16. action failures render InlineError but repository-selection guidance stays plain text', async () => {
  const h = harness()
  h.handlers.set('quirky.tasks/projectView', loaded())
  h.handlers.set('quirky.repo/list', () => [{ id: 'repo-1', kind: 'git', path: '/src/quirky', name: 'quirky' }])
  h.handlers.set('quirky.worktree/list', () => [{ id: 'wt-1', repoId: 'repo-1', isMain: true }])
  h.handlers.set('quirky.hosting/repository', () => ({ origin: { host: 'github.com', owner: 'acme', repo: 'quirky' } }))
  h.handlers.set('quirky.tasks/workspace', () => { throw new Error('disk full') })
  const container = await mount(h)
  await click(button(container, 'Start work on Improve project table'))
  expect(document.querySelector('[role="dialog"] .ui-inline-error__message')?.textContent).toBe('Could not start work: disk full')
  await unmount(container)

  const many = harness()
  many.handlers.set('quirky.tasks/projectView', loaded())
  many.handlers.set('quirky.repo/list', () => [
    { id: 'repo-1', kind: 'git', path: '/src/one', name: 'one' },
    { id: 'repo-2', kind: 'git', path: '/src/two', name: 'two' }
  ])
  many.handlers.set('quirky.worktree/list', (params) => [{ id: `wt-${String(params.repo)}`, repoId: params.repo, isMain: true }])
  many.handlers.set('quirky.hosting/repository', () => ({ origin: { host: 'github.com', owner: 'acme', repo: 'quirky' } }))
  const multipleContainer = await mount(many)
  await click(button(multipleContainer, 'Start work on Improve project table'))
  const guidance = document.querySelector('[role="dialog"]')!
  expect(guidance.textContent).toContain('This item matches multiple selected repositories. Select one repository before starting work.')
  expect(guidance.querySelector('.ui-inline-error')).toBeNull()
})

test('17. preview loading and detail failure are notices, not InlineErrors', async () => {
  const pullRequest = { id: 'PVTI_8', content: { kind: 'pullRequest', number: 8, title: 'Ship board', repository: 'acme/quirky', url: 'https://github.com/acme/quirky/pull/8' }, fieldValues: [] }
  const makeHarness = () => {
    const h = harness()
    h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [VIEW] }), load: () => ({ result: { ...TABLE.result, items: [pullRequest], totalCount: 1 } }) }))
    h.handlers.set('quirky.repo/list', () => [{ id: 'repo-1', kind: 'git', path: '/src/quirky', name: 'quirky' }])
    h.handlers.set('quirky.worktree/list', () => [{ id: 'wt-1', repoId: 'repo-1', isMain: true }])
    h.handlers.set('quirky.hosting/repository', () => { throw new Error('offline') })
    return h
  }
  const loading = makeHarness()
  loading.handlers.set('quirky.hosting/projectItemDetails', never)
  const loadingContainer = await mount(loading)
  await click(loadingContainer.querySelector<HTMLButtonElement>('.quirky-tasks-project-table__title')!)
  expect([...document.querySelectorAll('[role="dialog"] [role="status"] .ui-notice-line__text')].map((node) => node.textContent)).toEqual([
    'Repository matching is still updating; showing the exact Project item instead.',
    'Loading GitHub item details…'
  ])
  await unmount(loadingContainer)

  const failed = makeHarness()
  failed.handlers.set('quirky.hosting/projectItemDetails', () => { throw new Error('gh failed') })
  const failedContainer = await mount(failed)
  await click(failedContainer.querySelector<HTMLButtonElement>('.quirky-tasks-project-table__title')!)
  expect([...document.querySelectorAll('[role="dialog"] [role="status"] .ui-notice-line__text')].map((node) => node.textContent)).toEqual([
    'Repository matching is still updating; showing the exact Project item instead. Could not load additional GitHub details: gh failed'
  ])
  expect(failedContainer.querySelector('[role="dialog"] .ui-inline-error')).toBeNull()
})

test('18. picker clicks resolve the current window each time and reopening clears browse errors', async () => {
  const h = harness()
  windowHandlers(h)
  h.handlers.set('quirky.tasks/projectView', loaded())
  h.handlers.set('quirky.tasks/projects', () => { throw new Error('rate limited') })
  const container = await mount(h)
  await click(button(container, 'Roadmap'))
  await click(button(container, 'Browse all'))
  expect(document.querySelector('[role="dialog"] .ui-inline-error')).not.toBeNull()
  await click(button(container, 'Roadmap'))
  await click(button(container, 'Roadmap'))
  expect(document.querySelector('[role="dialog"] .ui-inline-error')).toBeNull()
  expect(controlArgs(h)).toEqual([
    { action: 'picker', open: true },
    { action: 'picker', open: false },
    { action: 'picker', open: true }
  ])
  expect(count(h, 'ui.window.self')).toBe(3)
  await unmount(container)

  const noProject = harness()
  windowHandlers(noProject)
  const empty = await mount(noProject, tasksState(null))
  await click(button(empty, 'Choose a project'))
  expect(controlArgs(noProject)).toEqual([{ action: 'picker', open: true }])
  expect(noProject.calls.find((call) => call.method === 'ui.window.command.run')?.params).toEqual({ connId: 7, id: PROJECTS_CONTROL_COMMAND, args: { action: 'picker', open: true } })
  expect(empty.querySelector('[role="dialog"]')?.textContent).toContain('Choose a project')
})

test('18b. a retained Projects mount routes only to its current window after connection ID reuse', async () => {
  const h = harness()
  let connId = 7
  let foreignDeliveries = 0
  const other = {} as never
  const stop = registerProjectsControl(other, () => { foreignDeliveries += 1; return true })
  h.handlers.set('ui.window.self', () => ({ connId }))
  h.handlers.set('ui.window.command.run', (params) => {
    if (params.connId === connId) return runProjectsControl(h.context as never, params.args)
    if (params.connId === 7) return runProjectsControl(other, params.args)
    throw new Error('No window')
  })
  try {
    const container = await mount(h, tasksState(null))
    await click(button(container, 'Choose a project'))
    await click(button(container, 'Close dialog'))
    for (const listener of h.connections) listener('reconnecting')
    connId = 22
    for (const listener of h.connections) listener('connected')
    await click(button(container, 'Choose a project'))
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(foreignDeliveries).toBe(0)
    expect(h.calls.filter((entry) => entry.method === 'ui.window.command.run').map((entry) => entry.params.connId)).toEqual([7, 22])
    expect(h.logs).toEqual([])
  } finally {
    stop()
  }
})

test('19. a failed window command falls back locally and logs the failure', async () => {
  const h = harness()
  h.handlers.set('ui.window.self', () => ({ connId: 7 }))
  h.handlers.set('ui.window.command.run', () => { throw new Error('No window') })
  const container = await mount(h, tasksState(null))
  await click(button(container, 'Choose a project'))
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Choose a project')
  expect(h.logs).toEqual(['tasks: projects control failed: No window'])
})

test('20. column settings, visibility, and width route and preserve the local layout format', async () => {
  const h = harness()
  windowHandlers(h)
  h.handlers.set('quirky.tasks/projectView', loaded())
  const container = await mount(h)
  await click(button(container, 'Configure columns'))
  expect(controlArgs(h)).toEqual([{ action: 'column-panel', open: true }])
  const fieldset = container.querySelector('fieldset')!
  expect(fieldset.querySelector('legend')?.textContent).toBe('Configure columns')
  const statusCheckbox = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes('Status'))!
  await click(statusCheckbox)
  expect(controlArgs(h)[1]).toEqual({ action: 'column', fieldId: 'PVTF_STATUS', visible: false })
  expect([...container.querySelectorAll('th button')].some((candidate) => candidate.textContent === 'Status')).toBe(false)
  const columnsKey = `quirky.tasks.projects.columns.${projectViewIdentity(PROJECT, 'V1')}`
  expect(JSON.parse(localStorage.getItem(columnsKey) ?? 'null')).toEqual({ hidden: ['PVTF_STATUS'], widths: {} })
  const width = container.querySelector<HTMLInputElement>('input[aria-label="Status column width"]')!
  await changeInput(width, '200')
  expect(controlArgs(h)[2]).toEqual({ action: 'column', fieldId: 'PVTF_STATUS', width: 200 })
  expect(count(h, 'ui.window.self')).toBe(3)
})

test('21. Back from the chooser routes to the picker', async () => {
  const h = harness()
  windowHandlers(h)
  h.handlers.set('quirky.tasks/projectView', projectView({ list: () => ({ views: [VIEW] }) }))
  const container = await mount(h, tasksState(PROJECT, null))
  expect(container.textContent).toContain('Choose a view')
  await click(button(container, '← Back'))
  expect(controlArgs(h)).toEqual([{ action: 'back-to-picker' }])
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Choose a project')
  expect(container.textContent).not.toContain('Choose a view')
  expect(container.querySelector('.ui-empty-state__message')?.textContent).toBe('Choose a project view to load its items.')
})

test('22. window dispatch delivers only to matching mounted views and cleans registrations on unmount', async () => {
  const h = harness()
  const context = h.context as never
  h.handlers.set('quirky.tasks/projectView', loaded())
  async function dispatch(request: unknown) {
    let result = { delivered: 0 }
    await act(async () => { result = runProjectsControl(context, request) })
    return result
  }
  const one = await mount(h)
  expect(await dispatch({ action: 'column-panel', open: true })).toEqual({ delivered: 1 })
  expect(one.querySelector('fieldset legend')?.textContent).toBe('Configure columns')
  expect(await dispatch({ action: 'column', fieldId: 'PVTF_NOPE', visible: false })).toEqual({ delivered: 0 })
  expect(await dispatch({ action: 'back-to-picker' })).toEqual({ delivered: 0 })
  await unmount(one)
  expect(await dispatch({ action: 'picker', open: true })).toEqual({ delivered: 0 })

  const first = await mount(h)
  const second = await mount(h)
  expect(await dispatch({ action: 'picker', open: true })).toEqual({ delivered: 2 })
  expect(first.querySelector('[role="dialog"]')).not.toBeNull()
  expect(second.querySelector('[role="dialog"]')).not.toBeNull()
  await unmount(first)
  expect(await dispatch({ action: 'picker', open: false })).toEqual({ delivered: 1 })
  await unmount(second)
  expect(await dispatch({ action: 'picker', open: true })).toEqual({ delivered: 0 })
})

test('23. project control rejects malformed requests and unidentified windows', async () => {
  const invalidAction = 'projects-control needs an action of picker, column-panel, back-to-picker or column.'
  for (const input of [{}, null, { action: 'sort' }]) expect(() => parseProjectsControlRequest(input)).toThrow(invalidAction)
  expect(() => parseProjectsControlRequest({ action: 'picker', open: 'yes' })).toThrow('projects-control open must be a boolean.')
  const invalidColumn = 'projects-control column needs a fieldId and a visible boolean or a width from 60 to 800.'
  for (const input of [
    { action: 'column', fieldId: 'PVTF_STATUS' },
    { action: 'column', fieldId: '', visible: true },
    { action: 'column', fieldId: 'PVTF_STATUS', width: 59 }
  ]) expect(() => parseProjectsControlRequest(input)).toThrow(invalidColumn)
  expect(() => parseProjectsControlRequest({ action: 'column', fieldId: 'title', visible: false })).toThrow('The Title column cannot be hidden.')
  expect(() => parseProjectsControlRequest({ action: 'back-to-picker', open: true })).toThrow('projects-control back-to-picker takes no other fields.')
  const h = harness()
  h.handlers.set('ui.window.self', () => ({}))
  await expect(requestProjectsControl(h.context as never, { action: 'picker', open: true })).rejects.toThrow('The daemon did not identify this window.')
})

test('24. activation provides the command and its descriptor keeps the public command shape', () => {
  const h = harness()
  activate(h.context as never)
  expect(h.provided.has(PROJECTS_CONTROL_COMMAND)).toBe(true)
  expect(h.provided.get(PROJECTS_CONTROL_COMMAND)?.({ action: 'picker', open: true })).toEqual({ delivered: 0 })
  expect(projectsControlDescriptor({ action: 'picker', open: false })).toEqual({
    command: 'command:quirky.tasks/projects-control',
    args: { action: 'picker', open: false }
  })
})
