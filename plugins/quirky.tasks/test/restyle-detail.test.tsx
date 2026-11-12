import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { registerUiDom, unregisterUiDom } from '../../quirky.loops/test/ui-dom'
import type { UiPluginContext } from '@quirky/protocol'
import { act, useState } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { IssueDraft, TasksState } from '../src/contracts'
import { IssueSurface } from '../src/issue/IssueSurface'
import { NewIssueDialog } from '../src/issue/NewIssueDialog'

type Mounted = { container: HTMLDivElement; root: Root }
let createRoot: typeof CreateRoot

const mounts: Mounted[] = []

beforeAll(async () => {
  registerUiDom()
  // React DOM binds its scheduler at import, so happy-dom must exist first.
  const reactDom = await import('react-dom/client')
  createRoot = reactDom.createRoot
})

afterEach(async () => {
  for (const mounted of mounts.splice(0).reverse()) {
    await act(async () => mounted.root.unmount())
    mounted.container.remove()
  }
})

afterAll(async () => {
  await unregisterUiDom()
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

function titleField(container: HTMLElement): HTMLInputElement | null {
  const dialog = container.querySelector('[role="dialog"]')
  if (!dialog) return null
  const label = [...dialog.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === 'Title')
  const control = label?.control
  return control instanceof HTMLInputElement ? control : null
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
    const input = titleField(container)
    return input !== null && !input.disabled
  }, 'enabled New Issue title field')
  const title = titleField(container)
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
    const input = titleField(container)
    return input !== null && !input.disabled
  }, 'reopened New Issue title field')
  expect(titleField(container)?.value).toBe('Edited draft')
  expect(creates).toBe(0)
})

test('an issue shows no placeholder state or author until its detail has arrived', async () => {
  const target = { worktree: 'worktree-1', kind: 'issue', number: 256, url: 'https://github.com/test-owner/test-repo/issues/256', host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  const detail = {
    item: { kind: 'issue', number: 256, title: 'Loaded issue', body: '', state: 'open', url: target.url, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', author: 'octocat', labels: [], assignees: [] },
    viewerCanUpdate: true, comments: [], participants: [], timeline: [], partialFailures: [], truncated: false, source: 'repository'
  }
  const read = Promise.withResolvers<unknown>()
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.tasks/issue') return read.promise
      if (method === 'quirky.tasks/issueChoices') return params.kind === 'source' ? { source: 'origin', sources: [] } : { available: false, labels: [], assignees: [] }
      return {}
    },
    async executeCommand() { return undefined },
    toast() {}
  } as unknown as UiPluginContext
  const state = { navigation: { detail: target, project: null }, links: {} } as unknown as TasksState
  const container = document.createElement('div')
  const mounted = { container, root: createRoot(container) }
  mounts.push(mounted)
  document.body.append(container)
  await act(async () => mounted.root.render(<IssueSurface context={context} state={state} refresh={async () => {}} />))

  expect(container.textContent).toContain('Issue #256')
  expect(container.textContent).toContain('Loading issue details…')
  expect(container.textContent).not.toContain('Unknown state')
  expect(container.textContent).not.toContain('unknown author')
  expect(container.textContent).not.toContain('updated unknown time')
  const labels = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim())
  expect(labels).toEqual(expect.arrayContaining(['Close', 'Copy link', 'Open on GitHub']))
  expect(labels.some((label) => label?.startsWith('Refresh') || label === 'Refreshing…')).toBe(true)

  await act(async () => read.resolve(detail))
  await waitFor(() => container.textContent?.includes('Loaded issue') === true, 'loaded issue detail')
  expect(container.textContent).toContain('octocat opened this issue')
  expect(container.textContent).toContain('Open')
  expect(container.textContent).not.toContain('Unknown state')
  expect(container.textContent).not.toContain('Loading issue details…')
})
