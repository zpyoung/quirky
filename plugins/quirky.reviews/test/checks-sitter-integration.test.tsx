import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode, type QuirkyEvent, type UiLayout, type UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HostingTest } from '../../quirky.hosting/test/helpers'
import { GITHUB_STAND_IN, standInState, type StandInState } from '../../quirky.sitter/test/github-stand-in'
import { ChecksPanel } from '../src/checks/ChecksPanel'
import { CHECKS_PANEL, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'
import { bootReviews } from './support'

const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
GlobalRegistrator.register()
for (const [name, value] of runtimeGlobals) {
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const B1 = 'b'.repeat(40)
const SCOPE_CHANGED = 'The approval scope changed; inspect the current escalation before approving.'
const STOP_HELP = 'Stopping prevents new actions; an in-flight provider operation may finish.'
const extraBuiltins = ['quirky.heimdall', 'quirky.orchestration', 'quirky.sitter', 'quirky.agent-status']
const GITHUB_STAND_IN_WITH_COMMENTS = GITHUB_STAND_IN.replace(
  "      fail('Unsupported GitHub GraphQL fixture query')",
  `      if (query.includes('HostingComments')) {
        const item = byNumber(variables.number)
        if (!item || variables.owner !== 'test-owner' || variables.name !== 'test-repo') {
          out({ data: { repository: { pullRequest: null } } })
        } else {
          const emptyConnection = { nodes: [], pageInfo: { hasNextPage: false } }
          out({ data: { repository: { pullRequest: {
            comments: emptyConnection,
            reviews: emptyConnection,
            reviewThreads: emptyConnection,
          } } } })
        }
      } else {
        fail('Unsupported GitHub GraphQL fixture query')
      }`
)
if (GITHUB_STAND_IN_WITH_COMMENTS === GITHUB_STAND_IN) {
  throw new Error('Could not add HostingComments support to the GitHub stand-in fixture.')
}

type Capabilities = { updateBranch: 'off' | 'gated' | 'on'; resolveConflicts: 'off' | 'gated' | 'on'; fixChecks: 'off' | 'gated' | 'on'; merge: 'off' | 'gated' | 'on' }
type ArmParams = {
  worktree: string
  capabilities: Capabilities
  branchUpdateMode: 'merge-base-update' | 'rebase'
  mergeMethod: 'merge' | 'squash' | 'rebase' | null
  mergeCheckScope: 'all' | 'required'
  budgetHours: number
}
type ApprovalScope = { actionKind: string; contentIdentity: string; evidenceKey: string; preparedCommitSha?: string }
type FleetRow = {
  target: { watcherId: string; connectionId?: string | null; pairingRevision?: number | null }
  ownerFence: { executionHostId: string; schedulerOwner: string; workspaceKey: string; revision: number }
  enrollment: {
    watcherId: string
    kind: string
    enabled: boolean
    paused: boolean
    commandRevision: number
    worktreeId?: string | null
    capabilities: Capabilities
    budget: { wallClockActiveMs: number | null; turns: number | null }
    kindPayload: Record<string, unknown>
    terminalAtMs: number | null
  }
  status: { state: string; reason?: string; consecutiveErrors: number }
}
type FleetSnapshot = { rows: FleetRow[]; activeCount: number }
type WatcherDetail = {
  target: FleetRow['target']
  ownerFence: FleetRow['ownerFence']
  enrollment: FleetRow['enrollment']
  status: { state: string; reason?: string } | null
  openEscalations: { escalationId: string; approvalScope?: ApprovalScope }[]
  journal: { kind: string; state?: string; effect?: string; action?: { kind?: unknown } }[]
}
type SitterState = { available: boolean; sitter: FleetRow | null; detail: WatcherDetail | null; activeCount: number; otherActiveCount: number }
type EnrollmentResult = { ok: true; kind: 'enrolled' | 're-armed'; enrollment: FleetRow['enrollment'] }
type CliResult = { code: number; stdout: string; stderr: string }
type CommandRequest = { requestId: string; id: string; args?: unknown }
type MountedChecks = { element: HTMLElement; root: Root; flush(): Promise<void> }
type TestHost = HostingTest

const hosts: TestHost[] = []
const mounted: MountedChecks[] = []
let clipboardDescriptor: PropertyDescriptor | undefined

function initialStandInState(): StandInState {
  const base = standInState()
  const pull = base.prs[0]
  if (!pull) throw new Error('The GitHub stand-in has no pull request fixture.')
  return standInState({
    prs: [{ ...pull, mergeStateStatus: 'BEHIND', reviewDecision: 'APPROVED' }],
    mergeVisible: false
  })
}

function armParams(worktree: string, overrides: Partial<ArmParams> = {}): ArmParams {
  return {
    worktree,
    capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'off' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: 'squash',
    mergeCheckScope: 'all',
    budgetHours: 4,
    ...overrides
  }
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${description} was not an object.`)
  return value as Record<string, unknown>
}

function sitterState(value: unknown): SitterState {
  const state = record(value, 'PR Sitter state')
  if (typeof state.available !== 'boolean' || !Number.isSafeInteger(state.activeCount) ||
      !Number.isSafeInteger(state.otherActiveCount) ||
      !(state.sitter === null || typeof state.sitter === 'object' && !Array.isArray(state.sitter)) ||
      !(state.detail === null || typeof state.detail === 'object' && !Array.isArray(state.detail))) {
    throw new Error('PR Sitter returned an incomplete state.')
  }
  return state as unknown as SitterState
}

function watcherDetail(value: unknown): WatcherDetail {
  const detail = record(value, 'Heimdall detail')
  if (!record(detail.enrollment, 'Heimdall enrollment') || !Array.isArray(detail.journal) || !Array.isArray(detail.openEscalations)) {
    throw new Error('Heimdall returned an incomplete watcher detail.')
  }
  return detail as unknown as WatcherDetail
}

function approvalScope(detail: WatcherDetail): { escalationId: string; scope: ApprovalScope } {
  const escalation = detail.openEscalations.find((candidate) => candidate.approvalScope !== undefined)
  if (!escalation?.approvalScope) throw new Error('The held watcher did not expose an approval scope.')
  return { escalationId: escalation.escalationId, scope: escalation.approvalScope }
}

function attempt(detail: WatcherDetail, actionKind: string): WatcherDetail['journal'][number] | undefined {
  return detail.journal.findLast((entry) => entry.kind === 'attempt' && entry.action?.kind === actionKind)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function boot(): Promise<TestHost> {
  const host = await bootReviews(GITHUB_STAND_IN_WITH_COMMENTS, { extraBuiltins })
  hosts.push(host)
  host.writeState(initialStandInState())
  return host
}

async function publicDetail(host: TestHost, watcherId: string): Promise<WatcherDetail> {
  return watcherDetail(await host.client.callAny('quirky.heimdall/detail', { target: { watcherId } }))
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 10_000
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (ready(last)) return last
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last)}`)
}

async function reviewCli(host: TestHost, name: string, params: Record<string, unknown>): Promise<CliResult> {
  const args = ['--json', 'reviews', name]
  if (params.worktree !== undefined) args.push('--worktree', String(params.worktree))
  if (params.watcherId !== undefined) args.push('--watcher-id', String(params.watcherId))
  if (params.escalationId !== undefined) args.push('--escalation-id', String(params.escalationId))
  if (params.capabilities !== undefined) args.push('--capabilities', JSON.stringify(params.capabilities))
  if (params.branchUpdateMode !== undefined) args.push('--branch-update-mode', String(params.branchUpdateMode))
  if (params.mergeMethod !== undefined) args.push('--merge-method', JSON.stringify(params.mergeMethod))
  if (params.mergeCheckScope !== undefined) args.push('--merge-check-scope', String(params.mergeCheckScope))
  if (params.budgetHours !== undefined) args.push('--budget-hours', String(params.budgetHours))
  if (params.expectedScope !== undefined) args.push('--expected-scope', JSON.stringify(params.expectedScope))
  if (params.includeDetail === true) args.push('--include-detail')
  return await host.cli(args)
}

function cliJson<T>(result: CliResult, description: string): T {
  if (result.code !== 0) throw new Error(`${description} failed (${result.code}): ${result.stderr}${result.stdout}`)
  try {
    return JSON.parse(result.stdout) as T
  } catch (error) {
    throw new Error(`${description} did not return JSON: ${result.stdout}`, { cause: error })
  }
}

function cliFailureText(result: CliResult): string {
  return `${result.stderr}\n${result.stdout}`
}

function findButton(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Could not find the ${label} button.`)
  return found
}

function findSelect(root: ParentNode, labelText: string): HTMLSelectElement {
  const label = [...root.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === labelText)
  if (!label) throw new Error(`Could not find the ${labelText} select label.`)
  const select = [...root.querySelectorAll('select')].find((candidate) => candidate.id === label.htmlFor)
  if (!select) throw new Error(`The ${labelText} label is not associated with a select.`)
  return select
}

async function choose(root: ParentNode, label: string, value: string): Promise<void> {
  const select = findSelect(root, label)
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(select.value).toBe(value)
}

async function waitForUi(mount: MountedChecks, ready: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await act(async () => {
      await mount.flush()
      await Bun.sleep(10)
    })
    if (ready()) return
  }
  throw new Error(`Timed out waiting for ${description}: ${mount.element.textContent}`)
}

async function mountChecks(host: TestHost, initial: ReviewsState): Promise<MountedChecks> {
  const windowClient = await host.connect('ui')
  const provided = new Map<string, (input?: unknown) => unknown>()
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const pending = new Set<Promise<unknown>>()
  let state = initial
  let layout = {
    view: { id: 'view:quirky.reviews/review' },
    worktree: host.worktree,
    panel: null,
    sidebar: true,
    focus: 'view',
    tools: {
      placements: {},
      order: [],
      open: {
        'left-top': null,
        'left-bottom': null,
        'right-top': null,
        'right-bottom': null,
        'bottom-left': CHECKS_PANEL,
        'bottom-right': null
      },
      sizes: { left: 0, right: 0, bottom: 0, leftSplit: 0, rightSplit: 0, bottomSplit: 0 }
    }
  } as UiLayout
  const track = <T,>(operation: Promise<T>): Promise<T> => {
    let tracked: Promise<T>
    tracked = operation.then((value) => {
      pending.delete(tracked)
      return value
    }, (error: unknown) => {
      pending.delete(tracked)
      throw error
    })
    pending.add(tracked)
    return tracked
  }
  const flush = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending])
  }
  const refresh = async (): Promise<void> => {
    state = await windowClient.callAny('quirky.reviews/state', { worktree: host.worktree }) as ReviewsState
    await act(async () => { root.render(<ChecksPanel context={context} state={state} refresh={refresh} />) })
  }
  const context = {
    pluginId: 'quirky.reviews',
    nativeBrowser: {} as UiPluginContext['nativeBrowser'],
    log() {},
    readClipboardText: async () => '',
    nativeDropPaths: async () => null,
    provide(id: string, implementation: unknown) {
      if (typeof implementation === 'function') provided.set(id, implementation as (input?: unknown) => unknown)
    },
    call(method: string, params: Record<string, unknown> = {}) {
      return track(windowClient.callAny(method, params))
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    getSetting: () => undefined,
    async executeCommand(id: string, args?: unknown) {
      await track(host.client.callAny('ui.command.run', { id, ...(args === undefined ? {} : { args }) }))
    },
    createCommandDrag() { throw new Error('Command dragging is unavailable in this integration test.') },
    consumeCommandDrag() { return null },
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => layoutListeners.delete(listener)
    },
    onStream() { return () => {} },
    onConnection() { return () => {} },
    confirm: async () => true,
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  } as unknown as UiPluginContext

  activate(context)
  windowClient.onEvent((event) => {
    for (const listener of eventListeners) void listener(event)
    if (event.type !== 'ui.command.request') return
    const request = event as unknown as CommandRequest
    const operation = (async () => {
      try {
        const handler = provided.get(request.id)
        if (!handler) throw new Error(`No activated UI command for ${request.id}.`)
        const result = await handler(request.args)
        await windowClient.callAny('ui.command.reply', { requestId: request.requestId, result })
      } catch (error) {
        await windowClient.callAny('ui.command.reply', {
          requestId: request.requestId,
          error: { message: messageOf(error) }
        })
      }
    })()
    void track(operation)
  })
  await windowClient.callAny('events.subscribe', {})

  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  const mount = { element, root, flush }
  mounted.push(mount)
  await act(async () => { root.render(<ChecksPanel context={context} state={state} refresh={refresh} />) })
  return mount
}

afterEach(async () => {
  await act(async () => { for (const surface of mounted.splice(0).reverse()) surface.root.unmount() })
  document.body.innerHTML = ''
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  clipboardDescriptor = undefined
})
afterAll(() => GlobalRegistrator.unregister())

test('the real Checks panel, activated UI commands, Heimdall and the GitHub stand-in complete a PR sitter round trip', async () => {
  const host = await boot()
  const refreshed = record(await host.call('checksRefresh', { worktree: host.worktree, force: true }), 'Checks refresh result')
  expect(refreshed).toMatchObject({ ok: true, kind: 'found', number: 7 })
  const initial = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree }) as ReviewsState
  expect(initial.checks).toMatchObject({
    worktree: host.worktree,
    review: { provider: 'github', number: 7, headRefName: 'feature', mergeStateStatus: 'BEHIND', reviewDecision: 'APPROVED' }
  })

  const clipboardWrites: string[] = []
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text) } }
  })

  const panel = await mountChecks(host, initial)
  await waitForUi(panel, () => panel.element.querySelector('button[aria-label="PR Sitter"]') !== null, 'the PR Sitter row')
  await act(async () => {
    findButton(panel.element, 'PR Sitter').click()
    await panel.flush()
  })
  await waitForUi(panel, () => panel.element.querySelector('[role="dialog"]') !== null, 'the PR Sitter dialog opened from its row')

  await choose(panel.element, 'Fix checks', 'on')
  await choose(panel.element, 'Update branch', 'on')
  await choose(panel.element, 'Merge', 'gated')
  await choose(panel.element, 'Merge method', 'squash')
  await act(async () => {
    findButton(panel.element, 'Arm PR Sitter').click()
    await panel.flush()
  })
  await waitForUi(panel, () => panel.element.textContent?.includes('Watching') === true, 'the newly enrolled watcher')
  const enrolled = sitterState(await host.call('checksSitterGet', { worktree: host.worktree, includeDetail: true }))
  expect(enrolled).toMatchObject({ available: true, activeCount: 1, sitter: {
    enrollment: {
      kind: 'hosted-review', enabled: true, terminalAtMs: null,
      capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'gated' },
      budget: { wallClockActiveMs: 14_400_000, turns: null },
      kindPayload: { branchUpdateMode: 'merge-base-update', mergeMethod: 'squash', mergeCheckScope: 'all' }
    },
    status: { state: 'watching' }
  } })
  const watcherId = enrolled.sitter?.target.watcherId
  if (!watcherId) throw new Error('The real enrollment did not return a watcher ID.')

  const fleet = await host.client.callAny('quirky.heimdall/fleet', {}) as FleetSnapshot
  const fleetRow = fleet.rows.find((row) => row.target.watcherId === watcherId)
  if (!fleetRow) throw new Error('The enrolled PR sitter is absent from the public Heimdall fleet.')
  const staleFence = await host.client.callAny('quirky.heimdall/command', {
    target: fleetRow.target,
    expectedOwner: { ...fleetRow.ownerFence, revision: fleetRow.ownerFence.revision + 1 },
    command: { kind: 'disarm' }
  })
  expect(staleFence).toMatchObject({ kind: 'refused', reason: 'stale-revision' })
  expect((await publicDetail(host, watcherId)).enrollment).toMatchObject({ enabled: true, commandRevision: fleetRow.ownerFence.revision })

  expect(panel.element.textContent).toContain(STOP_HELP)
  await act(async () => {
    findButton(panel.element, 'Stop this sitter').click()
    await panel.flush()
  })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  await waitForUi(panel, () => panel.element.textContent?.includes('Stopped') === true, 'the UI stop command')
  await act(async () => {
    findButton(panel.element, 'Re-arm PR Sitter').click()
    await panel.flush()
  })
  await waitForUi(panel, () => panel.element.textContent?.includes('Watching') === true, 'the UI re-arm command')

  const stoppedByCli = cliJson<{ ok: true; kind: 'applied' }>(
    await reviewCli(host, 'checks-sitter-stop', { worktree: host.worktree, watcherId }),
    'checks-sitter-stop'
  )
  expect(stoppedByCli).toMatchObject({ ok: true, kind: 'applied' })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  expect(sitterState(await host.call('checksSitterGet', { worktree: host.worktree })).sitter).toMatchObject({
    status: { state: 'disabled' }, enrollment: { enabled: false },
  })

  const cliRearm = cliJson<EnrollmentResult>(await reviewCli(host, 'checks-sitter-arm', armParams(host.worktree, {
    capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'gated' }
  })), 'checks-sitter-arm re-arm')
  expect(cliRearm).toMatchObject({ ok: true, kind: 're-armed', enrollment: { watcherId, enabled: true } })
  const stoppedAllByCli = cliJson<{ total: number; stopped: number; refusedCount: number; indeterminateCount: number; warning: string | null }>(
    await reviewCli(host, 'checks-sitter-stop-all', {}),
    'checks-sitter-stop-all'
  )
  expect(stoppedAllByCli).toEqual({ total: 1, stopped: 1, refusedCount: 0, indeterminateCount: 0, warning: null })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  expect(sitterState(await host.call('checksSitterGet', { worktree: host.worktree })).sitter).toMatchObject({
    status: { state: 'disabled' }, enrollment: { enabled: false },
  })

  const activeAfterCli = cliJson<EnrollmentResult>(await reviewCli(host, 'checks-sitter-arm', armParams(host.worktree, {
    capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'gated' }
  })), 'checks-sitter-arm after stop-all')
  expect(activeAfterCli).toMatchObject({ kind: 're-armed', enrollment: { watcherId, enabled: true } })
  await waitForUi(panel, () => panel.element.textContent?.includes('Watching') === true, 'the CLI re-arm fleet update')
  await act(async () => {
    findButton(panel.element, 'Stop all PR Sitters').click()
    await panel.flush()
  })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  await waitForUi(panel, () => panel.element.textContent?.includes('Stopped') === true, 'the safety-strip stop-all command')
  await act(async () => {
    findButton(panel.element, 'Re-arm PR Sitter').click()
    await panel.flush()
  })
  await waitForUi(panel, () => panel.element.textContent?.includes('Watching') === true, 'the final UI re-arm')

  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  const rerun = await waitFor(
    () => publicDetail(host, watcherId),
    (detail) => attempt(detail, 'rerun-check')?.state === 'settled' && attempt(detail, 'rerun-check')?.effect === 'landed',
    'the failed-check rerun'
  )
  expect(attempt(rerun, 'rerun-check')).toMatchObject({ state: 'settled', effect: 'landed', action: { kind: 'rerun-check' } })
  const rerunEndpoint = 'repos/test-owner/test-repo/actions/runs/41/rerun-failed-jobs'
  const rerunCalls = host.invocations()
    .filter(({ args }) => args[0] === 'api' && args.includes(rerunEndpoint))
    .map(({ args, input }) => ({ args, input }))
  expect(rerunCalls).toEqual([{
    args: ['api', '--hostname', 'github.com', rerunEndpoint, '-X', 'POST'],
    input: ''
  }])

  const afterRerun = host.readState() as StandInState
  const pull = afterRerun.prs[0]
  if (!pull) throw new Error('The stand-in pull request disappeared after rerun.')
  host.writeState({
    ...afterRerun,
    prs: [{ ...pull, mergeStateStatus: 'BEHIND' }],
    updatedHead: H2,
    checkRuns: [{
      __typename: 'CheckRun', databaseId: 9002, name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/test-owner/test-repo/actions/runs/41/job/9002', workflowRunId: 41
    }]
  })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  const updated = await waitFor(
    () => publicDetail(host, watcherId),
    (detail) => attempt(detail, 'update-branch')?.state === 'settled' && attempt(detail, 'update-branch')?.effect === 'landed',
    'the merge-base branch update'
  )
  expect(attempt(updated, 'update-branch')).toMatchObject({
    state: 'settled', effect: 'landed', action: { kind: 'update-branch', head: H1 }, expectedAfter: { head: H2 }
  })
  const updateCalls = host.invocations()
    .filter(({ args }) => args[0] === 'api' && args.includes('repos/test-owner/test-repo/pulls/7/update-branch'))
    .map(({ args, input }) => ({ args, input }))
  expect(updateCalls).toEqual([{
    args: ['api', '--hostname', 'github.com', 'repos/test-owner/test-repo/pulls/7/update-branch', '-X', 'PUT', '--input', '-'],
    input: JSON.stringify({ expected_head_sha: H1 })
  }])

  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  const held = await waitFor(
    () => publicDetail(host, watcherId),
    (detail) => detail.status?.state === 'held' && detail.status.reason === 'awaiting-approval',
    'the held merge approval'
  )
  const heldApproval = approvalScope(held)
  expect(heldApproval.scope).toEqual({
    actionKind: 'merge',
    contentIdentity: JSON.stringify([H2, B1]),
    evidenceKey: JSON.stringify(['merge', H2, 'squash', 1])
  })
  await waitForUi(panel, () => panel.element.textContent?.includes('Approve this action') === true, 'the rendered held-approval card')
  expect(panel.element.textContent).toContain('Merge review')
  expect(panel.element.textContent).toContain(heldApproval.scope.contentIdentity)
  expect(host.invocations().filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(0)

  const changedScope = { ...heldApproval.scope, evidenceKey: `${heldApproval.scope.evidenceKey}:stale` }
  const apiRefusal = await host.call('checksSitterApprove', {
    worktree: host.worktree, watcherId, escalationId: heldApproval.escalationId, expectedScope: changedScope
  }).then(() => null, (error: unknown) => error)
  expect(apiRefusal).not.toBeNull()
  expect(apiRefusal).toMatchObject({ code: RpcErrorCode.InvalidParams })
  expect(messageOf(apiRefusal)).toContain(SCOPE_CHANGED)
  const cliRefusal = await reviewCli(host, 'checks-sitter-approve', {
    worktree: host.worktree, watcherId, escalationId: heldApproval.escalationId, expectedScope: changedScope
  })
  expect(cliRefusal.code).not.toBe(0)
  expect(cliFailureText(cliRefusal)).toContain(SCOPE_CHANGED)
  expect((await publicDetail(host, watcherId)).status).toMatchObject({ state: 'held', reason: 'awaiting-approval' })

  await act(async () => {
    findButton(panel.element, 'Approve this action').click()
    await panel.flush()
  })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  const merged = await waitFor(
    () => publicDetail(host, watcherId),
    (detail) => attempt(detail, 'merge')?.state === 'settled' && attempt(detail, 'merge')?.effect === 'landed',
    'the approved merge on the stand-in'
  )
  expect(attempt(merged, 'merge')).toMatchObject({ state: 'settled', effect: 'landed', action: { kind: 'merge', head: H2, method: 'squash' } })
  const mergeCalls = host.invocations().filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')
  expect(mergeCalls).toHaveLength(1)
  expect(mergeCalls[0]).toMatchObject({
    args: ['pr', 'merge', '7', '--squash', '--match-head-commit', H2, '--repo', 'github.com/test-owner/test-repo'],
    input: ''
  })
  const mergedState = host.readState() as StandInState
  expect(mergedState.prs[0]).toMatchObject({ state: 'MERGED', headRefOid: H2 })
  host.writeState({ ...mergedState, mergeVisible: true })
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
  await waitFor(
    () => publicDetail(host, watcherId),
    (detail) => detail.status?.state === 'terminal',
    'the terminal merged state'
  )
  await waitForUi(panel, () => panel.element.textContent?.includes('Complete') === true, 'the Complete Checks-panel status')

  const cliState = cliJson<SitterState>(await reviewCli(host, 'checks-sitter-state', {
    worktree: host.worktree, includeDetail: true
  }), 'checks-sitter-state')
  expect(cliState).toMatchObject({ available: true, activeCount: 0, sitter: { enrollment: { watcherId }, status: { state: 'terminal' } } })
  expect(cliState.detail).not.toBeNull()

  const cliDebug = cliJson<{ report: { schemaVersion: number; enrollment: { watcherId: string }; status: { state: string } } }>(
    await reviewCli(host, 'checks-sitter-debug-report', { worktree: host.worktree, watcherId }),
    'checks-sitter-debug-report'
  )
  expect(cliDebug.report).toMatchObject({ schemaVersion: expect.any(Number), enrollment: { watcherId }, status: { state: 'terminal' } })
  await act(async () => {
    findButton(panel.element, 'Copy debug report').click()
    await panel.flush()
  })
  await waitForUi(panel, () => panel.element.textContent?.includes('Debug report copied') === true, 'the copied debug-report confirmation')
  expect(clipboardWrites).toHaveLength(1)
  expect(clipboardWrites[0]).toBe(JSON.stringify(JSON.parse(clipboardWrites[0]!), null, 2))
  expect(JSON.parse(clipboardWrites[0]!)).toMatchObject({ enrollment: { watcherId }, status: { state: 'terminal' } })
}, 90_000)

test('CLI arm methods return real Heimdall refusals for unsupported branch-update and check-scope modes', async () => {
  const host = await boot()
  const rebase = await reviewCli(host, 'checks-sitter-arm', armParams(host.worktree, { branchUpdateMode: 'rebase' }))
  expect(rebase.code).not.toBe(0)
  expect(cliFailureText(rebase)).toContain('The PR sitter updates a branch by merging its base; rebase is not supported.')
  expect((await host.client.callAny('quirky.heimdall/fleet', {}) as FleetSnapshot).rows).toEqual([])

  const requiredChecks = await reviewCli(host, 'checks-sitter-arm', armParams(host.worktree, { mergeCheckScope: 'required' }))
  expect(requiredChecks.code).not.toBe(0)
  expect(cliFailureText(requiredChecks)).toContain('The PR sitter supports only the all-checks merge scope.')
  expect((await host.client.callAny('quirky.heimdall/fleet', {}) as FleetSnapshot).rows).toEqual([])
}, 60_000)
