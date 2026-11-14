import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { ToolPanelFrame } from '@quirky/ui'
import { ChecksAgentDialog, ChecksPanel } from '../src/checks/ChecksPanel'
import { Comments } from '../src/detail/Comments'
import { ReviewActions } from '../src/detail/Actions'
import { ChecksList } from '../src/detail/ChecksList'
import { activate } from '../src/ui'
import { REVIEWS_UI_CONTROL, listReviewsUiControls } from '../src/checks/data'
import { CHECKS_PANEL, type ChecksState, type ReviewData, type ReviewsState } from '../src/contracts'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE = '/work/tree'
const DETAIL_WORKTREE = '/detail/tree'
const roots: Root[] = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

type Call = { method: string; params: Record<string, unknown> }

const review: ReviewData = {
  provider: 'github', number: 12, url: 'https://github.com/test-owner/test-repo/pull/12', title: 'Review 12', body: '',
  state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE', checksStatus: 'failure', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, stack: null, mergeMethods: null
}

const failingChecks = {
  number: 12, headSha: 'a'.repeat(40), rollup: 'failure', partial: false, partialFailures: [],
  checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', url: null, checkRunId: 31, workflowRunId: 41, suiteId: null }]
}

function stateWith(overrides: { review?: ReviewData; mergeable?: string; queued?: string[]; worktree?: string | null } = {}): ReviewsState {
  const checksReview = { ...(overrides.review ?? review), ...(overrides.mergeable ? { mergeable: overrides.mergeable } : {}) }
  const checks: ChecksState = {
    worktree: overrides.worktree === undefined ? WORKTREE : overrides.worktree, generation: 1, loading: false, error: null, lookup: null, eligibility: null, review: checksReview,
    checks: failingChecks, comments: { threads: [] }, conflicts: null, audience: 'all', grouping: 'grouped',
    expandedChecks: [], queuedComments: overrides.queued ?? [], checksCollapsed: false, commentDraft: '', titleDraft: null, height: 320, fetchedAt: 0,
    agentDialog: null
  }
  const detail = {
    target: { worktree: DETAIL_WORKTREE, number: 12 }, tab: 'conversation', generation: 1, loading: false, error: null, review,
    details: null, checks: failingChecks, comments: { number: 12, comments: [], partial: false, partialFailures: [] },
    files: null, audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: ['c1'], checksCollapsed: false,
    selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: '', fileTreeVisible: true, commentDraft: '', bodyDraft: null,
    pending: [], fetchedAt: 0
  }
  return { revision: 1, detail, checks } as unknown as ReviewsState
}

type ContextOptions = {
  agentList?: unknown | Promise<unknown>
  launchResult?: unknown | ((params: Record<string, unknown>) => unknown)
  onCall?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
}

function fakeContext(calls: Call[], layout?: UiLayout, options: ContextOptions = {}): UiPluginContext {
  const provided = new Map<string, (...args: unknown[]) => unknown>()
  const context = {
    pluginId: 'quirky.reviews',
    provide: (id: string, handler: (...args: unknown[]) => unknown) => { provided.set(id, handler) },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 42 }
      if (method === 'ui.window.command.run') {
        const handler = provided.get(String(params.id))
        if (!handler) throw new Error(`No provided UI command: ${String(params.id)}`)
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.agents/list') return options.agentList ?? { agents: [] }
      const result = await options.onCall?.(method, params)
      if (result !== undefined) return result
      if (method === 'quirky.reviews/checksLaunchAgent') {
        return typeof options.launchResult === 'function'
          ? options.launchResult(params)
          : options.launchResult ?? { delivered: true }
      }
      return { ok: true }
    },
    getLayout: () => layout,
    onLayout: () => () => {},
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {},
    confirm: async () => false,
    log() {}
  } as unknown as UiPluginContext
  activate(context)
  return context
}

function mount(
  node: (context: UiPluginContext) => React.ReactNode,
  layout?: UiLayout,
  options: ContextOptions = {}
) {
  const calls: Call[] = []
  const context = fakeContext(calls, layout, options)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  act(() => root.render(node(context)))
  return {
    element, calls, context,
    unmount() {
      const index = roots.indexOf(root)
      if (index >= 0) roots.splice(index, 1)
      act(() => root.unmount())
    }
  }
}


const panelLayout = {
  worktree: WORKTREE, view: { id: 'view:x' }, panel: null, sidebar: true, focus: 'view',
  tools: { open: { right: CHECKS_PANEL } }
} as unknown as UiLayout

function mountPanel(state: ReviewsState) {
  return mount((context) => (
    <ToolPanelFrame title="Checks">
      <ChecksPanel context={context} state={state} refresh={async () => {}} />
    </ToolPanelFrame>
  ), panelLayout)
}
function stateWithAgent(dialog: Partial<NonNullable<ChecksState['agentDialog']>> = {}) {
  const state = stateWith()
  state.checks.agentDialog = {
    action: 'fix',
    prompt: 'Investigate the failing build.',
    agent: 'fixture',
    args: '--safe',
    surface: 'checks',
    target: { worktree: WORKTREE, number: 12 },
    headOid: review.headRefOid,
    visible: true,
    ...dialog
  }
  return state
}

function mountAgentDialog(state: ReviewsState, options: ContextOptions = {}) {
  return mount((context) => <ChecksAgentDialog context={context} state={state} refresh={async () => {}} />, panelLayout, options)
}

function descriptorFor(context: UiPluginContext, slot: string, action: string) {
  const descriptor = listReviewsUiControls(context, CHECKS_PANEL).find((item) => item.slot === slot)
  if (!descriptor) throw new Error(`No mounted Reviews control slot: ${slot}`)
  return { target: descriptor.target, generation: descriptor.generation, action }
}

function dispatchControl(context: UiPluginContext, slot: string, action: string, value?: Record<string, unknown>) {
  const args = { ...descriptorFor(context, slot, action), ...(value === undefined ? {} : { value }) }
  return context.call('ui.window.command.run', { connId: 42, id: REVIEWS_UI_CONTROL, args })
}

function commandActions(calls: Call[]) {
  return calls.flatMap((call) => {
    if (call.method !== 'ui.window.command.run') return []
    const args = call.params.args
    if (args === null || typeof args !== 'object' || Array.isArray(args) || !('action' in args) || typeof args.action !== 'string') return []
    return [args.action]
  })
}
function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

const buttonByText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)!
const click = (button: HTMLButtonElement) => act(async () => {
  button.click()
  await Promise.resolve()
  await Promise.resolve()
})
const dialogCalls = (calls: Call[]) => calls.filter((call) => call.method === 'quirky.reviews/checksSetAgentDialog')

test('Checks panel Fix opens the agent dialog for the Checks worktree', async () => {
  const state = stateWith()
  state.checks.checks = {
    ...failingChecks,
    checks: [{ kind: 'check_run', name: 'build', status: 'failure', conclusion: null, url: null, checkRunId: 31, workflowRunId: 41, suiteId: null }]
  }
  const { element, calls } = mountPanel(state)
  const fixButton = buttonByText(element, 'Fix')
  expect(fixButton).toBeTruthy()
  await click(fixButton!)
  expect(dialogCalls(calls)).toEqual([{ method: 'quirky.reviews/checksSetAgentDialog', params: { surface: 'checks', worktree: WORKTREE, action: 'fix' } }])
})

test('Checks panel Resolve opens the conflicts dialog for the Checks worktree', async () => {
  const { element, calls } = mountPanel(stateWith({ mergeable: 'CONFLICTING' }))
  await click(buttonByText(element, 'Resolve'))
  expect(dialogCalls(calls)).toEqual([{ method: 'quirky.reviews/checksSetAgentDialog', params: { surface: 'checks', worktree: WORKTREE, action: 'conflicts' } }])
})

test('Checks panel Resolve Comments With AI opens the comments dialog for the Checks worktree', async () => {
  const passing = { ...review, checksStatus: 'passing' } as ReviewData
  const state = stateWith({ review: passing, queued: ['c1', 'c2'] })
  ;(state.checks as { checks: unknown }).checks = { ...failingChecks, rollup: 'success', checks: [] }
  const { element, calls } = mountPanel(state)
  await click(buttonByText(element, 'Resolve 2 Comments With AI'))
  expect(dialogCalls(calls)).toEqual([{ method: 'quirky.reviews/checksSetAgentDialog', params: { surface: 'checks', worktree: WORKTREE, action: 'comments' } }])
})

test('detail components on the checks surface pass the Checks worktree', async () => {
  const state = stateWith({ queued: ['c1'] })
  const comments = mount((context) => <Comments context={context} state={state} refresh={async () => {}} surface="checks" />)
  await click(buttonByText(comments.element, 'Send 1 queued comments to AI'))
  expect(dialogCalls(comments.calls).map((call) => call.params)).toEqual([{ surface: 'checks', worktree: WORKTREE, action: 'comments' }])

  const actions = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />)
  await click(buttonByText(actions.element, 'Fix broken checks'))
  expect(dialogCalls(actions.calls).map((call) => call.params)).toEqual([{ surface: 'checks', worktree: WORKTREE, action: 'fix' }])

  const list = mount((context) => <ChecksList context={context} state={state} refresh={async () => {}} surface="checks" />)
  await click(buttonByText(list.element, 'Fix broken checks'))
  expect(dialogCalls(list.calls).map((call) => call.params)).toEqual([{ surface: 'checks', worktree: WORKTREE, action: 'fix' }])
})

test('detail components on the detail surface keep their dialog calls unchanged', async () => {
  const state = stateWith()
  const comments = mount((context) => <Comments context={context} state={state} refresh={async () => {}} surface="detail" />)
  await click(buttonByText(comments.element, 'Send 1 queued comments to AI'))
  expect(dialogCalls(comments.calls).map((call) => call.params)).toEqual([{ surface: 'detail', action: 'comments' }])

  const actions = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="detail" />)
  await click(buttonByText(actions.element, 'Fix broken checks'))
  expect(dialogCalls(actions.calls).map((call) => call.params)).toEqual([{ surface: 'detail', action: 'fix' }])

  const list = mount((context) => <ChecksList context={context} state={state} refresh={async () => {}} surface="detail" />)
  await click(buttonByText(list.element, 'Fix broken checks'))
  expect(dialogCalls(list.calls).map((call) => call.params)).toEqual([{ surface: 'detail', action: 'fix' }])
})

test('a checks-surface dialog call without a Checks worktree is not sent', async () => {
  const state = stateWith({ queued: ['c1'], worktree: null })
  const comments = mount((context) => <Comments context={context} state={state} refresh={async () => {}} surface="checks" />)
  await click(buttonByText(comments.element, 'Send 1 queued comments to AI'))
  expect(dialogCalls(comments.calls)).toEqual([])
  expect(comments.element.querySelector('[role="alert"]')?.textContent).toContain('No pull request is selected.')

  const list = mount((context) => <ChecksList context={context} state={state} refresh={async () => {}} surface="checks" />)
  expect(dialogCalls(list.calls)).toEqual([])
})
const enabledAgentCatalog = {
  agents: [{ id: 'fixture', label: 'Fixture Agent', enabled: true, installed: true }],
  defaultAgent: 'fixture'
}

test('agent catalog pending, empty and failed gates reject keyboard and reported start commands', async () => {
  const pending = deferred<unknown>()
  const loading = mountAgentDialog(stateWithAgent(), { agentList: pending.promise })
  await act(async () => {})
  expect(loading.element.querySelector('.ui-notice-line')?.textContent).toContain('Detecting agents…')
  expect(buttonByText(loading.element, 'Start agent').disabled).toBe(true)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await Promise.resolve()
  })
  expect(await dispatchControl(loading.context, 'agent', 'agent-start')).toEqual({ result: { delivered: false, reason: 'disabled' } })
  expect(loading.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)
  pending.resolve({ agents: [] })
  await act(async () => { await pending.promise })
  expect(loading.element.querySelector('.ui-empty-state')?.textContent).toContain('No enabled agents')
  expect(await dispatchControl(loading.context, 'agent', 'agent-start')).toEqual({ result: { delivered: false, reason: 'disabled' } })
  loading.unmount()

  const failedCatalog = deferred<unknown>()
  const failed = mountAgentDialog(stateWithAgent(), { agentList: failedCatalog.promise })
  await act(async () => {})
  failedCatalog.reject(new Error('agent catalog fixture failed'))
  await act(async () => { await failedCatalog.promise.catch(() => undefined) })
  expect(failed.element.querySelector('.ui-inline-error')?.textContent).toContain('agent catalog fixture failed')
  expect(buttonByText(failed.element, 'Start agent').disabled).toBe(true)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await Promise.resolve()
  })
  expect(await dispatchControl(failed.context, 'agent', 'agent-start')).toEqual({ result: { delivered: false, reason: 'disabled' } })
  expect(failed.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)
})

test('missing agent, blank prompt and mismatched target reject both keyboard and reported starts', async () => {
  const cases = [
    { agent: 'missing' },
    { prompt: '   ' },
    { target: { worktree: DETAIL_WORKTREE, number: 12 } },
    { target: { worktree: WORKTREE, number: 0 } }
  ] satisfies Partial<NonNullable<ChecksState['agentDialog']>>[]

  for (const dialog of cases) {
    const mounted = mountAgentDialog(stateWithAgent(dialog), { agentList: enabledAgentCatalog })
    await act(async () => {})
    expect(buttonByText(mounted.element, 'Start agent').disabled).toBe(true)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
      await Promise.resolve()
    })
    expect(await dispatchControl(mounted.context, 'agent', 'agent-start')).toEqual({ result: { delivered: false, reason: 'disabled' } })
    expect(mounted.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)
    mounted.unmount()
  }
})

test('agent Start and Cmd/Ctrl+Enter use the reported agent-start control', async () => {
  for (const entry of ['click', 'keyboard'] as const) {
    const mounted = mountAgentDialog(stateWithAgent(), { agentList: enabledAgentCatalog })
    await act(async () => {})
    const descriptor = listReviewsUiControls(mounted.context, CHECKS_PANEL).find((item) => item.slot === 'agent')!
    expect(descriptor.actions.map((item) => item.action)).toEqual(['agent-start', 'agent-cancel'])
    const agentRoot = [...mounted.element.querySelectorAll<HTMLElement>('[data-review-control-target]')]
      .find((node) => node.dataset.reviewControlTarget === descriptor.target)
    expect(agentRoot?.dataset.reviewControlGeneration).toBe(String(descriptor.generation))

    if (entry === 'click') await click(buttonByText(mounted.element, 'Start agent'))
    else {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
        await Promise.resolve()
      })
    }
    await act(async () => {})
    const writes = dialogCalls(mounted.calls)
    const launchIndex = mounted.calls.findIndex((call) => call.method === 'quirky.reviews/checksLaunchAgent')
    const persistIndex = mounted.calls.findIndex((call) => call.method === 'quirky.reviews/checksSetAgentDialog')
    expect(writes[0]?.params).toMatchObject({
      surface: 'checks', worktree: WORKTREE, number: 12, action: 'fix',
      prompt: 'Investigate the failing build.', agent: 'fixture', args: '--safe'
    })
    expect(persistIndex).toBeLessThan(launchIndex)
    expect(mounted.calls.filter((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toHaveLength(1)
    expect(mounted.calls.find((call) => call.method === 'quirky.reviews/checksLaunchAgent')?.params)
      .toMatchObject({ worktree: WORKTREE, agent: 'fixture', args: '--safe' })
    expect(commandActions(mounted.calls)).toEqual(['agent-start'])
    mounted.unmount()
  }
})

test('same-tick button, keyboard and reported agent starts share one synchronous busy gate', async () => {
  const persist = deferred<unknown>()
  const entered = deferred<void>()
  let writes = 0
  const mounted = mountAgentDialog(stateWithAgent(), {
    agentList: enabledAgentCatalog,
    onCall(method) {
      if (method === 'quirky.reviews/checksSetAgentDialog' && writes++ === 0) {
        entered.resolve(undefined)
        return persist.promise
      }
      return undefined
    }
  })
  await act(async () => {})

  await click(buttonByText(mounted.element, 'Start agent'))
  await entered.promise
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await Promise.resolve()
  })
  expect(await dispatchControl(mounted.context, 'agent', 'agent-start')).toEqual({ result: { delivered: false, reason: 'disabled' } })
  expect(mounted.calls.filter((call) => call.method === 'quirky.reviews/checksSetAgentDialog')).toHaveLength(1)
  expect(mounted.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)

  persist.resolve({ ok: true })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(mounted.calls.filter((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toHaveLength(1)
  expect(commandActions(mounted.calls)).toEqual(['agent-start', 'agent-start', 'agent-start'])
})

test('undelivered and rejected agent starts show InlineError and keep the dialog open', async () => {
  const undelivered = mountAgentDialog(stateWithAgent(), {
    agentList: enabledAgentCatalog,
    launchResult: { delivered: false, error: 'delivery fixture failed' }
  })
  await act(async () => {})
  await click(buttonByText(undelivered.element, 'Start agent'))
  expect(undelivered.element.querySelector('.ui-inline-error')?.textContent).toContain('delivery fixture failed')
  expect(undelivered.element.querySelector('[role="dialog"]')).not.toBeNull()
  expect(dialogCalls(undelivered.calls)[0]?.params).toMatchObject({ action: 'fix', prompt: 'Investigate the failing build.' })
  expect(undelivered.calls.findIndex((call) => call.method === 'quirky.reviews/checksSetAgentDialog'))
    .toBeLessThan(undelivered.calls.findIndex((call) => call.method === 'quirky.reviews/checksLaunchAgent'))

  const rejected = mountAgentDialog(stateWithAgent(), {
    agentList: enabledAgentCatalog,
    onCall(method) {
      if (method === 'quirky.reviews/checksLaunchAgent') throw new Error('launch fixture rejected')
      return undefined
    }
  })
  await act(async () => {})
  await click(buttonByText(rejected.element, 'Start agent'))
  expect(rejected.element.querySelector('.ui-inline-error')?.textContent).toContain('launch fixture rejected')
  expect(rejected.element.querySelector('[role="dialog"]')).not.toBeNull()
  expect(rejected.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(true)
})

test('agent Cancel persists the latest draft before hiding through agent-cancel', async () => {
  const mounted = mountAgentDialog(stateWithAgent(), { agentList: enabledAgentCatalog })
  await act(async () => {})
  const prompt = mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent prompt"]')!
  const propsKey = Object.getOwnPropertyNames(prompt).find((key) => key.startsWith('__reactProps$'))!
  const props = (prompt as unknown as Record<string, { onChange(event: { target: HTMLTextAreaElement }): void }>)[propsKey]!
  await act(async () => {
    prompt.value = 'Use the newest prompt.'
    props.onChange({ target: prompt })
  })
  await click(buttonByText(mounted.element, 'Cancel'))

  const writes = dialogCalls(mounted.calls)
  expect(writes).toHaveLength(2)
  expect(writes[0]?.params).toMatchObject({ prompt: 'Use the newest prompt.', agent: 'fixture', args: '--safe' })
  expect(writes[1]?.params).toMatchObject({ action: 'hide', surface: 'checks' })
  expect(commandActions(mounted.calls)).toEqual(['agent-cancel'])
})
