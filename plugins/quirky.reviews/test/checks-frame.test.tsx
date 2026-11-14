import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { ToolPanelFrame } from '@quirky/ui'
import { ChecksPanel } from '../src/checks/ChecksPanel'
import { activate } from '../src/ui'
import { REVIEWS_UI_CONTROL, listReviewsUiControls } from '../src/checks/data'
import { CHECKS_PANEL, type ChecksState, type ReviewData, type ReviewsState } from '../src/contracts'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE = '/work/tree'
const roots: Root[] = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

const review: ReviewData = {
  provider: 'github', number: 12, url: 'https://github.com/test-owner/test-repo/pull/12', title: 'Review 12', body: '',
  state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE', checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, stack: null, mergeMethods: null
}

function stateWith(titleDraft: string | null = null, worktree: string | null = WORKTREE): ReviewsState {
  const checks: ChecksState = {
    worktree, generation: 1, loading: false, error: null, lookup: null, eligibility: null, review: { ...review },
    checks: { checks: [] }, comments: { threads: [] }, conflicts: null, audience: 'all', grouping: 'grouped',
    expandedChecks: [], queuedComments: [], checksCollapsed: false, commentDraft: '', titleDraft, height: 320, fetchedAt: 0,
    agentDialog: null
  }
  const detail = {
    target: null, tab: 'conversation', generation: 0, loading: false, error: null, review: null, details: null, checks: null,
    comments: null, files: null, audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
    selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: '', fileTreeVisible: true, commentDraft: '', bodyDraft: null,
    pending: [], fetchedAt: 0
  }
  return { revision: 1, detail, checks } as unknown as ReviewsState
}

interface MountOptions {
  panelOpen?: boolean
  stateWorktree?: string | null
  refreshResult?: unknown | ((worktree: string) => unknown)
}

function mountPanel({ panelOpen = false, stateWorktree = WORKTREE, refreshResult = { ok: true } }: MountOptions = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const provided = new Map<string, (...args: unknown[]) => unknown>()
  let connectionId = 42
  let beforeSelf: (() => Promise<unknown>) | null = null
  let beforeCommand: (() => Promise<void>) | null = null
  let layoutListener: (layout: UiLayout) => void = () => {}
  const makeLayout = (worktree: string | null) => ({
    worktree, view: { id: 'view:x' }, panel: null, sidebar: true, focus: 'view',
    ...(panelOpen ? { tools: { open: { right: CHECKS_PANEL } } } : {})
  }) as unknown as UiLayout
  let layout = makeLayout(WORKTREE)
  const context = {
    pluginId: 'quirky.reviews',
    provide: (id: string, handler: (...args: unknown[]) => unknown) => { provided.set(id, handler) },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return beforeSelf ? beforeSelf() : { connId: connectionId }
      if (method === 'ui.window.command.run') {
        await beforeCommand?.()
        const handler = provided.get(String(params.id))
        if (!handler) throw new Error(`No provided UI command: ${String(params.id)}`)
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.reviews/checksSaveTitle') return { updated: true }
      if (method === 'quirky.reviews/checksRefresh') {
        return typeof refreshResult === 'function' ? (refreshResult as (worktree: string) => unknown)(String(params.worktree)) : refreshResult
      }
      return { ok: true }
    },
    getLayout: () => layout,
    onLayout: (listener: (layout: UiLayout) => void) => { layoutListener = listener; return () => {} },
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {},
    executeCommand: (...args: unknown[]) => { calls.push({ method: 'executeCommand', params: { args } }) },
    log() {}
  } as unknown as UiPluginContext
  activate(context)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  let state = stateWith(null, stateWorktree)
  const render = () => act(() => root.render(
    <ToolPanelFrame title="Checks">
      <ChecksPanel context={context} state={state} refresh={async () => {}} />
    </ToolPanelFrame>
  ))
  render()
  return {
    element, calls, context,
    setState(next: ReviewsState) { state = next; render() },
    switchWorktree(worktree: string | null) { layout = makeLayout(worktree); act(() => layoutListener(layout)) },
    setConnectionId(value: number) { connectionId = value },
    setBeforeSelf(value: (() => Promise<unknown>) | null) { beforeSelf = value },
    setBeforeCommand(value: (() => Promise<void>) | null) { beforeCommand = value },
    unmount() {
      const index = roots.indexOf(root)
      if (index >= 0) roots.splice(index, 1)
      act(() => root.unmount())
    }
  }
}

const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
function descriptorFor(context: UiPluginContext, slot: string, action: string) {
  const descriptor = listReviewsUiControls(context, CHECKS_PANEL).find((item) => item.slot === slot)
  if (!descriptor) throw new Error(`No mounted Reviews control slot: ${slot}`)
  return {
    target: descriptor.target,
    generation: descriptor.generation,
    action,
  }
}

async function dispatchControl(context: UiPluginContext, slot: string, action: string, value?: Record<string, unknown>) {
  const request = { ...descriptorFor(context, slot, action), ...(value === undefined ? {} : { value }) }
  return context.call('ui.window.command.run', { connId: 42, id: REVIEWS_UI_CONTROL, args: request })
}

function commandActions(calls: { method: string; params: Record<string, unknown> }[]) {
  return calls.flatMap((call) => {
    if (call.method !== 'ui.window.command.run') return []
    const args = call.params.args
    if (args === null || typeof args !== 'object' || Array.isArray(args) || !('action' in args) || typeof args.action !== 'string') return []
    return [args.action]
  })
}
function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}
const click = (button: HTMLButtonElement) => act(async () => {
  button.click()
  await Promise.resolve()
  await Promise.resolve()
})
const byText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)
const rail = (root: ParentNode) => root.querySelector<HTMLElement>('.ui-tool-panel-frame__rail')!
const header = (root: ParentNode) => root.querySelector<HTMLElement>('.ui-tool-panel-frame__header')!
const body = (root: ParentNode) => root.querySelector<HTMLElement>('.ui-tool-panel-frame__body')!

test('panel-wide buttons sit on the frame and the pull request header content stays in the body', () => {
  const { element } = mountPanel()

  expect(rail(element).contains(byLabel(element, 'Refresh checks'))).toBe(true)
  expect(header(element).contains(byLabel(element, 'More PR actions'))).toBe(true)
  expect(body(element).contains(byLabel(element, 'Refresh checks'))).toBe(false)
  expect(body(element).contains(byLabel(element, 'More PR actions'))).toBe(false)

  expect(body(element).contains(byLabel(element, 'Edit pull request title'))).toBe(true)
  expect(byLabel(element, 'Edit pull request title')!.textContent).toBe('Review 12')
  expect(body(element).contains(byLabel(element, 'Copy PR link'))).toBe(true)
  expect(body(element).textContent).toContain('#12')
  expect(body(element).textContent).toContain('main ← feature')
  expect(element.querySelectorAll('.ui-tool-panel-frame__header')).toHaveLength(1)
})

test('Checks publishes a canonical control target on its mounted root', async () => {
  const { element, context } = mountPanel()
  await act(async () => {})

  const controls = listReviewsUiControls(context, CHECKS_PANEL)
  const checks = controls.find((item) => item.slot === 'checks')!
  expect(checks.target).toBe(JSON.stringify([
    CHECKS_PANEL, 'checks', WORKTREE,
    { host: 'github.com', owner: 'test-owner', repo: 'test-repo' },
    12, 'a'.repeat(40), null
  ]))
  expect(checks.actions.map((item) => item.action)).toEqual([
    'refresh', 'unlink', 'relink', 'link-open', 'title-edit', 'create',
    'blocker', 'open-link', 'copy-link', 'agent-open', 'height-set'
  ])
  const checksRoot = [...element.querySelectorAll<HTMLElement>('[data-review-control-target]')]
    .find((node) => node.dataset.reviewControlTarget === checks.target)
  expect(checksRoot?.dataset.reviewControlGeneration).toBe(String(checks.generation))
})
test('Checks renders pending, empty, failed lookup and retained review as distinct shared states', () => {
  const { element, setState, switchWorktree } = mountPanel()
  const pending = stateWith()
  pending.checks.loading = true
  pending.checks.review = null
  setState(pending)
  expect(element.querySelector('.ui-notice-line')?.textContent).toContain('Checking pull request status…')

  pending.checks.error = 'initial read failed'
  setState(pending)
  expect(element.querySelector('.ui-inline-error')?.textContent).toContain('initial read failed')
  expect(element.querySelector('.ui-notice-line')).toBeNull()

  switchWorktree(null)
  setState(stateWith(null, null))
  expect(element.querySelector('.ui-empty-state')?.textContent).toContain('Select a workspace to view checks.')

  const noReview = stateWith()
  noReview.checks.review = null
  noReview.checks.lookup = {
    kind: 'no-review',
    gitStatus: { branch: 'feature', head: 'a'.repeat(40) },
    fetchedAt: Date.now()
  }
  noReview.checks.eligibility = {
    eligible: true, worktree: WORKTREE, head: 'feature', headOid: 'a'.repeat(40), confirmedAt: Date.now()
  }
  switchWorktree(WORKTREE)
  setState(noReview)
  expect(element.querySelector('.ui-empty-state')?.textContent).toContain('No pull request found')
  expect(byText(element, 'Create PR')?.disabled).toBe(false)

  noReview.checks.lookup = { kind: 'unavailable', reason: 'lookup_unavailable', message: 'lookup fixture failed', fetchedAt: Date.now() }
  noReview.checks.eligibility = null
  setState(noReview)
  expect(element.querySelector('.ui-inline-error')?.textContent).toContain('lookup fixture failed')
  expect(element.querySelector('.ui-empty-state')).toBeNull()
  expect(byText(element, 'Create PR')).toBeUndefined()

  const retained = stateWith()
  retained.checks.error = 'retained fixture failed'
  setState(retained)
  expect(element.querySelector('.ui-inline-error')?.textContent).toContain('retained fixture failed')
  expect(element.querySelector('.ui-inline-error')?.textContent).toContain('Showing the last known review status.')
  expect(byLabel(element, 'Edit pull request title')).not.toBeNull()
})
test('stack failures use InlineError while a structured pending stack and conflict preview use NoticeLine', () => {
  const { element, setState } = mountPanel()
  const failed = stateWith()
  failed.checks.review!.stack = {
    available: false, reason: 'stack_unavailable', message: 'Stack is still loading words but unavailable.'
  }
  setState(failed)
  expect(element.querySelector('[aria-label="Pull request stack"] .ui-inline-error')?.textContent)
    .toContain('Stack is still loading words but unavailable.')
  expect(element.querySelector('[aria-label="Pull request stack"] .ui-notice-line')).toBeNull()

  failed.checks.review!.stack = { available: false, reason: 'stack_mismatch' }
  setState(failed)
  expect(element.querySelector('[aria-label="Pull request stack"] .ui-inline-error')?.textContent)
    .toContain('The provider stack did not match the selected pull request.')

  failed.checks.review!.stack = { available: true, number: 12, position: 1, entries: [] }
  setState(failed)
  expect(element.querySelector('[aria-label="Pull request stack"] .ui-inline-error')?.textContent)
    .toContain('The canonical stack response is incomplete.')

  failed.checks.review!.stack = { available: false, status: 'loading', message: 'Reading canonical stack members…' }
  setState(failed)
  expect(element.querySelector('[aria-label="Pull request stack"] .ui-notice-line')?.textContent)
    .toContain('Reading canonical stack members…')

  failed.checks.review!.stack = null
  failed.checks.review!.mergeable = 'CONFLICTING'
  failed.checks.conflicts = { status: 'loading' }
  setState(failed)
  expect(element.querySelector('[aria-label="Merge conflicts"] .ui-notice-line')?.textContent)
    .toContain('Loading conflict paths…')
})
test('the rail refresh button uses its provided exact-window route and the actions menu still lists its items', async () => {
  const { element, calls } = mountPanel()

  await click(byLabel(element, 'Refresh checks')!)
  expect(calls.map((call) => call.method)).toContain('quirky.hosting/refresh')
  expect(calls.some((call) => call.method === 'quirky.reviews/checksRefresh' && call.params.worktree === WORKTREE)).toBe(true)
  expect(calls.some((call) => call.method === 'ui.window.self')).toBe(true)
  expect(calls.find((call) => call.method === 'ui.window.command.run')?.params).toMatchObject({
    connId: 42,
    id: REVIEWS_UI_CONTROL,
    args: { action: 'refresh' }
  })
  expect(calls.some((call) => call.method === 'executeCommand')).toBe(false)

  await click(byLabel(element, 'More PR actions')!)
  const items = [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  expect(items).toEqual(['Unlink PR from workspace', 'Link another PR'])
  await click(byText(element, 'Unlink PR from workspace')!)
  expect(calls.some((call) => call.method === 'quirky.reviews/checksUnlink' && call.params.worktree === WORKTREE)).toBe(true)
})

test('editing the title in the body saves and cancels', async () => {
  const { element, calls, setState } = mountPanel()

  await click(byLabel(element, 'Edit pull request title')!)
  const input = element.querySelector<HTMLInputElement>('input[aria-label="Pull request title"]')!
  expect(body(element).contains(input)).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.reviews/checksSetTitleDraft')).toBe(true)

  await click(byLabel(element, 'Cancel title edit')!)
  expect(calls.some((call) => call.method === 'quirky.reviews/checksCancelTitle' && call.params.number === 12)).toBe(true)
  expect(element.querySelector('input[aria-label="Pull request title"]') === null).toBe(true)
  expect(byLabel(element, 'Edit pull request title') !== null).toBe(true)

  setState(stateWith('Renamed review'))
  const draft = element.querySelector<HTMLInputElement>('input[aria-label="Pull request title"]')!
  expect(draft.value).toBe('Renamed review')
  await click(byLabel(element, 'Save pull request title')!)
  const save = calls.find((call) => call.method === 'quirky.reviews/checksSaveTitle')
  expect(save?.params).toMatchObject({ worktree: WORKTREE, number: 12, title: 'Renamed review' })
  setState(stateWith(null))
  expect(element.querySelector('input[aria-label="Pull request title"]') === null).toBe(true)
})

const checksRefreshCalls = (calls: { method: string; params: Record<string, unknown> }[]) => calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')

test('a visible panel force-refreshes once when the shared slot holds another worktree, however often state changes', async () => {
  const { calls, setState } = mountPanel({ panelOpen: true, stateWorktree: '/other/tree' })
  await act(async () => {})
  expect(checksRefreshCalls(calls)).toHaveLength(1)
  expect(checksRefreshCalls(calls)[0]?.params).toEqual({ worktree: WORKTREE, force: true })

  for (let revision = 2; revision < 8; revision += 1) {
    setState({ ...stateWith(null, '/other/tree'), revision } as ReviewsState)
    await act(async () => {})
  }
  expect(checksRefreshCalls(calls)).toHaveLength(1)
})

test('a panel that has matched the slot does not refresh again when another client takes it over', async () => {
  const { calls, setState } = mountPanel({ panelOpen: true })
  await act(async () => {})
  expect(checksRefreshCalls(calls)).toHaveLength(0)

  setState(stateWith(null, '/other/tree'))
  await act(async () => {})
  setState(stateWith(null, '/third/tree'))
  await act(async () => {})
  expect(checksRefreshCalls(calls)).toHaveLength(0)
})

test('a failed entry refresh surfaces its error', async () => {
  const { element } = mountPanel({ panelOpen: true, stateWorktree: '/other/tree', refreshResult: { ok: false, error: 'gh is unavailable' } })
  await act(async () => {})
  expect(element.textContent).toContain('gh is unavailable')
})

test('a late failed entry refresh for the previous worktree does not show on the new one', async () => {
  const pending = new Map<string, (result: unknown) => void>()
  const { element, calls, switchWorktree } = mountPanel({
    panelOpen: true,
    stateWorktree: '/other/tree',
    refreshResult: (worktree: string) => new Promise((resolve) => { pending.set(worktree, resolve) })
  })
  await act(async () => {})
  expect(checksRefreshCalls(calls)[0]?.params).toEqual({ worktree: WORKTREE, force: true })

  switchWorktree('/next/tree')
  await act(async () => {})
  expect(checksRefreshCalls(calls)[1]?.params).toEqual({ worktree: '/next/tree', force: true })

  await act(async () => { pending.get(WORKTREE)!({ ok: false, error: 'old worktree failed' }) })
  expect(element.textContent).not.toContain('old worktree failed')

  await act(async () => { pending.get('/next/tree')!({ ok: false, error: 'new worktree failed' }) })
  expect(element.textContent).toContain('new worktree failed')
})
test('link form commands validate the local number and keep cancel local', async () => {
  const { element, calls, context } = mountPanel()
  await click(byLabel(element, 'More PR actions')!)
  await click(byText(element, 'Link another PR')!)

  const linkControls = listReviewsUiControls(context, CHECKS_PANEL).find((item) => item.slot === 'link')
  expect(linkControls?.actions.map((item) => item.action)).toEqual(['link-submit', 'link-cancel'])
  const input = element.querySelector<HTMLInputElement>('input[aria-label="Pull request number"]')!
  const propsKey = Object.getOwnPropertyNames(input).find((key) => key.startsWith('__reactProps$'))!
  const props = (input as unknown as Record<string, { onChange(event: { target: HTMLInputElement }): void }>)[propsKey]!
  const form = element.querySelector('form')!
  await act(async () => {
    input.value = '0'
    props.onChange({ target: input })
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  expect(element.querySelector('.ui-inline-error')?.textContent).toContain('Enter a positive pull request number.')
  expect(calls.some((call) => call.method === 'quirky.reviews/checksLink')).toBe(false)

  await act(async () => {
    input.value = '27'
    props.onChange({ target: input })
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  expect(calls.find((call) => call.method === 'quirky.reviews/checksLink')?.params)
    .toMatchObject({ worktree: WORKTREE, number: 27 })

  await click(byText(element, 'Cancel')!)
  expect(element.querySelector('input[aria-label="Pull request number"]')).toBeNull()
  expect(commandActions(calls)).toEqual(['link-open', 'link-submit', 'link-submit', 'link-cancel'])
})
test('create and blocker routes use only current eligibility and the offered blocker', async () => {
  const { element, calls, context, setState } = mountPanel()
  await act(async () => {})
  expect(await dispatchControl(context, 'checks', 'create')).toEqual({ result: { delivered: false, reason: 'disabled' } })
  expect(calls.some((call) => call.method === 'quirky.reviews/createOpen')).toBe(false)

  const eligible = stateWith()
  eligible.checks.review = null
  eligible.checks.lookup = { kind: 'no-review', gitStatus: { branch: 'feature', head: 'a'.repeat(40) }, fetchedAt: Date.now() }
  eligible.checks.eligibility = {
    eligible: true, worktree: WORKTREE, head: 'feature', headOid: 'a'.repeat(40), confirmedAt: Date.now()
  }
  setState(eligible)
  await click(byText(element, 'Create PR')!)
  expect(calls.some((call) => call.method === 'quirky.reviews/createOpen' && call.params.worktree === WORKTREE)).toBe(true)

  const blocked = stateWith()
  blocked.checks.review = null
  blocked.checks.lookup = { kind: 'no-review', gitStatus: { branch: 'feature', head: 'a'.repeat(40) }, fetchedAt: Date.now() }
  blocked.checks.eligibility = {
    eligible: false, worktree: WORKTREE, head: 'feature', headOid: 'a'.repeat(40), confirmedAt: Date.now(),
    blockers: [{ reason: 'no_upstream', message: 'Publish this branch first.' }]
  }
  setState(blocked)
  await click(byText(element, 'Publish Branch')!)
  expect(calls.find((call) => call.method === 'quirky.reviews/checksGitAction')?.params)
    .toMatchObject({ worktree: WORKTREE, action: 'publish' })
  const gitActionCount = calls.filter((call) => call.method === 'quirky.reviews/checksGitAction').length
  await dispatchControl(context, 'checks', 'blocker', { action: 'push' })
  expect(calls.filter((call) => call.method === 'quirky.reviews/checksGitAction')).toHaveLength(gitActionCount)
  const needsPush = stateWith()
  needsPush.checks.review = null
  needsPush.checks.lookup = { kind: 'no-review', gitStatus: { branch: 'feature', head: 'a'.repeat(40) }, fetchedAt: Date.now() }
  needsPush.checks.eligibility = {
    eligible: false, worktree: WORKTREE, head: 'feature', headOid: 'a'.repeat(40), confirmedAt: Date.now(),
    blockers: [{ reason: 'needs_push', message: 'Push this branch first.' }]
  }
  const beforePush = calls.length
  setState(needsPush)
  await click(byText(element, 'Push & Create PR')!)
  const pushIndex = calls.findIndex((call, index) => index >= beforePush && call.method === 'quirky.reviews/checksGitAction')
  const createIndex = calls.findIndex((call, index) => index > pushIndex && call.method === 'quirky.reviews/createOpen')
  expect(pushIndex).toBeGreaterThanOrEqual(0)
  expect(createIndex).toBeGreaterThan(pushIndex)
})

test('PR links open through the control route and copy uses the local clipboard helper', async () => {
  const { element, calls } = mountPanel()
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text) } }
  })
  try {
    const prLink = byText(element, '#12')!
    await click(prLink)
    expect(calls.find((call) => call.method === 'quirky.reviews/openLink')?.params)
      .toMatchObject({ url: review.url, worktree: WORKTREE })

    await click(byLabel(element, 'Copy PR link')!)
    await act(async () => {})
    expect(copied).toEqual([review.url])
    expect(calls.some((call) => call.method === 'quirky.reviews/copyText')).toBe(false)
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('resize previews without persistence, commits through commands and cleans listeners', async () => {
  const panel = mountPanel()
  const separator = panel.element.querySelector<HTMLElement>('[aria-label="Resize Checks panel"]')!
  await act(async () => {
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await Promise.resolve()
  })
  expect(panel.calls.find((call) => call.method === 'quirky.reviews/checksSetHeight')?.params.height).toBe(344)
  await act(async () => {
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await Promise.resolve()
  })
  expect(panel.calls.filter((call) => call.method === 'quirky.reviews/checksSetHeight').at(-1)?.params.height).toBe(296)

  await act(async () => {
    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 76 }))
  })
  const preview = [...panel.element.querySelectorAll<HTMLElement>('.ui-stack')].find((node) => node.style.height === '344px')
  expect(preview).toBeDefined()
  expect(panel.calls.filter((call) => call.method === 'quirky.reviews/checksSetHeight')).toHaveLength(2)
  await act(async () => {
    window.dispatchEvent(new MouseEvent('mouseup'))
    await Promise.resolve()
  })
  expect(panel.calls.filter((call) => call.method === 'quirky.reviews/checksSetHeight')).toHaveLength(3)
  expect(commandActions(panel.calls).slice(-3)).toEqual(['height-set', 'height-set', 'height-set'])
  await act(async () => {
    await dispatchControl(panel.context, 'checks', 'height-set', { height: 999 })
    await dispatchControl(panel.context, 'checks', 'height-set', { height: 159.6 })
  })
  expect(panel.calls.filter((call) => call.method === 'quirky.reviews/checksSetHeight').map((call) => call.params.height).slice(-2))
    .toEqual([800, 160])

  const dragging = mountPanel()
  const nextSeparator = dragging.element.querySelector<HTMLElement>('[aria-label="Resize Checks panel"]')!
  await act(async () => { nextSeparator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 })) })
  dragging.unmount()
  await act(async () => { window.dispatchEvent(new MouseEvent('mouseup')) })
  expect(dragging.calls.some((call) => call.method === 'quirky.reviews/checksSetHeight')).toBe(false)
})

test('a delayed exact-window self lookup cannot refresh a replacement worktree', async () => {
  const panel = mountPanel()
  const capturedRequest = descriptorFor(panel.context, 'checks', 'refresh')
  const self = deferred<unknown>()
  panel.setBeforeSelf(() => self.promise)
  await click(byLabel(panel.element, 'Refresh checks')!)

  panel.switchWorktree('/next/tree')
  panel.setState(stateWith(null, '/next/tree'))
  self.resolve({ connId: 42 })
  await act(async () => { await self.promise; await Promise.resolve(); await Promise.resolve() })

  expect(checksRefreshCalls(panel.calls)).toHaveLength(0)
  expect(panel.calls.find((call) => call.method === 'ui.window.command.run')?.params)
    .toEqual({ connId: 42, id: REVIEWS_UI_CONTROL, args: capturedRequest })
})
test('the offered relink action keeps its suppression-aware daemon call', async () => {
  const state = stateWith()
  state.checks.review = null
  state.checks.lookup = { kind: 'suppressed', number: 12 }
  const { element, calls, setState } = mountPanel()
  setState(state)
  await click(byText(element, 'Link PR #12')!)
  expect(calls.find((call) => call.method === 'quirky.reviews/checksRelink')?.params).toMatchObject({ worktree: WORKTREE })
})
