import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { ToolPanelFrame } from '@quirky/ui'
import { ChecksPanel } from '../src/checks/ChecksPanel'
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
    worktree, generation: 1, loading: false, error: null, lookup: null, eligibility: null, review,
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
  refreshResult?: unknown
}

function mountPanel({ panelOpen = false, stateWorktree = WORKTREE, refreshResult = { ok: true } }: MountOptions = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const layout = {
    worktree: WORKTREE, view: { id: 'view:x' }, panel: null, sidebar: true, focus: 'view',
    ...(panelOpen ? { tools: { open: { right: CHECKS_PANEL } } } : {})
  } as unknown as UiLayout
  const context = {
    pluginId: 'quirky.reviews',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.reviews/checksSaveTitle') return { updated: true }
      if (method === 'quirky.reviews/checksRefresh') return refreshResult
      return { ok: true }
    },
    getLayout: () => layout,
    onLayout: () => () => {},
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {},
    log() {}
  } as unknown as UiPluginContext
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
  return { element, calls, setState(next: ReviewsState) { state = next; render() } }
}

const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const click = (button: HTMLButtonElement) => act(async () => { button.click() })
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

test('the rail refresh button still refreshes and the actions menu still lists its items', async () => {
  const { element, calls } = mountPanel()

  await click(byLabel(element, 'Refresh checks')!)
  expect(calls.map((call) => call.method)).toContain('quirky.hosting/refresh')
  expect(calls.some((call) => call.method === 'quirky.reviews/checksRefresh' && call.params.worktree === WORKTREE)).toBe(true)

  await click(byLabel(element, 'More PR actions')!)
  const items = [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  expect(items).toEqual(['Unlink PR from workspace', 'Link another PR'])
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
