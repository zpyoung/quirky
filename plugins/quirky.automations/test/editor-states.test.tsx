import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AutomationEditor } from '../src/editor/AutomationEditor'
import { initialUiState } from '../src/state'
import type { AutomationDraft, AutomationEditorData, AutomationUiState } from '../src/ui-contracts'

type RecordedCall = { method: string; params: Record<string, unknown> }
type CallHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type SurfaceMount = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void

type TestContext = {
  context: UiPluginContext
  calls: RecordedCall[]
  provided: Map<string, unknown>
}

type EditorCallOverrides = Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>

let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
const cleanups: (() => void)[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterEach(async () => {
  const pending = cleanups.splice(0)
  await act(async () => {
    for (const cleanup of pending) cleanup()
    await Promise.resolve()
  })
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function trackCleanup(cleanup: () => void): () => void {
  const tracked = () => {
    const index = cleanups.indexOf(tracked)
    if (index >= 0) cleanups.splice(index, 1)
    cleanup()
  }
  cleanups.push(tracked)
  return tracked
}

async function settle(): Promise<void> {
  await act(async () => {
    await Bun.sleep(0)
  })
}

async function clickAndSettle(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await Bun.sleep(0)
  })
}

async function renderRoot(element: ReactNode): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const unmount = trackCleanup(() => root.unmount())
  await act(async () => root.render(element))
  await settle()
  return { container, unmount }
}

function editorData(overrides: Partial<AutomationEditorData> = {}): AutomationEditorData {
  return {
    hosts: [{ id: 'local', label: 'Local', available: true }],
    projects: [{ id: 'repo-1', name: 'quirky', hostId: 'local', path: '/work/quirky', kind: 'git' }],
    workspaces: [{ id: 'wt-main', repoId: 'repo-1', name: 'main', path: '/work/quirky', isMain: true }],
    agents: [{ id: 'codex', label: 'Codex', enabled: true, installed: true, isDefault: true }],
    errors: [],
    ...overrides
  }
}

function agentOptions(): Record<string, unknown> {
  const options = [
    { id: 'effort', label: 'Effort', type: 'select', choices: [{ value: 'high', label: 'High' }] },
    { id: 'fast', label: 'Fast', type: 'boolean', choices: null }
  ]
  return {
    supported: true,
    structured: true,
    unlisted: 'refuse',
    models: [{ id: 'gpt-x', label: 'GPT-X', options }],
    unlistedOptions: options
  }
}

function makeDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    name: 'Draft automation',
    prompt: 'Run the scheduled review.',
    agentId: 'codex',
    projectId: 'repo-1',
    workspaceMode: 'existing',
    workspaceId: 'wt-main',
    baseBranch: null,
    setupDecision: 'skip',
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
    missedRunGraceMinutes: 720,
    precheck: { command: 'bun test', timeoutSeconds: 60 },
    launchOverrides: null,
    runContext: null,
    sourceContext: null,
    ...overrides
  }
}

function makeEditorState(draft: AutomationDraft, id: string | null = null): AutomationUiState {
  const state = initialUiState()
  state.editor = { id, original: null, draft, creationKey: 'test-editor' }
  return state
}

function makeContext(onCall: CallHandler): TestContext {
  const calls: RecordedCall[] = []
  const provided = new Map<string, unknown>()
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      return await onCall(method, params)
    },
    subscribe: () => () => {},
    getSetting: () => true,
    toast() {}
  } as unknown as UiPluginContext
  return { context, calls, provided }
}

function defaultUiCall(method: string): unknown {
  switch (method) {
    case 'quirky.automations/uiState': return initialUiState()
    case 'quirky.automations/list': return []
    case 'quirky.automations/editorData': return editorData()
    case 'quirky.automations/externalList': return { managers: [] }
    case 'quirky.automations/runs': return { runs: [], nextCursor: null }
    default: return {}
  }
}

async function mountSurface(context: TestContext, id: string): Promise<HTMLElement> {
  activate(context.context)
  const element = document.createElement('div')
  document.body.append(element)
  const mount = context.provided.get(id) as SurfaceMount | undefined
  if (!mount) throw new Error(`The surface ${id} was not registered.`)
  let unmount = () => {}
  await act(async () => { unmount = mount(element, {}) })
  trackCleanup(unmount)
  await settle()
  return element
}

function makeEditorContext(overrides: EditorCallOverrides = {}): TestContext {
  return makeContext(async (method, params) => {
    if (Object.hasOwn(overrides, method)) return overrides[method]!(params)
    switch (method) {
      case 'quirky.automations/editorData': return editorData()
      case 'quirky.automations/target':
        return {
          available: true,
          target: {
            repoId: 'repo-1', repoPath: '/work/quirky', cwd: '/work/quirky',
            workspaceId: 'wt-main', workspaceDisplayName: 'main',
            owner: {
              kind: 'local', repoId: 'repo-1', repoPath: '/work/quirky',
              workspaceId: 'wt-main', workspacePath: '/work/quirky', workspaceInstanceId: 'instance-1'
            }
          }
        }
      case 'quirky.agents/options': return agentOptions()
      case 'quirky.repo/show': return { settings: { defaultBase: 'main' }, hooks: { setup: { text: '' } } }
      case 'quirky.git/branches': return { refs: [] }
      case 'quirky.worktree/list': return []
      case 'quirky.automations/patchDraft': return undefined
      case 'quirky.automations/saveEditor': return { setupDecision: 'run' }
      default: throw new Error(`Unexpected editor UI dependency call ${method}`)
    }
  })
}

async function mountEditor(options: {
  draft?: AutomationDraft
  id?: string | null
  callOverrides?: EditorCallOverrides
} = {}) {
  const state = makeEditorState(options.draft ?? makeDraft(), options.id ?? null)
  const context = makeEditorContext(options.callOverrides)
  const rendered = await renderRoot(createElement(AutomationEditor, {
    context: context.context,
    state,
    refresh: async () => {},
    notify: () => {}
  }))
  return { ...rendered, state, calls: context.calls }
}

function expectNotice(container: ParentNode, message: string): HTMLElement {
  const wrappers = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
    .filter((wrapper) => wrapper.querySelector('.ui-notice-line__text')?.textContent === message)
  expect(wrappers).toHaveLength(1)
  const wrapper = wrappers[0]!
  expect(wrapper.firstElementChild?.matches('.ui-notice-line')).toBe(true)
  expect(wrapper.querySelector('.ui-inline-error, [role="alert"]')).toBeNull()
  return wrapper
}

function expectEmptyState(container: ParentNode, message: string): HTMLElement {
  const states = [...container.querySelectorAll<HTMLElement>('[role="status"] > .ui-empty-state')]
    .filter((state) => state.querySelector('.ui-empty-state__message')?.textContent === message)
  expect(states).toHaveLength(1)
  return states[0]!
}

function expectInlineError(container: ParentNode, message: string): HTMLElement {
  const errors = [...container.querySelectorAll<HTMLElement>('.ui-inline-error[role="alert"]')]
    .filter((error) => error.querySelector('.ui-inline-error__message')?.textContent === message)
  expect(errors).toHaveLength(1)
  return errors[0]!
}

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

test('shell errors use InlineError and Retry reloads uiState without dropping loading status', async () => {
  let uiStateCalls = 0
  const context = makeContext(async (method) => {
    if (method === 'quirky.automations/uiState') {
      uiStateCalls += 1
      if (uiStateCalls === 1) throw new Error('Automations daemon is unavailable.')
      return initialUiState()
    }
    return defaultUiCall(method)
  })
  const shell = await mountSurface(context, 'view:quirky.automations/automations')
  const shellError = shell.querySelector<HTMLElement>('.auto-shell-error')
  expect(shellError).not.toBeNull()
  expect(shellError?.getAttribute('role')).toBeNull()
  expect(shellError?.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(shellError?.querySelector('.ui-inline-error__message')?.textContent).toBe('Automations daemon is unavailable.')
  const retryButtons = shellError?.querySelectorAll<HTMLButtonElement>('button.ui-inline-error__action')
  expect(retryButtons).toHaveLength(1)
  expect(retryButtons?.[0]?.textContent).toBe('Retry')
  expect(shell.querySelector('.auto-shell-loading[role="status"] .ui-empty-state .ui-empty-state__message')?.textContent)
    .toBe('Loading Automations…')
  expect(context.calls.filter((call) => call.method === 'quirky.automations/uiState')).toHaveLength(1)

  await clickAndSettle(retryButtons![0]!)
  expect(context.calls.filter((call) => call.method === 'quirky.automations/uiState')).toHaveLength(2)
  expect(shell.querySelector('.auto-shell-error')).toBeNull()
  expect(shell.querySelector('.ui-inline-error')).toBeNull()
  expect(shell.querySelector('.auto-shell-loading')).toBeNull()
})

test('settings write failures render one accessible InlineError', async () => {
  const context = makeContext(async (method) => {
    if (method === 'setting.set') throw new Error('Setting store is read-only.')
    return defaultUiCall(method)
  })
  const settings = await mountSurface(context, 'view:quirky.automations/settings')
  await clickAndSettle(settings.querySelector<HTMLInputElement>('#auto-setting-sidebar')!)
  expectInlineError(settings, 'Setting store is read-only.')
  expect(settings.querySelectorAll('p.auto-error')).toHaveLength(0)
})

test('sidebar open failures render one accessible InlineError', async () => {
  const context = makeContext(async (method) => {
    if (method === 'quirky.automations/open') throw new Error('Open failed.')
    return defaultUiCall(method)
  })
  const sidebar = await mountSurface(context, 'sidebar-section:quirky.automations/automations')
  await clickAndSettle(sidebar.querySelector<HTMLButtonElement>('.auto-sidebar__trigger')!)
  expectInlineError(sidebar, 'Open failed.')
  expect(sidebar.querySelectorAll('span[role="alert"]')).toHaveLength(0)
})

test('editor catalog loading is a polite NoticeLine and keeps the loading text', async () => {
  const catalog = deferred<unknown>()
  const rendered = await mountEditor({
    callOverrides: { 'quirky.automations/editorData': () => catalog.promise }
  })
  expectNotice(rendered.container, 'Loading projects, workspaces, and agents…')
  catalog.resolve(editorData())
  await settle()
})

test('empty project catalog uses EmptyState and retains editor layout, precheck, and schedule badge', async () => {
  const rendered = await mountEditor({
    callOverrides: { 'quirky.automations/editorData': () => editorData({ projects: [] }) }
  })
  const empty = expectEmptyState(rendered.container, 'No projects are available on Local. Add a project before saving an automation.')
  expect(empty.querySelector('.ui-inline-error, [role="alert"]')).toBeNull()
  expect(rendered.container.querySelector('.auto-editor__layout')).not.toBeNull()
  expect(rendered.container.querySelector('#auto-editor-precheck')).not.toBeNull()
  const scheduleStatus = rendered.container.querySelector<HTMLElement>('.auto-editor__schedule-status[role="status"]')
  expect(scheduleStatus?.querySelector('.ui-badge')).not.toBeNull()
})

test('saved target unavailability remains a polite advisory', async () => {
  const rendered = await mountEditor({
    id: 'automation-1',
    callOverrides: {
      'quirky.automations/target': () => ({
        available: false, status: 'skipped_unavailable', error: 'The saved project was removed.'
      })
    }
  })
  const notice = expectNotice(rendered.container, 'Saved target unavailable: The saved project was removed.')
  expect(notice.querySelector('.ui-inline-error')).toBeNull()
})

test('editor catalog errors render as InlineError alerts', async () => {
  const rendered = await mountEditor({
    callOverrides: {
      'quirky.automations/editorData': () => editorData({ errors: ['Workspace catalog is read-only.'] })
    }
  })
  expectInlineError(rendered.container.querySelector('.auto-editor__prompt')!, 'Workspace catalog is read-only.')
})

test('setup warnings stay advisory and do not block the save request', async () => {
  const rendered = await mountEditor({
    draft: makeDraft({ workspaceMode: 'new_per_run', workspaceId: null, setupDecision: 'run' }),
    callOverrides: {
      'quirky.worktree/list': () => [],
      'quirky.automations/saveEditor': () => ({ setupDecision: 'run' })
    }
  })
  await clickAndSettle(rendered.container.querySelector<HTMLButtonElement>('button[form="auto-editor-form"]')!)
  expect(rendered.calls.filter((call) => call.method === 'quirky.automations/saveEditor')).toHaveLength(1)
  expectNotice(rendered.container, 'No immutable workspace revision is available to inspect; setup will be skipped.')
})

test('agent option lookup errors render as InlineError alerts', async () => {
  const rendered = await mountEditor({
    callOverrides: {
      'quirky.agents/options': () => { throw new Error('Agent option lookup failed.') }
    }
  })
  const modelField = rendered.container.querySelector('#auto-editor-model')?.closest('.auto-editor__field')
  expectInlineError(modelField!, 'Agent options could not be loaded: Agent option lookup failed.')
})

test('saved model unavailability is a polite advisory, not an alert', async () => {
  const rendered = await mountEditor({
    draft: makeDraft({ launchOverrides: { model: 'removed-model' } })
  })
  const notice = expectNotice(rendered.container,
    "Saved model “removed-model” is not in this agent's catalog and may be refused. Choose a listed model or clear it.")
  expect(notice.querySelector('.ui-inline-error, [role="alert"]')).toBeNull()
})

test.each(['effort', 'fast'])('invalid saved %s option values render exactly one polite catalog advisory', async (optionId) => {
  const rendered = await mountEditor({
    draft: makeDraft({ launchOverrides: { model: 'gpt-x', optionValues: { [optionId]: 'unsupported' } } })
  })
  const message = 'Saved value is not in the current option catalog.'
  const matchingMessages = [...rendered.container.querySelectorAll('.ui-notice-line__text')]
    .filter((node) => node.textContent === message)
  expect(matchingMessages).toHaveLength(1)
  expectNotice(rendered.container, message)
})

test('unavailable saved options offer a NoticeLine clear action routed to patchDraft', async () => {
  const launchOverrides = { model: 'gpt-x', optionValues: { legacy: 'old-value' } }
  const originalValues = launchOverrides.optionValues
  const rendered = await mountEditor({ draft: makeDraft({ launchOverrides }) })
  const notice = expectNotice(rendered.container, 'Saved option “legacy” is unavailable for this model.')
  const actions = notice.querySelectorAll<HTMLButtonElement>('.ui-notice-line__action')
  expect(actions).toHaveLength(1)
  expect(actions[0]?.textContent?.trim()).toBe('Clear saved option')

  await clickAndSettle(actions[0]!)
  const patches = rendered.calls.filter((call) => call.method === 'quirky.automations/patchDraft')
  expect(patches).toHaveLength(1)
  expect(patches[0]?.params).toEqual({ patch: { launchOverrides: { model: 'gpt-x' } } })
  expect(rendered.state.editor?.draft.launchOverrides?.optionValues).toBe(originalValues)
  expect(originalValues).toEqual({ legacy: 'old-value' })
})

test('branch search loading and failures preserve their status and alert roles', async () => {
  const branches = deferred<unknown>()
  const started = Promise.withResolvers<void>()
  const rendered = await mountEditor({
    draft: makeDraft({ workspaceMode: 'new_per_run', workspaceId: null }),
    callOverrides: { 'quirky.git/branches': () => {
      started.resolve()
      return branches.promise
    } }
  })
  await act(async () => {
    await started.promise
  })
  expectNotice(rendered.container, 'Searching branches…')

  await act(async () => {
    branches.reject(new Error('Branch lookup failed.'))
    await Bun.sleep(0)
  })
  const branchField = rendered.container.querySelector('#auto-editor-base-branch')?.closest('.auto-editor__field')
  expectInlineError(branchField!, 'Branches could not be loaded: Branch lookup failed.')
})

test('project setup failures render as InlineError alerts', async () => {
  const rendered = await mountEditor({
    draft: makeDraft({ workspaceMode: 'new_per_run', workspaceId: null }),
    callOverrides: {
      'quirky.repo/show': () => { throw new Error('Project details failed.') }
    }
  })
  const setup = rendered.container.querySelector('section[aria-label="Workspace setup"]')
  expectInlineError(setup!, 'Project setup could not be checked: Project details failed.')
})

test('option updates preserve the original map and all four patchDraft payloads', async () => {
  const cases: {
    launchOverrides: NonNullable<AutomationDraft['launchOverrides']>
    action: 'clear-effort' | 'set-fast'
    expected: Record<string, unknown>
  }[] = [
    {
      launchOverrides: { optionValues: { effort: 'high' } },
      action: 'clear-effort',
      expected: { patch: { launchOverrides: null } }
    },
    {
      launchOverrides: { model: 'gpt-x', optionValues: { effort: 'high' } },
      action: 'clear-effort',
      expected: { patch: { launchOverrides: { model: 'gpt-x' } } }
    },
    {
      launchOverrides: { model: 'gpt-x', optionValues: { effort: 'high', fast: true } },
      action: 'clear-effort',
      expected: { patch: { launchOverrides: { model: 'gpt-x', optionValues: { fast: true } } } }
    },
    {
      launchOverrides: { optionValues: { effort: 'high' } },
      action: 'set-fast',
      expected: { patch: { launchOverrides: { optionValues: { effort: 'high', fast: true } } } }
    }
  ]

  for (const scenario of cases) {
    const originalValues = scenario.launchOverrides.optionValues!
    const originalSnapshot = { ...originalValues }
    const draft = makeDraft({ launchOverrides: scenario.launchOverrides })
    const rendered = await mountEditor({ draft })
    const control = scenario.action === 'set-fast'
      ? rendered.container.querySelector<HTMLInputElement>('#auto-option-fast')
      : rendered.container.querySelector('#auto-option-effort')?.closest('.auto-editor__control-row')?.querySelector<HTMLButtonElement>('button')
    expect(control).not.toBeNull()
    await clickAndSettle(control!)

    const patches = rendered.calls.filter((call) => call.method === 'quirky.automations/patchDraft')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.params).toEqual(scenario.expected)
    expect(rendered.state.editor?.draft.launchOverrides?.optionValues).toBe(originalValues)
    expect(originalValues).toEqual(originalSnapshot)
    await act(async () => rendered.unmount())
  }
})
