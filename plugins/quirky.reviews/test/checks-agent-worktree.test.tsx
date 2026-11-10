import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { ToolPanelFrame } from '@quirky/ui'
import { ChecksPanel } from '../src/checks/ChecksPanel'
import { Comments } from '../src/detail/Comments'
import { ReviewActions } from '../src/detail/Actions'
import { ChecksList } from '../src/detail/ChecksList'
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

function fakeContext(calls: Call[], layout?: UiLayout): UiPluginContext {
  return {
    pluginId: 'quirky.reviews',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
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
}

function mount(node: (context: UiPluginContext) => React.ReactNode, layout?: UiLayout) {
  const calls: Call[] = []
  const context = fakeContext(calls, layout)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  act(() => root.render(node(context)))
  return { element, calls }
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

const buttonByText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)!
const click = (button: HTMLButtonElement) => act(async () => { button.click() })
const dialogCalls = (calls: Call[]) => calls.filter((call) => call.method === 'quirky.reviews/checksSetAgentDialog')

test('Checks panel Fix opens the agent dialog for the Checks worktree', async () => {
  const { element, calls } = mountPanel(stateWith())
  await click(buttonByText(element, 'Fix'))
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
