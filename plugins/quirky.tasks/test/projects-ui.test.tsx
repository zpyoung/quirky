import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TasksState } from '../src/contracts'
import { ProjectsSurface } from '../src/projects/ProjectsSurface'
import { bootTasks, type TasksTest } from './helpers'
import { PROJECTS_GH_FIXTURE, seedProjectsState, type ProjectFixtureState } from './fixtures/projects'

type ApiCall = (method: string, params: Record<string, unknown>, forward: () => Promise<unknown>) => Promise<unknown>
type Mounted = { host: TasksTest; container: HTMLDivElement; root: Root; toasts: Array<{ title: string; message?: string }> }

const mounts: Mounted[] = []
const temporaryRepositories: string[] = []
const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT

beforeAll(() => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  try {
    for (const mounted of mounts.splice(0).reverse()) {
      await act(async () => mounted.root.unmount())
      await mounted.host.cleanup()
    }
  } finally {
    for (const path of temporaryRepositories.splice(0)) rmSync(path, { recursive: true, force: true })
  }
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array')
  return value
}

async function mountProjects(options: { state?: ProjectFixtureState; viewId?: string; intercept?: ApiCall } = {}): Promise<Mounted> {
  const host = await bootTasks(PROJECTS_GH_FIXTURE)
  const container = document.createElement('div')
  const mounted: Mounted = { host, container, root: createRoot(container), toasts: [] }
  mounts.push(mounted)
  host.writeState(options.state ?? seedProjectsState())
  await host.call('projectSelect', { action: 'add', input: 'https://github.com/orgs/test-owner/projects/4' })
  await host.call('projectView', { action: 'select', viewId: options.viewId ?? 'VIEW_TABLE' })
  const state = await host.call('state') as TasksState
  const context = {
    call(method: string, params: Record<string, unknown> = {}) {
      const forward = () => host.client.callAny(method, params)
      return options.intercept ? options.intercept(method, params, forward) : forward()
    },
    async executeCommand() { return undefined },
    toast(title: string, message?: string) { mounted.toasts.push({ title, ...(message === undefined ? {} : { message }) }) }
  } as unknown as UiPluginContext
  await act(async () => mounted.root.render(<ProjectsSurface context={context} state={state} refresh={async () => {}} />))
  await waitFor(() => mounted.container.querySelector('tbody tr') !== null, 'initial Project table')
  return mounted
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (predicate()) return
    const { promise, resolve } = Promise.withResolvers<void>()
    await act(async () => {
      setImmediate(resolve)
      await promise
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function clickButton(container: HTMLElement, text: string): Promise<HTMLButtonElement> {
  const target = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text))
  if (!target) throw new Error(`button containing ${JSON.stringify(text)} was not rendered`)
  await act(async () => target.click())
  return target
}

function projectStatus(container: HTMLElement): HTMLSelectElement {
  const row = [...container.querySelectorAll('tbody tr')].find((candidate) => candidate.textContent?.includes('Improve project table'))
  const select = row?.querySelector('select[aria-label="Status"]')
  if (!(select instanceof HTMLSelectElement)) throw new Error('Project issue status control was not rendered')
  return select
}

function boardMove(container: HTMLElement, title: string): HTMLSelectElement {
  const select = container.querySelector(`select[aria-label=${JSON.stringify(`Move ${title}`)}]`)
  if (!(select instanceof HTMLSelectElement)) throw new Error(`board move control for ${title} was not rendered`)
  return select
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (!setter) throw new Error('Select value setter is unavailable')
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function selectedTab(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent?.includes(label) && tab.getAttribute('aria-selected') === 'true')
}

function dialogByTitle(container: HTMLElement, title: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => {
    const labelledBy = dialog.getAttribute('aria-labelledby')
    return labelledBy !== null && [...dialog.querySelectorAll('h2')].some((heading) => heading.id === labelledBy && heading.textContent === title)
  }) ?? null
}

test('Project Start reports post-create outcomes truthfully and stays linked', async () => {
  const workspaceCalls: Record<string, unknown>[] = []
  const mounted = await mountProjects({ intercept: async (method, params, forward) => {
    if (method === 'quirky.tasks/workspace') {
      workspaceCalls.push(params)
      if (object(params.target).number === 9) return {
        kind: 'composer',
        requestId: 'composer-for-issue-9',
        setupDecisionRequired: true,
        blocked: true
      }
      if (params.action === 'start') return {
        kind: 'created',
        target: params.target,
        worktree: { id: 'workspace-7', repoId: 'repo-fixture', name: 'project-issue-7' },
        setup: { ran: 'none' },
        issueCommand: { ran: 'daemon', exitCode: 1 },
        warnings: ['The issue command failed after the workspace was created.'],
        agentSessionId: 'session-pending-7',
        agentPending: true,
        promptDelivery: 'pending'
      }
      return { kind: 'resumed', worktree: { id: 'workspace-7', repoId: 'repo-fixture', name: 'project-issue-7' } }
    }
    return forward()
  } })


  await clickButton(mounted.container, 'Start work on Improve project table')
  await waitFor(() => dialogByTitle(mounted.container, 'GitHub project item guidance')?.textContent?.includes('issue command failed') === true, 'post-create warning')
  const guidance = dialogByTitle(mounted.container, 'GitHub project item guidance')?.textContent?.toLowerCase() ?? ''
  expect(guidance).toContain('pending')
  expect(guidance).toContain('not been confirmed')
  expect(guidance).not.toContain('context delivered')
  expect(workspaceCalls.map((call) => call.action)).toEqual(['start'])

  await clickButton(mounted.container, 'Resume Improve project table')
  await waitFor(() => workspaceCalls.length === 2, 'resume of the created workspace')
  expect(workspaceCalls[1]).toMatchObject({ action: 'resume', target: { number: 7 } })
  expect(workspaceCalls[1]).not.toHaveProperty('newWorkspace')
  await clickButton(mounted.container, 'Start work on Undated project issue')
  await waitFor(() => mounted.toasts.some((toast) => toast.title === 'Workspace setup required'), 'setup decision composer fallback')
  expect(mounted.toasts.find((toast) => toast.title === 'Workspace setup required')?.message).toContain('setup script')
  expect(workspaceCalls[2]).toMatchObject({ action: 'start', target: { number: 9 } })
  expect(dialogByTitle(mounted.container, 'GitHub project item guidance')).toBeNull()
}, 60_000)

test('a delayed older UI selection response cannot replace a newer view or trigger another selection', async () => {
  let boardCallReturned = false
  let boardResponseReleased = false
  let roadmapSelections = 0
  const { promise: boardGate, resolve: releaseBoard } = Promise.withResolvers<void>()
  const mounted = await mountProjects({ intercept: async (method, params, forward) => {
    if (method === 'quirky.tasks/projectView' && params.action === 'select' && params.viewId === 'VIEW_BOARD') {
      const result = await forward()
      boardCallReturned = true
      await boardGate
      boardResponseReleased = true
      return result
    }
    if (method === 'quirky.tasks/projectView' && params.action === 'select' && params.viewId === 'VIEW_ROADMAP') roadmapSelections += 1
    return forward()
  } })

  await clickButton(mounted.container, 'Board · Board')
  await waitFor(() => boardCallReturned, 'Board selection response gate')
  await clickButton(mounted.container, 'Roadmap · Roadmap')
  await waitFor(() => selectedTab(mounted.container, 'Roadmap') && mounted.container.textContent?.includes('Placed by') === true, 'newer Roadmap view')
  releaseBoard()
  await waitFor(() => boardResponseReleased, 'late Board response release')

  expect(selectedTab(mounted.container, 'Roadmap')).toBe(true)
  expect(mounted.container.querySelector('[aria-label=\"Move Improve project table\"]')).toBeNull()
  expect(mounted.container.textContent).toContain('Placed by')
  expect(roadmapSelections).toBe(1)
  const prefs = object(await mounted.host.call('projectPreferences'))
  const stored = object(prefs.preferences ?? prefs)
  expect(Object.values(object(stored.lastViewByProject))).toContain('VIEW_ROADMAP')
}, 60_000)
test('Project query overrides remain isolated and survive switching views', async () => {
  let appliedTableQuery = false
  const mounted = await mountProjects({ intercept: async (method, params, forward) => {
    if (method === 'quirky.tasks/projectView' && params.action === 'load' && params.query === 'assignee:@me') {
      const result = await forward()
      appliedTableQuery = true
      return result
    }
    return forward()
  } })
  const search = mounted.container.querySelector('input[aria-label="Search project items"]')
  if (!(search instanceof HTMLInputElement)) throw new Error('Project search control was not rendered')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(search, 'assignee:@me')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await waitFor(() => appliedTableQuery, 'applied Table query')

  await clickButton(mounted.container, 'Board · Board')
  await waitFor(() => selectedTab(mounted.container, 'Board') && mounted.container.querySelector('[aria-label="Move Improve project table"]') !== null, 'Board view')
  const boardSearch = mounted.container.querySelector('input[aria-label="Search project items"]')
  if (!(boardSearch instanceof HTMLInputElement)) throw new Error('Board search control was not rendered')
  expect(boardSearch.value).not.toBe('assignee:@me')
  await clickButton(mounted.container, 'Table · Table')
  await waitFor(() => {
    const tableSearch = mounted.container.querySelector('input[aria-label="Search project items"]')
    return selectedTab(mounted.container, 'Table') && tableSearch instanceof HTMLInputElement && tableSearch.value === 'assignee:@me'
  }, 'restored Table query')
}, 60_000)

test('a failed earlier field edit cannot undo the later confirmed value across a lagging Project index', async () => {
  const earlierWrite = Promise.withResolvers<unknown>()
  let earlierStarted = false
  let laterWriteReturned = false
  let laggingReadReturned = false
  const mounted = await mountProjects({ state: seedProjectsState({ projectIndexLagging: true }), intercept: async (method, params, forward) => {
    if (method === 'quirky.tasks/projectEdit' && params.action === 'field' && params.clear === true && !earlierStarted) {
      earlierStarted = true
      return earlierWrite.promise
    }
    if (method === 'quirky.tasks/projectEdit' && params.action === 'field' && params.value !== undefined && object(params.value).singleSelectOptionId === 'OPT_DONE') {
      const result = await forward()
      laterWriteReturned = true
      return result
    }
    if (method === 'quirky.tasks/projectView' && params.action === 'load' && laterWriteReturned) {
      const result = await forward()
      laggingReadReturned = true
      return result
    }
    return forward()
  } })

  await changeSelect(projectStatus(mounted.container), '')
  await waitFor(() => earlierStarted && projectStatus(mounted.container).value === '', 'pending clear edit')
  await changeSelect(projectStatus(mounted.container), 'OPT_DONE')
  await waitFor(() => laggingReadReturned && projectStatus(mounted.container).value === 'OPT_DONE', 'confirmed later field edit over a lagging index')
  earlierWrite.reject(new Error('earlier clear failed'))
  const { promise, resolve } = Promise.withResolvers<void>()
  await act(async () => {
    setImmediate(resolve)
    await promise
  })
  expect(projectStatus(mounted.container).value).toBe('OPT_DONE')
  expect(mounted.container.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('earlier clear failed')
}, 60_000)

test('board moves clear into No Status and failed moves restore the confirmed column', async () => {
  let failClear = true
  let successfulWrites = 0
  const mounted = await mountProjects({ viewId: 'VIEW_BOARD', intercept: async (method, params, forward) => {
    if (method === 'quirky.tasks/projectEdit' && params.action === 'field' && params.clear === true && failClear) {
      failClear = false
      throw new Error('board clear refused')
    }
    if (method === 'quirky.tasks/projectEdit' && params.action === 'field') {
      const result = await forward()
      successfulWrites += 1
      return result
    }
    return forward()
  } })

  await changeSelect(boardMove(mounted.container, 'Improve project table'), 'OPT_DONE')
  await waitFor(() => successfulWrites === 1 && boardMove(mounted.container, 'Improve project table').value === 'OPT_DONE', 'move into Done')
  await changeSelect(boardMove(mounted.container, 'Improve project table'), '')
  await waitFor(() => mounted.container.querySelector('[role="alert"]')?.textContent?.includes('board clear refused') === true, 'visible board rollback error')
  expect(boardMove(mounted.container, 'Improve project table').value).toBe('OPT_DONE')

  await changeSelect(boardMove(mounted.container, 'Improve project table'), '')
  await waitFor(() => {
    const bucket = mounted.container.querySelector('[aria-label="No Status"]')
    return successfulWrites === 2 && bucket?.textContent?.includes('Improve project table') === true
  }, 'cleared item in No Status')
  const response = object(await mounted.host.call('projectView', { action: 'load', viewId: 'VIEW_BOARD' }))
  const table = object(response.result)
  const item = list(table.items).map(object).find((candidate) => candidate.id === 'PVTI_7')
  expect(item).toBeDefined()
  expect(list(item?.fieldValues).map(object).map((field) => field.fieldId)).not.toContain('PVTF_STATUS')
}, 60_000)

test('restricted Project rows stay read-only, refresh errors retain rows, and unknown sources offer repo addition', async () => {
  const state = seedProjectsState({
    resources: {
      projectItems: {
        'PVT_4/PVTI_RESTRICTED': {
          id: 'PVTI_RESTRICTED', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization',
          kind: 'issue', number: 10, title: 'Restricted issue', state: 'open', restricted: true,
          url: 'https://github.com/test-owner/test-repo/issues/10', repository: 'test-owner/test-repo',
          fieldValues: { PVTF_STATUS: { singleSelectOptionId: 'OPT_TODO' } }
        },
        'PVT_4/PVTI_UNKNOWN_REPO': {
          id: 'PVTI_UNKNOWN_REPO', projectId: 'PVT_4', projectNumber: 4, owner: 'test-owner', ownerType: 'Organization',
          kind: 'issue', number: 11, title: 'Unknown source issue', state: 'open',
          url: 'https://github.com/other-owner/other-repo/issues/11', repository: 'other-owner/other-repo', fieldValues: {}
        }
      }
    }
  })
  let failRefresh = false
  const workspaceCalls: Record<string, unknown>[] = []
  const mounted = await mountProjects({ state, intercept: async (method, params, forward) => {
    if (failRefresh && method === 'quirky.tasks/projectView' && params.action === 'refresh') {
      failRefresh = false
      throw new Error('temporary Project refresh failure')
    }
    if (method === 'quirky.tasks/workspace') {
      workspaceCalls.push(params)
      return { kind: 'composer', requestId: 'unknown-source-composer', error: 'Choose an agent.' }
    }
    return forward()
  } })

  const restrictedRow = [...mounted.container.querySelectorAll('tbody tr')].find((row) => row.textContent?.includes('Restricted item'))
  expect(restrictedRow).toBeDefined()
  expect(restrictedRow?.querySelector('select[aria-label="Status"]')).toBeNull()
  const restrictedStart = [...mounted.container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Start work on project item')
  expect(restrictedStart?.disabled).toBe(true)

  failRefresh = true
  await clickButton(mounted.container, 'Refresh')
  await waitFor(() => mounted.container.querySelector('[role="alert"]')?.textContent?.includes('temporary Project refresh failure') === true, 'retained refresh error')
  expect(mounted.container.textContent).toContain('Improve project table')
  expect(mounted.container.textContent).toContain('Restricted item')

  await clickButton(mounted.container, 'Start work on Unknown source issue')
  const guidance = dialogByTitle(mounted.container, 'GitHub project item guidance')
  if (!guidance) throw new Error('unknown repository guidance was not rendered')
  expect(guidance.textContent).toContain('Repository not in Quirky')
  const pathInput = guidance.querySelector('input#local-project-repo-path')
  if (!(pathInput instanceof HTMLInputElement)) throw new Error('repository addition path input was not rendered')
  const repoPath = mkdtempSync(join(tmpdir(), 'quirky-project-source-'))
  temporaryRepositories.push(repoPath)
  execFileSync('git', ['init', '--quiet', '--initial-branch', 'main', repoPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Project fixture'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'project-fixture@example.invalid'], { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), 'isolated project source\\n')
  execFileSync('git', ['-C', repoPath, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'fixture'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/other-owner/other-repo.git'], { stdio: 'ignore' })
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(pathInput, repoPath)
    pathInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await clickButton(guidance, 'Add repo')
  await waitFor(() => workspaceCalls.length === 1, 'workspace composer after adding the exact Project source repository')
  expect(workspaceCalls[0]).toMatchObject({
    action: 'start',
    target: {
      kind: 'issue',
      number: 11,
      url: 'https://github.com/other-owner/other-repo/issues/11',
      host: 'github.com',
      owner: 'other-owner',
      repo: 'other-repo'
    }
  })
}, 60_000)

test('Escape closes the project picker and restores focus without selecting a different project', async () => {
  let projectSelectionCalls = 0
  const mounted = await mountProjects({ intercept: async (method, params, forward) => {
    if (method === 'quirky.tasks/projectSelect') projectSelectionCalls += 1
    return forward()
  } })
  document.body.append(mounted.container)
  try {
    const opener = mounted.container.querySelector<HTMLButtonElement>('main button')
    if (!opener) throw new Error('project chooser was not rendered')
    await act(async () => {
      opener.focus()
      opener.click()
    })
    const dialog = mounted.container.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error('project picker dialog was not rendered')
    const closeButton = dialog.querySelector<HTMLElement>('[aria-label="Close dialog"]')
    if (!closeButton) throw new Error('shared dialog close button was not rendered')
    await act(async () => {
      closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(projectSelectionCalls).toBe(0)
  } finally {
    mounted.container.remove()
  }
})
