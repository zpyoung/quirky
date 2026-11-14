import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import { ChecksPanel } from '../src/checks/ChecksPanel'
import { CHECKS_PANEL, type ReviewData, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'
import { formatLedgerEntry, sitterStatusPresentation, type ChecksSitterState, type SitterDetail, type SitterFleetRow } from '../src/checks/data'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const WORKTREE = '/work/tree'
const OTHER = '/work/other'
const commandsPrefix = 'command:quirky.reviews/'
const stoppingHelp = 'Stopping prevents new actions; an in-flight provider operation may finish.'
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})
afterAll(() => GlobalRegistrator.unregister())

const review: ReviewData = {
  provider: 'github', number: 12, url: 'https://github.com/test-owner/test-repo/pull/12', title: 'Review 12', body: '',
  state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE', checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, stack: null, mergeMethods: null,
}

function reviewsState(worktree: string | null = WORKTREE, currentReview: ReviewData | null = review): ReviewsState {
  return {
    revision: 1,
    checks: {
      worktree, generation: 1, loading: false, error: null, lookup: { gitStatus: { branch: 'feature' } },
      eligibility: null, review: currentReview,
      checks: { number: 12, headSha: 'a'.repeat(40), rollup: 'success', partial: false, partialFailures: [], checks: [] },
      comments: null, conflicts: null,
      audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
      commentDraft: '', titleDraft: null, height: 320, fetchedAt: 0, agentDialog: null,
    },
    detail: { target: null, review: null },
  } as unknown as ReviewsState
}

function sitter(state: SitterFleetRow['status']['state'] = 'watching'): SitterFleetRow {
  return {
    target: { watcherId: 'watcher-a' },
    ownerFence: { executionHostId: 'host-a', schedulerOwner: 'owner-a', workspaceKey: 'workspace-a', revision: 1 },
    enrollment: {
      watcherId: 'watcher-a', kind: 'hosted-review', enabled: true, paused: false, commandRevision: 1,
      worktreeId: WORKTREE, capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'gated' },
      budget: { wallClockActiveMs: 14_400_000, turns: null },
      kindPayload: { branchUpdateMode: 'merge-base-update', mergeMethod: 'squash', mergeCheckScope: 'all' },
      createdAtMs: 1, terminalAtMs: null, parkReason: null, haltReason: null,
    },
    status: { state, nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
    name: 'PR #12', workspaceName: 'tree', branch: 'feature', phase: 'Watching checks',
    ownerContact: 'live', observedAtMs: Date.now(), lastSuccessfulTickAtMs: null,
    budget: { activeMs: 3_600_000, turns: 2, exhausted: null }, openEscalations: [], pendingQuestion: false,
  }
}

function sitterState(row: SitterFleetRow | null = null): ChecksSitterState {
  return { available: true, sitter: row, detail: null, activeCount: row ? 1 : 0, otherActiveCount: 0 }
}

function detailFor(row: SitterFleetRow): SitterDetail {
  return {
    target: row.target, ownerFence: row.ownerFence, enrollment: row.enrollment, status: row.status,
    budget: row.budget, ownerContact: row.ownerContact, observedAtMs: row.observedAtMs,
    openEscalations: row.openEscalations, pendingControls: [],
    journal: Array.from({ length: 25 }, (_, index) => ({
      seq: index + 1, eventId: `event-${index + 1}`, atMs: 60_000 * (index + 1),
      class: 'fact', origin: 'owner', kind: 'observation', resolved: false,
    })),
  }
}

async function settle() {
  await act(async () => {
    const pending = Promise.withResolvers<void>()
    setTimeout(pending.resolve, 0)
    await pending.promise
  })
}

type Call = { method: string; params: Record<string, unknown> }
type Options = {
  model?: ReviewsState
  response?: unknown
  call?: (method: string, params: Record<string, unknown>) => unknown
  panelOpen?: boolean
}

function mount(options: Options = {}) {
  let state = options.model ?? reviewsState()
  let response: unknown = options.response ?? sitterState()
  let layout = {
    worktree: state.checks.worktree, view: { id: 'view:x' }, panel: null, sidebar: true, focus: 'view',
    tools: { open: { 'right-top': options.panelOpen === false ? null : CHECKS_PANEL } },
  } as unknown as UiLayout
  const calls: Call[] = []
  const executed: { id: string; args: unknown }[] = []
  const registered = new Map<string, (args?: unknown) => unknown>()
  const events = new Set<(event: QuirkyEvent) => void>()
  const layouts = new Set<(layout: UiLayout) => void>()
  const context = {
    pluginId: 'quirky.reviews',
    provide(id: string, implementation: unknown) {
      if (typeof implementation === 'function') registered.set(id, implementation as (args?: unknown) => unknown)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const custom = options.call?.(method, params)
      if (custom !== undefined) return await custom
      if (method === 'quirky.reviews/checksSitterGet') return response
      if (method === 'quirky.reviews/checksSitterDebugReport') return { report: { watcher: 'watcher-a', state: 'watching' } }
      if (method === 'quirky.hosting/visibleRefreshCandidates') return { accepted: true }
      return { ok: true }
    },
    async executeCommand(id: string, args?: unknown) {
      executed.push({ id, args })
      const command = registered.get(id)
      if (!command) throw new Error(`Unregistered command ${id}`)
      return await command(args)
    },
    getLayout: () => layout,
    onLayout(listener: (layout: UiLayout) => void) { layouts.add(listener); return () => layouts.delete(listener) },
    onConnection: () => () => {},
    subscribe(listener: (event: QuirkyEvent) => void) { events.add(listener); return () => events.delete(listener) },
    getSetting: () => undefined, toast() {}, log() {},
  } as unknown as UiPluginContext
  activate(context)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  const render = () => act(() => root.render(<ChecksPanel context={context} state={state} refresh={async () => {}} />))
  render()
  return {
    element, context, calls, executed,
    setResponse(next: unknown) { response = next },
    setState(next: ReviewsState) { state = next; render() },
    switchWorktree(worktree: string) {
      layout = { ...layout, worktree }
      act(() => { for (const listener of layouts) listener(layout) })
    },
    async fleetChanged() {
      await act(async () => {
        const event = { type: 'quirky.heimdall/fleetChanged', data: {} } as unknown as QuirkyEvent
        for (const listener of events) listener(event)
      })
      await settle()
    },
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}. ${document.body.textContent}`)
  return found
}

async function click(label: string) {
  await act(async () => { button(label).click() })
  await settle()
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const element = [...document.querySelectorAll('label')].find((candidate) => candidate.textContent?.includes(label))
  const control = element?.htmlFor ? document.getElementById(element.htmlFor) : element?.querySelector('input,select')
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) throw new Error(`Missing field: ${label}`)
  return control
}

async function change(label: string, value: string) {
  await act(async () => {
    const control = field(label)
    if (control instanceof HTMLSelectElement) {
      control.value = value
      control.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      control.value = value
      const key = Object.getOwnPropertyNames(control).find((candidate) => candidate.startsWith('__reactProps$'))
      if (!key) throw new Error('Missing React input handlers')
      const props: unknown = Reflect.get(control, key)
      if (!props || typeof props !== 'object' || !('onChange' in props) || typeof props.onChange !== 'function') throw new Error('Missing input change handler')
      props.onChange({ target: control, currentTarget: control })
    }
  })
}

test('Checks keeps the fleet emergency stop available without a selected PR', async () => {
  mount({ model: reviewsState(null, null), response: { ...sitterState(), activeCount: 1, otherActiveCount: 1 } })
  await settle()
  expect(document.body.textContent).toContain('PR Sitter safety')
  expect(button('Stop all PR Sitters').disabled).toBe(false)
  expect(document.body.textContent).toContain(stoppingHelp)
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

test.each([{ ok: true }, { available: false }, new Error('Method not found')])('unavailable and legacy mock responses hide sitter controls without alerts: %j', async (response) => {
  mount({ call: (method) => {
    if (method !== 'quirky.reviews/checksSitterGet') return undefined
    if (response instanceof Error) return Promise.reject(Object.assign(response, { code: -32601 }))
    return response
  } })
  await settle()
  expect(document.body.textContent).not.toContain('PR Sitter')
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('unsupported reviews retain fleet safety but not a sitter enrollment row', async () => {
  mount({ model: reviewsState(WORKTREE, { ...review, provider: 'unsupported' }) })
  await settle()
  expect(document.body.textContent).toContain('PR Sitter safety')
  expect([...document.querySelectorAll('button')].some((element) => element.textContent?.trim() === 'PR Sitter')).toBe(false)
})

test.each([
  ['watching', 'Watching', 'working', 'working'], ['held', 'Held', 'needs-you', 'needs-you'],
  ['acting', 'Acting', 'working', 'working'], ['escalated', 'Escalated', 'needs-you', 'needs-you'],
  ['parked', 'Parked', 'needs-you', 'needs-you'], ['terminal', 'Complete', 'accent', 'done'],
  ['disabled', 'Stopped', 'neutral', 'idle'], ['unreachable', 'Host unreachable', 'failing', 'failing'],
  ['malformed', 'Malformed', 'failing', 'failing'],
] as const)('%s maps to the visible status %s', (state, label, tone, dot) => {
  expect(sitterStatusPresentation(sitter(state))).toMatchObject({ label, tone, dot })
})

test('owner uncertainty and held tick errors override ordinary status', () => {
  const row = sitter('held')
  row.status.reason = 'tick-error'
  expect(sitterStatusPresentation(row)).toMatchObject({ label: 'Error · retrying', tone: 'failing', dot: 'failing' })
  row.ownerContact = 'unverifiable'
  expect(sitterStatusPresentation(row).label).toContain('Host unreachable · last confirmed')
})

test('arm form defaults to no permissions and sends chosen capabilities through a registered command', async () => {
  let armed: Record<string, unknown> | null = null
  const row = sitter()
  const ui = mount({ call: (method, params) => {
    if (method === 'quirky.reviews/checksSitterArm') {
      armed = params
      ui.setResponse({ ...sitterState(row), detail: detailFor(row) })
      return { ok: true, kind: 'enrolled', enrollment: row.enrollment }
    }
    return undefined
  } })
  await settle()
  await click('PR Sitter')
  for (const label of ['Update branch', 'Resolve conflicts', 'Fix checks', 'Merge']) expect(field(label).value).toBe('off')
  expect(field('Active-time budget (hours)').value).toBe('4')
  expect(document.body.textContent).toContain('Actions set to Ask hold for your approval before running.')
  await change('Fix checks', 'on')
  await change('Update branch', 'on')
  await change('Merge', 'gated')
  await change('Merge method', 'squash')
  await click('Arm PR Sitter')
  expect(armed).toMatchObject({
    worktree: WORKTREE, capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'gated' },
    branchUpdateMode: 'merge-base-update', mergeMethod: 'squash', mergeCheckScope: 'all', budgetHours: 4,
  })
  expect(ui.executed.some(({ id }) => id === `${commandsPrefix}arm-sitter`)).toBe(true)
  expect(document.body.textContent).toContain('Active budget remaining')
})

test('rebase warning and enrollment refusals leave the form open', async () => {
  mount({ call: (method) => method === 'quirky.reviews/checksSitterArm'
    ? Promise.reject(new Error('The PR sitter updates a branch by merging its base; rebase is not supported.')) : undefined })
  await settle()
  await click('PR Sitter')
  await change('Branch update', 'rebase')
  expect(document.body.textContent).toContain('Rebasing rewrites commit SHAs')
  await click('Arm PR Sitter')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('rebase is not supported')
  expect(button('Arm PR Sitter')).toBeDefined()
})

test.each(['closed', 'merged'] as const)('a %s review cannot be armed', async (state) => {
  mount({ model: reviewsState(WORKTREE, { ...review, state }) })
  await settle()
  await click('PR Sitter')
  expect(button('Arm PR Sitter').disabled).toBe(true)
  expect(document.body.textContent).toContain('Only an open review can be armed.')
})

test('a detached branch and invalid active-time budget cannot be armed', async () => {
  const state = reviewsState()
  state.checks.lookup = { gitStatus: { branch: null } }
  const ui = mount({ model: state })
  await settle()
  await click('PR Sitter')
  expect(button('Arm PR Sitter').disabled).toBe(true)
  expect(document.body.textContent).toContain('A checked-out branch is required')
  ui.setState(reviewsState())
  await change('Active-time budget (hours)', '0')
  expect(button('Arm PR Sitter').disabled).toBe(true)
})

test('open-sitter command opens Checks and the pending dialog even before panel mounts', async () => {
  const ui = mount({ panelOpen: false })
  await settle()
  await act(async () => { await ui.context.executeCommand(`${commandsPrefix}open-sitter`, { worktree: WORKTREE }) })
  await settle()
  expect(ui.calls.some(({ method }) => method === 'quirky.reviews/showChecks')).toBe(true)
  expect(button('Arm PR Sitter')).toBeDefined()
})

test('fleetChanged updates the row and detail is requested only while the dialog is open', async () => {
  const row = sitter()
  const ui = mount({ response: sitterState(row) })
  await settle()
  expect(ui.calls.filter(({ method, params }) => method.endsWith('/checksSitterGet') && params.includeDetail === true)).toHaveLength(0)
  row.status.state = 'held'
  ui.setResponse({ ...sitterState(row), detail: detailFor(row) })
  await ui.fleetChanged()
  expect(ui.element.textContent).toContain('Held')
  await click('PR Sitter')
  expect(ui.calls.some(({ method, params }) => method.endsWith('/checksSitterGet') && params.includeDetail === true)).toBe(true)
  const ledger = document.querySelector('details')
  expect(ledger?.open).toBe(false)
  expect(ledger?.querySelector('summary')?.textContent).toBe('Activity ledger')
  expect(ledger?.textContent).toBeTruthy()
  await click('Close')
  const before = ui.calls.length
  await ui.fleetChanged()
  expect(ui.calls.slice(before).filter(({ params }) => params.includeDetail === true)).toHaveLength(0)
})

test('held approval shows immutable scope and sends that exact scope', async () => {
  const row = sitter('held')
  const scope = { actionKind: 'merge', contentIdentity: 'head/base', evidenceKey: 'merge/head/1', preparedCommitSha: 'prepared-sha' }
  row.openEscalations = [{ escalationId: 'esc-a', escalationKind: 'approval', status: 'open', foldCount: 0, reason: 'Approval required', approvalScope: scope }]
  const ui = mount({ response: { ...sitterState(row), detail: detailFor(row) } })
  await settle()
  await click('PR Sitter')
  expect(document.body.textContent).toContain('Merge review')
  expect(document.body.textContent).toContain('head/base')
  expect(document.body.textContent).toContain('prepared-sha')
  await click('Approve this action')
  expect(ui.executed).toContainEqual({ id: `${commandsPrefix}approve-sitter`, args: {
    worktree: WORKTREE, watcherId: 'watcher-a', escalationId: 'esc-a', expectedScope: scope,
  } })
})

test('an unverifiable owner makes held action and stop read-only', async () => {
  const row = sitter('held')
  row.ownerContact = 'unverifiable'
  row.openEscalations = [{ escalationId: 'esc-a', escalationKind: 'approval', status: 'open', foldCount: 0,
    approvalScope: { actionKind: 'merge', contentIdentity: 'head', evidenceKey: 'key' } }]
  mount({ response: { ...sitterState(row), detail: detailFor(row) } })
  await settle()
  await click('PR Sitter')
  expect(document.body.textContent).toContain('the owner cannot currently be reached')
  expect(button('Approve this action').disabled).toBe(true)
  expect(button('Stop this sitter').disabled).toBe(true)
})

test('stop refreshes into a prepopulated re-arm form', async () => {
  const row = sitter()
  const ui = mount({ response: { ...sitterState(row), detail: detailFor(row) }, call: (method) => {
    if (method !== 'quirky.reviews/checksSitterStop') return undefined
    row.status.state = 'disabled'
    row.enrollment.enabled = false
    ui.setResponse({ ...sitterState(row), detail: detailFor(row), activeCount: 0 })
    return { ok: true, kind: 'applied' }
  } })
  await settle()
  await click('PR Sitter')
  await click('Stop this sitter')
  expect(document.body.textContent).toContain('Stopped')
  expect(field('Merge').value).toBe('gated')
  expect(field('Merge method').value).toBe('squash')
  await click('Re-arm PR Sitter')
  expect(ui.executed.some(({ id }) => id === `${commandsPrefix}arm-sitter`)).toBe(true)
})

test('stop-all is disabled for an empty fleet and displays partial-failure warning', async () => {
  const ui = mount({ call: (method) => method === 'quirky.reviews/checksSitterStopAll'
    ? { total: 2, stopped: 1, refusedCount: 1, indeterminateCount: 0, warning: '1 owners refused the stop command.' } : undefined })
  await settle()
  expect(button('Stop all PR Sitters').disabled).toBe(true)
  ui.setResponse({ ...sitterState(), activeCount: 2, otherActiveCount: 2 })
  await ui.fleetChanged()
  await click('Stop all PR Sitters')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('1 owners refused the stop command.')
})

test('copy debug report writes only to the injected clipboard and resets feedback', async () => {
  const row = sitter()
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value: string) { copied.push(value) } } })
  try {
    mount({ response: { ...sitterState(row), detail: detailFor(row) } })
    await settle()
    await click('PR Sitter')
    await click('Copy debug report')
    expect(copied).toEqual([JSON.stringify({ watcher: 'watcher-a', state: 'watching' }, null, 2)])
    expect(button('Debug report copied')).toBeDefined()
    await act(async () => {
      const pending = Promise.withResolvers<void>()
      setTimeout(pending.resolve, 2_050)
      await pending.promise
    })
    expect(button('Copy debug report')).toBeDefined()
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('late responses from the previous worktree cannot overwrite the selected sitter', async () => {
  const late = Promise.withResolvers<unknown>()
  const row = sitter('held')
  row.enrollment.worktreeId = OTHER
  row.target.watcherId = 'watcher-b'
  const ui = mount({ call: (method, params) => {
    if (method !== 'quirky.reviews/checksSitterGet') return undefined
    return params.worktree === WORKTREE ? late.promise : sitterState(row)
  } })
  await settle()
  ui.switchWorktree(OTHER)
  ui.setState(reviewsState(OTHER))
  await settle()
  expect(ui.element.textContent).toContain('Held')
  await act(async () => { late.resolve(sitterState(sitter('watching'))) })
  await settle()
  expect(ui.element.textContent).toContain('Held')
  expect(ui.element.textContent).not.toContain('Watching')
})

test('activity shows only the newest twenty entries in descending order', async () => {
  const row = sitter()
  const detail = detailFor(row)
  mount({ response: { ...sitterState(row), detail } })
  await settle()
  await click('PR Sitter')
  const text = document.querySelector('details')?.textContent ?? ''
  const latest = formatLedgerEntry(detail.journal[24]!).timestamp
  const next = formatLedgerEntry(detail.journal[23]!).timestamp
  expect(text).toContain(latest)
  expect(text.indexOf(latest)).toBeLessThan(text.indexOf(next))
  for (const entry of detail.journal.slice(0, 5)) expect(text).not.toContain(formatLedgerEntry(entry).timestamp)
})

test('unlimited budget and bounded worker turns remain explicit in status', async () => {
  const row = sitter()
  row.enrollment.budget = { wallClockActiveMs: null, turns: 10 }
  mount({ response: { ...sitterState(row), detail: detailFor(row) } })
  await settle()
  await click('PR Sitter')
  expect(document.body.textContent).toContain('Unlimited')
  expect(document.body.textContent).toContain('Worker turns')
  expect(document.body.textContent).toContain('2 / 10')
})

test('parked unverifiable owners cannot be rearmed', async () => {
  const row = sitter('parked')
  row.ownerContact = 'unverifiable'
  row.enrollment.parkReason = 'budget-wall-clock'
  mount({ response: { ...sitterState(row), detail: detailFor(row) } })
  await settle()
  await click('PR Sitter')
  expect(button('Re-arm PR Sitter').disabled).toBe(true)
})

test('a refused approval remains visible for inspection and retry', async () => {
  const row = sitter('held')
  row.openEscalations = [{ escalationId: 'esc-a', escalationKind: 'approval', status: 'open', foldCount: 0,
    approvalScope: { actionKind: 'merge', contentIdentity: 'head', evidenceKey: 'key' } }]
  mount({ response: { ...sitterState(row), detail: detailFor(row) }, call: (method) =>
    method === 'quirky.reviews/checksSitterApprove' ? Promise.reject(new Error('The approval scope changed; inspect the current escalation before approving.')) : undefined })
  await settle()
  await click('PR Sitter')
  await click('Approve this action')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('The approval scope changed')
  expect(button('Approve this action').disabled).toBe(false)
})

test('other active sitters are counted in the arm dialog', async () => {
  mount({ response: { ...sitterState(), activeCount: 2, otherActiveCount: 2 } })
  await settle()
  await click('PR Sitter')
  expect(document.body.textContent).toContain('2 sitters are active on other reviews.')
  expect(document.body.textContent).toContain(stoppingHelp)
})

test('late errors from another worktree cannot add an alert', async () => {
  const late = Promise.withResolvers<unknown>()
  const ui = mount({ call: (method, params) => method === 'quirky.reviews/checksSitterGet'
    ? params.worktree === WORKTREE ? late.promise : sitterState(sitter('held')) : undefined })
  await settle()
  ui.switchWorktree(OTHER)
  ui.setState(reviewsState(OTHER))
  await settle()
  await act(async () => { late.reject(new Error('Old worktree failed')) })
  await settle()
  expect(document.body.textContent).not.toContain('Old worktree failed')
  expect(document.querySelector('[role="alert"]')).toBeNull()
})
