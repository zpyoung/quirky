import { expect, test } from 'bun:test'
import { buildWorkerPreamble } from '../../plugins/quirky.orchestration/src/workers/preamble'
import { parseWorkerPreamble } from './cli-worker-actor'
import {
  assertControllerRefusal,
  assertDispatchEvidence,
  assertQuestionReplyEvidence,
  assertResetEvidence,
  assertRunUseEvidence,
  assertWorkerAbandonEvidence,
  assertWorkerCompletion,
  assertWorkerListEvidence,
  assertWorkerReadArchived,
  assertWorkerReadLive,
  assertWorkerReleaseEvidence,
  assertWorkerRetain,
  assertWorkerStartEvidence,
  assertWorkerStopEvidence,
  assertWorktreeDashboardEvidence,
  assertWorktreeRunEvidence,
  assertWorktreeSummaryEvidence,
  assertWorktreeTaskEvidence,
  cleanupWorkerChecks,
  WORKER_CHECK_IDS
} from './cli-workers'
type SummaryFixture = {
  worktreeId: string; runId: string; coordinatorSessionId: string
  contextTaskId: string; contextDispatchId: string; assigneeSessionId: string
  workerTaskId: string; completeDispatchId: string; stopDispatchId: string; abandonDispatchId: string
  worktrees: Array<{ id: string; name: string; path: string; repoId: string }>
  sessions: Array<{ id: string; agent: string; kind: string; status: string; worktreeId: string }>
  dashboard: { cards: Array<{ thread: { sessionId: string; worktreeId: string; display: string; live: boolean } }> }
  runList: { runs: Array<{ id: string; coordinatorSessionId: string | null }> }
  taskList: { runId: string; tasks: Array<{
    id: string; runId: string; createdBySessionId: string; taskTitle: string; status: string
    dispatchId?: string; assigneeSessionId?: string
  }> }
  workers: { scope: { runId: string; source: 'flag' }; workers: Array<{
    dispatchId: string; taskId: string; runId: string; dispatchStatus: string
    workerState: string | null; terminalState: string; currentAssignment: boolean; agentTerminalHandle: string | null
  }> }
  summary: {
    scope: string
    rows: Array<{
      worktree: { id: string; name: string; path: string; repoId: string }
      sessions: Array<{ id: string; agent: string; kind: string; status: string; display: string | null; live: boolean }>
      runIds: string[]
      dispatches: Array<{
        id: string; runId: string; task: { id: string; title: string; status: string }; status: string
        creatorSessionId: string | null; assigneeSessionId: string | null; workerSessionId: string | null
        currentAssignment: boolean; workerState: string | null; terminalState: string
      }>
    }>
  }
}

function summaryEvidenceFixture(): SummaryFixture {
  const worktree = { id: 'wt-a', name: 'Alpha', path: '/fixture/a', repoId: 'repo-a' }
  const sessions = [
    { id: 's-coordinator', agent: 'shell', kind: 'terminal', status: 'working', worktreeId: 'wt-a' },
    { id: 's-target', agent: 'shell', kind: 'terminal', status: 'running', worktreeId: 'wt-a' },
    { id: 's-complete', agent: 'claude', kind: 'terminal', status: 'done', worktreeId: 'wt-a' },
    { id: 's-stop', agent: 'claude', kind: 'terminal', status: 'exited', worktreeId: 'wt-a' },
    { id: 's-abandon', agent: 'claude', kind: 'terminal', status: 'working', worktreeId: 'wt-a' },
    { id: 's-other', agent: 'shell', kind: 'terminal', status: 'working', worktreeId: 'wt-b' }
  ]
  const task = (id: string, taskTitle: string, status: string, dispatchId?: string, assigneeSessionId?: string) => ({
    id, runId: 'run-a', createdBySessionId: 's-coordinator', taskTitle, status,
    ...(dispatchId === undefined ? {} : { dispatchId, assigneeSessionId })
  })
  const taskRows = [
    task('task-context', 'Context task', 'dispatched', 'ctx-context', 's-target'),
    task('task-complete', 'Completed task', 'completed'),
    task('task-stop', 'Stopped task', 'failed', 'ctx-stop', 's-stop'),
    task('task-abandon', 'Abandoned task', 'dispatched', 'ctx-abandon', 's-abandon')
  ]
  const dispatch = (id: string, taskId: string, title: string, taskStatus: string, status: string, assignee: string, worker: string | null, workerState: string | null, terminalState: string) => ({
    id, runId: 'run-a', task: { id: taskId, title, status: taskStatus }, status,
    creatorSessionId: 's-coordinator', assigneeSessionId: assignee, workerSessionId: worker,
    currentAssignment: false, workerState, terminalState
  })
  const dispatches = [
    dispatch('ctx-context', 'task-context', 'Context task', 'dispatched', 'dispatched', 's-target', null, null, 'released'),
    dispatch('ctx-complete', 'task-complete', 'Completed task', 'completed', 'completed', 's-complete', 's-complete', 'succeeded', 'active'),
    dispatch('ctx-stop', 'task-stop', 'Stopped task', 'failed', 'failed', 's-stop', 's-stop', 'stopped', 'released'),
    dispatch('ctx-abandon', 'task-abandon', 'Abandoned task', 'dispatched', 'dispatched', 's-abandon', 's-abandon', 'abandoned', 'retained')
  ]
  const worker = (dispatchId: string, taskId: string, dispatchStatus: string, workerState: string | null, terminalState: string, agentTerminalHandle: string | null) => ({
    dispatchId, taskId, runId: 'run-a', dispatchStatus, workerState, terminalState, currentAssignment: false, agentTerminalHandle
  })
  const workers = [
    worker('ctx-context', 'task-context', 'dispatched', null, 'released', null),
    worker('ctx-complete', 'task-complete', 'completed', 'succeeded', 'active', 's-complete'),
    worker('ctx-stop', 'task-stop', 'failed', 'stopped', 'released', 's-stop'),
    worker('ctx-abandon', 'task-abandon', 'dispatched', 'abandoned', 'retained', 's-abandon')
  ]
  const displays: Record<string, string> = { 's-coordinator': 'working', 's-complete': 'done', 's-abandon': 'working' }
  return {
    worktreeId: 'wt-a', runId: 'run-a', coordinatorSessionId: 's-coordinator',
    contextTaskId: 'task-context', contextDispatchId: 'ctx-context', assigneeSessionId: 's-target',
    workerTaskId: 'task-complete', completeDispatchId: 'ctx-complete', stopDispatchId: 'ctx-stop', abandonDispatchId: 'ctx-abandon',
    worktrees: [worktree, { id: 'wt-b', name: 'Beta', path: '/fixture/b', repoId: 'repo-b' }],
    sessions,
    dashboard: { cards: Object.entries(displays).map(([sessionId, display]) => ({ thread: { sessionId, worktreeId: 'wt-a', display, live: true } })) },
    runList: { runs: [{ id: 'run-a', coordinatorSessionId: 's-coordinator' }] },
    taskList: { runId: 'run-a', tasks: taskRows },
    workers: { scope: { runId: 'run-a', source: 'flag' }, workers },
    summary: {
      scope: 'local',
      rows: [{
        worktree: { ...worktree },
        sessions: sessions.filter(row => row.worktreeId === 'wt-a').map(row => ({
          id: row.id, agent: row.agent, kind: row.kind, status: row.status,
          display: displays[row.id] ?? null, live: row.status !== 'exited'
        })),
        runIds: ['run-a'], dispatches
      }]
    }
  }
}

function assertSummaryEvidence(value: SummaryFixture) {
  const { summary, worktrees, sessions, dashboard, runList, taskList, workers } = value
  return assertWorktreeSummaryEvidence({
    summary, worktrees, sessions, dashboard, runList, taskList, workers,
    worktreeId: value.worktreeId, runId: value.runId, coordinatorSessionId: value.coordinatorSessionId,
    contextTaskId: value.contextTaskId, contextDispatchId: value.contextDispatchId,
    assigneeSessionId: value.assigneeSessionId, workerTaskId: value.workerTaskId,
    completeDispatchId: value.completeDispatchId, stopDispatchId: value.stopDispatchId,
    abandonDispatchId: value.abandonDispatchId
  })
}

test('worktree summary comparison proves local metadata, session, Run, task and fleet associations', () => {
  const value = summaryEvidenceFixture()
  expect(WORKER_CHECK_IDS).toContain('workers-ps-summary')
  expect(assertSummaryEvidence(value)).toEqual({
    worktreeId: 'wt-a', metadataMatched: true, sessionsMatched: true, displaysMatched: true,
    runsMatched: true, tasksMatched: true, dispatchesMatched: true, workerStatesMatched: true,
    terminalStatesMatched: true, scope: 'local'
  })
})

test('worktree summary comparison rejects missing and corrupted independent evidence', () => {
  const corruptions: Array<(value: SummaryFixture) => void> = [
    value => { value.summary.rows = [] },
    value => { value.worktrees = value.worktrees.filter(row => row.id !== 'wt-a') },
    value => { value.summary.rows[0]!.worktree.name = 'Wrong name' },
    value => { value.summary.rows[0]!.worktree.path = '/fixture/wrong' },
    value => { value.summary.rows[0]!.worktree.repoId = 'repo-wrong' },
    value => { value.summary.rows[0]!.sessions = value.summary.rows[0]!.sessions.filter(row => row.id !== 's-target') },
    value => { value.summary.rows[0]!.sessions[0]!.id = 's-wrong' },
    value => { value.summary.rows[0]!.sessions[0]!.agent = 'claude' },
    value => { value.summary.rows[0]!.sessions[0]!.status = 'exited' },
    value => { value.summary.rows[0]!.sessions[0]!.live = false },
    value => { value.summary.rows[0]!.sessions.find(row => row.id === 's-complete')!.display = 'unknown' },
    value => { value.dashboard.cards[1]!.thread.display = 'working' },
    value => { value.dashboard.cards[1]!.thread.worktreeId = 'wt-b' },
    value => { value.summary.scope = 'remote' },
    value => { value.summary.rows[0]!.runIds = ['run-other'] },
    value => {
      value.runList.runs.push({ id: 'run-b', coordinatorSessionId: 's-other' })
      value.summary.rows[0]!.runIds.push('run-b')
    },
    value => { value.runList.runs[0]!.coordinatorSessionId = 's-other' },
    value => { value.summary.rows[0]!.dispatches = value.summary.rows[0]!.dispatches.filter(row => row.id !== 'ctx-abandon') },
    value => { value.summary.rows[0]!.dispatches[0]!.id = 'ctx-wrong' },
    value => { value.summary.rows[0]!.dispatches[0]!.status = 'completed' },
    value => { value.summary.rows[0]!.dispatches[0]!.currentAssignment = true },
    value => { value.summary.rows[0]!.dispatches.find(row => row.id === 'ctx-complete')!.workerState = 'stopped' },
    value => { value.summary.rows[0]!.dispatches.find(row => row.id === 'ctx-abandon')!.workerState = 'stopped' },
    value => { value.summary.rows[0]!.dispatches.find(row => row.id === 'ctx-complete')!.terminalState = 'released' },
    value => { value.summary.rows[0]!.dispatches.find(row => row.id === 'ctx-abandon')!.terminalState = 'released' },
    value => { value.workers.workers = value.workers.workers.filter(row => row.dispatchId !== 'ctx-abandon') },
    value => { value.workers.workers.find(row => row.dispatchId === 'ctx-complete')!.dispatchStatus = 'failed' },
    value => { value.workers.workers.find(row => row.dispatchId === 'ctx-complete')!.workerState = 'stopped' },
    value => { value.workers.workers.find(row => row.dispatchId === 'ctx-complete')!.terminalState = 'released' },
    value => { value.workers.workers.find(row => row.dispatchId === 'ctx-complete')!.agentTerminalHandle = 's-other' }
  ]
  for (const corrupt of corruptions) {
    const value = summaryEvidenceFixture()
    corrupt(value)
    expectRejected(() => assertSummaryEvidence(value))
  }
})

test('worktree summary rejects task mismatches and matching-looking tasks from another worktree', () => {
  const corruptions: Array<(value: SummaryFixture) => void> = [
    value => { value.summary.rows[0]!.dispatches[0]!.task.id = 'task-other' },
    value => { value.summary.rows[0]!.dispatches[0]!.task.title = 'Wrong title' },
    value => { value.summary.rows[0]!.dispatches[0]!.task.status = 'completed' },
    value => { value.summary.rows[0]!.dispatches[1]!.task.id = 'task-other' },
    value => { value.summary.rows[0]!.dispatches[1]!.task.title = 'Wrong title' },
    value => { value.summary.rows[0]!.dispatches[1]!.task.status = 'failed' },
    value => { value.taskList.tasks[0]!.assigneeSessionId = 's-other' }
  ]
  const otherWorktreeTask = summaryEvidenceFixture()
  otherWorktreeTask.taskList.tasks.push({
    id: 'task-other', runId: 'run-other', createdBySessionId: 's-other',
    taskTitle: 'Context task', status: 'dispatched', dispatchId: 'ctx-other', assigneeSessionId: 's-target'
  })
  otherWorktreeTask.summary.rows[0]!.dispatches[0]!.task.id = 'task-other'
  expectRejected(() => assertSummaryEvidence(otherWorktreeTask))
  for (const corrupt of corruptions) {
    const value = summaryEvidenceFixture()
    corrupt(value)
    expectRejected(() => assertSummaryEvidence(value))
  }
})


function expectRejected(assertion: () => void): void {
  expect(assertion).toThrow()
}

const workerLog = [
  '7 --dangerously-skip-permissions --disallowedTools --append-system-prompt --settings',
  '7 --dangerously-skip-permissions --disallowedTools --append-system-prompt --settings',
  '7 --dangerously-skip-permissions --disallowedTools --append-system-prompt --settings'
].join('\n')

const controllerRefusal = {
  code: 'conflict',
  message: 'consumer_fenced: this operation requires a live runtime-attested session caller'
}

test('Run takeover checks coordinator identity, generation increase and controller fencing', () => {
  const value = {
    runId: 'run-1', coordinatorSessionId: 'session-C', beforeGeneration: 4,
    run: { id: 'run-1', coordinatorSessionId: 'session-C', coordinatorHistory: ['session-A', 'session-C'], consumerGeneration: 5 },
    controllerRefusal
  }
  expect(assertRunUseEvidence(value)).toEqual({
    runId: 'run-1', coordinator: 'session-C', generation: { before: 4, after: 5 }, controllerRefusal: 'consumer_fenced'
  })
  expectRejected(() => assertRunUseEvidence({ ...value, run: { ...value.run, coordinatorSessionId: 'session-A' } }))
  expectRejected(() => assertRunUseEvidence({ ...value, run: { ...value.run, consumerGeneration: 4 } }))
  expectRejected(() => assertRunUseEvidence({ ...value, controllerRefusal: { code: 'conflict', message: 'another reason' } }))
})

test('controller refusals require the requested conflict reason', () => {
  assertControllerRefusal(controllerRefusal)
  expectRejected(() => assertControllerRefusal({ code: 'not-found', message: controllerRefusal.message }))
  expectRejected(() => assertControllerRefusal({ code: 'conflict', message: 'consumer_fenced: another reason' }))
})

test('context dispatch checks dry-run, assigned Dispatch, preamble and readback identity', () => {
  const value = {
    taskId: 'task-0',
    dryRun: { dryRun: true, dispatch: null, preamble: 'Context for task-0' },
    dispatch: { dryRun: false, dispatch: { id: 'ctx_dispatch-0', taskId: 'task-0', assigneeSessionId: 'session-S', status: 'dispatched' } },
    dispatchShow: { dispatch: { id: 'ctx_dispatch-0' }, worker: null, preamble: 'Context preamble' },
    readback: { dispatch: { id: 'ctx_dispatch-0' } }
  }
  expect(assertDispatchEvidence(value)).toEqual({ taskId: 'task-0', dispatchId: 'ctx_dispatch-0', assigneeSessionId: 'session-S' })
  expectRejected(() => assertDispatchEvidence({ ...value, dryRun: { ...value.dryRun, dispatch: { id: 'ctx_wrong' } } }))
  expectRejected(() => assertDispatchEvidence({ ...value, dispatch: { ...value.dispatch, dispatch: { ...value.dispatch.dispatch, status: 'pending' } } }))
})

test('worker starts are ready terminal Claude launches with distinct dispatches and exact stand-in log', () => {
  const starts = ['complete', 'stop', 'abandon'].map((suffix) => ({
    state: 'ready', dispatchId: `ctx_${suffix}`, runId: 'run-1',
    launch: { effective: { agent: 'claude' } }, mode: { mode: 'terminal' }
  }))
  expect(assertWorkerStartEvidence(starts, 'run-1', workerLog)).toEqual(['ctx_complete', 'ctx_stop', 'ctx_abandon'])
  expectRejected(() => assertWorkerStartEvidence([{ ...starts[0], state: 'starting' }, ...starts.slice(1)], 'run-1', workerLog))
  expectRejected(() => assertWorkerStartEvidence([starts[0], starts[0], starts[2]], 'run-1', workerLog))
  expectRejected(() => assertWorkerStartEvidence(starts, 'run-1', `${workerLog}\nextra`))
})

test('question reply checks the answer, idempotent replay, mismatch refusal and request readbacks', () => {
  const value = {
    messageId: 'message-1', requestId: 'request-U', absentRequestId: 'request-V',
    ask: { state: 'answered', answer: 'cli-parity-answer', messageId: 'message-1' },
    reply: { kind: 'question_answer', messageId: 'message-1', duplicate: false, answerMessageId: 'answer-1', mutation: { replayed: false } },
    replay: { mutation: { replayed: true }, answerMessageId: 'answer-1' },
    mismatch: { code: 'conflict', message: 'request_mismatch: request request-U was used with different input' },
    request: { state: 'completed' }, absent: { state: 'absent' }, readback: { state: 'completed' }
  }
  expect(assertQuestionReplyEvidence(value)).toEqual({ replayed: true, sameAnswer: true, mismatch: 'request_mismatch' })
  expectRejected(() => assertQuestionReplyEvidence({ ...value, replay: { ...value.replay, mutation: { replayed: false } } }))
  expectRejected(() => assertQuestionReplyEvidence({ ...value, mismatch: { code: 'not-found', message: value.mismatch.message } }))
  expectRejected(() => assertQuestionReplyEvidence({ ...value, request: { state: 'absent' } }))
})

test('worker completion requires an accepted receipt and settled worker and Dispatch', () => {
  const value = {
    receipt: { id: 'workers-done', exitCode: 0 }, dispatchId: 'ctx_complete',
    show: { worker: { state: 'succeeded' }, dispatch: { id: 'ctx_complete', status: 'completed' } }
  }
  expect(() => assertWorkerCompletion(value)).not.toThrow()
  expectRejected(() => assertWorkerCompletion({ ...value, show: { ...value.show, worker: { state: 'ready' } } }))
  expectRejected(() => assertWorkerCompletion({ ...value, show: { ...value.show, dispatch: { ...value.show.dispatch, id: 'ctx_other' } } }))
  expectRejected(() => assertWorkerCompletion({ ...value, show: { ...value.show, dispatch: { ...value.show.dispatch, status: 'dispatched' } } }))
  expectRejected(() => assertWorkerCompletion({ ...value, receipt: { ...value.receipt, exitCode: 1 } }))
})

test('stop checks first action, repeat settlement, worker failure, dead PTY and unauthorized refusal', () => {
  const value = {
    sessionId: 'session-stop',
    stop: { state: 'stopped', processAction: 'closed_agent_terminal' },
    repeat: { state: 'stopped', processAction: 'none', alreadySettled: true },
    show: { worker: { state: 'stopped' }, dispatch: { status: 'failed' } },
    terminalSessions: { sessions: [{ sessionId: 'session-stop', alive: false, pid: 400 }] },
    unauthorized: { code: 'conflict', message: 'consumer_fenced: this operation requires a live runtime-attested session caller' }
  }
  expect(assertWorkerStopEvidence(value)).toEqual({ state: 'stopped', processAction: 'closed_agent_terminal', ptyAlive: false, unauthorized: 'consumer_fenced' })
  expectRejected(() => assertWorkerStopEvidence({ ...value, stop: { ...value.stop, processAction: 'none' } }))
  expectRejected(() => assertWorkerStopEvidence({ ...value, terminalSessions: { sessions: [{ sessionId: 'session-stop', alive: true, pid: 400 }] } }))
  expectRejected(() => assertWorkerStopEvidence({ ...value, unauthorized: { code: 'conflict', message: 'other' } }))
})

test('retain leaves the worker process untouched', () => {
  assertWorkerRetain({ state: 'retained', processAction: 'none' })
  expectRejected(() => assertWorkerRetain({ state: 'retained', processAction: 'closed_agent_terminal' }))
})

test('abandon records both live terminal views, process liveness and later coordinator close', () => {
  const value = {
    sessionId: 'session-abandoned', pidAlive: true, closedByCoordinator: true,
    abandon: { state: 'abandoned', processAction: 'none', warning: 'Possibly-live resources were retained; no process was stopped or deleted.' },
    coordinatorShow: { worker: { state: 'abandoned' }, terminal: { status: 'working' } },
    controllerShow: { worker: { state: 'abandoned' }, terminal: { status: 'working' } },
    terminalSessions: { sessions: [{ sessionId: 'session-abandoned', alive: true, pid: 501 }] }
  }
  expect(assertWorkerAbandonEvidence(value)).toEqual({ state: 'abandoned', processAction: 'none', ptyAlive: true, pidAlive: true })
  expectRejected(() => assertWorkerAbandonEvidence({ ...value, controllerShow: { ...value.controllerShow, terminal: { status: 'exited' } } }))
  expectRejected(() => assertWorkerAbandonEvidence({ ...value, terminalSessions: { sessions: [{ sessionId: 'session-abandoned', alive: false, pid: 501 }] } }))
  expectRejected(() => assertWorkerAbandonEvidence({ ...value, pidAlive: false }))
})

test('worker list correlates the three starts with run, worktree and retained terminal state', () => {
  const value = {
    runId: 'run-1', worktreeId: 'worktree-1', dispatchIds: ['ctx_complete', 'ctx_stop', 'ctx_abandon'], contextDispatchId: 'ctx_context',
    list: {
      scope: { runId: 'run-1', source: 'flag' },
      workers: [
        { dispatchId: 'ctx_complete', workerState: 'succeeded', resource: { worktreeId: 'worktree-1' } },
        { dispatchId: 'ctx_stop', workerState: 'stopped', resource: { worktreeId: 'worktree-1' } },
        { dispatchId: 'ctx_abandon', workerState: 'abandoned', terminalState: 'retained', resource: { worktreeId: 'worktree-1' } }
      ]
    }
  }
  expect(assertWorkerListEvidence(value)).toEqual({ runId: 'run-1', worktreeId: 'worktree-1', contextIncluded: false })
  expectRejected(() => assertWorkerListEvidence({ ...value, list: { ...value.list, workers: value.list.workers.map((row) => row.dispatchId === 'ctx_complete' ? { ...row, resource: { worktreeId: 'other' } } : row) } }))
  expectRejected(() => assertWorkerListEvidence({ ...value, list: { ...value.list, scope: { runId: 'other', source: 'flag' } } }))
})

test('archived worker read preserves the completion marker', () => {
  assertWorkerReadArchived({ archived: true, content: 'CLI-PARITY-WORKER-DONE:ctx_complete\n' }, 'ctx_complete')
  expectRejected(() => assertWorkerReadArchived({ archived: true, content: 'other output' }, 'ctx_complete'))
  expectRejected(() => assertWorkerReadArchived({ archived: false, content: 'CLI-PARITY-WORKER-DONE:ctx_complete' }, 'ctx_complete'))
})

type WorkerReadLiveInput = {
  dispatchId: string
  sessionId: string
  viewport: { lines: string[]; cols: number; rows: number; alt: boolean }
  history: { lines: string[]; cursor: string | null }
  automatic: {
    dispatchId: string
    sessionId: string | null
    source: string
    archived: boolean
    sourceExact: boolean
    fallbackReason: string | null
    content: unknown
    contentComplete: boolean
    clipping: { clipped: boolean; maxBytes: number }
    nextCursor: string | null
    warnings: string[]
  }
  terminal: WorkerReadLiveInput['automatic']
}

function workerReadLiveFixture(): WorkerReadLiveInput {
  const dispatchId = 'ctx_live'
  const sessionId = 'session-live'
  const marker = `CLI-PARITY-WORKER-DONE:${dispatchId}`
  const splitAt = marker.length - 4
  const content = `${marker.slice(0, splitAt)}\r\n${marker.slice(splitAt)}`
  const result = (fallbackReason: string | null, contentComplete: boolean) => ({
    dispatchId,
    sessionId,
    source: 'terminal',
    archived: false,
    sourceExact: true,
    fallbackReason,
    content,
    contentComplete,
    clipping: { clipped: false, maxBytes: 524288 },
    nextCursor: null,
    warnings: []
  })
  return {
    dispatchId,
    sessionId,
    viewport: {
      lines: [marker.slice(0, splitAt), marker.slice(splitAt)],
      cols: 80,
      rows: 24,
      alt: false
    },
    history: { lines: ['recent history without the completion marker'], cursor: null },
    automatic: result('session_not_reported', false),
    terminal: result(null, true)
  }
}


test('worker live-read comparator proves the viewport, newest history page and both read results', () => {
  expect(() => assertWorkerReadLive(workerReadLiveFixture())).not.toThrow()
})

const workerReadLiveMutations: [string, (value: WorkerReadLiveInput) => void][] = [
  ['missing viewport marker', value => { value.viewport.lines = ['ordinary visible output'] }],
  ['wrong viewport marker', value => { value.viewport.lines = ['CLI-PARITY-WORKER-DONE:other-dispatch'] }],
  ['completion marker in newest history page', value => { value.history.lines = ['CLI-PARITY-WORKER-DONE:ctx_live'] }],
  ['missing automatic-read marker', value => { value.automatic.content = 'ordinary worker output' }],
  ['wrong automatic-read marker', value => { value.automatic.content = 'CLI-PARITY-WORKER-DONE:other-dispatch' }],
  ['missing terminal-read marker', value => { value.terminal.content = 'ordinary worker output' }],
  ['wrong terminal-read marker', value => { value.terminal.content = 'CLI-PARITY-WORKER-DONE:other-dispatch' }],
  ['non-string automatic-read content', value => { value.automatic.content = 42 }],
  ['non-string terminal-read content', value => { value.terminal.content = null }],
  ['wrong dispatch identity', value => { value.automatic.dispatchId = 'other-dispatch' }],
  ['wrong session identity', value => { value.terminal.sessionId = 'other-session' }],
  ['wrong automatic-read source', value => { value.automatic.source = 'transcript' }],
  ['wrong terminal-read source', value => { value.terminal.source = 'structured' }],
  ['archived automatic read', value => { value.automatic.archived = true }],
  ['archived terminal read', value => { value.terminal.archived = true }],
  ['inexact automatic read', value => { value.automatic.sourceExact = false }],
  ['inexact terminal read', value => { value.terminal.sourceExact = false }],
  ['wrong automatic fallback reason', value => { value.automatic.fallbackReason = 'transcript_empty' }],
  ['wrong terminal fallback reason', value => { value.terminal.fallbackReason = 'session_not_reported' }],
  ['wrong automatic completeness', value => { value.automatic.contentComplete = true }],
  ['wrong terminal completeness', value => { value.terminal.contentComplete = false }],
  ['automatic-read warnings', value => { value.automatic.warnings = ['terminal_tail_limited'] }],
  ['terminal-read warnings', value => { value.terminal.warnings = ['unexpected_warning'] }],
  ['clipped automatic read', value => { value.automatic.clipping.clipped = true }],
  ['wrong terminal clipping limit', value => { value.terminal.clipping.maxBytes = 1024 }],
  ['automatic-read continuation', value => { value.automatic.nextCursor = 'next-page' }],
  ['terminal-read continuation', value => { value.terminal.nextCursor = 'next-page' }]
]

for (const [label, mutate] of workerReadLiveMutations) {
  test(`worker live-read comparator rejects ${label}`, () => {
    const value = workerReadLiveFixture()
    mutate(value)
    expectRejected(() => assertWorkerReadLive(value))
  })
}

test('worker live, terminal and archived read receipts are registered', () => {
  for (const id of ['workers-read-live', 'workers-read-terminal', 'workers-read-archived']) {
    expect(WORKER_CHECK_IDS.filter(registered => registered === id)).toHaveLength(1)
  }
})

test('release closes only settled output and keeps the archive', () => {
  const value = {
    dispatchId: 'ctx_complete', sessionId: 'session-complete',
    release: { state: 'released', processAction: 'closed_agent_terminal', archive: { status: 'captured' } },
    repeat: { state: 'already_released', alreadySettled: true },
    releaseAbandoned: { state: 'retained', processAction: 'none' },
    terminalSessions: { sessions: [{ sessionId: 'session-complete', alive: false }] }
  }
  expect(assertWorkerReleaseEvidence(value)).toEqual({ state: 'released', archive: 'captured', ptyAlive: false })
  expectRejected(() => assertWorkerReleaseEvidence({ ...value, release: { ...value.release, archive: { status: 'empty' } } }))
  expectRejected(() => assertWorkerReleaseEvidence({ ...value, terminalSessions: { sessions: [{ sessionId: 'session-complete', alive: true }] } }))
  expectRejected(() => assertWorkerReleaseEvidence({ ...value, releaseAbandoned: { state: 'released', processAction: 'closed_agent_terminal' } }))
})

test('messages and all resets clear the owned state and keep controller calls fenced', () => {
  const value = {
    runId: 'run-1',
    messagesReset: { mode: 'messages', mutation: { replayed: false } }, inbox: { messages: [] },
    allReset: { mode: 'all' }, runList: { runs: [{ id: 'run-2' }] },
    messagesRefusal: controllerRefusal, allRefusal: controllerRefusal
  }
  expect(() => assertResetEvidence(value)).not.toThrow()
  expectRejected(() => assertResetEvidence({ ...value, inbox: { messages: [{ id: 'message-1' }] } }))
  expectRejected(() => assertResetEvidence({ ...value, runList: { runs: [{ id: 'run-1' }] } }))
  expectRejected(() => assertResetEvidence({ ...value, messagesRefusal: { code: 'conflict', message: 'other' } }))
})

test('dashboard cards correlate both live worker sessions to the owned worktree', () => {
  const value = {
    worktreeId: 'worktree-1', sessionIds: ['session-complete', 'session-abandoned'],
    dashboard: { cards: [
      { thread: { sessionId: 'session-complete', worktreeId: 'worktree-1' }, bucket: 'done' },
      { thread: { sessionId: 'session-abandoned', worktreeId: 'worktree-1' }, bucket: 'working' }
    ] }
  }
  expect(() => assertWorktreeDashboardEvidence(value)).not.toThrow()
  expectRejected(() => assertWorktreeDashboardEvidence({ ...value, dashboard: { cards: [{ thread: { sessionId: 'session-complete', worktreeId: 'other' } }, value.dashboard.cards[1]] } }))
})

test('run list retains the coordinator binding for the selected run', () => {
  const value = { runId: 'run-1', coordinatorSessionId: 'session-C', runList: { runs: [{ id: 'run-1', coordinatorSessionId: 'session-C' }] } }
  expect(() => assertWorktreeRunEvidence(value)).not.toThrow()
  expectRejected(() => assertWorktreeRunEvidence({ ...value, runList: { runs: [{ id: 'run-1', coordinatorSessionId: 'session-A' }] } }))
})

test('task list correlates context dispatch and completed worker to the dashboard and fleet', () => {
  const value = {
    runId: 'run-1', worktreeId: 'worktree-1', taskId: 'task-context', dispatchId: 'ctx_context', assigneeSessionId: 'session-S',
    workerTaskId: 'task-worker', workerDispatchId: 'ctx_complete',
    taskList: { runId: 'run-1', tasks: [
      { id: 'task-context', status: 'dispatched', dispatchId: 'ctx_context', assigneeSessionId: 'session-S' },
      { id: 'task-worker', status: 'completed' }
    ] },
    dashboard: { cards: [
      { thread: { sessionId: 'session-complete', worktreeId: 'worktree-1' } },
      { thread: { sessionId: 'session-abandoned', worktreeId: 'worktree-1' } }
    ] },
    workers: { workers: [
      { dispatchId: 'ctx_complete', taskId: 'task-worker', workerState: 'succeeded', resource: { worktreeId: 'worktree-1', sessionId: 'session-complete' } },
      { dispatchId: 'ctx_stop', taskId: 'task-stop', workerState: 'stopped', resource: { worktreeId: 'worktree-1', sessionId: 'session-stop' } },
      { dispatchId: 'ctx_abandon', taskId: 'task-abandon', workerState: 'abandoned', resource: { worktreeId: 'worktree-1', sessionId: 'session-abandoned' } }
    ] }
  }
  expect(assertWorktreeTaskEvidence(value)).toEqual({
    correlation: { worktreeToSession: true, sessionToWorker: true, taskToDispatch: true, cardToTask: false, worktreePath: false, hostScope: false }
  })
  expectRejected(() => assertWorktreeTaskEvidence({ ...value, taskList: { ...value.taskList, tasks: [{ ...value.taskList.tasks[0], status: 'ready' }, value.taskList.tasks[1]] } }))
  expectRejected(() => assertWorktreeTaskEvidence({ ...value, workers: { workers: value.workers.workers.map((row) => row.dispatchId === 'ctx_complete' ? { ...row, taskId: 'another-task' } : row) } }))
})

test('worker preamble parser reads real completion and hold preambles and rejects missing identity lines', () => {
  const task = (spec: string) => ({
    id: 'task_1', runId: 'run_1', parentTaskId: null, dependencyTaskIds: [], createdBySessionId: 'session-C',
    taskTitle: 'CLI worker task', displayName: 'CLI worker task', spec, status: 'ready', result: null,
    createdAt: '2026-11-13T00:00:00.000Z', completedAt: null
  }) satisfies Parameters<typeof buildWorkerPreamble>[0]
  const dispatch = {
    id: 'ctx_dispatch-1', runId: 'run_1', taskId: 'task_1', contractVersion: 1, status: 'dispatched',
    assigneeSessionId: 'session-W', creatorSessionId: 'session-C', creatorDispatchId: null, retryOfDispatchId: null,
    depth: 0, failureCount: 0, lastFailure: null, terminationReason: null, consumerGeneration: 1,
    createdAt: '2026-11-13T00:00:00.000Z', dispatchedAt: '2026-11-13T00:00:00.000Z', completedAt: null, lastHeartbeatAt: null
  } satisfies Parameters<typeof buildWorkerPreamble>[1]
  const session = {
    sessionId: 'session-W', live: true, runtimeEpoch: 'epoch-1', processIncarnation: 'incarnation-1',
    source: 'terminal_launch', kind: 'terminal', providerId: 'claude', worktreeId: 'worktree-1'
  } as Parameters<typeof buildWorkerPreamble>[2]
  const complete = parseWorkerPreamble(buildWorkerPreamble(task('cli-parity-worker-complete'), dispatch, session, 'session-C', 2))
  expect(complete).toEqual({ sessionId: 'session-W', worktreeId: 'worktree-1', runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_dispatch-1', mode: 'complete' })
  const hold = parseWorkerPreamble(buildWorkerPreamble(task('cli-parity-worker-hold'), dispatch, session, 'session-C', 2))
  expect(hold).toEqual({ ...complete, mode: 'hold' })
  expectRejected(() => parseWorkerPreamble(buildWorkerPreamble(task('cli-parity-worker-complete'), dispatch, session, 'session-C', 2).replace('Your Dispatch ID is: ctx_dispatch-1\n', '')))
  const unknown = parseWorkerPreamble(buildWorkerPreamble(task('unexpected spec'), dispatch, session, 'session-C', 2))
  expect(unknown).toEqual({ ...complete, mode: 'unknown' })
})

test('worker cleanup closes every tab added beyond baseline and keeps going after a close fails', async () => {
  const state = { worktreeId: 'worktree-1', workersTerminalBaseline: ['base-tab'] }
  const calls: string[][] = []
  const errors: string[] = []
  const attempt = async (argv: string[]) => {
    calls.push(argv)
    if (argv[0] === 'terminal' && argv[1] === 'layout') return {
      id: 'worktree-1', root: { kind: 'group', id: 'group-1', tabs: [
        { id: 'base-tab', root: { kind: 'pane', id: 'pane-1', session: 'session-base' } },
        { id: 'worker-tab', root: { kind: 'pane', id: 'pane-2', session: 'session-worker' } },
        { id: 'coordinator-tab', root: { kind: 'pane', id: 'pane-3', session: 'session-C' } }
      ] }
    }
    if (argv[3] === 'worker-tab') throw new Error('worker tab close failed')
    return { closed: true }
  }
  await cleanupWorkerChecks({ state }, attempt, errors)
  expect(calls).toEqual([
    ['terminal', 'layout', '--worktree', 'worktree-1'],
    ['terminal', 'tab', 'close', 'worker-tab', '--yes'],
    ['terminal', 'tab', 'close', 'coordinator-tab', '--yes']
  ])
  expect(errors).toEqual(['worker tab close failed'])
})

test('worker cleanup does nothing once cleanup is verified', async () => {
  const calls: string[][] = []
  const errors: string[] = []
  await cleanupWorkerChecks({ state: { workersCleanupVerified: true } }, async (argv) => { calls.push(argv); return {} }, errors)
  expect(calls).toEqual([])
  expect(errors).toEqual([])
})

test('worker cleanup joins a failed layout read without attempting unknown tabs', async () => {
  const calls: string[][] = []
  const errors: string[] = []
  await cleanupWorkerChecks({ state: { worktreeId: 'worktree-1', workersTerminalBaseline: ['base-tab'] } }, async (argv) => {
    calls.push(argv)
    throw new Error('layout unavailable')
  }, errors)
  expect(calls).toEqual([['terminal', 'layout', '--worktree', 'worktree-1']])
  expect(errors).toEqual(['layout unavailable'])
})
