import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { registerUiDom, unregisterUiDom } from '../../quirky.loops/test/ui-dom'
import type { UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { ItemTarget, TasksState } from '../src/contracts'
import { IssueSurface } from '../src/issue/IssueSurface'

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

function choiceButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)
}

test('an issue can be assigned to someone beyond the first eight suggestions', async () => {
  const lateAssignee = 'contributor-nine'
  const availableAssignees = Array.from({ length: 9 }, (_, index) => ({ login: `contributor-${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][index]}`, avatarUrl: null }))
  const target: ItemTarget = {
    worktree: 'worktree-1',
    kind: 'issue',
    number: 256,
    url: 'https://github.com/test-owner/test-repo/issues/256',
    host: 'github.com',
    owner: 'test-owner',
    repo: 'test-repo'
  }
  let savedAssignees: string[] = []
  const issue = {
    kind: 'issue', number: 256, title: 'Loaded issue', body: '', state: 'open', url: target.url,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', author: 'octocat', labels: [] as string[], assignees: savedAssignees
  }
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.tasks/issue') {
        return { item: { ...issue, assignees: [...savedAssignees] }, viewerCanUpdate: true, comments: [], participants: [], timeline: [], partialFailures: [], truncated: false, source: 'repository' }
      }
      if (method === 'quirky.tasks/issueChoices') {
        if (params.kind === 'source') return { source: 'origin', sources: [{ id: 'origin', label: 'Origin' }] }
        if (params.kind === 'labels') return { available: true, labels: [] }
        if (params.kind === 'assignees') return { available: true, assignees: availableAssignees }
      }
      if (method === 'quirky.tasks/issueEdit') {
        savedAssignees = [...params.assignees as string[]]
        return { item: { ...issue, assignees: [...savedAssignees] } }
      }
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
  await act(async () => mounted.root.render(<IssueSurface context={context} state={state} refresh={async () => undefined} />))
  await waitFor(() => container.textContent?.includes('Loaded issue') === true, 'loaded issue details')
  await waitFor(() => choiceButton(container, '+ contributor-one') !== undefined, 'assignee choices')

  const suggestion = choiceButton(container, `+ ${lateAssignee}`)
  expect(suggestion).toBeDefined()
  if (!suggestion) throw new Error(`Expected an assignee suggestion for ${lateAssignee}`)

  await act(async () => suggestion.click())
  await waitFor(() => savedAssignees.includes(lateAssignee), 'confirmed assignee update')

  const assignedLabel = [...container.querySelectorAll('label')].find((label) => label.textContent?.trim() === lateAssignee)
  expect(savedAssignees).toEqual([lateAssignee])
  expect(assignedLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
})
