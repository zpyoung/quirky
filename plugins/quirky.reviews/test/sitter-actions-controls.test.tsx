import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { ReviewData, ReviewsState } from '../src/contracts'
import { createReviewsEnv, newChecksEntry } from '../src/env'
import { detailMethods } from '../src/detail/methods'
import { ReviewActions } from '../src/detail/Actions'
import { SitterRow, SitterSafetyStrip } from '../src/checks/SitterRow'
import { listReviewsUiControls, requestOpenSitter, requestReviewsUiControl, runReviewsUiControl, type ChecksSitterState, type SitterFleetRow, type ReviewsUiControlDescriptor } from '../src/checks/data'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import type { Candidate, CoverageFile, Evidence, Inventory, PluginInventory, Ref } from '../../../scripts/ui-scoreboard/contracts'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})
afterAll(() => GlobalRegistrator.unregister())
const WORKTREE = '/fixture/tree'
const PANEL = 'panel:quirky.reviews/checks'
const VIEW = 'view:quirky.reviews/review'
const REPO = { host: 'github.com', owner: 'fixture', repo: 'reviews' }
const review: ReviewData = {
  provider: 'github', number: 12, url: 'https://github.com/fixture/reviews/pull/12', title: 'Review 12', body: '',
  state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE', checksStatus: 'success', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, stack: null, mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
  mergeMetadataKnown: true, mergeQueueRequired: false, autoMergeAllowed: true, prRepo: REPO,
}

function model(current: ReviewData | null = review): ReviewsState {
  return {
    checks: { worktree: WORKTREE, generation: 1, review: current, conflicts: null },
    detail: { target: { worktree: WORKTREE, number: current?.number ?? 12, prRepo: REPO }, generation: 1, review: current, details: null, pending: [] },
  } as unknown as ReviewsState
}

test('loading check details preserves prior run keys and the public stored shape', async () => {
  const details = { check: { id: 31, name: 'build' }, annotations: [], jobs: [], logTails: [], partialFailures: [], truncated: false }
  const env = createReviewsEnv({
    openStore: () => ({ get: () => undefined, run: () => {} }), emit() {},
    error: (_kind: string, message: string) => new Error(message),
    call: async (method: string) => {
      if (method === 'quirky.worktree/resolve') return { id: WORKTREE, kind: 'git', repoId: 'fixture', path: WORKTREE }
      if (method === 'quirky.hosting/checkDetails') return details
      throw new Error(`Unexpected method ${method}`)
    },
  } as never)
  env.update((state) => {
    const entry = newChecksEntry(WORKTREE, 1)
    entry.review = review
    entry.checks = { number: 12, headSha: review.headRefOid, rollup: 'success', checks: [{ kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 31, workflowRunId: null, suiteId: null, url: null }], partial: false, partialFailures: [], detailsById: { '19': { prior: true } } }
    state.checksByWorktree[WORKTREE] = entry
  })
  const methods = detailMethods(env)
  await methods.detailLoadCheckDetails!({ surface: 'checks', worktree: WORKTREE, number: 12, expectedHead: review.headRefOid, checkRunId: 31 } as never, {} as never)
  expect(env.read().checksByWorktree[WORKTREE]?.checks?.detailsById).toEqual({ '19': { prior: true }, '31': details })
})

test('detail methods expose no UI action candidates', () => {
  const inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')!
  expect(discoverCandidates(plugin, ['plugins/quirky.reviews/src/detail/methods.ts'])).toEqual([])
})

type Call = { method: string; params: Record<string, unknown> }
function bridge(connId = 41) {
  const calls: Call[] = []
  const commands: Array<{ id: string; args: unknown }> = []
  const toasts: unknown[][] = []
  const methods = new Map<string, (params: Record<string, unknown>) => unknown>()
  const context: UiPluginContext = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (methods.has(method)) return await methods.get(method)!(params)
      if (method === 'ui.window.self') return { connId }
      if (method === 'ui.window.command.run') {
        expect(params.connId).toBe(connId)
        expect(params.id).toBe('command:quirky.reviews/ui-control')
        return { result: await runReviewsUiControl(context, params.args) }
      }
      if (method === 'quirky.reviews/detailMergeConfirmation') return 'Merge the captured pull request.'
      if (method === 'quirky.reviews/detailMerge') return { number: 12, state: 'merged' }
      if (method === 'quirky.tasks/state') return { items: [] }
      return {}
    },
    async executeCommand(id: string, args?: unknown) {
      commands.push({ id, args })
      if (id === 'command:quirky.reviews/open-sitter') requestOpenSitter(WORKTREE)
    },
    confirm: async () => true,
    toast: (...args: unknown[]) => { toasts.push(args) },
  } as unknown as UiPluginContext
  return { context, calls, commands, toasts, methods }
}

async function mount(render: () => ReactNode) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  const update = async () => { await act(async () => root.render(render())) }
  await update()
  return { element, update }
}

function control(h: ReturnType<typeof bridge>, slot: string, surface = PANEL) {
  const found = listReviewsUiControls(h.context, surface).find((entry) => entry.slot === slot)
  if (!found) throw new Error(`Missing ${slot} control`)
  return found
}
async function invoke(h: ReturnType<typeof bridge>, descriptor: ReviewsUiControlDescriptor, action: string, value?: Record<string, unknown>) {
  let result: unknown
  await act(async () => { result = await requestReviewsUiControl(h.context, { target: descriptor.target, generation: descriptor.generation, action, ...(value === undefined ? {} : { value }) }) })
  return result
}

async function expectInvalidControlHasNoMutation(h: ReturnType<typeof bridge>, operation: () => Promise<unknown>) {
  const calls = h.calls.filter((call) => !call.method.startsWith('ui.window.'))
  const commands = h.commands.slice()
  let failure: unknown = null
  try {
    await operation()
  } catch (cause) {
    failure = cause
  }
  await act(async () => { await Promise.resolve() })
  expect(h.calls.filter((call) => !call.method.startsWith('ui.window.'))).toEqual(calls)
  expect(h.commands).toEqual(commands)
  expect(failure !== null || document.querySelector('.ui-inline-error') !== null).toBe(true)
}

function fleetRow(state: SitterFleetRow['status']['state'] = 'watching'): SitterFleetRow {
  return {
    target: { watcherId: 'watcher-a' },
    ownerFence: { executionHostId: 'host-a', schedulerOwner: 'owner-a', workspaceKey: 'workspace-a', revision: 1 },
    enrollment: {
      watcherId: 'watcher-a', kind: 'hosted-review', enabled: true, paused: false, commandRevision: 1,
      worktreeId: WORKTREE, capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
      budget: { wallClockActiveMs: 14_400_000, turns: null },
      kindPayload: { branchUpdateMode: 'merge-base-update', mergeMethod: 'squash', mergeCheckScope: 'all' },
      createdAtMs: 1, terminalAtMs: null, parkReason: null, haltReason: null,
    },
    status: { state, nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
    name: 'PR #12', workspaceName: 'tree', branch: 'feature', phase: 'Watching checks',
    ownerContact: 'live', observedAtMs: 1, lastSuccessfulTickAtMs: null,
    budget: { activeMs: 0, turns: 0, exhausted: null }, openEscalations: [], pendingQuestion: false,
  }
}
function sitterState(row: SitterFleetRow | null = null): ChecksSitterState {
  return { available: true, sitter: row, detail: null, activeCount: row ? 1 : 0, otherActiveCount: 0 }
}
async function mountSitter(h: ReturnType<typeof bridge>, current: ChecksSitterState, loading = false) {
  const props = { context: h.context, activeWorktree: WORKTREE, review, lookup: { gitStatus: { branch: 'feature' } }, sitterState: current, loadingDetail: loading, onRefreshSitter: async () => {} }
  const ui = await mount(() => <SitterRow {...props} />)
  await invoke(h, control(h, 'sitter-row'), 'open-dialog')
  return { ...ui, props }
}

for (const connId of [41, 42]) {
  test(`sitter row and modal use exact-window ${connId} command envelopes`, async () => {
    const h = bridge(connId)
    await mountSitter(h, sitterState())
    const row = control(h, 'sitter-row')
    const dialog = control(h, 'sitter-dialog')
    expect(JSON.parse(row.target)).toEqual([PANEL, 'sitter-row', WORKTREE, 'github.com/fixture/reviews', 12, review.headRefOid, null])
    expect(JSON.parse(dialog.target)).toEqual([PANEL, 'sitter-dialog', WORKTREE, 'github.com/fixture/reviews', 12, review.headRefOid, 'sitter'])
    expect(await invoke(h, dialog, 'arm', { capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'gated', merge: 'off' }, branchUpdateMode: 'rebase', mergeMethod: 'merge', mergeCheckScope: 'required', budgetHours: 2 })).toMatchObject({ delivered: true })
    expect(h.commands.at(-1)).toEqual({ id: 'command:quirky.reviews/arm-sitter', args: { worktree: WORKTREE, capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'gated', merge: 'off' }, branchUpdateMode: 'rebase', mergeMethod: 'merge', mergeCheckScope: 'required', budgetHours: 2 } })
    await invoke(h, dialog, 'close-dialog')
    expect(listReviewsUiControls(h.context, PANEL).some((entry) => entry.slot === 'sitter-dialog')).toBe(false)
    expect(h.calls.filter((call) => call.method === 'ui.window.command.run').every((call) => call.params.connId === connId)).toBe(true)
  })
}

test('sitter ledger distinguishes pending, idle-unloaded, empty, populated and neutral unreachable guidance', async () => {
  const h = bridge()
  const row = fleetRow()
  row.ownerContact = 'unverifiable'
  const current = sitterState(row)
  const ui = await mountSitter(h, current, true)
  expect(document.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Loading sitter details')
  expect([...document.querySelectorAll('.ui-notice-line')].map((node) => node.textContent)).toContain('Loading activity ledger…')
  expect([...document.querySelectorAll('.ui-notice-line')].map((node) => node.textContent)).toContain('Stopping is disabled while the owner cannot be reached.')
  ui.props.loadingDetail = false
  await ui.update()
  expect(document.querySelector('.ui-empty-state')?.textContent).toContain('Open sitter details')
  current.detail = { target: row.target, ownerFence: row.ownerFence, enrollment: row.enrollment, status: row.status, budget: row.budget, ownerContact: row.ownerContact, observedAtMs: 1, openEscalations: [], pendingControls: [], journal: [] }
  await ui.update()
  expect(document.querySelector('.ui-empty-state')?.textContent).toContain('No activity has been recorded.')
  current.detail.journal = [{ seq: 1, eventId: 'fact-1', atMs: 1, class: 'fact', origin: 'owner', kind: 'observation', resolved: false }]
  await ui.update()
  expect(document.querySelector('details ol li')).not.toBeNull()
  const actions = control(h, 'sitter-dialog').actions
  for (const action of ['arm', 'approve', 'stop']) expect(actions.find((item) => item.action === action)?.enabled).toBe(false)
})

test.each([
  { budgetHours: 0 }, { budgetHours: -1 }, { budgetHours: NaN }, { budgetHours: Infinity }, { capabilities: { merge: 'maybe' } },
  { capabilities: { unknown: 'on' } }, { branchUpdateMode: 'reset' }, { mergeMethod: 'fast-forward' }, { mergeCheckScope: 'none' }, { unexpected: true },
])('sitter arm refuses malformed payload without mutation', async (value) => {
  const h = bridge()
  await mountSitter(h, sitterState())
  await expectInvalidControlHasNoMutation(h, () => invoke(h, control(h, 'sitter-dialog'), 'arm', value))
  expect(h.commands.filter((command) => command.id.endsWith('/arm-sitter'))).toEqual([])
})

test.each(['watching', 'acting', 'held', 'terminal'] as const)('active or completed sitter %s cannot arm through a raw control request', async (state) => {
  const h = bridge()
  await mountSitter(h, sitterState(fleetRow(state)))
  expect(await invoke(h, control(h, 'sitter-dialog'), 'arm')).toEqual({ delivered: false, reason: 'disabled' })
})

test.each(['disabled', 'parked'] as const)('%s sitter re-arms through the existing command', async (state) => {
  const h = bridge()
  await mountSitter(h, sitterState(fleetRow(state)))
  await invoke(h, control(h, 'sitter-dialog'), 'arm')
  expect(h.commands.at(-1)?.id).toBe('command:quirky.reviews/arm-sitter')
})

test('sitter controls refuse extra keys on no-payload actions and ambiguous approval ids', async () => {
  const h = bridge()
  const row = fleetRow('held')
  row.openEscalations = ['one', 'two'].map((escalationId) => ({ escalationId, status: 'open', foldCount: 1, escalationKind: 'approval', approvalScope: { actionKind: 'merge', contentIdentity: 'head-a', evidenceKey: escalationId } }))
  await mountSitter(h, sitterState(row))
  await mount(() => <SitterSafetyStrip context={h.context} sitterState={sitterState(row)} onStoppedAll={() => {}} />)
  for (const [slot, action] of [['sitter-safety-strip', 'stop-all'], ['sitter-row', 'open-dialog'], ['sitter-dialog', 'close-dialog'], ['sitter-dialog', 'stop'], ['sitter-dialog', 'copy-debug']] as const) {
    await expectInvalidControlHasNoMutation(h, () => invoke(h, control(h, slot), action, { unexpected: true }))
  }
  const descriptor = control(h, 'sitter-dialog')
  for (const value of [{}, { escalationId: 'missing' }, { escalationId: 'one', unexpected: true }]) {
    await expectInvalidControlHasNoMutation(h, () => invoke(h, descriptor, 'approve', value))
  }
  await invoke(h, descriptor, 'approve', { escalationId: 'one' })
  expect(h.commands.at(-1)).toEqual({ id: 'command:quirky.reviews/approve-sitter', args: { worktree: WORKTREE, watcherId: 'watcher-a', escalationId: 'one', expectedScope: row.openEscalations[0]!.approvalScope } })
})

test('sitter non-delivery errors are current-session only', async () => {
  const h = bridge()
  await mountSitter(h, sitterState(fleetRow()))
  h.methods.set('ui.window.command.run', () => ({ result: { delivered: false, reason: 'disabled' } }))
  const copy = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Copy debug report')!
  await act(async () => copy.click())
  expect(document.querySelector('.ui-inline-error')).not.toBeNull()
  h.methods.delete('ui.window.command.run')
  await invoke(h, control(h, 'sitter-dialog'), 'close-dialog')
  await invoke(h, control(h, 'sitter-row'), 'open-dialog')
  const held = Promise.withResolvers<unknown>()
  h.methods.set('ui.window.command.run', () => held.promise)
  await act(async () => { [...document.querySelectorAll('button')].find((item) => item.textContent === 'Copy debug report')!.click() })
  const closing = control(h, 'sitter-dialog')
  await act(async () => { await runReviewsUiControl(h.context, { target: closing.target, generation: closing.generation, action: 'close-dialog' }) })
  h.methods.delete('ui.window.command.run')
  await invoke(h, control(h, 'sitter-row'), 'open-dialog')
  await act(async () => { held.resolve({ result: { delivered: false, reason: 'target-unavailable' } }); await held.promise })
  expect(document.querySelector('.ui-inline-error')).toBeNull()
})

for (const surface of ['checks', 'detail'] as const) {
  const surfaceId = surface === 'checks' ? PANEL : VIEW
  for (const connId of [41, 42]) {
    test(`${surface} review actions use exact-window ${connId} and all merge method payloads`, async () => {
      const h = bridge(connId)
      await mount(() => <ReviewActions context={h.context} state={model()} surface={surface} refresh={async () => {}} />)
      const descriptor = control(h, 'review-actions', surfaceId)
      expect(JSON.parse(descriptor.target)).toEqual([surfaceId, 'review-actions', WORKTREE, 'github.com/fixture/reviews', 12, review.headRefOid, null])
      await expectInvalidControlHasNoMutation(h, () => invoke(h, descriptor, 'merge', { method: 'reset' }))
      await invoke(h, descriptor, 'merge', { method: 'merge' })
      expect(h.calls.find((call) => call.method === 'quirky.reviews/detailMerge')?.params).toEqual({ surface, worktree: WORKTREE, number: 12, prRepo: REPO, expectedHead: review.headRefOid, method: 'merge', action: 'direct', yes: true })
      expect(h.toasts).toContainEqual(['Pull request merged', 'PR #12 is merged.'])
    })
  }

  for (const [action, change, method, expected] of [
    ['merge-when-ready', { mergeQueueRequired: true }, 'quirky.reviews/detailMerge', { action: 'queue', method: 'squash' }],
    ['enable-auto-merge', { reviewDecision: 'REVIEW_REQUIRED' }, 'quirky.reviews/detailSetAutoMerge', { enabled: true, method: 'rebase' }],
    ['disable-auto-merge', { autoMergeRequest: {} }, 'quirky.reviews/detailSetAutoMerge', { enabled: false }],
    ['provider-merge-box', {}, 'quirky.reviews/openLink', { url: review.url, worktree: WORKTREE }],
    ['mark-ready', { state: 'draft' }, 'quirky.reviews/detailMarkReady', { surface, worktree: WORKTREE, number: 12 }],
    ['close', {}, 'quirky.reviews/detailCloseReview', { yes: true }],
    ['fix-checks', { checksStatus: 'failure' }, 'quirky.reviews/checksSetAgentDialog', { surface, action: 'fix' }],
  ] as const) {
    test(`${surface} ${action} validates keys and dispatches the captured target`, async () => {
      const h = bridge()
      await mount(() => <ReviewActions context={h.context} state={model({ ...review, ...change })} surface={surface} refresh={async () => {}} />)
      const descriptor = control(h, 'review-actions', surfaceId)
      await expectInvalidControlHasNoMutation(h, () => invoke(h, descriptor, action, { unexpected: true }))
      await invoke(h, descriptor, action, action === 'enable-auto-merge' ? { method: 'rebase' } : undefined)
      expect(h.calls.find((call) => call.method === method)?.params).toMatchObject(expected)
    })
  }

  test(`${surface} missing selection, stack error, workspace loading/empty/error and action failure use shared states`, async () => {
    const h = bridge()
    let state = model(null)
    const ui = await mount(() => <ReviewActions context={h.context} state={state} surface={surface} refresh={async () => {}} />)
    expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('Review actions are unavailable')
    state = model({ ...review, stack: { number: 1 } })
    await ui.update()
    expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Open the provider merge box')
    const held = Promise.withResolvers<unknown>()
    h.methods.set('quirky.tasks/state', () => held.promise)
    state = model({ ...review, state: 'merged' })
    await ui.update()
    expect(ui.element.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Checking for a linked workspace')
    await act(async () => { held.resolve({ workspaces: [] }); await held.promise })
    expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No workspace is linked')
    h.methods.set('quirky.tasks/state', () => { throw new Error('link lookup failed') })
    state[surface].generation += 1
    await ui.update()
    expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('link lookup failed')
    state = model()
    await ui.update()
    h.methods.set('ui.window.command.run', () => ({ result: { delivered: false, reason: 'disabled' } }))
    await act(async () => { [...ui.element.querySelectorAll('button')].find((item) => item.textContent === 'Squash and merge')!.click() })
    expect(ui.element.querySelector('.ui-inline-error')).not.toBeNull()
    expect(h.toasts.at(-1)?.[0]).toBe('Review action failed')
  })
}

const SCOREBOARD_FRAGMENT = 'plugins/quirky.reviews/ui-scoreboard/sitter-and-actions.json'
const SITTER_SOURCE = 'plugins/quirky.reviews/src/checks/SitterRow.tsx'
const ACTIONS_SOURCE = 'plugins/quirky.reviews/src/detail/Actions.tsx'
const METHODS_SOURCE = 'plugins/quirky.reviews/src/detail/methods.ts'
const DATA_SOURCE = 'plugins/quirky.reviews/src/checks/data.ts'
const UI_CONTROL = 'command:quirky.reviews/ui-control'
const OWNED_SOURCES: Record<string, true> = {
  [SITTER_SOURCE]: true,
  [ACTIONS_SOURCE]: true,
  [METHODS_SOURCE]: true
}
const OWNED_SURFACES: Record<string, true> = { [PANEL]: true, [VIEW]: true }
const AUDIT_PASS_CODES: Record<string, true> = {
  'state-covered': true, 'state-not-applicable': true, 'not-state': true,
  'action-routed': true, 'action-transient': true, 'action-not-user': true
}

type ScoreboardFixture = {
  inventory: Inventory
  plugin: PluginInventory
  graph: { files: string[]; failures: Evidence[] }
  candidates: Candidate[]
}

let cachedScoreboardFixture: ScoreboardFixture | undefined
function scoreboardFixture(): ScoreboardFixture {
  if (cachedScoreboardFixture === undefined) {
    const inventory = collectInventory(resolve(import.meta.dir, '../../..'))
    const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')
    if (!plugin) throw new Error('Expected quirky.reviews in the unfiltered inventory')
    const graph = discoverUiFiles(plugin)
    cachedScoreboardFixture = { inventory, plugin, graph, candidates: discoverCandidates(plugin, graph.files) }
  }
  return cachedScoreboardFixture
}

function requiredScoreboardFragment(plugin: PluginInventory) {
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === SCOREBOARD_FRAGMENT)
  if (!fragment) throw new Error(`Expected ${SCOREBOARD_FRAGMENT}`)
  return fragment
}

function withFragment(plugin: PluginInventory, content: string): PluginInventory {
  const fragments = plugin.coverageFragments ?? []
  if (!fragments.some((entry) => entry.file === SCOREBOARD_FRAGMENT)) throw new Error(`Expected ${SCOREBOARD_FRAGMENT}`)
  return {
    ...plugin,
    coverageFragments: fragments.map((entry) => entry.file === SCOREBOARD_FRAGMENT ? { ...entry, content } : entry)
  }
}

function withSource(plugin: PluginInventory, file: string, before: string, after: string): PluginInventory {
  let changed = false
  const sources = plugin.sources.map((source) => {
    if (source.file !== file) return source
    if (!source.content.includes(before)) throw new Error(`Expected mutation target in ${file}: ${before}`)
    changed = true
    return { ...source, content: source.content.replace(before, after) }
  })
  if (!changed) throw new Error(`Expected source ${file}`)
  return { ...plugin, sources }
}

function encodeCoverage(coverage: CoverageFile): string {
  return JSON.stringify(coverage)
}

function evidenceFor(plugin: PluginInventory) {
  return auditPlugin(scoreboardFixture().inventory, plugin).flatMap((check) => check.evidence)
}

function candidateAt(ref: Ref, category: Candidate['category'], anchor?: string): Candidate {
  const { plugin, graph, candidates } = scoreboardFixture()
  const resolved = resolveRef(plugin, graph.files, ref)
  if ('code' in resolved) throw new Error(resolved.message)
  const candidate = selectCandidate(resolved, candidates, category, anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  return candidate
}

function expectEntriesOnOneLine(content: string, coverage: CoverageFile) {
  const lines = content.split('\n')
  for (const section of ['states', 'notState', 'actions'] as const) {
    const start = lines.findIndex((line) => line.trim() === `"${section}": [`)
    const end = lines.findIndex((line, index) => index > start && (line.trim() === '],' || line.trim() === ']'))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const entries = lines.slice(start + 1, end).filter((line) => line.trim().startsWith('{'))
    expect(entries).toHaveLength(coverage[section].length)
    for (const line of entries) expect(line.trim()).toMatch(/^\{.*\},?$/)
  }
}

test('sitter and review actions coverage audits the unfiltered UI graph', () => {
  const { inventory, plugin, graph, candidates } = scoreboardFixture()
  expect(inventory.failures).toEqual([])
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain(SITTER_SOURCE)
  expect(graph.files).toContain(ACTIONS_SOURCE)
  expect(graph.files).toContain(METHODS_SOURCE)
  expect(candidates.filter((candidate) => candidate.file === METHODS_SOURCE)).toEqual([])

  const fragment = requiredScoreboardFragment(plugin)
  const coverage = parseCoverage(fragment.content)
  expect(coverage.schemaVersion).toBe(1)
  expect(Object.keys(coverage.surfaces)).toEqual([])
  expectEntriesOnOneLine(fragment.content, coverage)
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) {
    expect([SITTER_SOURCE, ACTIONS_SOURCE]).toContain(entry.site.file)
  }
  for (const entry of coverage.states) {
    expect(plugin.targets).toContain(entry.surface)
    expect(entry.render.component).toBe(entry.state === 'loading' ? 'NoticeLine' : entry.state === 'empty' ? 'EmptyState' : 'InlineError')
  }
  for (const entry of coverage.actions) {
    if ('route' in entry) {
      expect(entry.route.target).toBe(UI_CONTROL)
      expect(entry.route.invoke.file).toBe(DATA_SOURCE)
      expect(entry.route.invoke.quote).toMatch(/command\s*:\s*REVIEWS_UI_CONTROL/)
      expect(entry.route.via?.length).toBeGreaterThan(0)
      expect(entry.route.via?.at(-1)?.file).toBe(DATA_SOURCE)
      expect(entry.route.via?.at(-1)?.quote).toMatch(/reviewsUiControlDescriptor/)
      expect(entry.route.via?.at(-1)?.quote).toMatch(/command:\s*REVIEWS_UI_CONTROL,\s*args/)
    } else if ('transient' in entry) {
      expect(entry.transient).toBe('draft')
      expect(entry.reason).toMatch(/local.*draft|draft.*local/i)
    }
  }

  const failures = evidenceFor(plugin).filter((entry) => AUDIT_PASS_CODES[entry.code] !== true)
  expect(failures.every((entry) =>
    (entry.code === 'coverage-missing' && entry.source !== undefined && OWNED_SOURCES[entry.source.file] !== true) ||
    (entry.code === 'state-missing' && entry.targetId !== undefined && OWNED_SURFACES[entry.targetId] !== true)
  )).toBe(true)
})

test('removing one owned action witness exposes its exact missing candidate', () => {
  const { plugin } = scoreboardFixture()
  const fragment = requiredScoreboardFragment(plugin)
  const coverage = parseCoverage(fragment.content)
  const removed = coverage.actions.find((entry) => 'route' in entry)
  expect(removed).toBeDefined()
  if (!removed || !('route' in removed)) throw new Error('Expected a routed action')
  const candidate = candidateAt(removed.site, 'action', removed.anchor)
  const source = plugin.sources.find((entry) => entry.file === candidate.file)!
  const line = source.content.slice(0, candidate.anchorStart).split('\n').length
  const changed = withFragment(plugin, encodeCoverage({
    ...coverage,
    actions: coverage.actions.filter((entry) => entry !== removed)
  }))
  expect(evidenceFor(changed).some((entry) =>
    entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === line
  )).toBe(true)
})

test('raw markup invalidates shared-render evidence even when its witness is updated', () => {
  const { plugin } = scoreboardFixture()
  const fragment = requiredScoreboardFragment(plugin)
  const coverage = parseCoverage(fragment.content)
  const index = coverage.states.findIndex((entry) =>
    entry.site.file === SITTER_SOURCE && entry.state === 'loading' && entry.render.component === 'NoticeLine'
  )
  expect(index).toBeGreaterThanOrEqual(0)
  const entry = coverage.states[index]
  if (!entry || entry.render.component === 'toast') throw new Error('Expected shared loading evidence')
  const render = entry.render
  const oldElement = render.element.quote
  const rawElement = oldElement
    .replace(/<NoticeLine\b[^>]*>/, '<p role="status">')
    .replace(/<\/NoticeLine>/, '</p>')
  expect(rawElement).not.toBe(oldElement)
  const changedSource = withSource(plugin, SITTER_SOURCE, oldElement, rawElement)
  expect(evidenceFor(changedSource).some((issue) => issue.code === 'evidence-missing' && issue.coverageFile === SCOREBOARD_FRAGMENT)).toBe(true)

  const updatedStates = coverage.states.map((state, stateIndex) => stateIndex !== index ? state : {
    ...entry,
    site: {
      ...entry.site,
      quote: entry.site.quote.includes(oldElement) ? entry.site.quote.replace(oldElement, rawElement) : entry.site.quote
    },
    render: { ...render, element: { ...render.element, quote: rawElement } }
  })
  const updatedWitness = withFragment(changedSource, encodeCoverage({ ...coverage, states: updatedStates }))
  expect(evidenceFor(updatedWitness).some((issue) => issue.code === 'render-element-invalid' && issue.coverageFile === SCOREBOARD_FRAGMENT)).toBe(true)
})

test('undeclared UI-control targets are rejected by the public-route audit', () => {
  const { plugin } = scoreboardFixture()
  const fragment = requiredScoreboardFragment(plugin)
  const coverage = parseCoverage(fragment.content)
  const index = coverage.actions.findIndex((entry) => 'route' in entry)
  const entry = coverage.actions[index]
  expect(index).toBeGreaterThanOrEqual(0)
  if (!entry || !('route' in entry)) throw new Error('Expected a routed action')
  const replacementTarget = 'command:quirky.reviews/undeclared-ui-control'
  const changedSource = withSource(plugin, DATA_SOURCE, `'${UI_CONTROL}'`, `'${replacementTarget}'`)
  expect(evidenceFor(changedSource).some((issue) => issue.code === 'route-target-changed' && issue.coverageFile === SCOREBOARD_FRAGMENT)).toBe(true)

  const actions = coverage.actions.map((action, actionIndex) => actionIndex !== index || !('route' in action)
    ? action
    : { ...action, route: { ...action.route, target: replacementTarget } })
  const changedCoverage = withFragment(changedSource, encodeCoverage({ ...coverage, actions }))
  expect(evidenceFor(changedCoverage).some((issue) => issue.code === 'route-undeclared' && issue.coverageFile === SCOREBOARD_FRAGMENT)).toBe(true)
})
