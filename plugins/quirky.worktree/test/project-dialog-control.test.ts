import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { EffectiveHooks, ProjectSettings, Repo, RepoDetails, UiPluginContext, Worktree } from '@quirky/protocol'
import type { act as ReactAct, createElement as ReactCreateElement } from 'react'
import type { createRoot as ReactCreateRoot } from 'react-dom/client'
import { dispatchUiControl, requestUiControl, registerUiControlScope, UI_CONTROL_COMMAND, type ScopedUiControlArgs, type ScopedUiControlInput } from '../src/ui-control'
import type { CreateDialog as CreateDialogComponent } from '../src/CreateDialog'


const INVALID_ARGS_MESSAGE = 'Worktree UI control needs a known action and its target.'
const INVALID_CREATE_MESSAGE = 'Invalid create-dialog control.'
const WINDOW_RESULT_MESSAGE = 'The window returned no UI control result.'
const PR_URL = 'https://github.com/acme/api/pull/3'
const ISSUE_URL = 'https://github.com/acme/api/issues/4'

type Params = Record<string, unknown>
type Call = { method: string; params: Params }

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function scoped(scope: string, target: string, operation: string, payload?: Record<string, unknown>): ScopedUiControlInput {
  return { action: 'control', scope, target, operation, ...(payload === undefined ? {} : { payload }) }
}
function emptyContext(): UiPluginContext {
  return {} as unknown as UiPluginContext
}
function contextWith(call: (method: string, params: Params) => Promise<unknown>, executeCommand: () => unknown = () => {
  throw new Error('executeCommand must not be used')
}): UiPluginContext {
  return { call, executeCommand } as unknown as UiPluginContext
}
function expectInvalidArgs(context: UiPluginContext, args: unknown): void {
  expect(() => dispatchUiControl(context, args)).toThrow(INVALID_ARGS_MESSAGE)
}

const repo = (id: string, kind: Repo['kind'] = 'git'): Repo => ({
  id, name: id, path: `/repos/${id}`, addedAt: 0, kind, displayName: null, groupId: null
})
const repos = [repo('r1'), repo('r2'), repo('rf', 'folder')]
const main = (repoId: string, id: string): Worktree => ({
  id, repoId, path: `/repos/${repoId}`, branch: 'main', head: 'b'.repeat(40), isMain: true, name: 'main', kind: 'git',
  displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false, parentId: null, createdAt: 0,
  createdBy: 'external', baseRef: null, keepBranch: false, removing: false, groupId: null, projectGroupId: null,
  lastActivityAt: 0, instanceId: `fixture:${id}`
})
const mains = [main('r1', 'wt-r1'), main('r2', 'wt-r2')]
const settings: ProjectSettings = {
  defaultBase: 'main', worktreeLocation: null, setupPolicy: 'skip-by-default', agentStartup: null,
  commandSource: null, setupScript: '', archiveScript: '', issueCommand: ''
}
const noHooks: EffectiveHooks = {
  file: null, setup: null, archive: null, issueCommand: null, agentStartup: null, sharedDirectories: [], warnings: []
}
const workItems = [
  { kind: 'issue', number: 4, title: 'Add a multiply function', url: ISSUE_URL, labels: [], headRefName: null },
  { kind: 'pullRequest', number: 3, title: 'Reword the README', url: PR_URL, labels: [], headRefName: 'feat/docs' }
]
const source = {
  item: { provider: 'github', kind: 'issue', number: 4, title: 'Add a multiply function', url: ISSUE_URL, repository: { host: 'github.com', owner: 'acme', repo: 'api' } },
  head: null,
  base: null
}

type AppOptions = {
  onCall?(method: string, params: Params): unknown
  hooks?: EffectiveHooks
  settings?: ProjectSettings
  createResult?: unknown
  windowFailure?: Error | null
}

type Mounted = ReturnType<typeof mountCreate>
let act: typeof ReactAct
let createElement: typeof ReactCreateElement
let createRoot: typeof ReactCreateRoot
let CreateDialog: typeof CreateDialogComponent
const roots: Array<{ unmount(): void }> = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const react = await import('react')
  act = react.act
  createElement = react.createElement
  createRoot = (await import('react-dom/client')).createRoot
  ;({ CreateDialog } = await import('../src/CreateDialog'))
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
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}
async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    await flush()
    const result = read()
    if (result !== null && result !== undefined && result !== false) return result as T
  }
  throw new Error('UI did not reach the expected state')
}
async function click(target: HTMLElement | undefined | null): Promise<void> {
  if (!target) throw new Error('Expected button was not rendered')
  await act(async () => { target.click(); await Promise.resolve() })
  await flush()
}
async function setText(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
function button(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
}
function buttonContaining(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes(text))
}
function input(root: ParentNode, id: string): HTMLInputElement | undefined {
  return root.querySelector<HTMLInputElement>(`#${id}`) ?? undefined
}

function mountCreate(options: AppOptions = {}, initialRepoId = 'r1') {
  const calls: Call[] = []
  const logs: string[] = []
  const executed: string[] = []
  let context!: UiPluginContext
  const rawContext = {
    async call(method: string, params: Params = {}): Promise<unknown> {
      calls.push({ method, params })
      const custom = options.onCall?.(method, params)
      if (custom !== undefined) return await custom
      if (method === 'ui.window.self') return { connId: 7 }
      if (method === 'ui.window.command.run') {
        if (options.windowFailure) throw options.windowFailure
        if (params.connId !== 7 || params.id !== UI_CONTROL_COMMAND) throw new Error('Unexpected window command descriptor')
        return { result: dispatchUiControl(context, params.args) }
      }
      if (method === 'quirky.repo/show') {
        return { settings: options.settings ?? settings } satisfies Partial<RepoDetails>
      }
      if (method === 'quirky.repo/hooks') return options.hooks ?? noHooks
      if (method === 'quirky.worktree/availableHosts') return { hosts: [] }
      if (method === 'quirky.worktree/suggestName') return { name: `generated-${String(params.repo)}` }
      if (method === 'quirky.worktree/prefetchCreate') return {}
      if (method === 'quirky.agents/list') return { agents: [] }
      if (method === 'quirky.hosting/listWorkItems') return { items: workItems, partial: false }
      if (method === 'quirky.git/branches') return { refs: [{ name: 'release/next', kind: 'local' }, { name: 'feat/used', kind: 'local', checkedOutIn: '/worktrees/other' }], current: 'main' }
      if (method === 'quirky.hosting/worktreeSource') return source
      if (method === 'quirky.worktree/create') return options.createResult ?? new Promise(() => {})
      throw new Error(`Unexpected UI call ${method}`)
    },
    executeCommand(id: string) {
      executed.push(id)
      throw new Error('executeCommand must not be used')
    },
    log(message: string) { logs.push(message) },
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    openView() {},
    toast() {},
    subscribe: () => () => {},
    onConnection: () => () => {},
    getSetting: () => undefined
  }
  context = rawContext as unknown as UiPluginContext
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  let props = {
    context,
    repos,
    worktrees: mains,
    repoId: initialRepoId,
    onRepoChange: (_repoId: string) => {},
    onClose: () => {},
    onPending: (_repoId: string, _name: string) => () => {},
    hooks: { askTrust: async () => 'cancel' as const, showFallback: (_id: string, _message: string) => {} }
  }
  const render = async (changes: Partial<typeof props> = {}) => {
    props = { ...props, ...changes }
    await act(async () => { root.render(createElement(CreateDialog, props)); await Promise.resolve() })
    await flush()
  }
  const ready = render()
  return { context, calls, logs, executed, element, root, render, ready }
}

function createEnvelope(operation: string, payload: Record<string, unknown>, target = 'r1'): ScopedUiControlArgs {
  return { action: 'control', scope: 'create-dialog', target, operation, payload }
}

describe('scoped Worktree UI control', () => {
  test('registers arbitrary operations independently by context and scope', () => {
    const contextA = emptyContext()
    const contextB = emptyContext()
    const acceptsTarget = (args: ScopedUiControlArgs) => args.target === 'r1'
    const cleanups = [
      registerUiControlScope(contextA, 'tree-and-menus', acceptsTarget),
      registerUiControlScope(contextA, 'worktrees-section', acceptsTarget),
      registerUiControlScope(contextA, 'group-and-settings-dialogs', acceptsTarget),
      registerUiControlScope(contextB, 'tree-and-menus', acceptsTarget)
    ]
    const tree = scoped('tree-and-menus', 'r1', 'a-future-tree-operation', { custom: 1 })
    const section = scoped('worktrees-section', 'r1', 'a-future-section-operation')
    const groups = scoped('group-and-settings-dialogs', 'r1', 'a-future-group-operation', { arbitrary: true })

    expect(dispatchUiControl(contextA, tree)).toEqual({ ...tree, delivered: 1 })
    expect(dispatchUiControl(contextA, section)).toEqual({ ...section, payload: {}, delivered: 1 })
    expect(dispatchUiControl(contextA, groups)).toEqual({ ...groups, delivered: 1 })
    expect(dispatchUiControl(contextB, tree)).toEqual({ ...tree, delivered: 1 })
    expect(dispatchUiControl(contextB, section).delivered).toBe(0)
    expect(dispatchUiControl(contextA, scoped('tree-and-menus', 'missing', 'anything')).delivered).toBe(0)
    expect(dispatchUiControl(contextA, scoped('unknown-scope', 'r1', 'anything', {})).delivered).toBe(0)
    expect(dispatchUiControl(contextA, { ...tree, unrelated: 'discarded' })).toEqual({ ...tree, delivered: 1 })

    cleanups[0]!()
    cleanups[0]!()
    expect(dispatchUiControl(contextA, tree).delivered).toBe(0)
    expect(dispatchUiControl(contextB, tree).delivered).toBe(1)
    for (const cleanup of cleanups.slice(1)) cleanup()
    expect(dispatchUiControl(contextA, section).delivered).toBe(0)
    expect(dispatchUiControl(contextA, groups).delivered).toBe(0)
  })

  test('counts independent mounts and rejects a blank scope at registration', () => {
    const context = emptyContext()
    const handler = () => true
    const cleanupOne = registerUiControlScope(context, 'create-dialog', handler)
    const cleanupTwo = registerUiControlScope(context, 'create-dialog', handler)
    const args = scoped('create-dialog', 'r1', 'custom-operation', {})

    expect(dispatchUiControl(context, args).delivered).toBe(2)
    cleanupOne()
    expect(dispatchUiControl(context, args).delivered).toBe(1)
    cleanupOne()
    cleanupTwo()
    expect(dispatchUiControl(context, args).delivered).toBe(0)
    expect(() => registerUiControlScope(context, '  ', handler)).toThrow(INVALID_ARGS_MESSAGE)
  })

  test('rejects malformed scoped envelopes before entering any handler', () => {
    const context = emptyContext()
    let received = 0
    registerUiControlScope(context, 'create-dialog', () => { received += 1; return true })
    const valid = scoped('create-dialog', 'r1', 'anything', {})
    const malformed: unknown[] = [
      { ...valid, scope: undefined }, { ...valid, scope: 7 }, { ...valid, scope: '  ' },
      { ...valid, target: undefined }, { ...valid, target: false }, { ...valid, target: '\n ' },
      { ...valid, operation: undefined }, { ...valid, operation: 3 }, { ...valid, operation: '  ' },
      { ...valid, payload: null }, { ...valid, payload: [] }, { ...valid, payload: 1 }, { ...valid, payload: 'x' }
    ]

    for (const args of malformed) expectInvalidArgs(context, args)
    expect(received).toBe(0)
  })

  test('routes scoped requests through the descriptor to their exact context window', async () => {
    const contexts = new Map<number, UiPluginContext>()
    const callsA: Call[] = []
    const callsB: Call[] = []
    const receivedA: ScopedUiControlArgs[] = []
    const receivedB: ScopedUiControlArgs[] = []
    const makeWindow = (connId: number, calls: Call[]): UiPluginContext => {
      let context!: UiPluginContext
      context = contextWith(async (method, params) => {
        calls.push({ method, params })
        if (method === 'ui.window.self') return { connId }
        if (method === 'ui.window.command.run') {
          const target = contexts.get(params.connId as number)
          if (!target) throw new Error(`no live UI window ${String(params.connId)}`)
          return { result: dispatchUiControl(target, params.args) }
        }
        throw new Error(`Unexpected method ${method}`)
      })
      contexts.set(connId, context)
      return context
    }
    const contextA = makeWindow(7, callsA)
    const contextB = makeWindow(9, callsB)
    registerUiControlScope(contextA, 'create-dialog', (args) => { receivedA.push(args); return true })
    registerUiControlScope(contextB, 'create-dialog', (args) => { receivedB.push(args); return true })
    const request: ScopedUiControlInput = scoped('create-dialog', 'r1', 'set-advanced', { open: true })
    const resultA = await requestUiControl(contextA, request)
    const resultB = await requestUiControl(contextB, request)

    expect(resultA).toEqual({ ...request, delivered: 1 })
    expect(resultB).toEqual({ ...request, delivered: 1 })
    expect(callsA.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
      method: 'ui.window.command.run', params: { connId: 7, id: UI_CONTROL_COMMAND, args: request }
    }])
    expect(callsB.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
      method: 'ui.window.command.run', params: { connId: 9, id: UI_CONTROL_COMMAND, args: request }
    }])
    expect(receivedA).toEqual([request])
    expect(receivedB).toEqual([request])
    expect(await requestUiControl(contextA, scoped('create-dialog', 'r1', 'omitted-payload'))).toEqual({
      action: 'control', scope: 'create-dialog', target: 'r1', operation: 'omitted-payload', payload: {}, delivered: 1
    })
  })

  test('applies every visible Create choice through one window-exact request', async () => {
    const routeFor = async (
      options: AppOptions,
      prepare: (h: Mounted) => Promise<HTMLButtonElement>,
      expected: ScopedUiControlArgs
    ) => {
      const h = mountCreate(options)
      await h.ready
      const choice = await prepare(h)
      await click(choice)
      await waitFor(() => h.calls.find((call) => call.method === 'ui.window.command.run'))
      expect(h.calls.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
        method: 'ui.window.command.run',
        params: { connId: 7, id: UI_CONTROL_COMMAND, args: expected }
      }])
      expect(h.executed).toEqual([])
    }
    const setup: EffectiveHooks = { ...noHooks, setup: { text: 'echo setup', source: 'local', badge: 'local', shared: null } }
    const askSettings = { ...settings, setupPolicy: 'ask' as const }

    await routeFor({}, async (h) => button(h.element, 'Advanced')!, createEnvelope('set-advanced', { open: true }))
    for (const [label, mode] of [
      ['Use text as workspace name', 'name'], ['Search branches', 'branch'], ['Search GitHub', 'github']
    ] as const) {
      await routeFor({}, async (h) => {
        await setText(input(h.element, 'create-smart-name')!, '  feature work  ')
        return button(h.element, label)!
      }, createEnvelope('use-smart-text', { text: 'feature work', mode }))
    }
    await routeFor({}, async (h) => {
      await click(button(h.element, 'GitHub'))
      await setText(input(h.element, 'create-github-query')!, 'multiply')
      return waitFor(() => buttonContaining(h.element, 'Issue #4'))
    }, createEnvelope('choose-work-item', { query: 'multiply', url: ISSUE_URL }))
    await routeFor({}, async (h) => {
      await click(button(h.element, 'Branch'))
      await setText(input(h.element, 'create-branch')!, 'release')
      return waitFor(() => buttonContaining(h.element, 'release/next'))
    }, createEnvelope('choose-branch', { query: 'release', branch: 'release/next' }))
    await routeFor({}, async (h) => {
      await setText(input(h.element, 'create-smart-name')!, ISSUE_URL)
      await waitFor(() => h.element.querySelector('section[aria-label="Chosen GitHub source"]'))
      return button(h.element, 'Clear source')!
    }, createEnvelope('clear-source', { url: ISSUE_URL }))
    for (const choice of ['run', 'skip'] as const) {
      const h = mountCreate({ hooks: setup, settings: askSettings })
      await h.ready
      await click(button(h.element, 'Advanced'))
      await click(button(h.element, choice === 'run' ? 'Run setup now' : 'Skip for now'))
      await waitFor(() => h.calls.filter((call) => call.method === 'ui.window.command.run').length === 2)
      const commands = h.calls.filter((call) => call.method === 'ui.window.command.run')
      expect(commands.map((call) => call.params.args)).toEqual([
        createEnvelope('set-advanced', { open: true }),
        createEnvelope('set-setup', { choice })
      ])
      expect(h.executed).toEqual([])
    }
  })

  test('keeps routed source lookup failures in the source error area', async () => {
    const h = mountCreate({
      onCall: (method) => method === 'quirky.hosting/worktreeSource' ? Promise.reject(new Error('No item')) : undefined
    })
    await h.ready
    await click(button(h.element, 'GitHub'))
    await setText(input(h.element, 'create-github-query')!, 'multiply')
    await click(await waitFor(() => buttonContaining(h.element, 'Issue #4')))
    await waitFor(() => h.element.querySelector('.ui-inline-error')?.textContent === 'Could not resolve GitHub work item: No item')

    expect(h.element.querySelector('.ui-inline-error')?.textContent).toBe('Could not resolve GitHub work item: No item')
    expect(h.element.querySelector('.ui-inline-error')?.textContent).not.toContain('Could not change worktree form')
    expect(h.calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)
    expect(h.executed).toEqual([])
  })

  test('uses the current committed Create state for operation and payload guards', async () => {
    const h = mountCreate()
    await h.ready
    const context = h.context
    const invalid: unknown[] = [
      createEnvelope('unknown-operation', {}),
      { ...createEnvelope('set-advanced', { open: true }), payload: { open: true, extra: 1 } },
      createEnvelope('set-advanced', { open: 'yes' }),
      { ...createEnvelope('use-smart-text', { text: 'name', mode: 'name' }), payload: { text: 'name', mode: 'name', extra: 1 } },
      createEnvelope('choose-work-item', { query: 'x', url: 5 }),
      createEnvelope('choose-branch', { query: 'x', branch: false }),
      createEnvelope('clear-source', { url: null }),
      createEnvelope('set-setup', { choice: 'later' })
    ]
    for (const args of invalid) expect(() => dispatchUiControl(context, args)).toThrow(INVALID_CREATE_MESSAGE)
    expect(h.element.querySelector('[aria-expanded="true"]')).toBeNull()
    expect(h.calls.some((call) => call.method === 'quirky.hosting/worktreeSource')).toBe(false)

    await act(async () => {
      expect(dispatchUiControl(context, createEnvelope('set-advanced', { open: true }))).toMatchObject({ delivered: 1 })
    })
    expect(button(h.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('true')
    expect(dispatchUiControl(context, createEnvelope('set-advanced', { open: false }, 'r2')).delivered).toBe(0)
    expect(button(h.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('true')
  })

  test('declines stale queries and repo targets after delayed window identity resolves', async () => {
    const queryIdentity = deferred<{ connId: number }>()
    const queryCalls: Call[] = []
    const queryApp = mountCreate({ onCall: (method) => method === 'ui.window.self' ? queryIdentity.promise : undefined })
    await queryApp.ready
    await click(button(queryApp.element, 'GitHub'))
    await setText(input(queryApp.element, 'create-github-query')!, 'old query')
    const result = await waitFor(() => buttonContaining(queryApp.element, 'Issue #4'))
    await click(result)
    await waitFor(() => queryApp.calls.some((call) => call.method === 'ui.window.self'))
    await setText(input(queryApp.element, 'create-github-query')!, 'new query')
    queryIdentity.resolve({ connId: 7 })
    await waitFor(() => queryApp.logs.includes('worktree: choose-work-item reached no mounted target'))
    expect(queryApp.element.querySelector('section[aria-label="Chosen GitHub source"]')).toBeNull()
    expect(queryApp.calls.some((call) => call.method === 'quirky.hosting/worktreeSource')).toBe(false)
    queryCalls.push(...queryApp.calls)
    expect(queryCalls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)

    const repoIdentity = deferred<{ connId: number }>()
    const repoApp = mountCreate({ onCall: (method) => method === 'ui.window.self' ? repoIdentity.promise : undefined })
    await repoApp.ready
    await click(button(repoApp.element, 'Advanced'))
    await waitFor(() => repoApp.calls.some((call) => call.method === 'ui.window.self'))
    await repoApp.render({ repoId: 'r2' })
    repoIdentity.resolve({ connId: 7 })
    await waitFor(() => repoApp.logs.includes('worktree: set-advanced reached no mounted target'))
    expect(button(repoApp.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('false')
    expect(repoApp.calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)
  })

  test('does not restore stale Smart text after delayed routing', async () => {
    const identity = deferred<{ connId: number }>()
    const h = mountCreate({ onCall: (method) => method === 'ui.window.self' ? identity.promise : undefined })
    await h.ready
    await setText(input(h.element, 'create-smart-name')!, 'old name')
    await click(button(h.element, 'Use text as workspace name'))
    await waitFor(() => h.calls.some((call) => call.method === 'ui.window.self'))
    await setText(input(h.element, 'create-smart-name')!, 'new name')
    identity.resolve({ connId: 7 })
    await waitFor(() => h.logs.includes('worktree: use-smart-text reached no mounted target'))
    expect(input(h.element, 'create-smart-name')?.value).toBe('new name')
    expect(input(h.element, 'create-name')).toBeUndefined()
  })

  test('disables decisive clicks while busy and rejects direct controls without mutation', async () => {
    const createResult = deferred<unknown>()
    const h = mountCreate({ onCall: (method) => method === 'quirky.worktree/create' ? createResult.promise : undefined })
    await h.ready
    await setText(input(h.element, 'create-smart-name')!, 'ready name')
    const advanced = button(h.element, 'Advanced')!
    const chooseName = button(h.element, 'Use text as workspace name')!
    await click(button(h.element, 'Create'))
    await waitFor(() => h.calls.some((call) => call.method === 'quirky.worktree/create'))
    expect(advanced.disabled).toBe(true)
    expect(chooseName.disabled).toBe(true)
    const commandCount = h.calls.filter((call) => call.method === 'ui.window.command.run').length
    await click(advanced)
    expect(h.calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(commandCount)
    expect(dispatchUiControl(h.context, createEnvelope('set-advanced', { open: true }))).toMatchObject({ delivered: 0 })
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    createResult.resolve({ worktree: { id: 'w-created', name: 'ready-name', path: '/worktrees/ready-name' }, warnings: [], setup: { ran: 'none' } })
    await flush()
  })

  test('shows routing failures without fallback and clears after any successful response', async () => {
    let fail = true
    let identity: Deferred<{ connId: number }> | null = null
    const h = mountCreate({
      onCall: (method) => {
        if (method === 'ui.window.command.run' && fail) return Promise.reject(new Error('no live UI window 7'))
        if (method === 'ui.window.self' && identity) return identity.promise
        return undefined
      }
    })
    await h.ready
    await click(button(h.element, 'Advanced'))
    await waitFor(() => h.element.querySelector('.ui-inline-error'))
    expect(h.element.querySelector('.ui-inline-error')?.textContent).toBe('Could not change worktree form: no live UI window 7')
    expect(button(h.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('false')

    fail = false
    await setText(input(h.element, 'create-smart-name')!, 'old name')
    identity = deferred<{ connId: number }>()
    await click(button(h.element, 'Use text as workspace name'))
    await waitFor(() => h.calls.filter((call) => call.method === 'ui.window.self').length > 1)
    await setText(input(h.element, 'create-smart-name')!, 'new name')
    identity.resolve({ connId: 7 })
    await waitFor(() => h.logs.includes('worktree: use-smart-text reached no mounted target'))
    expect(h.element.querySelector('.ui-inline-error')).toBeNull()
    expect(input(h.element, 'create-smart-name')?.value).toBe('new name')
    expect(input(h.element, 'create-name')).toBeUndefined()
    identity = null
    await click(button(h.element, 'Advanced'))
    expect(button(h.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('true')
    expect(h.element.querySelector('.ui-inline-error')).toBeNull()
    expect(h.executed).toEqual([])
  })

  test('registers Create handlers per context and removes each mount independently', async () => {
    const first = mountCreate()
    await first.ready
    const second = mountCreate()
    await second.ready
    const args = createEnvelope('set-advanced', { open: true })
    await act(async () => {
      expect(dispatchUiControl(first.context, args).delivered).toBe(1)
    })
    expect(button(first.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('true')
    expect(button(second.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('false')
    await second.render({ context: first.context })
    expect(dispatchUiControl(second.context, args).delivered).toBe(0)
    await act(async () => {
      expect(dispatchUiControl(first.context, args).delivered).toBe(2)
    })
    expect(button(second.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => first.root.unmount())
    await act(async () => {
      expect(dispatchUiControl(first.context, createEnvelope('set-advanced', { open: false })).delivered).toBe(1)
    })
    expect(button(second.element, 'Advanced')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => second.root.unmount())
    expect(dispatchUiControl(first.context, args).delivered).toBe(0)
  })

  test('keeps malformed control errors separate from window result errors', async () => {
    const invalidReply = contextWith(async (method) => {
      if (method === 'ui.window.self') return { connId: 7 }
      if (method === 'ui.window.command.run') return { result: { action: 'control' } }
      throw new Error(`Unexpected method ${method}`)
    })
    await expect(requestUiControl(invalidReply, scoped('create-dialog', 'r1', 'set-advanced', { open: true }))).rejects.toThrow(WINDOW_RESULT_MESSAGE)
  })

  test('rejects every malformed scoped envelope with the shared dispatcher error', () => {
    const context = emptyContext()
    const malformed: unknown[] = [
      undefined, null, { action: 'control' }, { action: 'control', scope: 'create-dialog', target: 7, operation: 'x' },
      { action: 'control', scope: ' ', target: 'r1', operation: 'x', payload: {} }
    ]
    for (const args of malformed) expectInvalidArgs(context, args)
  })
})
