import { expect, test } from 'bun:test'
import { buildWorkerPreamble } from '../../plugins/quirky.orchestration/src/workers/preamble'
import { parseWorkerPreamble } from './cli-worker-actor'
import {
  WORKER_CHECK_IDS,
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
  assertWorktreeTaskEvidence,
  cleanupWorkerChecks
} from './cli-workers'

function expectRejected(assertion: () => void): void {
  expect(assertion).toThrow()
}

const workerLog = [
  '3 --dangerously-skip-permissions --settings',
  '3 --dangerously-skip-permissions --settings',
  '3 --dangerously-skip-permissions --settings'
].join('\n')

const controllerRefusal = {
  code: 'conflict',
  message: 'consumer_fenced: this operation requires a live runtime-attested session caller'
}

test('worker checks register the complete fixed ID set', () => {
  expect(WORKER_CHECK_IDS).toEqual([
    'workers-run-use',
    'workers-dispatch-dry-run', 'workers-dispatch', 'workers-dispatch-show',
    'workers-start-complete', 'workers-start-stop', 'workers-start-abandon',
    'workers-ask', 'workers-reply', 'workers-reply-replay', 'workers-request-show', 'workers-done',
    'workers-show', 'workers-read-live', 'workers-read-archived', 'workers-list',
    'workers-stop', 'workers-retain', 'workers-abandon', 'workers-release',
    'workers-reset-messages', 'workers-reset-all',
    'workers-ps-dashboard', 'workers-ps-runs', 'workers-ps-tasks'
  ])
})

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

test('live worker read checks terminal source and its completion marker', () => {
  assertWorkerReadLive({ source: 'terminal', archived: false, content: 'hello\r\nCLI-PARITY-WORKER-DONE:ctx_complete\r\n' }, 'ctx_complete')
  expectRejected(() => assertWorkerReadLive({ source: 'terminal', archived: false, content: 'no marker' }, 'ctx_complete'))
  expectRejected(() => assertWorkerReadLive({ source: 'transcript', archived: false, content: 'CLI-PARITY-WORKER-DONE:ctx_complete' }, 'ctx_complete'))
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
    id: 'task-1', runId: 'run-1', parentTaskId: null, dependencyTaskIds: [], createdBySessionId: 'session-C',
    taskTitle: 'CLI worker task', displayName: 'CLI worker task', spec, status: 'ready', result: null,
    createdAt: '2026-11-13T00:00:00.000Z', completedAt: null
  }) as Parameters<typeof buildWorkerPreamble>[0]
  const dispatch = {
    id: 'ctx_dispatch-1', runId: 'run-1', taskId: 'task-1', contractVersion: 1, status: 'dispatched',
    assigneeSessionId: 'session-W', creatorSessionId: 'session-C', creatorDispatchId: null, retryOfDispatchId: null,
    depth: 0, failureCount: 0, lastFailure: null, terminationReason: null, consumerGeneration: 1,
    createdAt: '2026-11-13T00:00:00.000Z', dispatchedAt: '2026-11-13T00:00:00.000Z', completedAt: null, lastHeartbeatAt: null
  } as Parameters<typeof buildWorkerPreamble>[1]
  const session = {
    sessionId: 'session-W', live: true, runtimeEpoch: 'epoch-1', processIncarnation: 'incarnation-1',
    source: 'terminal_launch', kind: 'terminal', providerId: 'claude', worktreeId: 'worktree-1'
  } as Parameters<typeof buildWorkerPreamble>[2]
  const complete = parseWorkerPreamble(buildWorkerPreamble(task('cli-parity-worker-complete'), dispatch, session, 'session-C', 2))
  expect(complete).toEqual({ sessionId: 'session-W', worktreeId: 'worktree-1', runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx_dispatch-1', mode: 'complete' })
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
