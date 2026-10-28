import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { MessageRow, MutationResult, RunRow, TaskRow } from '../../src/contracts'
import type { WorkerControlResult, WorkerListResult, WorkerShowResult, WorkerStartReceipt } from '../../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './acceptance-support'

let harness: WorkerAcceptance | undefined
afterEach(async () => { await harness?.cleanup(); harness = undefined })

type Repo = { id: string; name: string; path: string }
type Worktree = {
  id: string
  repoId: string
  path: string
  name: string
  kind: string
  parentId: string | null
  displayName: string | null
  comment: string
  baseRef: string | null
}
type PublicError = { code: string; reason?: string; message: string }
type AgentOptions = {
  supported: boolean
  models: { id: string; options: { id: string; choices: { value: string }[] | null }[] }[]
  unlisted: 'accept' | 'refuse'
}
type AgentList = { agents: { id: string; enabled: boolean; installed: boolean }[] }
type UiState = { layout: { view: { id: string; input?: unknown } | null; focus: string | null } }
type TerminalTab = { id: string; defaultTitle: string; customTitle: string | null; liveTitle: string | null }
type TerminalGroup = { kind: 'group'; id: string; tabs: TerminalTab[]; activeTab: string | null; recent: string[] }
type TerminalWorkspace = { id: string; activeGroup: string; root: TerminalGroup }
type TerminalNewTab = { workspace: TerminalWorkspace; session: string; tab: string; pane: string }
type PaneLocation = { workspace: string; tab: string; pane: string }

async function terminalWorkspace(h: WorkerAcceptance, selector: string, ensure = false): Promise<TerminalWorkspace> {
  const result = await h.fixture.call('quirky.terminal/workspace', {
    workspace: selector,
    ...(ensure ? { ensure: true } : {}),
  }) as { workspace: TerminalWorkspace }
  return result.workspace
}

async function startRun() {
  harness = await startWorkerAcceptance()
  const result = await harness.callAs<MutationResult<{ run: RunRow }>>(
    harness.coordinator.id,
    'run-create',
    ['--objective', 'Isolated real worker placement acceptance'],
  )
  return { h: harness, run: result.run }
}

async function repoFor(h: WorkerAcceptance): Promise<Repo> {
  const repos = await h.fixture.call('quirky.repo/list', {}) as Repo[]
  const repo = repos.find(candidate => candidate.path === h.fixture.repo)
  if (!repo) throw new Error(`the isolated project ${h.fixture.repo} is absent from quirky.repo/list`)
  return repo
}

async function sessions(h: WorkerAcceptance): Promise<Session[]> {
  return h.fixture.call('quirky.session/list', {}) as Promise<Session[]>
}

async function workerStart(h: WorkerAcceptance, flags: string[]): Promise<MutationResult<WorkerStartReceipt>> {
  return h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', flags)
}

async function startCurrentWorker(h: WorkerAcceptance, spec: string) {
  const receipt = await workerStart(h, [
    '--spec', spec,
    '--task-title', 'Placement acceptance worker',
    '--worktree', 'current',
    '--agent', 'claude',
    '--timeout-ms', '10000',
  ])
  expect(receipt.state).toBe('ready')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  if (!shown.worker?.sessionId) throw new Error(`ready worker ${receipt.dispatchId} has no terminal session`)
  return { receipt, session: shown.worker.sessionId, shown }
}

async function report(h: WorkerAcceptance, session: string, receipt: WorkerStartReceipt, outcome: 'succeeded' | 'failed' = 'succeeded') {
  return h.callAs<{ report: { status: string } }>(session, 'send', [
    '--type', 'worker_done',
    '--task-id', receipt.taskId,
    '--dispatch-id', receipt.dispatchId,
    '--outcome', outcome,
    '--subject', `Placement task ${outcome}`,
    '--body', 'The requested placement behavior was checked. No additional work remains.',
  ])
}

function expectRefusal(result: { code: number; stdout: string }, reason: string): void {
  expect(result.code).toBe(1)
  let parsed: { error?: PublicError }
  try {
    parsed = JSON.parse(result.stdout) as { error?: PublicError }
  } catch {
    throw new Error(`expected a typed JSON refusal, received ${JSON.stringify(result.stdout)}`)
  }
  expect(parsed.error?.reason).toBe(reason)
}

async function inventory(h: WorkerAcceptance, runId: string, repoId: string) {
  const [tasks, workers, sessionRows, worktrees] = await Promise.all([
    h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', runId]),
    h.callAs<WorkerListResult>(h.coordinator.id, 'worker-list', ['--run', runId]),
    sessions(h),
    h.fixture.call('quirky.worktree/list', { repo: repoId }) as Promise<Worktree[]>,
  ])
  return {
    tasks: tasks.tasks.map(task => task.id).sort(),
    dispatches: workers.workers.map(worker => worker.dispatchId).sort(),
    sessions: sessionRows.map(session => session.id).sort(),
    worktrees: worktrees.map(worktree => worktree.id).sort(),
  }
}

async function focusCoordinatorView(h: WorkerAcceptance): Promise<UiState['layout']> {
  const worktreeId = (await h.session(h.coordinator.id)).worktreeId
  await h.fixture.call('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: worktreeId } })
  await h.fixture.call('ui.focus', { target: 'view' })
  const state = await h.fixture.call('ui.state', {}) as UiState
  expect(state.layout.view).toEqual({ id: 'view:quirky.session/worktree', input: { worktree: worktreeId } })
  expect(state.layout.focus).toBe('view')
  return state.layout
}

async function layout(h: WorkerAcceptance): Promise<UiState['layout']> {
  return (await h.fixture.call('ui.state', {}) as UiState).layout
}

function inputText(h: WorkerAcceptance, sessionId: string): string {
  return h.events(sessionId)
    .filter(event => event.type === 'input' && typeof event.base64 === 'string')
    .map(event => Buffer.from(event.base64 as string, 'base64').toString())
    .join('')
}

function worktreeRecord(value: unknown): Worktree {
  const result = value as Worktree | { worktree: Worktree }
  return 'worktree' in result ? result.worktree : result
}

test('unsupported model and effort picks and current-worktree placement flags refuse before Task, Dispatch, Session, or worktree effects', async () => {
  const { h, run } = await startRun()
  h.fixture.addFake('gemini')
  await h.fixture.call('quirky.agents/refresh', {})

  const [agentList, gemini, claude, repo] = await Promise.all([
    h.fixture.call('quirky.agents/list', { all: true }) as Promise<AgentList>,
    h.fixture.call('quirky.agents/options', { agent: 'gemini' }) as Promise<AgentOptions>,
    h.fixture.call('quirky.agents/options', { agent: 'claude' }) as Promise<AgentOptions>,
    repoFor(h),
  ])
  expect(agentList.agents.find(agent => agent.id === 'gemini')).toMatchObject({ enabled: true, installed: true })
  expect(gemini.supported).toBe(true)
  expect(gemini.unlisted).toBe('refuse')
  const modelWithoutEffort = gemini.models.find(model => !model.options.some(option => option.id === 'effort'))
  expect(modelWithoutEffort).toBeDefined()
  const effortModel = claude.models.find(model => model.options.some(option => option.id === 'effort'))
  expect(effortModel).toBeDefined()
  const unsupportedModel = `worker-acceptance-${crypto.randomUUID()}`
  expect(gemini.models.some(model => model.id === unsupportedModel)).toBe(false)
  const unsupportedEffort = `worker-acceptance-${crypto.randomUUID()}`
  const effortChoices = effortModel!.options.find(option => option.id === 'effort')!.choices
  if (effortChoices) expect(effortChoices.some(choice => choice.value === unsupportedEffort)).toBe(false)

  const baseline = await inventory(h, run.id, repo.id)
  const refused = [
    {
      reason: 'invalid_argument',
      flags: ['--spec', 'Unsupported worker model must not create a Task.', '--worktree', 'current', '--agent', 'gemini', '--model', unsupportedModel],
    },
    {
      reason: 'invalid_argument',
      flags: ['--spec', 'Unsupported worker effort must not create a Task.', '--worktree', 'current', '--agent', 'claude', '--model', effortModel!.id, '--effort', unsupportedEffort],
    },
    {
      reason: 'invalid_argument',
      flags: [
        '--spec', 'Current-worktree placement flags must not create a Task.',
        '--worktree', 'current', '--agent', 'claude',
        '--name', 'must-not-be-created', '--repo', repo.id, '--base-branch', 'main',
        '--display-name', 'Must not be created', '--comment', 'preflight refusal', '--setup', 'skip',
      ],
    },
  ]

  for (const attempt of refused) {
    const result = await h.cli(h.coordinator.id, ['orchestration', 'worker-start', ...attempt.flags])
    expectRefusal(result, attempt.reason)
    expect(await inventory(h, run.id, repo.id)).toEqual(baseline)
  }
}, 60_000)

test('new-child uses the coordinator worktree as parent, inherits the repository skip policy, and leaves focus and unrelated sessions alone', async () => {
  const { h } = await startRun()
  const repo = await repoFor(h)
  const coordinatorWorktreeId = (await h.session(h.coordinator.id)).worktreeId
  await h.fixture.call('quirky.repo/set', {
    repo: repo.id,
    setupPolicy: 'skip-by-default',
    setupScript: 'printf setup-ran > .worker-placement-setup',
    agentStartup: 'start-immediately',
  })
  const focusBefore = await focusCoordinatorView(h)
  const priorSessions = await sessions(h)
  const priorSessionIds = new Set(priorSessions.map(session => session.id))

  const receipt = await workerStart(h, [
    '--spec', 'Use a child worktree with inherited setup policy.',
    '--task-title', 'Child placement worker',
    '--worktree', 'new-child',
    '--agent', 'claude',
    '--name', 'worker-child-placement',
    '--setup', 'inherit',
    '--timeout-ms', '10000',
  ])
  expect(receipt.state).toBe('ready')
  expect(receipt.setup).toMatchObject({ requested: 'inherit', effective: 'skipped', hookFound: true, state: 'skipped' })
  const worktreeEffect = receipt.effects.find(effect => effect.kind === 'worktree' && effect.action === 'created')
  expect(worktreeEffect).toBeDefined()
  const child = worktreeRecord(await h.fixture.call('quirky.worktree/show', { worktree: worktreeEffect!.id }))
  expect(child).toMatchObject({ repoId: repo.id, parentId: coordinatorWorktreeId, name: 'worker-child-placement' })
  expect(existsSync(join(child.path, '.worker-placement-setup'))).toBe(false)

  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(shown.worker?.worktreeId).toBe(child.id)
  expect(shown.terminalResource?.worktreeId).toBe(child.id)
  const createdSessions = (await sessions(h)).filter(session => !priorSessionIds.has(session.id))
  const createdAgentEffects = receipt.effects.filter(effect => effect.kind === 'terminal' && effect.role === 'agent' && effect.action === 'created')
  const setupSessionEffects = receipt.effects.filter(effect => effect.kind === 'setup' && effect.role === 'setup' && effect.id)
  expect(createdAgentEffects).toHaveLength(1)
  expect(createdSessions.map(session => session.id).sort()).toEqual([createdAgentEffects[0]!.id, ...setupSessionEffects.map(effect => effect.id)].sort())
  expect(createdSessions.filter(session => session.agent === 'shell' && session.title !== 'Setup')).toHaveLength(0)
  await eventually(() => inputText(h, createdAgentEffects[0]!.id), text => text.includes(receipt.dispatchId), 'child worker preamble')
  expect(await layout(h)).toEqual(focusBefore)
}, 90_000)

test('new-top-level honors requested repository metadata and wait-for-setup before preamble without changing coordinator focus', async () => {
  const { h } = await startRun()
  const repo = await repoFor(h)
  await h.fixture.call('quirky.repo/set', {
    repo: repo.id,
    setupPolicy: 'run-by-default',
    setupScript: 'sleep 0.1; printf complete > .worker-placement-setup',
    agentStartup: 'wait-for-setup',
  })
  const focusBefore = await focusCoordinatorView(h)
  const priorSessionIds = new Set((await sessions(h)).map(session => session.id))

  const receipt = await workerStart(h, [
    '--spec', 'Use a top-level worktree after repository setup completes.',
    '--task-title', 'Top-level placement worker',
    '--worktree', 'new-top-level',
    '--agent', 'claude',
    '--repo', repo.id,
    '--name', 'worker-top-level-placement',
    '--base-branch', 'main',
    '--display-name', 'Requested top-level display name',
    '--comment', 'Requested top-level placement comment',
    '--setup', 'inherit',
    '--timeout-ms', '10000',
  ])
  expect(receipt.state).toBe('ready')
  expect(receipt.setup.effective).not.toBe('skipped')
  expect(receipt.setup).toMatchObject({ requested: 'inherit', hookFound: true, startupPolicy: 'wait-for-setup', state: 'succeeded' })
  const worktreeEffect = receipt.effects.find(effect => effect.kind === 'worktree' && effect.action === 'created')
  expect(worktreeEffect).toBeDefined()
  const topLevel = worktreeRecord(await h.fixture.call('quirky.worktree/show', { worktree: worktreeEffect!.id }))
  expect(topLevel).toMatchObject({
    repoId: repo.id,
    parentId: null,
    name: 'worker-top-level-placement',
    displayName: 'Requested top-level display name',
    comment: 'Requested top-level placement comment',
    baseRef: 'main',
  })
  expect(readFileSync(join(topLevel.path, '.worker-placement-setup'), 'utf8')).toBe('complete')

  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(shown.worker?.worktreeId).toBe(topLevel.id)
  const createdSessions = (await sessions(h)).filter(session => !priorSessionIds.has(session.id))
  const createdAgentEffects = receipt.effects.filter(effect => effect.kind === 'terminal' && effect.role === 'agent' && effect.action === 'created')
  const setupSessionEffects = receipt.effects.filter(effect => effect.kind === 'setup' && effect.role === 'setup' && effect.id)
  expect(createdAgentEffects).toHaveLength(1)
  expect(createdSessions.map(session => session.id).sort()).toEqual([createdAgentEffects[0]!.id, ...setupSessionEffects.map(effect => effect.id)].sort())
  expect(createdSessions.filter(session => session.agent === 'shell' && session.title !== 'Setup')).toHaveLength(0)
  const preamble = await eventually(() => inputText(h, createdAgentEffects[0]!.id), text => text.includes(receipt.dispatchId), 'top-level worker preamble')
  expect(preamble).toContain('Use a top-level worktree after repository setup completes.')
  expect(readFileSync(join(topLevel.path, '.worker-placement-setup'), 'utf8')).toBe('complete')
  expect(await layout(h)).toEqual(focusBefore)
}, 90_000)

test('start-immediately launches the child worker beside setup and emits one high failure status', async () => {
  const { h } = await startRun()
  const repo = await repoFor(h)
  const coordinatorWorktreeId = (await h.session(h.coordinator.id)).worktreeId
  await h.fixture.call('quirky.repo/set', {
    repo: repo.id,
    setupPolicy: 'run-by-default',
    setupScript: 'sleep 3; exit 1',
    agentStartup: 'start-immediately',
  })
  const focusBefore = await focusCoordinatorView(h)
  const priorSessionIds = new Set((await sessions(h)).map(session => session.id))

  const receipt = await workerStart(h, [
    '--spec', 'Start beside setup and surface one high-priority setup failure.',
    '--task-title', 'Immediate setup worker',
    '--worktree', 'new-child',
    '--agent', 'claude',
    '--name', 'worker-immediate-setup-failure',
    '--setup', 'inherit',
    '--timeout-ms', '10000',
  ])
  expect(receipt.state).toBe('ready')
  expect(receipt.setup).toMatchObject({ requested: 'inherit', hookFound: true, startupPolicy: 'start-immediately' })
  expect(receipt.setup.state).toBe('running')
  const worktreeEffect = receipt.effects.find(effect => effect.kind === 'worktree' && effect.action === 'created')
  const agentEffect = receipt.effects.find(effect => effect.kind === 'terminal' && effect.role === 'agent' && effect.action === 'created')
  const setupEffect = receipt.effects.find(effect => effect.kind === 'setup' && effect.role === 'setup' && effect.action === 'started')
  expect(worktreeEffect).toBeDefined()
  expect(agentEffect).toBeDefined()
  expect(setupEffect).toBeDefined()
  const child = worktreeRecord(await h.fixture.call('quirky.worktree/show', { worktree: worktreeEffect!.id }))
  expect(child).toMatchObject({ repoId: repo.id, parentId: coordinatorWorktreeId, name: 'worker-immediate-setup-failure' })
  const createdSessions = (await sessions(h)).filter(session => !priorSessionIds.has(session.id))
  expect(createdSessions.map(session => session.id).sort()).toEqual([agentEffect!.id, setupEffect!.id].sort())
  expect(createdSessions.filter(session => session.agent === 'shell' && session.title !== 'Setup')).toHaveLength(0)
  await eventually(() => inputText(h, agentEffect!.id), text => text.includes(receipt.dispatchId), 'immediate-start child worker preamble')

  await eventually(
    () => h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as Promise<WorkerShowResult>,
    shown => shown.worker?.setupState === 'failed',
    'start-immediately setup failure settlement',
  )
  const inbox = await h.callAs<{ messages: MessageRow[] }>(h.coordinator.id, 'inbox', ['--full', '--limit', '100'])
  const setupFailures = inbox.messages.filter(message => message.subject === `Setup failed for worker ${receipt.dispatchId}`)
  expect(setupFailures).toHaveLength(1)
  expect(setupFailures[0]).toMatchObject({ type: 'status', priority: 'high' })
  expect(await layout(h)).toEqual(focusBefore)

  expect((await report(h, agentEffect!.id, receipt)).report.status).toBe('accepted')
  const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  expect(released.processAction).toBe('closed_agent_terminal')
}, 90_000)

test('settled worker-terminal reuse transfers custody and a late release cannot close the replacement', async () => {

  const { h } = await startRun()
  const coordinatorWorktreeId = (await h.session(h.coordinator.id)).worktreeId
  await terminalWorkspace(h, coordinatorWorktreeId, true)
  const openedTabs: TerminalNewTab[] = []
  for (const title of ['Coordinator focus tab one', 'Coordinator focus tab two', 'Coordinator focus tab three']) {
    openedTabs.push(await h.fixture.call('quirky.terminal/newTab', {
      workspace: coordinatorWorktreeId,
      agent: 'shell',
      title,
      activate: true,
    }) as TerminalNewTab)
  }
  const focusBefore = await focusCoordinatorView(h)
  const beforeWorkspace = await terminalWorkspace(h, coordinatorWorktreeId)
  const beforeGroup = beforeWorkspace.root
  expect(beforeWorkspace.activeGroup).toBe(beforeGroup.id)
  expect(beforeGroup.activeTab).toBe(openedTabs[2]!.tab)
  expect(beforeGroup.recent[0]).toBe(openedTabs[2]!.tab)
  const activeBefore = {
    activeGroup: beforeWorkspace.activeGroup,
    group: beforeGroup.id,
    activeTab: beforeGroup.activeTab,
    recent: [...beforeGroup.recent],
  }

  const first = await startCurrentWorker(h, 'Complete the original terminal-owned task before reuse.')
  const workerPane = await h.fixture.call('quirky.terminal/paneOf', { session: first.session }) as PaneLocation
  expect(workerPane.workspace).toBe(coordinatorWorktreeId)
  const afterWorkspace = await terminalWorkspace(h, coordinatorWorktreeId)
  expect({
    activeGroup: afterWorkspace.activeGroup,
    group: afterWorkspace.root.id,
    activeTab: afterWorkspace.root.activeTab,
    recent: afterWorkspace.root.recent,
  }).toEqual(activeBefore)
  expect(workerPane.tab).not.toBe(activeBefore.activeTab)
  const workerSession = await h.session(first.session)
  const workerTab = await eventually(
    async () => (await terminalWorkspace(h, workerPane.workspace)).root.tabs.find(tab => tab.id === workerPane.tab) ?? null,
    tab => tab !== null && tab.liveTitle !== null && tab.customTitle !== null,
    'fresh worker tab title after provider OSC',
  )
  expect(workerSession.title).toContain('Placement acceptance worker')
  if (workerTab === null) throw new Error('the worker terminal tab disappeared after observation')
  expect(workerTab.customTitle).toBe(workerSession.title)
  expect(workerTab.liveTitle).not.toBeNull()
  expect(await layout(h)).toEqual(focusBefore)

  const firstReport = await report(h, first.session, first.receipt)
  expect(firstReport.report.status).toBe('accepted')
  const identityBefore = await h.fixture.call('quirky.session/identity', { session: first.session }) as { processIncarnation: string }
  const firstPreamble = inputText(h, first.session)
  expect(firstPreamble).toContain(first.receipt.dispatchId)

  const second = await workerStart(h, [
    '--spec', 'This replacement worker must receive a fresh preamble on the transferred terminal.',
    '--task-title', 'Replacement terminal worker',
    '--worktree', 'current',
    '--terminal', first.session,
    '--timeout-ms', '10000',
  ])
  expect(second.state).toBe('ready')
  expect(second.dispatchId).not.toBe(first.receipt.dispatchId)
  const replacement = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: second.dispatchId }) as WorkerShowResult
  expect(replacement.terminalResource).toMatchObject({
    ownerDispatchId: second.dispatchId,
    sessionId: first.session,
    processIncarnation: identityBefore.processIncarnation,
    ownershipState: 'owned',
    priorOwnerDispatchIds: [first.receipt.dispatchId],
  })
  const transferred = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: first.receipt.dispatchId }) as WorkerShowResult
  expect(transferred.terminalResource).toMatchObject({ ownerDispatchId: second.dispatchId, ownershipState: 'transferred' })
  const freshPreamble = await eventually(
    () => inputText(h, first.session),
    text => text.includes(second.dispatchId),
    'replacement worker preamble on the reused terminal',
  )
  expect(freshPreamble.slice(firstPreamble.length)).toContain(second.taskId)
  expect(freshPreamble.slice(firstPreamble.length)).toContain('This replacement worker must receive a fresh preamble on the transferred terminal.')

  const oldRelease = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', first.receipt.dispatchId])
  expect(oldRelease.state).toBe('retained')
  expect(oldRelease.processAction).toBe('none')
  expect(await h.ptyAlive(first.session)).toBe(true)
  const afterOldRelease = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: second.dispatchId }) as WorkerShowResult
  expect(afterOldRelease.worker?.state).toBe('ready')
  expect(afterOldRelease.terminalResource?.ownerDispatchId).toBe(second.dispatchId)
  const identityAfter = await h.fixture.call('quirky.session/identity', { session: first.session }) as { processIncarnation: string }
  expect(identityAfter.processIncarnation).toBe(identityBefore.processIncarnation)

  expect((await report(h, first.session, second)).report.status).toBe('accepted')
  const releaseReplacement = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', second.dispatchId])
  expect(releaseReplacement.processAction).toBe('closed_agent_terminal')
  expect(await h.ptyAlive(first.session)).toBe(false)
}, 90_000)

test('a precreated external agent stays external and release never closes it', async () => {
  const { h } = await startRun()
  const worktreeId = (await h.session(h.coordinator.id)).worktreeId
  const external = await h.fixture.call('quirky.session/create', {
    worktree: worktreeId,
    agent: 'claude',
    title: 'Precreated external agent',
  }) as Session
  await eventually(() => h.events(external.id), events => events.some(event => event.type === 'started'), 'precreated external agent process')
  const beforeSessionIds = (await sessions(h)).map(session => session.id).sort()

  const receipt = await workerStart(h, [
    '--spec', 'Use the precreated external agent, but preserve its external custody.',
    '--task-title', 'External terminal worker',
    '--worktree', 'current',
    '--terminal', external.id,
    '--timeout-ms', '10000',
  ])
  expect(receipt.state).toBe('ready')
  expect((await sessions(h)).map(session => session.id).sort()).toEqual(beforeSessionIds)
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(shown.terminalResource).toMatchObject({ ownerDispatchId: receipt.dispatchId, sessionId: external.id, ownershipState: 'external' })
  expect((await report(h, external.id, receipt)).report.status).toBe('accepted')

  const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  expect(released.state).toBe('retained')
  expect(released.processAction).toBe('none')
  expect(await h.ptyAlive(external.id)).toBe(true)
  const after = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(after.terminalResource?.ownershipState).toBe('external')
  const externalResource = shown.terminalResource
  if (!externalResource) throw new Error('the external terminal has no custody record')
  expect((await h.fixture.call('quirky.session/identity', { session: external.id }) as { processIncarnation: string }).processIncarnation)
    .toBe(externalResource.processIncarnation)
}, 90_000)

test('wrong-workspace, coordinator, nonagent, and already-active terminals refuse without typing or adding work', async () => {
  const { h, run } = await startRun()
  const repo = await repoFor(h)
  const currentWorktree = (await h.session(h.coordinator.id)).worktreeId
  const wrongWorkspaceResult = await h.fixture.call('quirky.worktree/create', {
    repo: repo.id,
    name: 'worker-wrong-workspace',
    setup: 'skip',
    noParent: true,
  }) as { worktree: Worktree }
  const wrongWorkspaceAgent = await h.fixture.call('quirky.session/create', {
    worktree: wrongWorkspaceResult.worktree.id,
    agent: 'claude',
    title: 'Wrong workspace agent',
  }) as Session
  await eventually(() => h.events(wrongWorkspaceAgent.id), events => events.some(event => event.type === 'started'), 'wrong-workspace agent process')
  const plainShell = await h.fixture.call('quirky.session/create', {
    worktree: currentWorktree,
    agent: 'shell',
    title: 'Nonagent terminal',
  }) as Session
  await eventually(() => h.ptyAlive(plainShell.id), Boolean, 'nonagent shell process')
  const active = await startCurrentWorker(h, 'Keep this worker active while terminal admission is checked.')
  await eventually(() => inputText(h, active.session), text => text.includes(active.receipt.dispatchId), 'active worker preamble before refusal checks')
  const baseline = await inventory(h, run.id, repo.id)
  const inputBefore = new Map([
    [h.coordinator.id, inputText(h, h.coordinator.id)],
    [wrongWorkspaceAgent.id, inputText(h, wrongWorkspaceAgent.id)],
    [plainShell.id, inputText(h, plainShell.id)],
    [active.session, inputText(h, active.session)],
  ])
  const attempts = [
    { terminal: wrongWorkspaceAgent.id, reason: 'terminal_worktree_mismatch' },
    { terminal: h.coordinator.id, reason: 'terminal_is_coordinator' },
    { terminal: plainShell.id, reason: 'inject_rejected' },
    { terminal: active.session, reason: 'task_not_startable' },
  ]

  for (const attempt of attempts) {
    const result = await h.cli(h.coordinator.id, [
      'orchestration', 'worker-start',
      '--spec', `Refused terminal ${attempt.terminal} must not create a task or receive input.`,
      '--worktree', 'current',
      '--terminal', attempt.terminal,
      '--timeout-ms', '10000',
    ])
    expectRefusal(result, attempt.reason)
    expect(await inventory(h, run.id, repo.id)).toEqual(baseline)
    for (const [sessionId, priorInput] of inputBefore) expect(inputText(h, sessionId)).toBe(priorInput)
  }

  expect((await report(h, active.session, active.receipt)).report.status).toBe('accepted')
  const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', active.receipt.dispatchId])
  expect(released.processAction).toBe('closed_agent_terminal')
}, 90_000)
