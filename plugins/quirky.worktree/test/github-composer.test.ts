import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import type {
  EffectiveHooks,
  GitHubWorktreeSource,
  ProjectSettings,
  Repo,
  RepoDetails,
  UiPluginContext,
  Worktree,
  WorktreeCreateResult
} from '@quirky/protocol'
import { DEFAULT_WORKTREE_STATUSES } from '../src/daemon/statuses'
import type { act as ReactAct, createElement as ReactCreateElement } from 'react'
import type { createRoot as ReactCreateRoot } from 'react-dom/client'
import type { CreateDialog as CreateDialogComponent } from '../src/CreateDialog'
import type { createWorkspace as createWorkspaceAction } from '../src/actions'
import type { ProjectSettingsDialog as ProjectSettingsDialogComponent } from '../src/ProjectSettingsDialog'
import type { buildTreeModel as buildTreeModelFunction } from '../src/report'
import type { Tree as TreeComponent } from '../src/Tree'
import type { TrustDialog as TrustDialogComponent } from '../src/TrustDialog'
let act: typeof ReactAct
let createElement: typeof ReactCreateElement
let createRoot: typeof ReactCreateRoot
let CreateDialog: typeof CreateDialogComponent
let createWorkspace: typeof createWorkspaceAction
let ProjectSettingsDialog: typeof ProjectSettingsDialogComponent
let buildTreeModel: typeof buildTreeModelFunction
let Tree: typeof TreeComponent
let TrustDialog: typeof TrustDialogComponent

const PR_URL = 'https://github.com/acme/api/pull/3'
const ISSUE_URL = 'https://github.com/acme/api/issues/4'
const repository = { host: 'github.com', owner: 'acme', repo: 'api' }
const prLink = { provider: 'github', kind: 'pullRequest', number: 3, title: 'Reword the README', url: PR_URL, repository } as const
const issueLink = { provider: 'github', kind: 'issue', number: 4, title: 'Add a multiply function', url: ISSUE_URL, repository } as const
const prSource: GitHubWorktreeSource = {
  item: prLink,
  head: { repository, refName: 'feat/conflict', oid: 'a'.repeat(40), sshUrl: 'git@github.com:acme/api.git', httpsUrl: 'https://github.com/acme/api.git', maintainerCanModify: false },
  base: { repository, refName: 'main', oid: 'b'.repeat(40) }
}
const issueSource: GitHubWorktreeSource = { item: issueLink, head: null, base: null }

const repo = (id = 'r1', name = 'api', kind: Repo['kind'] = 'git'): Repo => ({
  id,
  name,
  path: `/repos/${name}`,
  addedAt: 0,
  kind,
  displayName: null,
  groupId: null
})
const repos = [repo(), repo('r2', 'web'), repo('rf', 'notes', 'folder')]
const main = (repoId = 'r1', id = 'wt-main'): Worktree => ({
  id,
  repoId,
  path: `/repos/${repoId}`,
  branch: 'main',
  head: 'b'.repeat(40),
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
  instanceId: `fixture:${id}`
})
const mains = [main(), main('r2', 'wt-web')]
const settings: ProjectSettings = {
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

type Call = { method: string; params: Record<string, unknown> }
type AppOptions = {
  onCall?(method: string, params: Record<string, unknown>): unknown
  details?: RepoDetails
  hooks?: EffectiveHooks
  settings?: ProjectSettings
}

function makeApp(options: AppOptions = {}) {
  const calls: Call[] = []
  const opened: { id: string; input?: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const details = options.details
  const effectiveHooks = options.hooks ?? details?.hooks ?? noHooks
  const projectSettings = options.settings ?? details?.settings ?? settings
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const custom = options.onCall?.(method, params)
      if (custom !== undefined) return await custom
      if (method === 'ui.window.self') return { connId: 1 }
      if (method === 'quirky.repo/show') {
        const selected = repos.find((entry) => entry.id === params.repo) ?? repo(String(params.repo))
        return details ?? { repo: selected, settings: projectSettings, hooks: effectiveHooks }
      }
      if (method === 'quirky.worktree/projectMetadata') return {
        repoId: String(params.repo),
        identity: { displayName: null, icon: null, color: null, trackerProject: null },
        externalVisibility: 'inherit',
        effectiveExternalVisibility: 'hide',
        externalInboxSuppressed: false,
        sharedDirectories: []
      }
      if (method === 'quirky.hosting/projects') return { projects: [], partialFailures: [], truncated: false }
      if (method === 'quirky.repo/hooks') return effectiveHooks
      if (method === 'quirky.worktree/suggestName') return { name: `generated-${String(params.repo)}` }
      if (method === 'quirky.worktree/create') {
        const created: Worktree = {
          ...main(String(params.repo), 'wt-created'),
          isMain: false,
          name: typeof params.name === 'string' ? params.name : 'created',
          path: `/worktrees/${String(params.name ?? 'created')}`,
          createdBy: 'window'
        }
        return { worktree: created, warnings: [], setup: { ran: 'none' } } satisfies WorktreeCreateResult
      }
      if (method === 'quirky.repo/set' || method === 'quirky.repo/trustHooks') return { ok: true }
      if (method === 'quirky.hosting/listWorkItems') return { items: [], partial: false }
      if (method === 'quirky.git/branches') return { refs: [], current: null }
      if (method === 'quirky.hosting/worktreeSource') {
        const reference = params.reference
        if (reference === '#3' || reference === PR_URL) return prSource
        if (reference === ISSUE_URL) return issueSource
        throw new Error(`No GitHub work item matches ${String(reference)}`)
      }
      if (method === 'quirky.agents/list') throw new Error('agent catalog unavailable')
      if (method === 'plugin.list') return []
      throw new Error(`unexpected UI call ${method}`)
    },
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    mountView() { return () => {} },
    openView(id: string, input?: unknown) {
      opened.push({ id, input })
    },
    toast(title: string, body: string) {
      toasts.push({ title, body })
    },
    log() {},
    subscribe: () => () => {},
    onConnection: () => () => {},
    getSetting: () => undefined
  } as unknown as UiPluginContext
  return { context, calls, opened, toasts }
}

const roots: Root[] = []
let host: HTMLElement

// React DOM detects browser support at import time, so load it only after Happy DOM is registered.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const react = await import('react')
  act = react.act
  createElement = react.createElement
  const [reactDom, createDialog, actions, projectSettings, report, tree, trust] = await Promise.all([
    import('react-dom/client'),
    import('../src/CreateDialog'),
    import('../src/actions'),
    import('../src/ProjectSettingsDialog'),
    import('../src/report'),
    import('../src/Tree'),
    import('../src/TrustDialog')
  ])
  createRoot = reactDom.createRoot
  CreateDialog = createDialog.CreateDialog
  createWorkspace = actions.createWorkspace
  ProjectSettingsDialog = projectSettings.ProjectSettingsDialog
  buildTreeModel = report.buildTreeModel
  Tree = tree.Tree
  TrustDialog = trust.TrustDialog
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.replaceChildren()
})

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
  throw new Error('UI did not reach the expected state')
}

function element(): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  return host
}

function labelField<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(root: ParentNode, label: string): T | undefined {
  const holder = [...root.querySelectorAll<HTMLLabelElement>('label')]
    .find((item) => item.textContent?.replace(/\s+/g, ' ').trim() === label)
  return (holder?.control ?? holder?.querySelector('input, textarea, select')) as T | undefined
}
function button(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
}
function buttonContaining(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(text))
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
      : target instanceof HTMLInputElement
        ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        : undefined
    if (!setter) throw new Error('expected an input or textarea control')
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

function mountCreate(options: AppOptions = {}, initialRepoId = 'r1') {
  const app = makeApp(options)
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  let props = {
    context: app.context,
    repos,
    worktrees: mains,
    repoId: initialRepoId,
    onRepoChange: (_repoId: string) => {},
    onClose: () => {},
    onPending: (_repoId: string, name: string) => {
      pending.push(name)
      return () => {}
    },
    hooks: {
      askTrust: async () => 'cancel' as const,
      showFallback: (_worktreeId: string, _message: string) => {}
    }
  }
  const pending: string[] = []
  const render = async (changes: Partial<typeof props> = {}) => {
    props = { ...props, ...changes }
    await act(async () => {
      root.render(createElement(CreateDialog, props))
      await Promise.resolve()
    })
  }
  const ready = (async () => {
    await act(async () => {
      root.render(createElement(CreateDialog, props))
      await Promise.resolve()
    })
    await flush()
  })()
  return { ...app, element, pending, render, ready }
}

const item = (kind: 'issue' | 'pullRequest', number: number, title: string, url: string, extra: Record<string, unknown> = {}) => ({
  kind,
  number,
  title,
  url,
  state: 'open',
  labels: [],
  ...extra
})

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

test('Smart # references resolve authoritatively and create from the canonical PR URL', async () => {
  const h = mountCreate({ onCall: (method, params) => (method === 'quirky.hosting/worktreeSource' ? prSource : undefined) })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'Name')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Base')!, 'release')
  await click(button(dialog, 'Advanced')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Branch name')!, 'custom-pr-branch')
  await click(button(dialog, 'Branch')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Existing branch')!, 'local-branch')
  await click(button(dialog, 'Smart')!)
  const smart = labelField<HTMLInputElement>(dialog, 'Name')!
  await setText(smart, '#3')
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))

  expect(h.calls.find((call) => call.method === 'quirky.hosting/worktreeSource')?.params).toEqual({ worktree: 'wt-main', reference: '#3' })
  expect(dialog.textContent).toContain('Reword the README')
  expect(dialog.textContent).toContain('feat/conflict')
  expect(button(dialog, 'Use text as workspace name')).toBeUndefined()
  expect(labelField(dialog, 'Base')).toBeUndefined()
  expect(labelField(dialog, 'Existing branch')).toBeUndefined()

  await click(button(dialog, 'Create')!)
  const create = h.calls.find((call) => call.method === 'quirky.worktree/create')!
  expect(create.params).toMatchObject({ repo: 'r1', github: PR_URL })
  expect(create.params).not.toHaveProperty('base')
  expect(create.params).not.toHaveProperty('branch')
  expect(create.params).not.toHaveProperty('branchName')
  expect(create.params).not.toHaveProperty('head')
  expect(h.pending).toEqual(['Reword the README'])
})

test('a pasted GitHub PR URL is an authoritative source lookup', async () => {
  const h = mountCreate({ onCall: (method, params) => (method === 'quirky.hosting/worktreeSource' && params.reference === PR_URL ? prSource : undefined) })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, PR_URL)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))
  expect(h.calls.find((call) => call.method === 'quirky.hosting/worktreeSource')?.params).toEqual({ worktree: 'wt-main', reference: PR_URL })
  await click(button(dialog, 'Create')!)
  expect(h.calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({ github: PR_URL })
})

test('GitHub Enterprise work-item URLs stay authoritative when the configured host rejects them', async () => {
  const reference = 'https://github.enterprise.example/acme/api/pull/7'
  const h = mountCreate({
    onCall: (method) => (method === 'quirky.hosting/worktreeSource' ? Promise.reject(new Error('Repository host is not configured for this project')) : undefined)
  })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, reference)
  await waitFor(() => dialog.querySelector('[role="alert"]'))

  expect(h.calls.find((call) => call.method === 'quirky.hosting/worktreeSource')?.params).toEqual({ worktree: 'wt-main', reference })
  expect(dialog.textContent).toContain('Repository host is not configured for this project')
  expect(button(dialog, 'Use text as workspace name')).toBeUndefined()
  expect(button(dialog, 'Create')?.disabled).toBe(true)
  expect(h.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
})

test('GitHub search shows mixed labelled items, selected source, external link, clear, and issue base option', async () => {
  const rows = [
    item('pullRequest', 3, 'Reword the README', PR_URL, { labels: ['docs'], headRefName: 'feat/conflict' }),
    item('issue', 4, 'Add a multiply function', ISSUE_URL, { labels: ['enhancement'] })
  ]
  const h = mountCreate({
    onCall: (method, params) => {
      if (method === 'quirky.hosting/listWorkItems') return { items: rows, partial: false }
      if (method === 'quirky.hosting/worktreeSource') return params.reference === PR_URL ? prSource : issueSource
      return undefined
    }
  })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'GitHub')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'multiply')
  await waitFor(() => buttonContaining(dialog, 'Add a multiply function'))

  expect(dialog.textContent).toContain('Pull request')
  expect(dialog.textContent).toContain('Issue')
  expect(dialog.textContent).toContain('enhancement')
  const searchCall = h.calls.find((call) => call.method === 'quirky.hosting/listWorkItems' && call.params.query === 'multiply')!
  expect(searchCall.params).toMatchObject({ worktree: 'wt-main', query: 'multiply' })

  await click(buttonContaining(dialog, 'PR #3')!)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))
  expect(dialog.querySelector(`a[href="${PR_URL}"]`)?.textContent).toContain('Open')
  expect(dialog.textContent).toContain('feat/conflict')
  await click(button(dialog, 'Clear source')!)
  expect(dialog.querySelector('section[aria-label="Chosen GitHub source"]')).toBeNull()

  await click(buttonContaining(dialog, 'Issue #4')!)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))
  expect(labelField(dialog, 'Base')).toBeDefined()
  await setText(labelField<HTMLInputElement>(dialog, 'Base')!, 'release')
  await click(button(dialog, 'Advanced')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Display name')!, 'Multiply task')
  await setText(labelField<HTMLInputElement>(dialog, 'Branch name')!, 'issue/multiply')
  await setText(labelField<HTMLTextAreaElement>(dialog, 'Note')!, 'Keep the command notes')
  await click(button(dialog, 'Create')!)
  expect(h.calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({
    repo: 'r1',
    github: ISSUE_URL,
    base: 'release',
    displayName: 'Multiply task',
    branchName: 'issue/multiply',
    comment: 'Keep the command notes'
  })
})

test('an issue-derived agent prompt keeps its raw URL as an unsubmitted draft by default', async () => {
  const h = mountCreate({
    onCall: (method, params) => {
      if (method === 'quirky.hosting/listWorkItems') return { items: [item('issue', 4, 'Add a multiply function', ISSUE_URL)], partial: false }
      if (method === 'quirky.hosting/worktreeSource') return issueSource
      return undefined
    }
  })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'GitHub')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'multiply')
  await waitFor(() => buttonContaining(dialog, 'Issue #4'))
  await click(buttonContaining(dialog, 'Issue #4')!)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))
  await setSelect(labelField<HTMLSelectElement>(dialog, 'Agent')!, 'claude')

  const submit = labelField<HTMLInputElement>(dialog, 'Submit prompt automatically')!
  expect(submit.checked).toBe(false)
  await click(button(dialog, 'Create')!)
  const params = h.calls.find((call) => call.method === 'quirky.worktree/create')?.params
  expect(params).toMatchObject({ github: ISSUE_URL, agent: 'claude', prompt: ISSUE_URL, submitPrompt: false })
})

test('a person can explicitly submit an issue-derived prompt and generic prompts remain submitted by default', async () => {
  const issue = mountCreate({
    onCall: (method) => {
      if (method === 'quirky.hosting/listWorkItems') return { items: [item('issue', 4, 'Add a multiply function', ISSUE_URL)], partial: false }
      if (method === 'quirky.hosting/worktreeSource') return issueSource
      return undefined
    }
  })
  await issue.ready
  let dialog = issue.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'GitHub')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'multiply')
  await waitFor(() => buttonContaining(dialog, 'Issue #4'))
  await click(buttonContaining(dialog, 'Issue #4')!)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))
  await setSelect(labelField<HTMLSelectElement>(dialog, 'Agent')!, 'claude')
  await click(labelField<HTMLInputElement>(dialog, 'Submit prompt automatically')!)
  await click(button(dialog, 'Create')!)
  expect(issue.calls.find((call) => call.method === 'quirky.worktree/create')?.params)
    .toMatchObject({ github: ISSUE_URL, agent: 'claude', prompt: ISSUE_URL, submitPrompt: true })

  const generic = mountCreate()
  await generic.ready
  dialog = generic.element.querySelector('[role="dialog"]')!
  await setSelect(labelField<HTMLSelectElement>(dialog, 'Agent')!, 'claude')
  await setText(labelField<HTMLTextAreaElement>(dialog, 'Prompt')!, 'Implement the requested change.')
  const genericSubmit = labelField<HTMLInputElement>(dialog, 'Submit prompt automatically')!
  expect(genericSubmit.checked).toBe(true)
  await click(button(dialog, 'Create')!)
  expect(generic.calls.find((call) => call.method === 'quirky.worktree/create')?.params)
    .toMatchObject({ agent: 'claude', prompt: 'Implement the requested change.', submitPrompt: true })
})

test('GitHub search exposes loading, empty, partial and error states', async () => {
  const initial = deferred<unknown>()
  const denied = deferred<unknown>()
  const h = mountCreate({
    onCall: (method, params) => {
      if (method !== 'quirky.hosting/listWorkItems') return undefined
      if (params.query === '') return initial.promise
      if (params.query === 'denied') return denied.promise
      if (params.query === 'partial') {
        return {
          items: [item('issue', 4, 'Partial issue', ISSUE_URL)],
          partial: true,
          errors: { prs: { reason: 'rate_limited', message: 'Pull request search is rate-limited.' } }
        }
      }
      return { items: [], partial: false }
    }
  })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'GitHub')!)
  expect(dialog.querySelector('[role="status"]')?.textContent?.toLowerCase()).toContain('loading')
  await act(async () => initial.resolve({ items: [], partial: false }))
  await waitFor(() => dialog.textContent?.includes('No GitHub issues or pull requests found.'))

  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'denied')
  await act(async () => denied.reject(new Error('GitHub access denied')))
  await waitFor(() => dialog.querySelector('[role="alert"]'))
  expect(dialog.textContent).toContain('GitHub access denied')

  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'partial')
  await waitFor(() => buttonContaining(dialog, 'Partial issue'))
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Pull request search is rate-limited.')
})

test('a folder project rejects explicit GitHub input instead of creating a folder from it', async () => {
  const h = mountCreate({}, 'rf')
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  expect(button(dialog, 'GitHub')).toBeUndefined()
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, PR_URL)
  expect(dialog.querySelector('[role="alert"]')?.textContent).toMatch(/GitHub.*Git repository/i)
  expect(button(dialog, 'Create')?.disabled).toBe(true)
  expect(h.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
})

test('late GitHub search responses cannot replace the current query results', async () => {
  const old = deferred<unknown>()
  const current = deferred<unknown>()
  const h = mountCreate({
    onCall: (method, params) => {
      if (method !== 'quirky.hosting/listWorkItems') return undefined
      if (params.query === 'old') return old.promise
      if (params.query === 'current') return current.promise
      return { items: [], partial: false }
    }
  })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'GitHub')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'old')
  await waitFor(() => h.calls.some((call) => call.method === 'quirky.hosting/listWorkItems' && call.params.query === 'old'))
  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'current')
  await waitFor(() => h.calls.some((call) => call.method === 'quirky.hosting/listWorkItems' && call.params.query === 'current'))

  await act(async () => old.resolve({ items: [item('issue', 99, 'Obsolete result', 'https://github.com/acme/api/issues/99')], partial: false }))
  await flush()
  expect(dialog.textContent).not.toContain('Obsolete result')
  await act(async () => current.resolve({ items: [item('issue', 4, 'Current result', ISSUE_URL)], partial: false }))
  await waitFor(() => buttonContaining(dialog, 'Current result'))
  expect(dialog.textContent).not.toContain('Obsolete result')
})

test('a pending lookup from the prior project cannot select a source after switching projects', async () => {
  const sourceRequest = deferred<unknown>()
  const h = mountCreate({ onCall: (method, params) => (method === 'quirky.hosting/worktreeSource' && params.worktree === 'wt-main' ? sourceRequest.promise : undefined) })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, '#3')
  await waitFor(() => h.calls.some((call) => call.method === 'quirky.hosting/worktreeSource'))
  await h.render({ repoId: 'r2' })
  await act(async () => sourceRequest.resolve(prSource))
  await flush()
  expect(dialog.querySelector('section[aria-label="Chosen GitHub source"]')).toBeNull()
  expect(dialog.textContent).not.toContain('Reword the README')
})

test('a failed explicit GitHub lookup stays an error instead of becoming a workspace name', async () => {
  const h = mountCreate({ onCall: (method) => (method === 'quirky.hosting/worktreeSource' ? Promise.reject(new Error('GitHub item not found')) : undefined) })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, '#404')
  await waitFor(() => dialog.querySelector('[role="alert"]'))
  expect(dialog.textContent).toContain('GitHub item not found')
  expect(button(dialog, 'Use text as workspace name')).toBeUndefined()
  expect(button(dialog, 'Create')?.disabled).toBe(true)
  expect(h.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
})

test('plain Smart text offers an explicit name choice and branch/name modes retain existing behavior', async () => {
  const h = mountCreate()
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  const smart = labelField<HTMLInputElement>(dialog, 'Name')!
  await setText(smart, 'quick fix')
  expect(button(dialog, 'Use text as workspace name')).toBeDefined()
  expect(button(dialog, 'Search GitHub')).toBeDefined()
  expect(button(dialog, 'Search branches')).toBeDefined()
  expect(button(dialog, 'Create')?.disabled).toBe(false)
  await click(button(dialog, 'Use text as workspace name')!)
  expect(labelField<HTMLInputElement>(dialog, 'Name')?.value).toBe('quick fix')
  await click(button(dialog, 'Create')!)
  expect(h.calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({ name: 'quick fix' })
  expect(h.calls.find((call) => call.method === 'quirky.worktree/create')?.params).not.toHaveProperty('github')

  const branch = mountCreate()
  await branch.ready
  const branchDialog = branch.element.querySelector('[role="dialog"]')!
  await click(button(branchDialog, 'Branch')!)
  await setText(labelField<HTMLInputElement>(branchDialog, 'Existing branch')!, 'feat/local')
  expect(labelField(branchDialog, 'Base')).toBeUndefined()
  await click(button(branchDialog, 'Create')!)
  expect(branch.calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({ branch: 'feat/local' })
})

test('Smart text searches local and remote branches through the public Git API', async () => {
  const refs = [
    { name: 'feat/conflict', kind: 'local' },
    { name: 'origin/feat/conflict', kind: 'remote' }
  ]
  const h = mountCreate({ onCall: (method) => (method === 'quirky.git/branches' ? { refs, current: 'main' } : undefined) })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, 'feat/conflict')
  await click(button(dialog, 'Search branches')!)
  await waitFor(() => buttonContaining(dialog, 'origin/feat/conflict'))
  expect(h.calls.find((call) => call.method === 'quirky.git/branches' && call.params.query === 'feat/conflict')?.params).toMatchObject({
    worktree: 'wt-main',
    query: 'feat/conflict'
  })

  await click(buttonContaining(dialog, 'origin/feat/conflict')!)
  expect(labelField<HTMLInputElement>(dialog, 'Existing branch')?.value).toBe('origin/feat/conflict')
  await click(button(dialog, 'Create')!)
  expect(h.calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({ branch: 'origin/feat/conflict' })
})

test('Name mode keeps blank generated-name creation available', async () => {
  const h = mountCreate()
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'Name')!)
  const name = await waitFor(() => {
    const field = labelField<HTMLInputElement>(dialog, 'Name')
    return field?.placeholder ? field : null
  })
  const suggestion = name.placeholder
  expect(name.value).toBe('')
  expect(button(dialog, 'Create')?.disabled).toBe(false)
  await click(button(dialog, 'Create')!)
  expect(h.calls.find((call) => call.method === 'quirky.worktree/create')?.params).not.toHaveProperty('name')
  expect(h.pending).toEqual([suggestion])
})

test('create more resets the selected source, name, query, agent and setup choice', async () => {
  const setup: EffectiveHooks = {
    ...noHooks,
    setup: { text: 'echo setup', source: 'local', badge: 'local', shared: null }
  }
  const settingsWithSetup = { ...settings, setupPolicy: 'ask' as const }
  const rows = [item('issue', 4, 'Add a multiply function', ISSUE_URL)]
  const h = mountCreate({
    hooks: setup,
    settings: settingsWithSetup,
    onCall: (method) => (method === 'quirky.hosting/listWorkItems' ? { items: rows, partial: false } : undefined)
  })
  await h.ready
  const dialog = h.element.querySelector('[role="dialog"]')!
  await click(button(dialog, 'GitHub')!)
  await setText(labelField<HTMLInputElement>(dialog, 'Search GitHub')!, 'multiply')
  await waitFor(() => buttonContaining(dialog, 'Issue #4'))
  await click(buttonContaining(dialog, 'Issue #4')!)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]'))
  await setText(labelField<HTMLInputElement>(dialog, 'Name')!, 'custom-name')
  await setSelect(labelField<HTMLSelectElement>(dialog, 'Agent')!, 'claude')
  await click(labelField<HTMLInputElement>(dialog, 'Create more')!)
  await click(button(dialog, 'Advanced')!)
  await click(button(dialog, 'Run setup now')!)
  await click(button(dialog, 'Create')!)
  await waitFor(() => dialog.querySelector('section[aria-label="Chosen GitHub source"]') === null)

  expect(dialog.querySelector('section[aria-label="Chosen GitHub source"]')).toBeNull()
  expect(labelField<HTMLInputElement>(dialog, 'Agent')?.value).toBe('')
  expect(button(dialog, 'Create')?.disabled).toBe(true)
  await click(button(dialog, 'Name')!)
  expect(labelField<HTMLInputElement>(dialog, 'Name')?.value).toBe('')
  await click(button(dialog, 'GitHub')!)
  expect(labelField<HTMLInputElement>(dialog, 'Search GitHub')?.value).toBe('')
  expect(h.calls.filter((call) => call.method === 'quirky.worktree/create')).toHaveLength(1)
})
test('shared setup and issue trust choices accumulate across create retries', async () => {
  const calls: Call[] = []
  const questions: string[] = []
  let attempt = 0
  const context = {
    getLayout: () => ({ view: null }),
    openView() {},
    toast() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 1 }
      if (method === 'quirky.worktree/create') {
        attempt += 1
        if (attempt === 1) throw Object.assign(new Error('setup trust required'), { data: { reason: 'hooks-untrusted', repo: 'r1', kind: 'setup', script: 'echo setup', hash: 'setup-hash', ref: 'main' } })
        if (attempt === 2) throw Object.assign(new Error('issue trust required'), { data: { reason: 'hooks-untrusted', repo: 'r1', kind: 'issue', script: 'gh issue develop {{issue}}', hash: 'issue-hash', ref: 'main' } })
        return { worktree: { id: 'created', name: 'created', path: '/created' }, warnings: [], setup: { ran: 'none' } }
      }
      if (method === 'quirky.repo/trustHooks') return { ok: true }
      throw new Error(`unexpected call ${method}`)
    }
  } as unknown as UiPluginContext
  const result = await createWorkspace(context, { repo: 'r1', github: ISSUE_URL }, {
    askTrust: async (request) => {
      questions.push(request.kind)
      return 'run'
    },
    showFallback() {}
  })

  expect(result).not.toBeNull()
  expect(questions).toEqual(['setup', 'issue'])
  const creates = calls.filter((call) => call.method === 'quirky.worktree/create')
  expect(creates[1]?.params).toMatchObject({ trustSetup: true, trustSetupHash: 'setup-hash' })
  expect(creates[2]?.params).toMatchObject({ trustSetup: true, trustSetupHash: 'setup-hash', trustIssueCommand: true, trustIssueCommandHash: 'issue-hash' })
})

test('Run once binds consent to the shown hash and asks again when the shared script changes', async () => {
  const questions: string[] = []
  let current = { script: 'echo A', hash: 'hash-A', ref: 'ref-A' }
  const context = {
    getLayout: () => ({ view: null }),
    openView() {},
    toast() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'ui.window.self') return { connId: 1 }
      if (method !== 'quirky.worktree/create') throw new Error(`unexpected call ${method}`)
      const currentCallTrust = params.trustSetup === true && (params.trustSetupHash === undefined || params.trustSetupHash === current.hash)
      if (!currentCallTrust) {
        throw Object.assign(new Error('shared setup is untrusted'), {
          data: { reason: 'hooks-untrusted', repo: 'r1', kind: 'setup', script: current.script, hash: current.hash, ref: current.ref }
        })
      }
      return { worktree: { id: 'created', name: 'created', path: '/created' }, warnings: [], setup: { ran: 'none' } }
    }
  } as unknown as UiPluginContext

  const result = await createWorkspace(context, { repo: 'r1' }, {
    askTrust: async (request) => {
      questions.push(request.script)
      if (request.script === 'echo A') current = { script: 'echo B', hash: 'hash-B', ref: 'ref-B' }
      return 'run'
    },
    showFallback() {}
  })

  expect(result).not.toBeNull()
  expect(questions).toEqual(['echo A', 'echo B'])
})
test('Always trust on changed content replaces the earlier one-time pin', async () => {
  const questions: string[] = []
  let current = { script: 'echo A', hash: 'hash-A', ref: 'ref-A' }
  const persisted: { hash: string | null } = { hash: null }
  const context = {
    getLayout: () => ({ view: null }),
    openView() {},
    toast() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'ui.window.self') return { connId: 1 }
      if (method === 'quirky.repo/trustHooks') {
        if (params.ref === current.ref) persisted.hash = current.hash
        return { ok: true }
      }
      if (method !== 'quirky.worktree/create') throw new Error(`unexpected call ${method}`)
      const stalePin = params.trustSetup === true && params.trustSetupHash !== undefined && params.trustSetupHash !== current.hash
      const currentCallTrust = params.trustSetup === true && (params.trustSetupHash === undefined || params.trustSetupHash === current.hash)
      if (stalePin || (persisted.hash !== current.hash && !currentCallTrust)) {
        throw Object.assign(new Error('shared setup is untrusted'), {
          data: { reason: 'hooks-untrusted', repo: 'r1', kind: 'setup', script: current.script, hash: current.hash, ref: current.ref }
        })
      }
      return { worktree: { id: 'created', name: 'created', path: '/created' }, warnings: [], setup: { ran: 'none' } }
    }
  } as unknown as UiPluginContext

  const result = await createWorkspace(context, { repo: 'r1' }, {
    askTrust: async (request) => {
      questions.push(request.script)
      if (request.script === 'echo A') {
        current = { script: 'echo B', hash: 'hash-B', ref: 'ref-B' }
        return 'run'
      }
      if (questions.length > 2) throw new Error('the changed script was asked about more than once')
      return 'always'
    },
    showFallback() {}
  })

  expect(result).toMatchObject({ worktree: { id: 'created' } })
  expect(questions).toEqual(['echo A', 'echo B'])
  expect(persisted.hash).toBe('hash-B')
})

test('Run once and Always cannot proceed when the untrusted-script error has no hash', async () => {
  for (const choice of ['run', 'always'] as const) {
    const calls: Call[] = []
    const toasts: string[] = []
    const context = {
      getLayout: () => ({ view: null }),
      openView() {},
      toast: (_title: string, message: string) => toasts.push(message),
      async call(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params })
        if (method === 'ui.window.self') return { connId: 1 }
        if (method === 'quirky.worktree/create') {
          throw Object.assign(new Error('shared setup is untrusted'), {
            data: { reason: 'hooks-untrusted', repo: 'r1', kind: 'setup', script: 'echo setup', ref: 'main' }
          })
        }
        throw new Error(`unexpected call ${method}`)
      }
    } as unknown as UiPluginContext

    const result = await createWorkspace(context, { repo: 'r1' }, {
      askTrust: async () => choice,
      showFallback() {}
    })

    expect(result).toBeNull()
    expect(calls.filter((call) => call.method === 'quirky.worktree/create')).toHaveLength(1)
    expect(calls.some((call) => call.method === 'quirky.repo/trustHooks')).toBe(false)
    expect(toasts.some((message) => /hash/i.test(message))).toBe(true)
  }
})

test('issue trust dialog identifies the issue command', async () => {
  const root = createRoot(element())
  roots.push(root)
  await act(async () => root.render(createElement(TrustDialog, {
    request: { repoId: 'r1', kind: 'issue', script: 'gh issue develop {{issue}}', changed: true },
    project: 'api',
    onChoose: () => {}
  })))
  const dialog = host.querySelector('[role="dialog"]')!
  expect(dialog.textContent?.toLowerCase()).toContain('issue command')
  expect(button(dialog, 'Run issue command')).toBeDefined()
})

test('Project Settings edits the local GitHub issue command and shows shared command trust', async () => {
  const shared: EffectiveHooks = {
    ...noHooks,
    issueCommand: {
      text: 'gh issue develop {{issue}}',
      source: 'shared',
      badge: 'shared',
      shared: { text: 'gh issue develop {{issue}}', hash: 'sha256:test', trusted: false, changed: true }
    }
  }
  const details: RepoDetails = {
    repo: repos[0]!,
    settings,
    hooks: shared
  }
  const h = makeApp({ details, hooks: shared })
  const root = createRoot(element())
  roots.push(root)
  let closed = false
  await act(async () => root.render(createElement(ProjectSettingsDialog, { context: h.context, repo: repos[0]!, onClose: () => { closed = true } })))
  const dialog = await waitFor(() => host.querySelector('[role="dialog"]'))
  const command = await waitFor(() => labelField<HTMLTextAreaElement>(dialog, 'Custom GitHub issue command'))
  expect(dialog.textContent).toMatch(/shared/i)
  expect(dialog.textContent).toMatch(/trust|approval|changed/i)
  await setText(command, 'gh issue develop --issue {{issue}} {{artifact_url}}')
  await click(button(dialog, 'Save')!)
  await waitFor(() => closed)
  expect(h.calls.find((call) => call.method === 'quirky.repo/set')?.params).toMatchObject({
    repo: 'r1',
    issueCommand: 'gh issue develop --issue {{issue}} {{artifact_url}}'
  })
})

test('sidebar renders a durable linked PR as an external link beside the editable workspace', async () => {
  const linked: Worktree = { ...main(), isMain: false, name: 'Reword the README', linkedPR: prLink, comment: 'Keep this editable note' }
  const linkedIssueWorktree: Worktree = { ...main('r1', 'wt-issue'), isMain: false, name: 'Add a multiply function', linkedIssue: issueLink }
  const model = buildTreeModel([repos[0]!], [], [linked, linkedIssueWorktree], [])
  const app = makeApp()
  const root = createRoot(element())
  roots.push(root)
  await act(async () => root.render(createElement(Tree, {
    context: app.context,
    model,
    groups: [],
    sessions: [],
    selectedId: null,
    automationExpandedId: null,
    automationAvailability: null,
    onToggleAutomationDetails() {},
    now: 0,
    separatorEnabled: false,
    statusDefinitions: DEFAULT_WORKTREE_STATUSES.map((status) => ({ ...status })),
    projectIdentities: {},
    onDropPreviewChange() {},
    onSeparatorStateChange() {},
    openDialog() {},
    requestDelete() {}
  })))
  const anchor = host.querySelector<HTMLAnchorElement>(`a[href="${PR_URL}"]`)
  expect(anchor?.textContent).toContain('PR #3')
  expect(anchor?.target).toBe('_blank')
  expect(anchor?.rel).toContain('noreferrer')
  const workspaceButton = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find((button) => button.getAttribute('aria-label') === 'Open Reword the README')
  expect(workspaceButton?.textContent).toContain('Reword the README')
  const issueAnchor = host.querySelector<HTMLAnchorElement>(`a[href="${ISSUE_URL}"]`)
  expect(issueAnchor?.textContent).toContain('Issue #4')
})
