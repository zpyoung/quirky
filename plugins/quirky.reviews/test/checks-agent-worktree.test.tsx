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
  windowConnId?: number
  confirm?: (input: { title: string; body: string; confirmLabel: string }) => boolean | Promise<boolean>
  toast?: (title: string, body: string) => void
  windowCommandRun?: (params: Record<string, unknown>, invoke: () => Promise<unknown>) => unknown | Promise<unknown>
  onCall?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
}

function fakeContext(calls: Call[], layout?: UiLayout, options: ContextOptions = {}): UiPluginContext {
  const provided = new Map<string, (...args: unknown[]) => unknown>()
  const connId = options.windowConnId ?? 42
  const context = {
    pluginId: 'quirky.reviews',
    provide: (id: string, handler: (...args: unknown[]) => unknown) => { provided.set(id, handler) },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId }
      if (method === 'ui.window.command.run') {
        if (params.connId !== connId) throw new Error(`Unexpected window connection: ${String(params.connId)}`)
        const handler = provided.get(String(params.id))
        if (!handler) throw new Error(`No provided UI command: ${String(params.id)}`)
        const invoke = async () => ({ result: await handler(params.args) })
        return options.windowCommandRun ? options.windowCommandRun(params, invoke) : invoke()
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
    toast: (title: string, body: string) => options.toast?.(title, body),
    confirm: async (input: { title: string; body: string; confirmLabel: string }) => options.confirm?.(input) ?? false,
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
    rerender(nextNode = node) {
      act(() => root.render(nextNode(context)))
    },
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

function setControlValue(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  if (control instanceof HTMLSelectElement) {
    control.value = value
    control.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  const propsKey = Object.getOwnPropertyNames(control).find((key) => key.startsWith('__reactProps$'))
  if (!propsKey) throw new Error('Missing React props for controlled field')
  const props = (control as unknown as Record<string, { onChange?: (event: { target: typeof control }) => void }>)[propsKey]
  if (typeof props?.onChange !== 'function') throw new Error('Missing React onChange handler')
  control.value = value
  props.onChange({ target: control })
}

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

const selectableAgentCatalog = {
  agents: [
    { id: 'fixture', label: 'Fixture Agent', enabled: true, installed: true },
    { id: 'secondary', label: 'Secondary Agent', enabled: true, installed: true }
  ],
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

test('agent drafts survive a live head change while launch remains fenced to the pinned head', async () => {
  const state = stateWithAgent()
  const pinnedHead = state.checks.agentDialog!.headOid
  const nextHead = 'c'.repeat(40)
  const mounted = mountAgentDialog(state, { agentList: selectableAgentCatalog })
  await act(async () => {})

  const prompt = mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent prompt"]')!
  const agent = mounted.element.querySelector<HTMLSelectElement>('select[aria-label="Agent"]')!
  const args = mounted.element.querySelector<HTMLInputElement>('input[aria-label="CLI arguments"]')!
  await act(async () => {
    setControlValue(prompt, 'Draft from the dialog before polling.')
    setControlValue(agent, 'secondary')
    setControlValue(args, '--use-latest')
  })
  state.checks.review = { ...state.checks.review!, headRefOid: nextHead }
  mounted.rerender()

  expect(state.checks.agentDialog?.headOid).toBe(pinnedHead)
  expect(state.checks.review?.headRefOid).toBe(nextHead)
  expect(prompt.value).toBe('Draft from the dialog before polling.')
  expect(agent.value).toBe('secondary')
  expect(args.value).toBe('--use-latest')
  expect(buttonByText(mounted.element, 'Start agent').disabled).toBe(true)

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await Promise.resolve()
  })
  await act(async () => {})
  expect(mounted.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)
  expect(await dispatchControl(mounted.context, 'agent', 'agent-start'))
    .toEqual({ result: { delivered: false, reason: 'disabled' } })
  expect(mounted.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)
})

test('background refresh keeps CLI focus and keyboard start uses the latest draft through the exact-window handler', async () => {
  const state = stateWithAgent()
  const latestPrompt = 'Use the draft written before the background refresh.'
  const latestArgs = '--fresh-args'
  const mounted = mountAgentDialog(state, { agentList: selectableAgentCatalog })
  await act(async () => {})

  const prompt = mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent prompt"]')!
  const agent = mounted.element.querySelector<HTMLSelectElement>('select[aria-label="Agent"]')!
  const args = mounted.element.querySelector<HTMLInputElement>('input[aria-label="CLI arguments"]')!
  await act(async () => {
    setControlValue(prompt, latestPrompt)
    setControlValue(agent, 'secondary')
    setControlValue(args, latestArgs)
  })
  args.focus()
  expect(document.activeElement).toBe(args)

  state.checks.review = { ...state.checks.review!, checksStatus: 'pending' }
  mounted.rerender()

  expect(document.activeElement).toBe(args)
  expect(prompt.value).toBe(latestPrompt)
  expect(agent.value).toBe('secondary')
  expect(args.value).toBe(latestArgs)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await Promise.resolve()
  })
  await act(async () => {})

  expect(dialogCalls(mounted.calls)[0]?.params).toMatchObject({
    surface: 'checks', worktree: WORKTREE, number: 12, action: 'fix',
    prompt: latestPrompt, agent: 'secondary', args: latestArgs
  })
  expect(mounted.calls.find((call) => call.method === 'quirky.reviews/checksLaunchAgent')?.params)
    .toMatchObject({ worktree: WORKTREE, agent: 'secondary', args: latestArgs })
  expect(mounted.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
  expect(mounted.calls.find((call) => call.method === 'ui.window.command.run')?.params).toMatchObject({
    connId: 42,
    id: REVIEWS_UI_CONTROL,
    args: { action: 'agent-start' }
  })
})

test('a head change while Start settles keeps the draft editable after the stale launch is stopped', async () => {
  const state = stateWithAgent()
  const draft = Promise.withResolvers<unknown>()
  const mounted = mountAgentDialog(state, {
    agentList: enabledAgentCatalog,
    onCall(method) {
      return method === 'quirky.reviews/checksSetAgentDialog' ? draft.promise : undefined
    }
  })
  await act(async () => {})
  await click(buttonByText(mounted.element, 'Start agent'))
  const prompt = mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent prompt"]')!
  expect(prompt.disabled).toBe(true)
  state.checks.review = { ...state.checks.review!, headRefOid: 'c'.repeat(40) }
  mounted.rerender()
  await act(async () => { draft.resolve({ ok: true }) })
  await act(async () => {})
  expect(mounted.calls.some((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toBe(false)
  expect(prompt.value).toBe('Investigate the failing build.')
  expect(prompt.disabled).toBe(false)
  expect(buttonByText(mounted.element, 'Cancel').disabled).toBe(false)
})
function mergedChecksState(): ReviewsState {
  const state = stateWith()
  state.checks.review = { ...review, state: 'merged' }
  return state
}

function linkedWorkspace(worktree: string, name: string) {
  return {
    links: {
      [review.url]: { worktree, name, url: review.url, repoId: 'fixture-repo' }
    }
  }
}

function reviewActionsDescriptor(context: UiPluginContext) {
  return listReviewsUiControls(context, CHECKS_PANEL).find((item) => item.slot === 'review-actions')!
}

test('review-action lease renewal on owner generation invalidates old workspace lookups and unmount reads', async () => {
  const state = mergedChecksState()
  const oldLookup = deferred<unknown>()
  const currentLookup = deferred<unknown>()
  let lookupCount = 0
  const mounted = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />, undefined, {
    onCall(method) {
      if (method === 'quirky.tasks/state') return lookupCount++ === 0 ? oldLookup.promise : currentLookup.promise
      return undefined
    }
  })
  await act(async () => {})
  const initial = reviewActionsDescriptor(mounted.context)
  expect(initial.target).toBe(JSON.stringify([
    CHECKS_PANEL, 'review-actions', WORKTREE, 'github.com/test-owner/test-repo', 12, review.headRefOid, null
  ]))

  state.checks.generation += 1
  mounted.rerender()
  const replacement = reviewActionsDescriptor(mounted.context)
  expect(replacement.target).toBe(initial.target)
  expect(replacement.generation).not.toBe(initial.generation)
  expect(lookupCount).toBe(2)

  oldLookup.resolve(linkedWorkspace('/workspace/stale', 'Stale workspace'))
  currentLookup.resolve({ links: {} })
  await act(async () => {
    await Promise.all([oldLookup.promise, currentLookup.promise])
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mounted.element.querySelector('.ui-empty-state')?.textContent).toContain('No workspace is linked')
  expect([...mounted.element.querySelectorAll('button')].some((button) => button.textContent?.includes('Stale workspace'))).toBe(false)
  mounted.unmount()

  const pendingUnmount = deferred<unknown>()
  const unmounted = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />, undefined, {
    onCall(method) {
      return method === 'quirky.tasks/state' ? pendingUnmount.promise : undefined
    }
  })
  await act(async () => {})
  unmounted.unmount()
  pendingUnmount.resolve(linkedWorkspace('/workspace/unmounted', 'Unmounted workspace'))
  await act(async () => {
    await pendingUnmount.promise
    await Promise.resolve()
  })
  expect(unmounted.element.childElementCount).toBe(0)
})

test('stale merge confirmation cannot launch and its finally cannot unlock the replacement lease', async () => {
  const state = stateWith()
  state.checks.review = {
    ...review,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergeMethods: { allowed: ['squash'], default: 'squash' }
  }
  const confirmations = [deferred<boolean>(), deferred<boolean>()]
  const confirmEntered = [deferred<void>(), deferred<void>()]
  let confirmCount = 0
  const mounted = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />, undefined, {
    confirm() {
      const index = confirmCount++
      confirmEntered[index]?.resolve()
      return confirmations[index]!.promise
    },
    onCall(method) {
      if (method === 'quirky.reviews/detailMergeConfirmation') return 'Confirm merge.'
      return undefined
    }
  })
  await act(async () => {})
  const original = reviewActionsDescriptor(mounted.context)
  await act(async () => { await dispatchControl(mounted.context, 'review-actions', 'merge', { method: 'squash' }) })
  await confirmEntered[0]!.promise

  state.checks.generation += 1
  mounted.rerender()
  const replacement = reviewActionsDescriptor(mounted.context)
  expect(replacement.target).toBe(original.target)
  expect(replacement.generation).not.toBe(original.generation)
  await act(async () => { await dispatchControl(mounted.context, 'review-actions', 'merge', { method: 'squash' }) })
  await confirmEntered[1]!.promise

  confirmations[0]!.resolve(true)
  await act(async () => {
    await confirmations[0]!.promise
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mounted.calls.some((call) => call.method === 'quirky.reviews/detailMerge')).toBe(false)
  expect(reviewActionsDescriptor(mounted.context).actions.find((action) => action.action === 'merge')?.enabled).toBe(false)

  confirmations[1]!.resolve(false)
  await act(async () => {
    await confirmations[1]!.promise
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mounted.calls.some((call) => call.method === 'quirky.reviews/detailMerge')).toBe(false)
})

test('old merge mutation completion cannot toast or clear busy state for a same-target replacement', async () => {
  const state = stateWith()
  state.checks.review = {
    ...review,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergeMethods: { allowed: ['squash'], default: 'squash' }
  }
  const oldMerge = deferred<unknown>()
  const replacementMerge = deferred<unknown>()
  const mergeEntered = [deferred<void>(), deferred<void>()]
  const toasts: Array<{ title: string; body: string }> = []
  let mergeCount = 0
  const mounted = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />, undefined, {
    confirm: async () => true,
    toast: (title, body) => toasts.push({ title, body }),
    onCall(method) {
      if (method === 'quirky.reviews/detailMergeConfirmation') return 'Confirm merge.'
      if (method === 'quirky.reviews/detailMerge') {
        const index = mergeCount++
        mergeEntered[index]?.resolve()
        return index === 0 ? oldMerge.promise : replacementMerge.promise
      }
      return undefined
    }
  })
  await act(async () => {})
  await act(async () => { await dispatchControl(mounted.context, 'review-actions', 'merge', { method: 'squash' }) })
  await mergeEntered[0]!.promise

  state.checks.generation += 1
  mounted.rerender()
  await act(async () => { await dispatchControl(mounted.context, 'review-actions', 'merge', { method: 'squash' }) })
  await mergeEntered[1]!.promise

  oldMerge.resolve({ number: 12, state: 'merged' })
  await act(async () => {
    await oldMerge.promise
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(toasts).toEqual([])
  expect(reviewActionsDescriptor(mounted.context).actions.find((action) => action.action === 'merge')?.enabled).toBe(false)

  replacementMerge.resolve({ number: 12, state: 'merged' })
  await act(async () => {
    await replacementMerge.promise
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(toasts).toEqual([{ title: 'Pull request merged', body: 'PR #12 is merged.' }])
})

test('confirmed workspace removal unlinks its captured task target after selection changes without stale UI or toast writes', async () => {
  const state = mergedChecksState()
  const oldRemoval = deferred<unknown>()
  const replacementRemoval = deferred<unknown>()
  const oldRemovalEntered = deferred<void>()
  const replacementRemovalEntered = deferred<void>()
  const oldUnlinked = deferred<void>()
  const replacementUnlinked = deferred<void>()
  const unlinks: Record<string, unknown>[] = []
  const toasts: Array<{ title: string; body: string }> = []
  let stateReads = 0
  const mounted = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />, undefined, {
    confirm: async () => true,
    toast: (title, body) => toasts.push({ title, body }),
    onCall(method, params) {
      if (method === 'quirky.tasks/state') {
        return stateReads++ < 2
          ? linkedWorkspace('/workspace/original', 'Original workspace')
          : linkedWorkspace('/workspace/replacement', 'Replacement workspace')
      }
      if (method === 'quirky.worktree/remove') {
        if (params.worktree === '/workspace/original') {
          oldRemovalEntered.resolve()
          return oldRemoval.promise
        }
        replacementRemovalEntered.resolve()
        return replacementRemoval.promise
      }
      if (method === 'quirky.tasks/workspace') {
        unlinks.push(params)
        if (params.worktree === '/workspace/original') oldUnlinked.resolve()
        else replacementUnlinked.resolve()
        return { ok: true }
      }
      return undefined
    }
  })
  await act(async () => {})
  expect(buttonByText(mounted.element, 'Delete workspace · Original workspace')).toBeTruthy()
  await act(async () => { await dispatchControl(mounted.context, 'review-actions', 'delete-workspace') })
  await oldRemovalEntered.promise

  state.checks.worktree = '/replacement/tree'
  state.checks.generation += 1
  mounted.rerender()
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(buttonByText(mounted.element, 'Delete workspace · Replacement workspace')).toBeTruthy()
  await act(async () => { await dispatchControl(mounted.context, 'review-actions', 'delete-workspace') })
  await replacementRemovalEntered.promise

  oldRemoval.resolve({ ok: true, removed: ['/workspace/original'] })
  await oldUnlinked.promise
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(unlinks).toHaveLength(1)
  expect(unlinks[0]).toEqual({
    action: 'unlink',
    target: {
      worktree: WORKTREE,
      kind: 'pullRequest',
      number: 12,
      url: review.url,
      host: 'github.com',
      owner: 'test-owner',
      repo: 'test-repo'
    },
    worktree: '/workspace/original'
  })
  expect(toasts).toEqual([])
  expect(reviewActionsDescriptor(mounted.context).actions.find((action) => action.action === 'delete-workspace')?.enabled).toBe(false)

  replacementRemoval.resolve({ ok: true, removed: ['/workspace/replacement'] })
  await replacementUnlinked.promise
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(unlinks).toHaveLength(2)
  expect(toasts).toEqual([{
    title: 'Workspace deleted',
    body: 'Removed Replacement workspace from merged pull request #12.'
  }])
})

test('workspace unlink is not attempted after unconfirmed removal and cleanup failure keeps its established toast', async () => {
  const unconfirmed = mergedChecksState()
  const unconfirmedToasts: Array<{ title: string; body: string }> = []
  let unconfirmedUnlinks = 0
  const failedRemovalDone = deferred<void>()
  const failed = mount((context) => <ReviewActions context={context} state={unconfirmed} refresh={async () => {}} surface="checks" />, undefined, {
    confirm: async () => true,
    toast: (title, body) => {
      unconfirmedToasts.push({ title, body })
      if (title === 'Could not delete workspace') failedRemovalDone.resolve()
    },
    onCall(method) {
      if (method === 'quirky.tasks/state') return linkedWorkspace('/workspace/failed', 'Failed workspace')
      if (method === 'quirky.worktree/remove') return { ok: true, removed: [] }
      if (method === 'quirky.tasks/workspace') unconfirmedUnlinks += 1
      return undefined
    }
  })
  await act(async () => {})
  await act(async () => { await dispatchControl(failed.context, 'review-actions', 'delete-workspace') })
  await failedRemovalDone.promise
  expect(unconfirmedUnlinks).toBe(0)
  expect(unconfirmedToasts[0]?.title).toBe('Could not delete workspace')
  failed.unmount()

  const cleanupFailure = mergedChecksState()
  const cleanupToasts: Array<{ title: string; body: string }> = []
  const cleanupDone = deferred<void>()
  const removed = mount((context) => <ReviewActions context={context} state={cleanupFailure} refresh={async () => {}} surface="checks" />, undefined, {
    confirm: async () => true,
    toast: (title, body) => {
      cleanupToasts.push({ title, body })
      if (title === 'Workspace removed; link cleanup failed') cleanupDone.resolve()
    },
    onCall(method) {
      if (method === 'quirky.tasks/state') return linkedWorkspace('/workspace/cleanup-failed', 'Cleanup failure workspace')
      if (method === 'quirky.worktree/remove') return { ok: true, removed: ['/workspace/cleanup-failed'] }
      if (method === 'quirky.tasks/workspace') throw new Error('task link cleanup rejected')
      return undefined
    }
  })
  await act(async () => {})
  await act(async () => { await dispatchControl(removed.context, 'review-actions', 'delete-workspace') })
  await cleanupDone.promise
  expect(cleanupToasts).toEqual([{
    title: 'Workspace removed; link cleanup failed',
    body: 'Cleanup failure workspace: task link cleanup rejected'
  }])
})
test('a delayed old-window delivery failure after owner generation replacement is ignored', async () => {
  const state = stateWith()
  const bridgeResponse = deferred<unknown>()
  const bridgeEntered = deferred<void>()
  const toasts: Array<{ title: string; body: string }> = []
  let invokeBridge: (() => Promise<unknown>) | null = null
  const mounted = mount((context) => <ReviewActions context={context} state={state} refresh={async () => {}} surface="checks" />, undefined, {
    toast: (title, body) => toasts.push({ title, body }),
    windowCommandRun(_params, invoke) {
      invokeBridge = invoke
      bridgeEntered.resolve()
      return bridgeResponse.promise
    }
  })
  await act(async () => {})
  await act(async () => {
    buttonByText(mounted.element, 'Fix broken checks').click()
    await bridgeEntered.promise
  })

  state.checks.generation += 1
  mounted.rerender()
  const staleEnvelope = await invokeBridge!()
  expect(staleEnvelope).toEqual({ result: { delivered: false, reason: 'target-unavailable' } })
  bridgeResponse.resolve(staleEnvelope)
  await act(async () => {
    await bridgeResponse.promise
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
  expect(toasts).toEqual([])
})
