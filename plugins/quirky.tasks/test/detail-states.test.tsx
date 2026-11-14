import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { registerUiDom, unregisterUiDom } from '../../quirky.loops/test/ui-dom'
import type { UiPluginContext } from '@quirky/protocol'
import { act, createElement, useState, type ReactElement } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { ItemTarget, TasksState } from '../src/contracts'
import { IssueSurface } from '../src/issue/IssueSurface'
import { runIssueControl } from '../src/issue/issue-control'
import { MarkdownComposer } from '../src/issue/Markdown'
import { PrDetail, type PrDetailProps } from '../src/list/PrDetail'
import { usePrDescription, type PrDescription } from '../src/list/usePrDescription'
import type { ListItem } from '../src/list/model'

type Mounted = { container: HTMLDivElement; root: Root }
type Call = { method: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>) => unknown
let createRoot: typeof CreateRoot
const mounts: Mounted[] = []
const ISSUE_CONTROL = 'command:quirky.tasks/issue-control'

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

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    const { promise, resolve } = Promise.withResolvers<void>()
    await act(async () => {
      setImmediate(resolve)
      await promise
    })
  }
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await settle()
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function mount(node: ReactElement) {
  const container = document.createElement('div')
  const mounted = { container, root: createRoot(container) }
  mounts.push(mounted)
  document.body.append(container)
  await act(async () => mounted.root.render(node))
  await settle()
  return container
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('expected a rendered control')
  await act(async () => element.click())
  await settle()
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
const notices = (root: ParentNode) => [...root.querySelectorAll('[role="status"] .ui-notice-line__text, .ui-notice-line__text')].map((node) => node.textContent)
const errors = (root: ParentNode) => [...root.querySelectorAll('.ui-inline-error[role="alert"] .ui-inline-error__message')].map((node) => node.textContent)
const empties = (root: ParentNode) => [...root.querySelectorAll('.ui-empty-state__message')].map((node) => node.textContent)

function prItem(patch: Partial<ListItem> = {}): ListItem {
  return {
    kind: 'pullRequest', number: 274, title: 'Fix focus', body: 'Body of 274', state: 'open', url: 'https://github.com/acme/quirky/pull/274',
    createdAt: null, updatedAt: new Date().toISOString(), author: 'sam', labels: [], assignees: [], isDraft: false,
    worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', ...patch
  } as ListItem
}

function prProps(patch: Partial<PrDetailProps> = {}, record: string[] = []): PrDetailProps {
  return {
    item: prItem(),
    onPage: true,
    description: { body: 'Body of 274', loading: false, error: null, retry: () => record.push('retry') },
    metadata: undefined,
    metadataLoading: false,
    metadataError: undefined,
    check: { label: 'Passing', tone: 'success' },
    busy: false,
    linkedName: null,
    merge: { open: false, onToggle: () => record.push('merge.toggle'), onClose: () => record.push('merge.close'), onMerge: () => record.push('merge'), onToggleAutoMerge: () => record.push('auto') },
    reviewers: { open: false, text: '', options: undefined, onToggle: () => record.push('reviewers.toggle'), onTextChange: () => undefined, onAddOption: () => undefined, onSave: () => undefined, onClose: () => record.push('reviewers.close') },
    onReview: () => record.push('review'),
    onLoadChecks: () => undefined,
    onRetryMetadata: () => record.push('retryMetadata'),
    onWorkspace: () => record.push('workspace'),
    onOpenLink: () => record.push('open'),
    onCopyLink: () => record.push('copy'),
    ...patch
  }
}

test('an off-page pull request shows a loading notice, then an error with Retry', async () => {
  const loading = await mount(createElement(PrDetail, prProps({ item: prItem({ number: 276 }), onPage: false })))
  expect(notices(loading)).toEqual(['Loading pull request…'])
  expect(loading.querySelector('[role="status"]')?.textContent).toBe('Loading pull request…')
  expect(errors(loading)).toEqual([])

  const record: string[] = []
  const failed = await mount(createElement(PrDetail, prProps({ item: prItem({ number: 276 }), onPage: false, metadataError: 'GitHub is down' }, record)))
  expect(errors(failed)).toEqual(['Could not load pull request #276: GitHub is down'])
  expect(failed.querySelector('[role="status"]')).toBeNull()
  await click(failed.querySelector('.ui-inline-error__action'))
  expect(record).toEqual(['retryMetadata'])
})

test('an on-page metadata failure is an error with Retry beside the unavailable merge control', async () => {
  const record: string[] = []
  const container = await mount(createElement(PrDetail, prProps({ metadataError: 'GitHub is down' }, record)))
  expect(errors(container)).toEqual(['Review metadata unavailable: GitHub is down'])
  expect(button(container, 'Merge metadata unavailable for PR #274')).toBeDefined()
  await click(container.querySelector('.ui-inline-error__action'))
  expect(record).toEqual(['retryMetadata'])
})

test('the description shows a loading notice, then an error whose Retry runs the description retry', async () => {
  const loading = await mount(createElement(PrDetail, prProps({ description: { body: '', loading: true, error: null, retry: () => undefined } })))
  expect(notices(loading.querySelector('.tasks-pr__description')!)).toEqual(['Loading pull-request description…'])

  const record: string[] = []
  const failed = await mount(createElement(PrDetail, prProps({ description: { body: '', loading: false, error: 'offline', retry: () => record.push('retry') } })))
  expect(errors(failed.querySelector('.tasks-pr__description')!)).toEqual(['Could not load pull-request description: offline'])
  await click(failed.querySelector('.tasks-pr__description .ui-inline-error__action'))
  expect(record).toEqual(['retry'])
})

test('the merge menu and reviewers dialog use shared loading, empty and advisory states', async () => {
  const menu = await mount(createElement(PrDetail, prProps({ metadataLoading: true, merge: { ...prProps().merge, open: true } })))
  expect(notices(menu.querySelector('[role="menu"]')!)).toEqual(['Loading merge metadata…'])

  const loadingReviewers = await mount(createElement(PrDetail, prProps({ reviewers: { ...prProps().reviewers, open: true } })))
  expect(notices(loadingReviewers.querySelector('[role="dialog"]')!)).toEqual(['Loading reviewer suggestions…'])

  const metadata = { review: { requestedReviewers: [], reviews: [], assignees: [] } } as unknown as PrDetailProps['metadata']
  const empty = await mount(createElement(PrDetail, prProps({ metadata, reviewers: { ...prProps().reviewers, open: true, options: { recentlyActive: [], suggestions: [] } } })))
  expect(empties(empty.querySelector('[role="dialog"]')!)).toEqual(['No matching reviewers.'])

  const unknown = { review: { requestedReviewers: null, reviews: null, assignees: null, participantsTruncated: true } } as unknown as PrDetailProps['metadata']
  const advisory = await mount(createElement(PrDetail, prProps({ metadata: unknown, reviewers: { ...prProps().reviewers, open: true, options: { recentlyActive: [], suggestions: [] } } })))
  const dialog = advisory.querySelector('[role="dialog"]')!
  expect(notices(dialog)).toEqual(['Requested reviewers are unavailable.', 'Review history is unavailable.', 'Pull-request assignees are unavailable.', 'Recent reviewer activity is incomplete.'])
  expect(dialog.querySelector('[role="alert"]')).toBeNull()
  expect(empties(dialog)).toEqual([])
})

function DescriptionProbe(props: { context: UiPluginContext; item: ListItem; report(value: PrDescription): void }) {
  const description = usePrDescription(props.context, props.item)
  props.report(description)
  return createElement('button', { type: 'button', onClick: description.retry }, description.error ?? description.body)
}

test('a description Retry reads the work item again with the same parameters', async () => {
  const calls: Call[] = []
  let fail = true
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (fail) throw new Error('offline')
      return { body: 'Fetched description' }
    }
  } as unknown as UiPluginContext
  let latest: PrDescription | null = null
  const container = await mount(createElement(DescriptionProbe, { context, item: prItem({ body: '' }), report: (value) => { latest = value } }))
  await waitFor(() => latest?.error === 'offline', 'first description failure')
  fail = false
  await click(container.querySelector('button'))
  await waitFor(() => latest?.body === 'Fetched description', 'description after retry')
  const expected = { worktree: 'wt-main', number: 274, kind: 'pullRequest', reference: 'https://github.com/acme/quirky/pull/274' }
  expect(calls).toEqual([{ method: 'quirky.hosting/workItem', params: expected }, { method: 'quirky.hosting/workItem', params: expected }])
})

function issueHarness(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const commands: Array<{ id: string; args: unknown }> = []
  const table: Record<string, Handler> = {
    'ui.window.self': () => ({ connId: 7 }),
    'ui.window.command.run': async (params) => {
      return { result: params.id === ISSUE_CONTROL ? runIssueControl(context, params.args) : undefined }
    },
    ...handlers
  }
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = table[method]
      if (!handler) throw new Error('offline')
      return handler(params)
    },
    async executeCommand(id: string, args: unknown) {
      commands.push({ id, args })
      const handler = table[id]
      if (handler) await handler(args as Record<string, unknown>)
    },
    toast() {}
  } as unknown as UiPluginContext
  const bridge = () => calls.filter((call) => call.method.startsWith('ui.window.'))
  return { context, calls, commands, bridge }
}

const issueTarget: ItemTarget = { worktree: 'worktree-1', kind: 'issue', number: 256, url: 'https://github.com/test-owner/test-repo/issues/256', host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
const issueState = { navigation: { detail: issueTarget, project: null }, links: {} } as unknown as TasksState

function issueDetail(patch: Record<string, unknown> = {}, item: Record<string, unknown> = {}) {
  return {
    item: { kind: 'issue', number: 256, title: 'Loaded issue', body: 'Old body', state: 'open', url: issueTarget.url, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', author: 'octocat', labels: [], assignees: [], ...item },
    viewerCanUpdate: true, comments: [], participants: [], timeline: [], partialFailures: [], truncated: false, source: 'repository', ...patch
  }
}

const choices: Record<string, Handler> = {
  'quirky.tasks/issueChoices': (params) => params.kind === 'source' ? { source: 'origin', sources: [] } : params.kind === 'labels' ? { available: true, labels: ['bug'] } : { available: true, assignees: [] }
}

async function mountIssue(context: UiPluginContext, state: TasksState = issueState) {
  return mount(createElement(IssueSurface, { context, state, refresh: async () => undefined }))
}

test('issue details show a loading notice, then a blocking error with Retry', async () => {
  const pending = Promise.withResolvers<unknown>()
  const loading = issueHarness({ ...choices, 'quirky.tasks/issue': () => pending.promise })
  const loadingPage = await mountIssue(loading.context)
  expect(loadingPage.querySelector('.quirky-tasks-issue__status[role="status"] .ui-notice-line__text')?.textContent).toBe('Loading issue details…')
  expect(errors(loadingPage)).toEqual([])

  let fail = true
  const failing = issueHarness({ ...choices, 'quirky.tasks/issue': () => { if (fail) throw new Error('GitHub timed out.'); return issueDetail() } })
  const page = await mountIssue(failing.context)
  await waitFor(() => errors(page).length > 0, 'first read error')
  expect(errors(page)).toEqual(["Couldn't load issue details: GitHub timed out."])
  expect(page.textContent).not.toContain('Loading issue details…')
  fail = false
  await click(page.querySelector('.ui-inline-error__action'))
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'issue after retry')
  expect(failing.calls.filter((call) => call.method === 'quirky.tasks/issue').map((call) => call.params)).toEqual([{}, { refresh: true }])
  expect(errors(page)).toEqual([])
})

test('a failed reread keeps the issue on screen with an advisory notice', async () => {
  let fail = false
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => { if (fail) throw new Error('rate limited'); return issueDetail() } })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  fail = true
  await click(button(page, 'Refresh'))
  await waitFor(() => notices(page).some((text) => text?.startsWith("Couldn't refresh")), 'reread notice')
  expect(notices(page)).toContain("Couldn't refresh issue details. Showing the last confirmed data: rate limited")
  expect([...page.querySelectorAll('.ui-notice-line__action')].map((node) => node.textContent)).toContain('Retry')
  expect(errors(page)).toEqual([])
  expect(page.querySelector('h1')?.textContent).toBe('Loaded issue')
})

test('empty activity and comments use EmptyState, and advisories are notices', async () => {
  const harness = issueHarness({
    ...choices,
    'quirky.tasks/issue': () => issueDetail({ viewerCanUpdate: false, truncated: true, partialFailures: ['comments', 'timeline'] })
  })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  expect(empties(page)).toEqual(['No timeline events.', 'No comments yet.'])
  expect(notices(page)).toEqual(expect.arrayContaining([
    'This issue description is read-only.',
    'Activity was truncated at the public API limit.',
    'Some issue data is unavailable: comments; timeline'
  ]))
  expect(page.querySelector('[role="alert"]')).toBeNull()
  await click([...page.querySelectorAll<HTMLButtonElement>('.ui-notice-line__action')].find((node) => node.textContent === 'Retry unavailable sources'))
  expect(harness.calls.filter((call) => call.method === 'quirky.tasks/issue').at(-1)?.params).toEqual({ refresh: true })
})

test('choice, edit, link and close failures are shared errors', async () => {
  const harness = issueHarness({
    'quirky.tasks/issue': () => issueDetail(),
    'quirky.tasks/issueChoices': (params) => { if (params.kind === 'labels') throw new Error('gh failed'); return params.kind === 'source' ? { source: 'origin', sources: [] } : { available: true, assignees: [] } },
    'quirky.tasks/issueEdit': () => { throw new Error('Validation failed') },
    'quirky.tasks/navigate': () => { throw new Error('navigation refused') },
    'command:quirky.tasks/copy-link': () => { throw new Error('Clipboard denied') }
  })
  const page = await mountIssue(harness.context)
  await waitFor(() => errors(page).includes('Issue choices could not be loaded: gh failed'), 'choice error')
  const field = [...page.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Add label')?.control as HTMLInputElement
  await act(async () => setValue(field, 'triage'))
  await click(button(page, 'Add'))
  await waitFor(() => errors(page).includes('Validation failed'), 'edit error')
  await click(button(page, 'Copy link'))
  await waitFor(() => errors(page).includes('Clipboard denied'), 'link error')
  await click(button(page, 'Close'))
  await waitFor(() => errors(page).includes('navigation refused'), 'close error')
  expect(page.textContent).not.toContain("Couldn't load issue details")
  expect(page.textContent).not.toContain("Couldn't refresh issue details")
})

test('an oversized comment shows one shared error and no duplicate after Cmd+Enter', async () => {
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => issueDetail() })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  const comment = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')!
  await act(async () => setValue(comment, 'x'.repeat(65_537)))
  await act(async () => { comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })) })
  await settle()
  expect(errors(page).filter((message) => message === 'Comments are limited to 65,536 UTF-8 bytes.')).toHaveLength(1)
  expect(page.textContent?.split('Comments are limited to 65,536 UTF-8 bytes.').length).toBe(2)
  expect(harness.calls.some((call) => call.method === 'quirky.tasks/issueComment')).toBe(false)
})

test('Edit description opens at once from the loaded body through the window bridge', async () => {
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => issueDetail() })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  await click(button(page, 'Edit description'))
  await waitFor(() => page.querySelector('textarea[aria-label="Issue description"]') !== null, 'description editor')
  expect(page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Issue description"]')!.value).toBe('Old body')
  expect(harness.bridge()).toEqual([
    { method: 'ui.window.self', params: {} },
    { method: 'ui.window.command.run', params: { connId: 7, id: ISSUE_CONTROL, args: { worktree: 'worktree-1', number: 256, action: 'edit-description' } } }
  ])
  expect(harness.calls.filter((call) => call.method === 'quirky.tasks/issue').map((call) => call.params)).toEqual([{}])
  expect(harness.commands).toEqual([])
})

test('edit-description on a read-only issue opens nothing and says why', async () => {
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => issueDetail({ viewerCanUpdate: false }) })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  let result: unknown
  await act(async () => { result = runIssueControl(harness.context, { worktree: 'worktree-1', number: 256, action: 'edit-description' }) })
  await settle()
  expect(result).toEqual({ delivered: 1 })
  expect(page.querySelector('textarea[aria-label="Issue description"]')).toBeNull()
  expect(errors(page)).toEqual(['This issue description is read-only.'])
})

test('when the window bridge rejects, Edit description and Cancel still act on this page', async () => {
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => issueDetail(), 'ui.window.self': () => { throw new Error('Not a UI connection.') } })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  await click(button(page, 'Edit description'))
  await waitFor(() => page.querySelector('textarea[aria-label="Issue description"]') !== null, 'editor after a rejected bridge')
  await click([...page.querySelectorAll<HTMLButtonElement>('.quirky-tasks-issue__edit-actions button')].find((node) => node.textContent === 'Cancel'))
  await waitFor(() => page.querySelector('textarea[aria-label="Issue description"]') === null, 'editor closed after a rejected bridge')
  expect(harness.bridge()).toEqual([{ method: 'ui.window.self', params: {} }, { method: 'ui.window.self', params: {} }])
  expect(page.querySelectorAll('.ui-inline-error')).toHaveLength(0)
})

test('both Cancel buttons route through the issue-control command on this window', async () => {
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => issueDetail() })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  await click(button(page, 'Edit description'))
  await waitFor(() => page.querySelector('textarea[aria-label="Issue description"]') !== null, 'description editor')
  const editor = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Issue description"]')!
  await act(async () => setValue(editor, 'Discard me'))
  await click([...page.querySelectorAll<HTMLButtonElement>('.quirky-tasks-issue__edit-actions button')].find((node) => node.textContent === 'Cancel'))
  await waitFor(() => page.querySelector('textarea[aria-label="Issue description"]') === null, 'editor closed')
  expect(harness.bridge()).toEqual([
    { method: 'ui.window.self', params: {} },
    { method: 'ui.window.command.run', params: { connId: 7, id: ISSUE_CONTROL, args: { worktree: 'worktree-1', number: 256, action: 'edit-description' } } },
    { method: 'ui.window.command.run', params: { connId: 7, id: ISSUE_CONTROL, args: { worktree: 'worktree-1', number: 256, action: 'cancel-description' } } }
  ])
  expect(page.querySelector('.quirky-tasks-issue__markdown')?.textContent).toContain('Old body')

  const status = page.querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    status.value = 'closed-duplicate'
    status.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  const form = page.querySelector('.quirky-tasks-issue__inline-form')!
  await click([...form.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === 'Cancel'))
  await waitFor(() => page.querySelector('.quirky-tasks-issue__inline-form') === null, 'duplicate form closed')
  expect(harness.bridge().at(-1)).toEqual({ method: 'ui.window.command.run', params: { connId: 7, id: ISSUE_CONTROL, args: { worktree: 'worktree-1', number: 256, action: 'cancel-duplicate' } } })
  expect(harness.commands).toEqual([])
})

test('issue-control reaches the mounted issue page from outside and rejects malformed input', async () => {
  const harness = issueHarness({ ...choices, 'quirky.tasks/issue': () => issueDetail() })
  expect(runIssueControl(harness.context, { worktree: 'worktree-1', number: 256, action: 'cancel-duplicate' })).toEqual({ delivered: 0 })
  const page = await mountIssue(harness.context)
  await waitFor(() => page.textContent?.includes('Loaded issue') === true, 'loaded issue')
  expect(runIssueControl(harness.context, { worktree: 'worktree-1', number: 999, action: 'edit-description' })).toEqual({ delivered: 0 })
  let result: unknown
  await act(async () => { result = runIssueControl(harness.context, { worktree: 'worktree-1', number: 256, action: 'edit-description' }) })
  expect(result).toEqual({ delivered: 1 })
  await waitFor(() => page.querySelector('textarea[aria-label="Issue description"]') !== null, 'editor opened by command')
  const message = 'issue-control needs a worktree, a positive integer number, and an action of edit-description, cancel-description or cancel-duplicate.'
  expect(() => runIssueControl(harness.context, { number: 256, action: 'edit-description' })).toThrow(message)
  expect(() => runIssueControl(harness.context, { worktree: 'worktree-1', number: 0, action: 'cancel-duplicate' })).toThrow(message)
  expect(() => runIssueControl(harness.context, { worktree: 'worktree-1', number: 256, action: 'close' })).toThrow(message)
})

function ComposerProbe(props: { onChange(value: string): void; onSubmit(): void; initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '')
  return createElement(MarkdownComposer, { value, onChange: (next: string) => { props.onChange(next); setValue(next) }, onSubmit: props.onSubmit, label: 'Body' })
}

test('the composer preview is an EmptyState and the image URL field is a disclosure with a shared error', async () => {
  const changes: string[] = []
  const container = await mount(createElement(ComposerProbe, { onChange: (value) => changes.push(value), onSubmit: () => undefined }))
  expect(button(container, 'Insert image URL')).toBeUndefined()
  const details = container.querySelector<HTMLDetailsElement>('details.quirky-tasks-markdown-composer__image')!
  expect(details.querySelector('summary')?.textContent).toBe('Insert image URL')
  await act(async () => {
    details.open = true
    details.dispatchEvent(new Event('toggle'))
  })
  const field = [...container.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Image URL')?.control as HTMLInputElement
  await act(async () => setValue(field, 'not a url'))
  await click(button(container, 'Insert'))
  expect(errors(container)).toEqual(['Use an absolute HTTP(S) image URL no longer than 8 KiB.'])
  expect(changes).toEqual([])
  await act(async () => setValue(field, 'https://example.com/cat.png'))
  await click(button(container, 'Insert'))
  expect(changes).toEqual(['![cat](https://example.com/cat.png)'])
  expect(errors(container)).toEqual([])
  expect(details.open).toBe(false)

  await click([...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Preview'))
  expect(empties(container)).toEqual([])
  const blank = await mount(createElement(ComposerProbe, { onChange: () => undefined, onSubmit: () => undefined }))
  await click([...blank.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Preview'))
  expect(empties(blank)).toEqual(['Nothing to preview'])
})

test('a disabled composer shows no image-URL disclosure and keeps the hint', async () => {
  const container = await mount(createElement(MarkdownComposer, { value: '', onChange: () => undefined, label: 'Body', disabled: true }))
  expect(container.querySelector('details')).toBeNull()
  expect(button(container, 'Insert image URL')).toBeUndefined()
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Body"]')!.disabled).toBe(true)
  expect(container.querySelector('.quirky-tasks-markdown-composer__hint')?.textContent).toBe('Paste, drop, or enter an HTTP(S) image URL.')
  await click([...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Preview'))
  expect(container.querySelector('details')).toBeNull()
})

test('the composer inserts at the caret saved on blur and submits on Cmd+Enter', async () => {
  const changes: string[] = []
  let submits = 0
  const container = await mount(createElement(ComposerProbe, { initial: 'ab', onChange: (value) => changes.push(value), onSubmit: () => { submits += 1 } }))
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Body"]')!
  await act(async () => {
    textarea.focus()
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
    textarea.blur()
  })
  const details = container.querySelector<HTMLDetailsElement>('details.quirky-tasks-markdown-composer__image')!
  await act(async () => {
    details.open = true
    details.dispatchEvent(new Event('toggle'))
  })
  const field = [...container.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Image URL')?.control as HTMLInputElement
  await act(async () => setValue(field, 'https://example.com/cat.png'))
  await click(button(container, 'Insert'))
  expect(changes.at(-1)).toBe('a![cat](https://example.com/cat.png)b')
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })) })
  expect(submits).toBe(1)
})
