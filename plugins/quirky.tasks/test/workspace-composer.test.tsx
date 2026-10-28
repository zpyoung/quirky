import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { WorkspaceComposer } from '../src/list/WorkspaceComposer'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { ItemTarget, TasksState, WorkspaceComposerRequest } from '../src/contracts'
import { registerUiDom, unregisterUiDom } from '../../quirky.loops/test/ui-dom'

type RecordValue = Record<string, unknown>
type Call = { method: string; params: RecordValue }
const setupHash = 'a'.repeat(64)
const issueHash = 'b'.repeat(64)
let createRoot: typeof CreateRoot
let root: Root | null = null
let container: HTMLElement


function request(overrides: Partial<WorkspaceComposerRequest> = {}): WorkspaceComposerRequest {
  const target: ItemTarget = { worktree: 'base-worktree', kind: 'issue', number: 7, url: 'https://github.com/owner/repo/issues/7' }
  return {
    requestId: 'request-1',
    target,
    repoId: 'repo-1',
    repoName: 'owner/repo',
    name: 'Fix the fixture',
    title: 'Issue title',
    prompt: 'Work on the issue',
    setup: 'run',
    issueCommand: 'inherit',
    agent: null,
    ...overrides
  }
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function select(label: string): HTMLSelectElement {
  const field = [...container.querySelectorAll('label')].find((entry) => entry.textContent?.includes(label))
  const select = field?.querySelector('select')
  if (!(select instanceof HTMLSelectElement)) throw new Error(`could not find ${label} select`)
  return select
}

function setSelectValue(element: HTMLSelectElement, value: string): void {
  element.value = value
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`could not find ${label} button`)
  return found
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function mount(options: {
  initial?: WorkspaceComposerRequest
  workspace?(params: RecordValue, count: number): Promise<unknown>
} = {}) {
  const calls: Call[] = []
  const toasts: { title: string; body: string }[] = []
  let eventListener: ((event: unknown) => void) | null = null
  let workspaceCalls = 0
  const context = {
    pluginId: 'quirky.tasks',
    async call(method: string, params: RecordValue = {}) {
      calls.push({ method, params })
      if (method === 'quirky.tasks/workspaceComposerState') return options.initial ?? request()
      if (method === 'quirky.agents/list') {
        return { defaultAgent: 'codex', agents: [
          { id: 'codex', label: 'Codex list flag', installed: true, enabled: true, isDefault: true },
          { id: 'goose', label: 'Goose picked', installed: true, enabled: true, isDefault: false }
        ] }
      }
      if (method === 'quirky.agents/pick') return { agent: 'goose' }
      if (method === 'quirky.tasks/workspace') {
        workspaceCalls += 1
        if (!options.workspace) throw new Error('unexpected workspace call')
        return options.workspace(params, workspaceCalls)
      }
      if (method === 'quirky.tasks/workspaceComposerCancel') return null
      throw new Error(`unexpected API call ${method}`)
    },
    subscribe(listener: (event: unknown) => void) {
      eventListener = listener
      return () => { if (eventListener === listener) eventListener = null }
    },
    toast(title: string, body: string) { toasts.push({ title, body }) },
    executeCommand: async () => undefined
  } as unknown as UiPluginContext
  const refresh = async () => undefined
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(createElement(WorkspaceComposer, { context, state: {} as TasksState, refresh })))
  return {
    calls,
    toasts,
    async emit(next: WorkspaceComposerRequest | null) {
      eventListener?.({ type: 'quirky.tasks/workspaceComposer', data: { request: next } })
      await flush()
    }
  }
}

beforeAll(async () => {
  registerUiDom()
  // React DOM binds its scheduler at import, so happy-dom must exist first.
  const reactDom = await import('react-dom/client')
  createRoot = reactDom.createRoot
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = null
  }
  document.body.innerHTML = ''
})

afterAll(async () => {
  await unregisterUiDom()
})

test('composer binds each Run once to its displayed script hash and retains drafts and independent approvals across the other hook retry', async () => {
  const issueRequest = request({
    trustKind: 'issue',
    trustScript: "printf 'issue-command'",
    trustHash: issueHash,
    trustChanged: true,
    trustSetupHash: setupHash
  })
  const h = mount({
    initial: request({ trustKind: 'setup', trustScript: "printf 'setup'", trustHash: setupHash }),
    workspace: async (_params, count) => count === 1
      ? issueRequest
      : {
          kind: 'created',
          worktree: { id: 'created-worktree', name: 'created-workspace' },
          setup: { ran: 'daemon', exitCode: 0 },
          issueCommand: { ran: 'skipped' },
          warnings: ['could not start goose in the created workspace'],
          agentSessionId: 'session-1',
          promptDelivery: 'unconfirmed'
        }
  })
  await flush()
  expect(select('Agent (optional)').value).toBe('goose')
  await act(async () => {
    setValue(container.querySelector('input')!, 'edited workspace name')
    setValue(container.querySelector('textarea')!, 'edited prompt text')
    await Promise.resolve()
  })
  await act(async () => { setSelectValue(select('Agent (optional)'), ''); await Promise.resolve() })

  await act(async () => { button('Run setup once').click(); await Promise.resolve() })
  await flush()
  const first = h.calls.filter((call) => call.method === 'quirky.tasks/workspace')[0]!
  expect(first.params).toMatchObject({
    trustSetup: true,
    trustSetupHash: setupHash,
    setup: 'run',
    issueCommand: 'inherit',
    name: 'edited workspace name',
    prompt: 'edited prompt text',
    agent: ''
  })
  expect(first.params.trustIssueCommand).toBeUndefined()
  expect(container.textContent).toContain('Issue command')
  expect(container.textContent).toContain("printf 'issue-command'")
  expect(container.textContent).toContain(issueHash)
  expect((container.querySelector('input') as HTMLInputElement).value).toBe('edited workspace name')
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('edited prompt text')
  expect(select('Agent (optional)').value).toBe('')

  await act(async () => { button('Skip issue command').click(); await Promise.resolve() })
  await flush()
  const second = h.calls.filter((call) => call.method === 'quirky.tasks/workspace')[1]!
  expect(second.params).toMatchObject({ trustSetup: true, trustSetupHash: setupHash, setup: 'run', issueCommand: 'skip', agent: '' })
  expect(second.params.trustIssueCommand).toBeUndefined()
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0]?.title).toBe('Workspace created')
  expect(h.toasts[0]?.body).toContain('unconfirmed')
  expect(h.toasts[0]?.body).toContain('could not start goose')
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

test('issue-command Run once sends its displayed issue hash separately from the retained setup approval', async () => {
  const h = mount({
    initial: request({
      trustKind: 'issue',
      trustScript: "printf 'issue-command'",
      trustHash: issueHash,
      trustSetupHash: setupHash
    }),
    workspace: async () => ({
      kind: 'created',
      worktree: { id: 'created-worktree', name: 'created-workspace' },
      setup: { ran: 'daemon', exitCode: 0 },
      issueCommand: { ran: 'daemon', exitCode: 0 },
      warnings: []
    })
  })
  await flush()
  await act(async () => { button('Run issue command once').click(); await Promise.resolve() })
  await flush()
  const submitted = h.calls.filter((call) => call.method === 'quirky.tasks/workspace')[0]!
  expect(submitted.params).toMatchObject({
    setup: 'run',
    issueCommand: 'run',
    trustSetup: true,
    trustSetupHash: setupHash,
    trustIssueCommand: true,
    trustIssueCommandHash: issueHash
  })
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0]?.title).toBe('Workspace created')
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

test('rapid submit is single-flight and an older completion cannot close a newer composer', async () => {
  const deferred = Promise.withResolvers<unknown>()
  const first = request({ requestId: 'request-old' })
  const newer = request({ requestId: 'request-new', target: { worktree: 'base-worktree', kind: 'issue', number: 8, url: 'https://github.com/owner/repo/issues/8' }, title: 'Newer issue' })
  const h = mount({ initial: first, workspace: () => deferred.promise })
  await flush()
  await act(async () => {
    button('Create workspace').click()
    button('Create workspace').click()
    await Promise.resolve()
  })
  expect(h.calls.filter((call) => call.method === 'quirky.tasks/workspace')).toHaveLength(1)

  await h.emit(newer)
  expect(container.textContent).toContain('Newer issue')
  deferred.resolve({ kind: 'created', target: first.target, worktree: { id: 'old-worktree', name: 'old-created' }, warnings: [], setup: { ran: 'none' } })
  await act(async () => { await deferred.promise; await Promise.resolve(); await Promise.resolve() })
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  expect(container.textContent).toContain('Newer issue')
})
