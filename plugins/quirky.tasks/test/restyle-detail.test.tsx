import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { IssueDraft, TasksState } from '../src/contracts'
import { NewIssueDialog } from '../src/issue/NewIssueDialog'

type Mounted = { container: HTMLDivElement; root: Root }

const mounts: Mounted[] = []
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
  for (const mounted of mounts.splice(0).reverse()) {
    await act(async () => mounted.root.unmount())
    mounted.container.remove()
  }
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
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

function NewIssueHarness(props: { context: UiPluginContext; getDraft(): IssueDraft; registerOpenSetter(setOpen: (value: boolean) => void): void }) {
  const [open, setOpen] = useState(true)
  props.registerOpenSetter(setOpen)
  const state = {
    navigation: { newIssue: open },
    issueDraft: props.getDraft()
  } as unknown as TasksState
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open issue draft</button>
    <NewIssueDialog context={props.context} state={state} refresh={async () => {}} />
  </>
}

test('Cancel closes New Issue without creating it and keeps the saved draft for reopening', async () => {
  const initialDraft: IssueDraft = { title: 'Keep this draft', body: 'Draft body', labels: ['bug'], assignees: ['alice'], repoId: 'repo-1' }
  const repository = { id: 'repo-1', name: 'test-repo', path: '/test-repo', kind: 'git', worktree: 'worktree-1' }
  let draft = initialDraft
  let setOpen: ((value: boolean) => void) | null = null
  let creates = 0
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.tasks/issueChoices') {
        if (params.kind === 'repositories') return { repositories: [repository], defaultRepoId: repository.id }
        if (params.kind === 'source') return { available: true, source: 'origin', sources: [{ id: 'origin', label: 'Origin' }], repoId: repository.id }
        if (params.kind === 'labels') return { available: true, labels: [] }
        if (params.kind === 'assignees') return { available: true, assignees: [] }
      }
      if (method === 'quirky.tasks/draft') {
        draft = { ...draft, ...params } as IssueDraft
        return {}
      }
      if (method === 'quirky.tasks/navigate') {
        if (params.newIssue === false) setOpen?.(false)
        return {}
      }
      if (method === 'quirky.tasks/createIssue') {
        creates += 1
        return { item: { number: 1 } }
      }
      return {}
    },
    async executeCommand() { return undefined },
    toast() {}
  } as unknown as UiPluginContext
  const container = document.createElement('div')
  const mounted = { container, root: createRoot(container) }
  mounts.push(mounted)
  document.body.append(container)
  await act(async () => mounted.root.render(<NewIssueHarness context={context} getDraft={() => draft} registerOpenSetter={(setter) => { setOpen = setter }} />))
  await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>('[role="dialog"] input#new-issue-title')
    return input !== null && !input.disabled
  }, 'enabled New Issue title field')
  const title = container.querySelector<HTMLInputElement>('[role="dialog"] input#new-issue-title')
  if (!title) throw new Error('New Issue title field was not rendered')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Input value setter is unavailable')
    setter.call(title, 'Edited draft')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await waitFor(() => draft.title === 'Edited draft', 'saved title draft')

  const cancel = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'Cancel')
  if (!cancel) throw new Error('New Issue cancel action was not rendered')
  await act(async () => cancel.click())
  await waitFor(() => container.querySelector('[role="dialog"]') === null, 'New Issue cancel')
  expect(creates).toBe(0)
  expect(draft).toEqual({ ...initialDraft, title: 'Edited draft' })

  const reopen = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Open issue draft')
  if (!reopen) throw new Error('New Issue reopen control was not rendered')
  await act(async () => reopen.click())
  await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>('[role="dialog"] input#new-issue-title')
    return input !== null && !input.disabled
  }, 'reopened New Issue title field')
  expect(container.querySelector<HTMLInputElement>('[role="dialog"] input#new-issue-title')?.value).toBe('Edited draft')
  expect(creates).toBe(0)
})
