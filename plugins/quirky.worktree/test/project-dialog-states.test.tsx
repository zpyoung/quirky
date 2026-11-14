import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { RpcErrorCode, type EffectiveHooks, type ProjectSettings, type Repo, type RepoDetails, type UiPluginContext, type Worktree } from '@quirky/protocol'
import type { createRoot as ReactCreateRoot, Root } from 'react-dom/client'
import type { act as ReactAct, createElement as ReactCreateElement } from 'react'
import { dispatchUiControl, UI_CONTROL_COMMAND } from '../src/ui-control'
import type { AddProjectDialog as AddProjectDialogComponent } from '../src/AddProjectDialog'
import type { CreateDialog as CreateDialogComponent } from '../src/CreateDialog'
import type { ProjectSettingsDialog as ProjectSettingsDialogComponent } from '../src/ProjectSettingsDialog'
import type { DialogState } from '../src/report'

let act: typeof ReactAct
let createElement: typeof ReactCreateElement
let createRoot: typeof ReactCreateRoot
let AddProjectDialog: typeof AddProjectDialogComponent
let CreateDialog: typeof CreateDialogComponent
let ProjectSettingsDialog: typeof ProjectSettingsDialogComponent

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const react = await import('react')
  act = react.act
  createElement = react.createElement
  // React DOM must load after Happy DOM registration so its renderer binds this document.
  const [reactDom, addProject, create, settings] = await Promise.all([
    import('react-dom/client'),
    import('../src/AddProjectDialog'),
    import('../src/CreateDialog'),
    import('../src/ProjectSettingsDialog')
  ])
  createRoot = reactDom.createRoot
  AddProjectDialog = addProject.AddProjectDialog
  CreateDialog = create.CreateDialog
  ProjectSettingsDialog = settings.ProjectSettingsDialog
})

const repository = (id = 'r1', name = 'api', kind: Repo['kind'] = 'git'): Repo => ({
  id,
  name,
  path: `/repos/${name}`,
  addedAt: 0,
  kind,
  displayName: null,
  groupId: null
})
const repos = [repository(), repository('rf', 'notes', 'folder')]
const primary: Worktree = {
  id: 'wt-main',
  repoId: 'r1',
  path: '/repos/api',
  branch: 'main',
  head: 'a'.repeat(40),
  isMain: true,
  name: 'main',
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0,
  instanceId: 'fixture:wt-main'
}
const projectSettings: ProjectSettings = {
  defaultBase: 'main',
  worktreeLocation: null,
  setupPolicy: 'skip-by-default',
  agentStartup: null,
  commandSource: null,
  setupScript: '',
  archiveScript: '',
  issueCommand: ''
}
const noHooks: EffectiveHooks = {
  file: null,
  setup: null,
  archive: null,
  issueCommand: null,
  agentStartup: null,
  sharedDirectories: [],
  warnings: []
}
const defaultDetails: RepoDetails = { repo: repos[0]!, settings: projectSettings, hooks: noHooks }
const defaultMetadata = {
  repoId: 'r1',
  identity: { displayName: null, icon: null, color: null, trackerProject: null },
  externalVisibility: 'inherit',
  effectiveExternalVisibility: 'hide',
  externalInboxSuppressed: false,
  sharedDirectories: []
}

type Call = { method: string; params: Record<string, unknown> }
type Toast = { title: string; body: string }
type TestHooks = EffectiveHooks & {
  defaultTabs?: { title?: string; color?: string; command?: string }[]
  environmentRecipes?: { id: string; name: string; create: string }[]
  environmentRecipeDiagnostics?: { index: number; field?: string; message: string }[]
}
type HarnessOptions = {
  details?: RepoDetails
  hooks?: TestHooks
  onCall?(method: string, params: Record<string, unknown>): unknown
  mountViewError?: Error
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const toasts: Toast[] = []
  const details = options.details ?? defaultDetails
  let context: UiPluginContext
  context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 1 }
      if (method === 'ui.window.command.run') {
        if (params.id !== UI_CONTROL_COMMAND) throw new Error(`unexpected command ${String(params.id)}`)
        return { result: dispatchUiControl(context, params.args) }
      }
      const custom = options.onCall?.(method, params)
      if (custom !== undefined) return await custom
      if (method === 'quirky.repo/show') return details
      if (method === 'quirky.worktree/projectMetadata') return defaultMetadata
      if (method === 'quirky.hosting/projects') return { projects: [], partialFailures: [], truncated: false }
      if (method === 'quirky.repo/hooks') return options.hooks ?? details.hooks
      if (method === 'quirky.worktree/availableHosts') return { hosts: [] }
      if (method === 'quirky.agents/list') return { agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true }] }
      if (method === 'quirky.agents/options') return { supported: false, models: [], unlisted: 'refuse', unlistedOptions: [] }
      if (method === 'quirky.worktree/suggestName') return { name: 'new-worktree' }
      if (method === 'quirky.hosting/listWorkItems') return { items: [], partial: false }
      if (method === 'quirky.git/branches') return { refs: [], current: null }
      if (method === 'quirky.worktree/create') return { worktree: primary, warnings: [], setup: { ran: 'none' } }
      if (method === 'quirky.worktree/navigate') return { ok: true }
      if (method === 'quirky.repo/set' || method === 'quirky.worktree/setProjectMetadata') return { ok: true }
      throw new Error(`unexpected call ${method}`)
    },
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    mountView() {
      if (options.mountViewError) throw options.mountViewError
      return () => {}
    },
    openView() {},
    toast(title: string, body: string) { toasts.push({ title, body }) },
    log() {},
    subscribe: () => () => {},
    onConnection: () => () => {},
    getSetting: () => undefined,
    executeCommand() { throw new Error('unexpected executeCommand call') }
  } as unknown as UiPluginContext
  return { context, calls, toasts }
}

const roots: Root[] = []
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function attachRoot() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  return { host, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await flush()
    const value = read()
    if (value !== null && value !== undefined) return value
  }
  throw new Error('Dialog did not reach the expected state')
}

async function mountCreate(options: HarnessOptions = {}, repoId = 'r1', onClose: () => void = () => {}) {
  const harness = makeHarness(options)
  const { host, root } = attachRoot()
  await act(async () => {
    root.render(createElement(CreateDialog, {
      context: harness.context,
      repos,
      worktrees: [primary],
      repoId,
      onRepoChange() {},
      onClose,
      onPending() { return () => {} },
      hooks: { askTrust: async () => 'cancel' as const, showFallback() {} }
    }))
    await Promise.resolve()
  })
  await flush()
  return { ...harness, host, root, dialog: host.querySelector<HTMLElement>('[role="dialog"]')! }
}

async function mountSettings(options: HarnessOptions = {}, onClose: () => void = () => {}) {
  const harness = makeHarness(options)
  const { host, root } = attachRoot()
  await act(async () => {
    root.render(createElement(ProjectSettingsDialog, { context: harness.context, repo: repos[0]!, onClose }))
    await Promise.resolve()
  })
  await flush()
  return { ...harness, host, root, dialog: host.querySelector<HTMLElement>('[role="dialog"]')! }
}

async function mountAddProject(
  options: HarnessOptions = {},
  onStep: (dialog: DialogState) => void = () => {},
  onClose: () => void = () => {}
) {
  const harness = makeHarness(options)
  const { host, root } = attachRoot()
  await act(async () => {
    root.render(createElement(AddProjectDialog, { context: harness.context, onStep, onClose }))
    await Promise.resolve()
  })
  await flush()
  return { ...harness, host, root, dialog: host.querySelector<HTMLElement>('[role="dialog"]')! }
}

function button(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click()
    await Promise.resolve()
  })
}

async function setText(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = target instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('expected a text input')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function setSelect(target: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    target.value = value
    target.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const noticeText = (dialog: ParentNode) => dialog.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()
const emptyText = (dialog: ParentNode) => dialog.querySelector('.ui-empty-state')?.textContent?.trim()
const inlineErrorText = (dialog: ParentNode) => dialog.querySelector('.ui-inline-error__message')?.textContent?.trim()
const textField = (dialog: ParentNode, id: string) => dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!
const deferred = <T,>() => Promise.withResolvers<T>()

test('Project Settings initial reads render the shared loading NoticeLine', async () => {
  const pending = new Promise<never>(() => {})
  const h = await mountSettings({
    onCall(method) {
      if (method === 'quirky.repo/show' || method === 'quirky.worktree/projectMetadata') return pending
      return undefined
    }
  })
  expect(noticeText(h.dialog)).toBe('Loading…')
})

test('pending Create reads render the shared NoticeLine in each loading mode', async () => {
  const source = deferred<unknown>()
  const search = deferred<unknown>()
  const branches = deferred<unknown>()
  const options = deferred<unknown>()
  const h = await mountCreate({
    onCall(method) {
      if (method === 'quirky.hosting/worktreeSource') return source.promise
      if (method === 'quirky.hosting/listWorkItems') return search.promise
      if (method === 'quirky.git/branches') return branches.promise
      if (method === 'quirky.agents/options') return options.promise
      return undefined
    }
  })
  await setText(textField(h.dialog, 'create-smart-name') as HTMLInputElement, '#404')
  expect(await waitFor(() => noticeText(h.dialog))).toBe('Loading GitHub work item…')

  await click(button(h.dialog, 'GitHub')!)
  expect(await waitFor(() => noticeText(h.dialog))).toBe('Loading GitHub issues and pull requests…')

  await click(button(h.dialog, 'Branch')!)
  expect(await waitFor(() => noticeText(h.dialog))).toBe('Loading branches…')

  await setSelect(h.dialog.querySelector<HTMLSelectElement>('#create-agent')!, 'claude')
  expect(await waitFor(() =>
    [...h.dialog.querySelectorAll<HTMLElement>('[role="status"] .ui-notice-line')]
      .find((line) => line.textContent?.trim() === 'Loading claude model options…')?.textContent?.trim()
  )).toBe('Loading claude model options…')
})

test('successful empty GitHub, branch and shared-script reads use EmptyState', async () => {
  const github = await mountCreate()
  await click(button(github.dialog, 'GitHub')!)
  expect(await waitFor(() => emptyText(github.dialog))).toBe('No GitHub issues or pull requests found.')

  const branch = await mountCreate()
  await click(button(branch.dialog, 'Branch')!)
  expect(await waitFor(() => emptyText(branch.dialog))).toBe('No matching branches.')

  const settings = await mountSettings()
  expect(await waitFor(() => emptyText(settings.dialog))).toBe('No shared scripts.')

  const emptySharedScript = {
    text: '',
    source: 'shared' as const,
    badge: 'shared',
    shared: { text: '', hash: 'sha256:empty', trusted: false, changed: false }
  }
  const details: RepoDetails = { ...defaultDetails, hooks: { ...noHooks, setup: emptySharedScript } }
  const settingsWithEmptySharedText = await mountSettings({ details })
  await waitFor(() => settingsWithEmptySharedText.dialog.querySelector('#project-setup-script'))
  expect(emptyText(settingsWithEmptySharedText.dialog)).toBeUndefined()
})

test('Create rejected reads and blockers render exact shared InlineError messages', async () => {
  const source = await mountCreate({
    onCall(method) {
      if (method === 'quirky.hosting/worktreeSource') throw new Error('No item')
      return undefined
    }
  })
  await setText(textField(source.dialog, 'create-smart-name') as HTMLInputElement, '#404')
  expect(await waitFor(() => inlineErrorText(source.dialog))).toBe('Could not resolve GitHub work item: No item')
  expect(emptyText(source.dialog)).toBeUndefined()

  const search = await mountCreate({
    onCall(method) {
      if (method === 'quirky.hosting/listWorkItems') throw new Error('Access denied')
      return undefined
    }
  })
  await click(button(search.dialog, 'GitHub')!)
  expect(await waitFor(() => inlineErrorText(search.dialog))).toBe('Could not search GitHub work items: Access denied')
  expect(emptyText(search.dialog)).toBeUndefined()

  const branchFailure = await mountCreate({
    onCall(method) {
      if (method === 'quirky.git/branches') throw new Error('Git unavailable')
      return undefined
    }
  })
  await click(button(branchFailure.dialog, 'Branch')!)
  expect(await waitFor(() => inlineErrorText(branchFailure.dialog))).toBe('Could not search branches: Git unavailable')
  expect(emptyText(branchFailure.dialog)).toBeUndefined()

  const occupied = await mountCreate({
    onCall(method) {
      if (method === 'quirky.git/branches') return {
        refs: [{ name: 'feat/used', kind: 'local', checkedOutIn: '/worktrees/other' }],
        current: 'main'
      }
      return undefined
    }
  })
  await click(button(occupied.dialog, 'Branch')!)
  await setText(textField(occupied.dialog, 'create-branch') as HTMLInputElement, 'feat/used')
  expect(await waitFor(() => inlineErrorText(occupied.dialog))).toBe(
    'Branch “feat/used” is already in use in workspace “other”. Open that workspace or choose another branch.'
  )

  const invalidName = await mountCreate()
  await setText(textField(invalidName.dialog, 'create-smart-name') as HTMLInputElement, '///')
  expect(inlineErrorText(invalidName.dialog)).toBe('Invalid worktree name')

  const folderReference = await mountCreate({}, 'rf')
  await setText(textField(folderReference.dialog, 'create-name') as HTMLInputElement, 'https://github.com/acme/api/issues/4')
  expect(inlineErrorText(folderReference.dialog)).toBe('GitHub worktree sources require a Git repository.')

  const agentOptions = await mountCreate({
    onCall(method) {
      if (method === 'quirky.agents/options') throw new Error('Catalog offline')
      return undefined
    }
  })
  await setSelect(agentOptions.dialog.querySelector<HTMLSelectElement>('#create-agent')!, 'claude')
  expect(await waitFor(() => inlineErrorText(agentOptions.dialog))).toBe('Could not load claude model options: Catalog offline')

  const createFailure = await mountCreate({
    onCall(method) {
      if (method === 'quirky.worktree/create') throw new Error('Create denied')
      return undefined
    }
  })
  await click(button(createFailure.dialog, 'Create')!)
  expect(await waitFor(() => inlineErrorText(createFailure.dialog))).toBe('Could not create worktree: Create denied')
  expect(createFailure.dialog.querySelector('[role="alert"] .ui-inline-error__message')).not.toBeNull()
})
test('Project Settings keeps Ledger failure in InlineError and tracker catalog failure in FormRow', async () => {
  const ledger = await mountSettings({ mountViewError: new Error('Ledger offline') })
  expect(await waitFor(() => inlineErrorText(ledger.dialog))).toBe('Ledger Staleness is unavailable: Ledger offline')
  expect(ledger.dialog.querySelector('.ui-inline-error')).not.toBeNull()
  expect(button(ledger.dialog, 'Save')).toBeDefined()

  const tracker = await mountSettings({
    onCall(method) {
      if (method === 'quirky.hosting/projects') throw new Error('Catalog offline')
      return undefined
    }
  })
  const trackerError = await waitFor(() =>
    tracker.dialog.querySelector<HTMLElement>('#project-tracker-project')?.closest('.ui-form-row')?.querySelector<HTMLElement>('.ui-error-text[role="alert"]')
  )
  expect(trackerError.textContent).toBe('Provider-backed tracker projects are unavailable: Catalog offline')
  expect(tracker.dialog.querySelector('.ui-inline-error')).toBeNull()
})

test('host, default-tab, recipe and partial-search diagnostics remain advisories', async () => {
  const warnings: TestHooks = {
    ...noHooks,
    warnings: ['defaultTabs: Tab 1 command is unavailable.'],
    defaultTabs: [{ title: 'Shell', command: 'echo ready' }],
    environmentRecipes: [{ id: 'fixture', name: 'Check', create: 'true' }],
    environmentRecipeDiagnostics: [{ index: 0, field: 'create', message: 'Recipe 1 has an invalid command.' }]
  }
  let closes = 0
  const local = await mountCreate({
    hooks: warnings,
    onCall(method) {
      if (method === 'quirky.worktree/availableHosts') throw new Error('Catalog offline')
      return undefined
    }
  }, 'r1', () => { closes += 1 })
  await click(button(local.dialog, 'Advanced')!)
  await waitFor(() => local.dialog.querySelector('#create-target-peer'))
  const hostWarning = await waitFor(() =>
    [...local.dialog.querySelectorAll<HTMLElement>('[role="status"]')].find((status) => status.textContent?.includes('Remote host discovery is unavailable'))
  )
  expect(hostWarning.textContent).toBe('Remote host discovery is unavailable: Catalog offline')
  expect(hostWarning.classList.contains('ui-help-text')).toBe(true)
  expect(hostWarning.querySelector('.ui-notice-line')).toBeNull()
  expect(local.dialog.querySelector('[role="alert"]')).toBeNull()
  expect(local.dialog.querySelector('.ui-empty-state')).toBeNull()

  const defaultTabWarning = [...local.dialog.querySelectorAll<HTMLElement>('[role="status"]')]
    .find((status) => status.textContent === 'defaultTabs: Tab 1 command is unavailable.')
  const recipeWarning = [...local.dialog.querySelectorAll<HTMLElement>('[role="status"]')]
    .find((status) => status.textContent === 'Recipe 1 has an invalid command.')
  expect(defaultTabWarning?.classList.contains('ui-text-muted')).toBe(true)
  expect(recipeWarning?.classList.contains('ui-text-muted')).toBe(true)
  expect(defaultTabWarning?.querySelector('.ui-notice-line')).toBeNull()
  expect(recipeWarning?.querySelector('.ui-notice-line')).toBeNull()
  expect(button(local.dialog, 'Create')?.disabled).toBe(false)
  await click(button(local.dialog, 'Create')!)
  expect(await waitFor(() => closes > 0 ? closes : undefined)).toBe(1)
  expect(local.calls.find((call) => call.method === 'quirky.worktree/create')?.params).not.toHaveProperty('host')

  const unavailable = await mountCreate({
    onCall(method) {
      if (method === 'quirky.worktree/availableHosts') {
        return { hosts: [{ id: 'remote-9', label: 'Remote 9', available: false, capabilities: [] }] }
      }
      return undefined
    }
  })
  await click(button(unavailable.dialog, 'Advanced')!)
  await waitFor(() => unavailable.dialog.querySelector('#create-target-peer'))
  await setSelect(unavailable.dialog.querySelector<HTMLSelectElement>('#create-target-peer')!, 'remote-9')
  expect(button(unavailable.dialog, 'Create')?.disabled).toBe(true)
  await click(button(unavailable.dialog, 'Create')!)
  expect(unavailable.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)

  const partial = {
    items: [{
      kind: 'issue',
      number: 4,
      title: 'Partial issue',
      url: 'https://github.com/acme/api/issues/4',
      state: 'open',
      labels: []
    }],
    partial: true,
    errors: { prs: { reason: 'rate_limited', message: 'Pull request search is rate-limited.' } }
  }
  const usable = await mountCreate({
    onCall(method) {
      if (method === 'quirky.hosting/listWorkItems') return partial
      return undefined
    }
  })
  await click(button(usable.dialog, 'GitHub')!)
  expect(await waitFor(() =>
    [...usable.dialog.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('Issue #4'))
  )).toBeDefined()
  const partialWarning = await waitFor(() =>
    [...usable.dialog.querySelectorAll<HTMLElement>('.ui-text-muted')].find((message) => message.textContent === 'Pull request search is rate-limited.')
  )
  expect(partialWarning.tagName).toBe('P')
  expect(partialWarning.getAttribute('role')).not.toBe('alert')
  expect(partialWarning.classList.contains('ui-error-text')).toBe(false)
  expect(usable.dialog.querySelector('.ui-inline-error')).toBeNull()
  expect(emptyText(usable.dialog)).toBeUndefined()

  const warningWithoutItems = await mountCreate({
    onCall(method) {
      if (method === 'quirky.hosting/listWorkItems') return { ...partial, items: [] }
      return undefined
    }
  })
  await click(button(warningWithoutItems.dialog, 'GitHub')!)
  expect(await waitFor(() => [...warningWithoutItems.dialog.querySelectorAll('.ui-text-muted')]
    .find((message) => message.textContent === 'Pull request search is rate-limited.'))).toBeDefined()
  expect(emptyText(warningWithoutItems.dialog)).toBeUndefined()
})

test('Project Settings load failure toasts and closes; picker cancel, unavailable and failure preserve the draft', async () => {
  let closes = 0
  const failedLoad = await mountSettings({
    onCall(method) {
      if (method === 'quirky.repo/show') throw new Error('Settings offline')
      return undefined
    }
  }, () => { closes += 1 })
  await waitFor(() => failedLoad.toasts.length > 0 ? failedLoad.toasts.length : undefined)
  expect(failedLoad.toasts).toEqual([{ title: 'Could not load project settings', body: 'Settings offline' }])
  expect(closes).toBe(1)

  let picker: 'cancel' | 'unavailable' | 'failure' = 'cancel'
  const settings = await mountSettings({
    onCall(method) {
      if (method !== 'desktop.folder.pick') return undefined
      if (picker === 'cancel') return { cancelled: true, paths: [] }
      if (picker === 'unavailable') throw Object.assign(new Error('picker missing'), { code: RpcErrorCode.MethodNotFound })
      throw new Error('Picker offline')
    }
  })
  const location = textField(settings.dialog, 'project-worktree-location') as HTMLInputElement
  await setText(location, '/draft/worktrees')
  await click(button(settings.dialog, 'Browse worktree location')!)
  expect(location.value).toBe('/draft/worktrees')
  expect(settings.toasts).toHaveLength(0)

  picker = 'unavailable'
  await click(button(settings.dialog, 'Browse worktree location')!)
  expect(settings.toasts.at(-1)).toEqual({
    title: 'Native folder picker unavailable',
    body: 'This shell does not provide the native folder picker.'
  })
  expect(location.value).toBe('/draft/worktrees')

  picker = 'failure'
  await click(button(settings.dialog, 'Browse worktree location')!)
  expect(settings.toasts.at(-1)).toEqual({ title: 'Could not choose worktree location', body: 'Picker offline' })
  expect(location.value).toBe('/draft/worktrees')
  expect(settings.calls.filter((call) => call.method === 'desktop.folder.pick')).toHaveLength(3)
})

test('Project Settings rejects unsafe paths and icons, and keeps the form after a save failure', async () => {
  const settings = await mountSettings({
    onCall(method) {
      if (method === 'quirky.repo/set') throw new Error('Save denied')
      return undefined
    }
  })
  const shared = textField(settings.dialog, 'project-shared-directories') as HTMLTextAreaElement
  await setText(shared, '../outside')
  await click(button(settings.dialog, 'Save')!)
  expect(settings.toasts.at(-1)?.title).toBe('Invalid shared directories')
  expect(settings.calls.some((call) => call.method === 'quirky.repo/set')).toBe(false)

  await setText(shared, '')
  await setText(textField(settings.dialog, 'project-icon') as HTMLInputElement, '<svg onload=alert(1)>')
  await click(button(settings.dialog, 'Save')!)
  expect(settings.toasts.at(-1)?.title).toBe('Invalid project icon')
  expect(settings.calls.some((call) => call.method === 'quirky.repo/set')).toBe(false)

  await setText(textField(settings.dialog, 'project-icon') as HTMLInputElement, '◆')
  await setText(textField(settings.dialog, 'project-display-name') as HTMLInputElement, 'Renamed API')
  await click(button(settings.dialog, 'Save')!)
  await waitFor(() => settings.toasts.some((toast) => toast.title === 'Could not save project settings') ? true : undefined)
  expect(settings.toasts.at(-1)).toEqual({ title: 'Could not save project settings', body: 'Save denied' })
  expect(settings.host.querySelector('[role="dialog"]')).not.toBeNull()
  expect(textField(settings.host, 'project-display-name').value).toBe('Renamed API')
  expect(button(settings.host, 'Save')?.disabled).toBe(false)
})

test('metadata-only Project Settings save uses project metadata without calling repo/set', async () => {
  let closed = false
  const settings = await mountSettings({}, () => { closed = true })
  await setText(textField(settings.dialog, 'project-icon') as HTMLInputElement, '◇')
  await click(button(settings.dialog, 'Save')!)
  await waitFor(() => closed ? true : undefined)

  expect(settings.calls.filter((call) => call.method === 'quirky.repo/set')).toHaveLength(0)
  const metadataSave = settings.calls.find((call) => call.method === 'quirky.worktree/setProjectMetadata')
  expect(metadataSave?.params).toMatchObject({ repo: 'r1', identity: { icon: '◇' } })
})

test('Add Project picker cancel and failures toast without changing the typed path', async () => {
  let picker: 'cancel' | 'unavailable' | 'failure' = 'cancel'
  const add = await mountAddProject({
    onCall(method) {
      if (method !== 'desktop.folder.pick') return undefined
      if (picker === 'cancel') return { cancelled: true, paths: [] }
      if (picker === 'unavailable') throw Object.assign(new Error('picker missing'), { code: RpcErrorCode.MethodNotFound })
      throw new Error('Picker offline')
    }
  })
  const path = textField(add.dialog, 'add-project-path') as HTMLInputElement
  await setText(path, '/draft/project')
  await click(button(add.dialog, 'Browse')!)
  expect(path.value).toBe('/draft/project')
  expect(add.toasts).toHaveLength(0)

  picker = 'unavailable'
  await click(button(add.dialog, 'Browse')!)
  expect(add.toasts.at(-1)).toEqual({
    title: 'Native folder picker unavailable',
    body: 'This shell does not provide the native folder picker.'
  })
  expect(path.value).toBe('/draft/project')

  picker = 'failure'
  await click(button(add.dialog, 'Browse')!)
  expect(add.toasts.at(-1)).toEqual({ title: 'Could not choose project folder', body: 'Picker offline' })
  expect(path.value).toBe('/draft/project')
  expect(add.calls.filter((call) => call.method === 'desktop.folder.pick')).toHaveLength(3)
})

test('Add Project add and scan failures retain their current question and toast', async () => {
  const addFailure = await mountAddProject({
    onCall(method) {
      if (method === 'quirky.repo/add') throw new Error('Add denied')
      return undefined
    }
  })
  await setText(textField(addFailure.dialog, 'add-project-path') as HTMLInputElement, '/repo')
  await click(button(addFailure.dialog, 'Add')!)
  expect(addFailure.toasts).toEqual([{ title: 'Could not add project', body: 'Add denied' }])
  expect(addFailure.host.querySelector('[role="dialog"]')).not.toBeNull()

  const scanFailure = await mountAddProject({
    onCall(method) {
      if (method === 'quirky.repo/add') throw Object.assign(new Error('Not a repository'), { data: { reason: 'not-a-repository' } })
      if (method === 'quirky.repo/scan') throw new Error('Scan denied')
      return undefined
    }
  })
  await setText(textField(scanFailure.dialog, 'add-project-path') as HTMLInputElement, '/folder')
  await click(button(scanFailure.dialog, 'Add')!)
  expect(scanFailure.toasts).toEqual([{ title: 'Could not add project', body: 'Scan denied' }])
  expect(scanFailure.host.querySelector('[role="dialog"]')).not.toBeNull()
})

test('Add Project partial import toasts, forwards the step and closes after the import', async () => {
  const steps: DialogState[] = []
  let closes = 0
  const add = await mountAddProject({
    onCall(method) {
      if (method === 'quirky.repo/add') throw Object.assign(new Error('Not a repository'), { data: { reason: 'not-a-repository' } })
      if (method === 'quirky.repo/scan') return { repos: ['/folder/api'] }
      if (method === 'quirky.repo/import') return {
        failed: 1,
        results: [{ path: '/folder/api', status: 'failed', error: 'Git unavailable' }]
      }
      return undefined
    }
  }, (step) => steps.push(step), () => { closes += 1 })
  await setText(textField(add.dialog, 'add-project-path') as HTMLInputElement, '/folder')
  await click(button(add.dialog, 'Add')!)
  const importDialog = await waitFor(() => {
    const dialog = add.host.querySelector<HTMLElement>('[role="dialog"]')
    return dialog?.getAttribute('aria-label')?.includes('Import repositories') ||
      dialog?.textContent?.includes('Group these repositories') ? dialog : undefined
  })
  expect(importDialog.textContent).toContain('Found 1 repository in /folder')
  expect(steps).toEqual([{ kind: 'import', path: '/folder' }])
  await click(button(importDialog, 'No, import separately')!)
  await waitFor(() => closes > 0 ? closes : undefined)
  expect(add.calls.map((call) => call.method)).toEqual(['quirky.repo/add', 'quirky.repo/scan', 'quirky.repo/import'])
  expect(add.calls.at(-1)?.params).toEqual({ path: '/folder' })
  expect(add.toasts).toEqual([{ title: 'Some repositories could not be added', body: '/folder/api: Git unavailable' }])
  expect(closes).toBe(1)
})
