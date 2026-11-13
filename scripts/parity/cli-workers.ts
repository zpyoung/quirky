import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createActorReceiptStore, readActorReceipts, type CliActorReceipt, type CliActorReceiptStore } from './cli-actor'
import type { CliCheckContext } from './cli-checks'
import { COORDINATOR_PHASE_ONE_IDS, COORDINATOR_PHASE_TWO_IDS } from './cli-worker-actor'

export const WORKER_CHECK_IDS = [
  'workers-run-use',
  'workers-dispatch-dry-run', 'workers-dispatch', 'workers-dispatch-show',
  'workers-start-complete', 'workers-start-stop', 'workers-start-abandon',
  'workers-ask', 'workers-reply', 'workers-reply-replay', 'workers-request-show', 'workers-done',
  'workers-show', 'workers-read-live', 'workers-read-archived', 'workers-list',
  'workers-stop', 'workers-retain', 'workers-abandon', 'workers-release',
  'workers-reset-messages', 'workers-reset-all',
  'workers-ps-dashboard', 'workers-ps-runs', 'workers-ps-tasks'
] as const

type ObjectValue = Record<string, unknown>
type TerminalPane = { tabId: string; sessionId: string }

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): ObjectValue {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function nonEmptyText(value: unknown, label: string): string {
  const result = text(value, label)
  if (result.length === 0) throw new Error(`${label} must not be empty`)
  return result
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} did not match the expected value`)
}

function field(value: unknown, key: string, label: string): unknown {
  return object(value, label)[key]
}

function stringField(value: unknown, key: string, label: string): string {
  return text(field(value, key, label), `${label}.${key}`)
}

function listObjects(value: unknown, label: string): ObjectValue[] {
  return array(value, label).map((entry, index) => object(entry, `${label}[${index}]`))
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`${label} did not contain JSON`, { cause: error })
  }
}

function controllerRefusal(value: unknown, label: string): ObjectValue {
  const refusal = object(value, label)
  equal(refusal.code, 'conflict', `${label} code`)
  equal(refusal.message, 'consumer_fenced: this operation requires a live runtime-attested session caller', `${label} message`)
  return refusal
}

export function assertControllerRefusal(value: unknown): void {
  controllerRefusal(value, 'controller refusal')
}

export function assertRunUseEvidence(value: {
  runId: string; coordinatorSessionId: string; beforeGeneration: number; run: unknown; controllerRefusal: unknown
}): { runId: string; coordinator: string; generation: { before: number; after: number }; controllerRefusal: 'consumer_fenced' } {
  const run = object(value.run, 'run-use result')
  equal(run.id, value.runId, 'run-use Run ID')
  equal(run.coordinatorSessionId, value.coordinatorSessionId, 'run-use coordinator')
  const history = array(run.coordinatorHistory, 'run-use coordinator history')
  ensure(history.includes(value.coordinatorSessionId), 'run-use coordinator history omitted the new coordinator')
  const after = run.consumerGeneration
  ensure(typeof after === 'number' && Number.isInteger(after), 'run-use consumer generation must be an integer')
  equal(after, value.beforeGeneration + 1, 'run-use consumer generation')
  controllerRefusal(value.controllerRefusal, 'run-use controller refusal')
  return {
    runId: value.runId,
    coordinator: value.coordinatorSessionId,
    generation: { before: value.beforeGeneration, after },
    controllerRefusal: 'consumer_fenced'
  }
}

export function assertDispatchEvidence(value: {
  taskId: string; dryRun: unknown; dispatch: unknown; dispatchShow: unknown; readback: unknown
}): { taskId: string; dispatchId: string; assigneeSessionId: string } {
  const dryRun = object(value.dryRun, 'dispatch dry-run result')
  equal(dryRun.dryRun, true, 'dispatch dry-run flag')
  equal(dryRun.dispatch, null, 'dispatch dry-run dispatch')
  ensure(typeof dryRun.preamble === 'string' && dryRun.preamble.includes(value.taskId), 'dispatch dry-run preamble omitted the Task ID')

  const result = object(value.dispatch, 'dispatch result')
  equal(result.dryRun, false, 'dispatch result dry-run flag')
  const dispatch = object(result.dispatch, 'dispatch result.dispatch')
  const dispatchId = nonEmptyText(dispatch.id, 'dispatch result.dispatch.id')
  ensure(dispatchId.startsWith('ctx_'), 'context Dispatch ID must start with ctx_')
  equal(dispatch.taskId, value.taskId, 'context Dispatch Task ID')
  const assigneeSessionId = nonEmptyText(dispatch.assigneeSessionId, 'context Dispatch assignee')
  equal(dispatch.status, 'dispatched', 'context Dispatch status')

  const shown = object(value.dispatchShow, 'dispatch-show result')
  equal(object(shown.dispatch, 'dispatch-show result.dispatch').id, dispatchId, 'dispatch-show Dispatch ID')
  equal(shown.worker, null, 'context dispatch worker')
  ensure(typeof shown.preamble === 'string' && shown.preamble.length > 0, 'dispatch-show preamble must not be empty')
  equal(object(object(value.readback, 'dispatch-show readback').dispatch, 'dispatch-show readback.dispatch').id, dispatchId, 'controller dispatch-show readback ID')
  return { taskId: value.taskId, dispatchId, assigneeSessionId }
}

export function assertWorkerStartEvidence(
  startsValue: unknown,
  runId: string,
  workerLog: string
): string[] {
  const starts = listObjects(startsValue, 'worker-start results')
  equal(starts.length, 3, 'worker-start count')
  const ids = starts.map((start, index) => {
    equal(start.state, 'ready', `worker-start[${index}] state`)
    const dispatchId = nonEmptyText(start.dispatchId, `worker-start[${index}] dispatch ID`)
    ensure(dispatchId.startsWith('ctx_'), `worker-start[${index}] Dispatch ID must start with ctx_`)
    equal(start.runId, runId, `worker-start[${index}] Run ID`)
    const launch = object(start.launch, `worker-start[${index}] launch`)
    equal(object(launch.effective, `worker-start[${index}] launch.effective`).agent, 'claude', `worker-start[${index}] effective agent`)
    equal(object(start.mode, `worker-start[${index}] mode`).mode, 'terminal', `worker-start[${index}] mode`)
    return dispatchId
  })
  equal(new Set(ids).size, 3, 'worker-start Dispatch IDs')
  const lines = workerLog.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  equal(lines, [
    '3 --dangerously-skip-permissions --settings',
    '3 --dangerously-skip-permissions --settings',
    '3 --dangerously-skip-permissions --settings'
  ], 'Claude worker log')
  return ids
}

export function assertQuestionReplyEvidence(value: {
  messageId: string; requestId: string; absentRequestId: string; ask: unknown; reply: unknown; replay: unknown;
  mismatch: unknown; request: unknown; absent: unknown; readback: unknown
}): { replayed: true; sameAnswer: true; mismatch: 'request_mismatch' } {
  const ask = object(value.ask, 'worker ask result')
  equal(ask.state, 'answered', 'worker ask state')
  equal(ask.answer, 'cli-parity-answer', 'worker ask answer')
  equal(ask.messageId, value.messageId, 'worker ask message ID')

  const reply = object(value.reply, 'coordinator reply result')
  equal(reply.kind, 'question_answer', 'coordinator reply kind')
  equal(reply.messageId, value.messageId, 'coordinator reply message ID')
  equal(reply.duplicate, false, 'coordinator reply duplicate flag')
  equal(object(reply.mutation, 'coordinator reply mutation').replayed, false, 'coordinator reply replay flag')
  const answerMessageId = nonEmptyText(reply.answerMessageId, 'coordinator reply answer message ID')

  const replay = object(value.replay, 'coordinator reply replay result')
  equal(object(replay.mutation, 'coordinator reply replay mutation').replayed, true, 'coordinator reply replay flag')
  equal(replay.answerMessageId, answerMessageId, 'replayed answer message ID')
  const mismatch = object(value.mismatch, 'reply mismatch refusal')
  equal(mismatch.code, 'conflict', 'reply mismatch code')
  const mismatchMessage = text(mismatch.message, 'reply mismatch message')
  ensure(mismatchMessage.startsWith(`request_mismatch: request ${value.requestId} was`), 'reply mismatch message did not identify the reused request')
  equal(object(value.request, 'request-show result').state, 'completed', 'completed request state')
  equal(object(value.absent, 'absent request-show result').state, 'absent', 'absent request state')
  equal(object(value.readback, 'controller request-show readback').state, 'completed', 'controller completed request state')
  return { replayed: true, sameAnswer: true, mismatch: 'request_mismatch' }
}

export function assertWorkerCompletion(value: { receipt: unknown; show: unknown; dispatchId: string }): void {
  equal(object(value.receipt, 'worker_done receipt').exitCode, 0, 'worker_done exit code')
  const show = object(value.show, 'completed worker-show')
  equal(object(show.worker, 'completed worker-show worker').state, 'succeeded', 'completed worker state')
  equal(object(show.dispatch, 'completed worker-show dispatch').id, value.dispatchId, 'completed worker Dispatch ID')
  equal(object(show.dispatch, 'completed worker-show dispatch').status, 'completed', 'completed Dispatch status')
}

function terminalSessions(value: unknown, label: string): ObjectValue[] {
  return listObjects(object(value, label).sessions, `${label}.sessions`)
}

export function assertWorkerStopEvidence(value: {
  sessionId: string; stop: unknown; repeat: unknown; show: unknown; terminalSessions: unknown; unauthorized: unknown
}): { state: 'stopped'; processAction: 'closed_agent_terminal'; ptyAlive: false; unauthorized: 'consumer_fenced' } {
  const stop = object(value.stop, 'worker-stop result')
  equal(stop.state, 'stopped', 'worker-stop state')
  equal(stop.processAction, 'closed_agent_terminal', 'worker-stop process action')
  const repeat = object(value.repeat, 'repeated worker-stop result')
  equal(repeat.state, 'stopped', 'repeated worker-stop state')
  equal(repeat.processAction, 'none', 'repeated worker-stop process action')
  equal(repeat.alreadySettled, true, 'repeated worker-stop settlement')
  const shown = object(value.show, 'stopped worker-show')
  equal(object(shown.worker, 'stopped worker-show worker').state, 'stopped', 'stopped worker state')
  equal(object(shown.dispatch, 'stopped worker-show dispatch').status, 'failed', 'stopped Dispatch status')
  const live = terminalSessions(value.terminalSessions, 'worker-stop terminal sessions')
    .some(session => session.sessionId === value.sessionId && session.alive === true)
  equal(live, false, 'stopped worker PTY liveness')
  const refusal = object(value.unauthorized, 'unauthorized worker-stop result')
  equal(refusal.code, 'conflict', 'unauthorized worker-stop code')
  const message = text(refusal.message, 'unauthorized worker-stop message')
  ensure(message.includes('consumer_fenced') && message.includes('live runtime-attested session caller'), 'unauthorized worker-stop did not report consumer_fenced')
  return { state: 'stopped', processAction: 'closed_agent_terminal', ptyAlive: false, unauthorized: 'consumer_fenced' }
}

export function assertWorkerRetain(value: unknown): void {
  const result = object(value, 'worker-retain result')
  equal(result.state, 'retained', 'worker-retain state')
  equal(result.processAction, 'none', 'worker-retain process action')
}

export function assertWorkerAbandonEvidence(value: {
  sessionId: string; abandon: unknown; coordinatorShow: unknown; controllerShow: unknown; terminalSessions: unknown;
  pidAlive: boolean; closedByCoordinator: boolean
}): { state: 'abandoned'; processAction: 'none'; ptyAlive: true; pidAlive: true } {
  const abandon = object(value.abandon, 'worker-abandon result')
  equal(abandon.state, 'abandoned', 'worker-abandon state')
  equal(abandon.processAction, 'none', 'worker-abandon process action')
  equal(abandon.warning, 'Possibly-live resources were retained; no process was stopped or deleted.', 'worker-abandon warning')
  for (const [label, raw] of [['coordinator', value.coordinatorShow], ['controller', value.controllerShow]] as const) {
    const shown = object(raw, `${label} abandoned worker-show`)
    equal(object(shown.worker, `${label} abandoned worker-show worker`).state, 'abandoned', `${label} abandoned worker state`)
    ensure(object(shown.terminal, `${label} abandoned worker-show terminal`).status !== 'exited', `${label} abandoned terminal unexpectedly exited`)
  }
  const matching = terminalSessions(value.terminalSessions, 'worker-abandon terminal sessions')
    .filter(session => session.sessionId === value.sessionId)
  equal(matching.length, 1, 'abandoned worker terminal session count')
  equal(matching[0]!.alive, true, 'abandoned worker PTY liveness')
  ensure(typeof matching[0]!.pid === 'number' && matching[0]!.pid > 0, 'abandoned worker PID must be positive')
  equal(value.pidAlive, true, 'abandoned worker process liveness')
  equal(value.closedByCoordinator, true, 'abandoned worker coordinator close')
  return { state: 'abandoned', processAction: 'none', ptyAlive: true, pidAlive: true }
}

export function assertWorkerReadLive(value: unknown, dispatchId: string): void {
  const result = object(value, 'live worker-read result')
  equal(result.source, 'terminal', 'live worker-read source')
  equal(result.archived, false, 'live worker-read archive flag')
  const content = text(result.content, 'live worker-read content').replace(/\r?\n/g, '')
  ensure(content.includes(`CLI-PARITY-WORKER-DONE:${dispatchId}`), 'live worker-read omitted the completion marker')
}

export function assertWorkerListEvidence(value: {
  list: unknown; runId: string; worktreeId: string; dispatchIds: readonly string[]; contextDispatchId: string
}): { runId: string; worktreeId: string; contextIncluded: boolean } {
  const list = object(value.list, 'worker-list result')
  const scope = object(list.scope, 'worker-list scope')
  equal(scope.runId, value.runId, 'worker-list Run scope')
  equal(scope.source, 'flag', 'worker-list scope source')
  const workers = listObjects(list.workers, 'worker-list workers')
  const expectedStates = ['succeeded', 'stopped', 'abandoned']
  for (const [index, dispatchId] of value.dispatchIds.entries()) {
    const matches = workers.filter(worker => worker.dispatchId === dispatchId)
    equal(matches.length, 1, `worker-list row count for ${dispatchId}`)
    const row = matches[0]!
    equal(row.workerState, expectedStates[index], `worker-list state for ${dispatchId}`)
    equal(object(row.resource, `worker-list ${dispatchId} resource`).worktreeId, value.worktreeId, `worker-list ${dispatchId} worktree`)
    if (index === 2) equal(row.terminalState, 'retained', 'abandoned worker terminal state')
  }
  return { runId: value.runId, worktreeId: value.worktreeId, contextIncluded: workers.some(worker => worker.dispatchId === value.contextDispatchId) }
}

export function assertWorkerReadArchived(value: unknown, dispatchId: string): void {
  const result = object(value, 'archived worker-read result')
  equal(result.archived, true, 'archived worker-read flag')
  const content = text(result.content, 'archived worker-read content').replace(/\r?\n/g, '')
  ensure(content.includes(`CLI-PARITY-WORKER-DONE:${dispatchId}`), 'archived worker-read omitted the completion marker')
}

export function assertWorkerReleaseEvidence(value: {
  dispatchId: string; sessionId: string; release: unknown; repeat: unknown; releaseAbandoned: unknown; terminalSessions: unknown
}): { state: 'released'; archive: 'captured'; ptyAlive: false } {
  const release = object(value.release, 'worker-release result')
  equal(release.state, 'released', 'worker-release state')
  equal(release.processAction, 'closed_agent_terminal', 'worker-release process action')
  equal(object(release.archive, 'worker-release archive').status, 'captured', 'worker-release archive status')
  const repeat = object(value.repeat, 'repeated worker-release result')
  equal(repeat.state, 'already_released', 'repeated worker-release state')
  equal(repeat.alreadySettled, true, 'repeated worker-release settlement')
  const abandoned = object(value.releaseAbandoned, 'abandoned worker-release result')
  equal(abandoned.state, 'retained', 'abandoned worker release state')
  equal(abandoned.processAction, 'none', 'abandoned worker release process action')
  const live = terminalSessions(value.terminalSessions, 'worker-release terminal sessions')
    .some(session => session.sessionId === value.sessionId && session.alive === true)
  equal(live, false, 'released worker PTY liveness')
  return { state: 'released', archive: 'captured', ptyAlive: false }
}

export function assertResetEvidence(value: {
  runId: string; messagesReset: unknown; inbox: unknown; allReset: unknown; runList: unknown;
  messagesRefusal: unknown; allRefusal: unknown
}): void {
  const messagesReset = object(value.messagesReset, 'messages reset result')
  equal(messagesReset.mode, 'messages', 'messages reset mode')
  equal(object(messagesReset.mutation, 'messages reset mutation').replayed, false, 'messages reset replay flag')
  equal(array(object(value.inbox, 'reset inbox result').messages, 'reset inbox messages').length, 0, 'inbox messages after reset')
  equal(object(value.allReset, 'all reset result').mode, 'all', 'all reset mode')
  const runs = listObjects(object(value.runList, 'reset run-list result').runs, 'reset run-list runs')
  ensure(!runs.some(run => run.id === value.runId), 'run-list still contained the reset Run')
  controllerRefusal(value.messagesRefusal, 'unauthorized messages reset')
  controllerRefusal(value.allRefusal, 'unauthorized all reset')
}

export function assertWorktreeDashboardEvidence(value: {
  dashboard: unknown; worktreeId: string; sessionIds: readonly string[]
}): void {
  const cards = listObjects(object(value.dashboard, 'agent-status dashboard').cards, 'agent-status dashboard cards')
  for (const sessionId of value.sessionIds) {
    const matches = cards.filter(card => isObject(card.thread) && card.thread.sessionId === sessionId)
    equal(matches.length, 1, `dashboard card count for ${sessionId}`)
    equal(object(matches[0]!.thread, `dashboard card ${sessionId} thread`).worktreeId, value.worktreeId, `dashboard ${sessionId} worktree`)
  }
}

export function assertWorktreeRunEvidence(value: {
  runList: unknown; runId: string; coordinatorSessionId: string
}): void {
  const runs = listObjects(object(value.runList, 'worktree run-list result').runs, 'worktree run-list runs')
  const matches = runs.filter(run => run.id === value.runId)
  equal(matches.length, 1, 'worktree run-list target count')
  equal(matches[0]!.coordinatorSessionId, value.coordinatorSessionId, 'worktree run-list coordinator')
}

export function assertWorktreeTaskEvidence(value: {
  taskList: unknown; workers: unknown; dashboard: unknown; runId: string; worktreeId: string;
  taskId: string; dispatchId: string; assigneeSessionId: string; workerTaskId: string; workerDispatchId: string
}): { correlation: { worktreeToSession: true; sessionToWorker: true; taskToDispatch: true; cardToTask: false; worktreePath: false; hostScope: false } } {
  const taskList = object(value.taskList, 'worktree task-list result')
  equal(taskList.runId, value.runId, 'worktree task-list Run ID')
  const tasks = listObjects(taskList.tasks, 'worktree task-list tasks')
  const contextTask = tasks.find(task => task.id === value.taskId)
  ensure(contextTask !== undefined, 'worktree task-list omitted the context Task')
  equal(contextTask.status, 'dispatched', 'context Task status')
  equal(contextTask.dispatchId, value.dispatchId, 'context Task Dispatch ID')
  equal(contextTask.assigneeSessionId, value.assigneeSessionId, 'context Task assignee')
  const workerTask = tasks.find(task => task.id === value.workerTaskId)
  ensure(workerTask !== undefined, 'worktree task-list omitted the completed worker Task')
  equal(workerTask.status, 'completed', 'worker Task status')

  const workers = listObjects(object(value.workers, 'worktree worker-list result').workers, 'worktree worker-list workers')
  const completed = workers.filter(worker => worker.workerState === 'succeeded')
  const abandoned = workers.filter(worker => worker.workerState === 'abandoned')
  equal(completed.length, 1, 'completed worker row count')
  equal(abandoned.length, 1, 'abandoned worker row count')
  const completedWorker = completed[0]!
  equal(completedWorker.dispatchId, value.workerDispatchId, 'completed worker Dispatch ID')
  equal(completedWorker.taskId, value.workerTaskId, 'worker Dispatch Task ID')
  const cards = listObjects(object(value.dashboard, 'worktree dashboard').cards, 'worktree dashboard cards')
  for (const [label, worker] of [['completed', completedWorker], ['abandoned', abandoned[0]!] ] as const) {
    const resource = object(worker.resource, `${label} worker resource`)
    equal(resource.worktreeId, value.worktreeId, `${label} worker resource worktree`)
    const sessionId = nonEmptyText(resource.sessionId, `${label} worker resource session ID`)
    const matchingCards = cards.filter(card => isObject(card.thread) && card.thread.sessionId === sessionId)
    equal(matchingCards.length, 1, `${label} worker dashboard card count`)
    const thread = object(matchingCards[0]!.thread, `${label} worker dashboard thread`)
    equal(thread.worktreeId, value.worktreeId, `${label} worker dashboard worktree`)
    ensure(!Object.hasOwn(thread, 'taskId') && !Object.hasOwn(thread, 'dispatchId'), `${label} dashboard card unexpectedly names a Task or Dispatch`)
    ensure(!Object.hasOwn(resource, 'worktreePath') && !Object.hasOwn(resource, 'worktreeName'), `${label} worker resource unexpectedly names a worktree path or name`)
  }

  const correlation = {
    worktreeToSession: true as const,
    sessionToWorker: true as const,
    taskToDispatch: true as const,
    cardToTask: false as const,
    worktreePath: false as const,
    hostScope: false as const
  }
  return { correlation }
}

function stateString(context: CliCheckContext, key: string): string {
  return nonEmptyText(context.state[key], `check state.${key}`)
}

async function productCall(context: CliCheckContext, id: string, argv: string[], checkId = id): Promise<unknown> {
  context.check(checkId)
  return context.call(id, argv, 'json')
}

async function productRefusal(context: CliCheckContext, id: string, argv: string[], checkId: string): Promise<{ code: string; message: string; data?: unknown }> {
  context.check(checkId)
  return context.refuse(id, argv)
}

function actorResult(receipt: CliActorReceipt, label = receipt.id): ObjectValue {
  equal(receipt.exitCode, 0, `${label} actor exit code`)
  return object(parseJson(receipt.stdout, `${label} actor result`), `${label} actor result`)
}

function actorReceipt(receipts: readonly CliActorReceipt[], id: string): CliActorReceipt {
  const matches = receipts.filter(receipt => receipt.id === id)
  equal(matches.length, 1, `actor receipt ${id} count`)
  return matches[0]!
}

function actorArgument(receipt: CliActorReceipt, flag: string): string {
  const index = receipt.argv.indexOf(flag)
  ensure(index >= 0 && typeof receipt.argv[index + 1] === 'string', `actor receipt ${receipt.id} omitted ${flag}`)
  return receipt.argv[index + 1]!
}

function coordinatorRun(receipt: CliActorReceipt, runId: string): ObjectValue {
  const result = actorResult(receipt, 'coordinator run result')
  const runs = listObjects(result.runs, 'coordinator run-list runs')
  const matches = runs.filter(run => run.objective === 'cli-parity-objective')
  equal(matches.length, 1, 'coordinator objective Run count')
  equal(matches[0]!.id, runId, 'coordinator selected Run ID')
  return matches[0]!
}

function terminalPanes(value: unknown, label: string): TerminalPane[] {
  const result = object(value, label)
  const workspace = isObject(result.workspace) ? result.workspace : result
  const panes: TerminalPane[] = []
  const visit = (current: unknown, tabId?: string): void => {
    if (Array.isArray(current)) {
      current.forEach(entry => visit(entry, tabId))
      return
    }
    if (!isObject(current)) return
    if (current.kind === 'pane') {
      if (tabId !== undefined && typeof current.session === 'string' && typeof current.id === 'string') {
        panes.push({ tabId, sessionId: current.session })
      }
      return
    }
    if (Array.isArray(current.tabs)) {
      for (const rawTab of current.tabs) {
        if (isObject(rawTab) && typeof rawTab.id === 'string' && rawTab.root !== undefined) visit(rawTab.root, rawTab.id)
        else visit(rawTab, tabId)
      }
    }
    if (current.root !== undefined) {
      const nestedTabId = typeof current.id === 'string' && tabId === undefined ? current.id : tabId
      visit(current.root, nestedTabId)
    }
    if (current.first !== undefined) visit(current.first, tabId)
    if (current.second !== undefined) visit(current.second, tabId)
  }
  visit(workspace.root)
  return panes
}

function tabIds(value: unknown, label: string): string[] {
  const found = new Set<string>()
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (!isObject(current)) return
    if (Array.isArray(current.tabs)) {
      for (const tab of current.tabs) {
        if (isObject(tab) && typeof tab.id === 'string') found.add(tab.id)
        visit(tab)
      }
    }
    for (const [key, child] of Object.entries(current)) if (key !== 'tabs') visit(child)
  }
  visit(value)
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return [...found]
}

function addedPane(panes: TerminalPane[], baseline: ReadonlySet<string>): TerminalPane {
  const added = panes.filter(pane => !baseline.has(pane.tabId))
  const tabIds = [...new Set(added.map(pane => pane.tabId))]
  equal(tabIds.length, 1, 'coordinator terminal new tab count')
  const matches = added.filter(pane => pane.tabId === tabIds[0])
  equal(matches.length, 1, 'coordinator terminal pane count')
  return matches[0]!
}

function phaseFixedIds(ids: readonly string[]): string[] {
  return ids.filter(id => !id.includes('poll'))
}

function assertPhaseReceipts(receipts: readonly CliActorReceipt[], expectedIds: readonly string[], label: string): void {
  const present = new Set(receipts.map(receipt => receipt.id))
  const missing = phaseFixedIds(expectedIds).filter(id => !present.has(id))
  if (missing.length > 0) throw new Error(`${label} omitted actor receipts: ${missing.join(', ')}`)
}

function readStore(store: CliActorReceiptStore): CliActorReceipt[] {
  try {
    return store.read()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('manifest is unavailable') || message.includes('ENOENT')) return []
    throw error
  }
}
function importAvailableActorReceipts(context: CliCheckContext, receipts: readonly CliActorReceipt[], imported: Set<string>): void {
  const current = receipts.filter(receipt => !imported.has(receipt.id))
  const successful = current.filter(receipt => receipt.exitCode === 0)
  if (successful.length > 0) context.importActor(successful)
  for (const receipt of current) {
    if (receipt.exitCode !== 0) context.importActorRefusal(receipt)
    imported.add(receipt.id)
  }
}

function availableWorkerReceipts(actorRoot: string): CliActorReceipt[] {
  const sessionsRoot = join(actorRoot, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const receipts: CliActorReceipt[] = []
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) receipts.push(...readStore(createActorReceiptStore(join(sessionsRoot, entry.name))))
  }
  return receipts
}

function actorReceiptCheckId(receiptId: string, fallback: string): string {
  if ((WORKER_CHECK_IDS as readonly string[]).includes(receiptId)) return receiptId
  if (/^workers-question-poll-\d+$/.test(receiptId)) return 'workers-ask'
  if (/^workers-complete-poll-\d+$/.test(receiptId)) return 'workers-done'
  switch (receiptId) {
    case 'workers-run-list':
      return 'workers-run-use'
    case 'workers-target':
    case 'workers-context-task':
      return 'workers-dispatch'
    case 'workers-request-absent':
      return 'workers-request-show'
    case 'workers-stop-repeat':
      return 'workers-stop'
    case 'workers-abandon-show':
    case 'workers-close-abandoned':
      return 'workers-abandon'
    case 'workers-release-repeat':
    case 'workers-release-abandoned':
    case 'workers-close-target':
      return 'workers-release'
    case 'workers-reset-messages-readback':
      return 'workers-reset-messages'
    case 'workers-reset-all-readback':
      return 'workers-reset-all'
    default:
      return fallback
  }
}

function phaseFailureReceiptId(
  receipts: readonly CliActorReceipt[], expectedIds: readonly string[], errorFile: string, fallback: string
): string {
  if (existsSync(errorFile)) {
    try {
      const failure = JSON.parse(readFileSync(errorFile, 'utf8')) as unknown
      if (isObject(failure) && typeof failure.failedReceipt === 'string') {
        return actorReceiptCheckId(failure.failedReceipt, fallback)
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  const failed = receipts.find(receipt => receipt.exitCode !== 0 && receipt.id !== 'workers-reply-mismatch')
  if (failed) return actorReceiptCheckId(failed.id, fallback)
  const present = new Set(receipts.map(receipt => receipt.id))
  const missing = phaseFixedIds(expectedIds).find(id => !present.has(id))
  return missing === undefined ? fallback : actorReceiptCheckId(missing, fallback)
}

function terminalText(value: unknown, label: string): string {
  const result = object(value, label)
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.lines) && result.lines.every(line => typeof line === 'string')) return result.lines.join('\n')
  if (typeof result.content === 'string') return result.content
  throw new Error(`${label} did not contain terminal text`)
}

function actorError(path: string, home: string, token: string): string | undefined {
  if (!existsSync(path)) return undefined
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    return `coordinator error file could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
  const redacted = content.replaceAll(home, '<cli-home>')
  return token.length === 0 ? redacted : redacted.replaceAll(token, '<redacted>')
}

async function waitForCoordinatorPhase(
  context: CliCheckContext,
  store: CliActorReceiptStore,
  expectedIds: readonly string[],
  sessionId: string,
  errorFile: string,
  marker: string,
  label: string,
  timeoutMs: number,
  checkId: string
): Promise<CliActorReceipt[]> {
  const deadline = Date.now() + timeoutMs
  const phaseId = label.replaceAll(' ', '-')
  let statusAt = 0
  let readAt = 0
  let attempt = 0
  while (Date.now() < deadline) {
    context.check(checkId)
    const actorFailure = actorError(errorFile, context.world.home, context.world.env.QUIRKY_SESSION_TOKEN ?? '')
    if (actorFailure !== undefined) throw new Error(`${label} failed: ${actorFailure}`)
    const receipts = readStore(store)
    const fixedIds = phaseFixedIds(expectedIds)
    const present = new Set(receipts.map(receipt => receipt.id))
    const ready = fixedIds.every(id => present.has(id))
    const now = Date.now()
    if (ready && now >= readAt) {
      const value = await productCall(context, `${checkId}-${phaseId}-terminal-${++attempt}`, ['terminal', 'read', sessionId, '--lines', '200'], checkId)
      if (terminalText(value, `${label} terminal read`).includes(marker)) {
        assertPhaseReceipts(receipts, expectedIds, label)
        if (label === 'coordinator phase 1') {
          ensure(receipts.some(receipt => /^workers-question-poll-\d+$/.test(receipt.id)), 'coordinator phase 1 omitted question polling receipts')
          ensure(receipts.some(receipt => /^workers-complete-poll-\d+$/.test(receipt.id)), 'coordinator phase 1 omitted completion polling receipts')
        }
        return receipts
      }
      readAt = now + 250
    }
    if (now >= statusAt) {
      const status = object(await productCall(context, `${checkId}-${phaseId}-session-${++attempt}`, ['session', 'get', sessionId], checkId), `${label} coordinator session`)
      if (status.status === 'exited') throw new Error(`${label} coordinator session exited before ${marker}`)
      statusAt = now + 1_000
    }
    await Bun.sleep(100)
  }
  const latest = readStore(store)
  const present = new Set(latest.map(receipt => receipt.id))
  const missing = phaseFixedIds(expectedIds).filter(id => !present.has(id))
  throw new Error(`Timed out waiting for ${label}${missing.length === 0 ? '' : `; missing receipts ${missing.join(', ')}`}`)
}

function importCoordinatorReceipts(
  context: CliCheckContext,
  receipts: readonly CliActorReceipt[],
  phaseIds: readonly string[],
  imported: Set<string>
): void {
  assertPhaseReceipts(receipts, phaseIds, 'coordinator phase 2')
  const expected = new Set(phaseFixedIds(phaseIds))
  importAvailableActorReceipts(context, receipts.filter(receipt => expected.has(receipt.id)), imported)
}



function requiredActorResult(receipts: readonly CliActorReceipt[], id: string): ObjectValue {
  return actorResult(actorReceipt(receipts, id))
}

function proveWorkerStart(context: CliCheckContext, id: string, start: ObjectValue): void {
  context.check(id)
  context.prove(id, {
    dispatchId: start.dispatchId,
    runId: start.runId,
    state: start.state,
    agent: object(object(start.launch, `${id} launch`).effective, `${id} launch.effective`).agent,
    mode: object(start.mode, `${id} mode`).mode
  })
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForWorkerReceipts(
  context: CliCheckContext,
  store: CliActorReceiptStore,
  requiredIds: readonly string[],
  checkId: string,
  timeoutMs: number
): Promise<CliActorReceipt[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    context.check(checkId)
    const receipts = readStore(store)
    const present = new Set(receipts.map(receipt => receipt.id))
    if (requiredIds.every(id => present.has(id))) return receipts
    await Bun.sleep(100)
  }
  const receipts = readStore(store)
  const present = new Set(receipts.map(receipt => receipt.id))
  const missing = requiredIds.filter(id => !present.has(id))
  throw new Error(`Timed out waiting for worker receipts: ${missing.join(', ')}`)
}

export async function runWorkerChecks(context: CliCheckContext): Promise<void> {
  const { world } = context
  const worktreeId = stateString(context, 'worktreeId')
  const actorSessionId = stateString(context, 'actorSessionId')
  const runId = stateString(context, 'actorRunId')
  const actorRoot = world.paths.workerActorRoot
  const coordinatorDirectory = join(actorRoot, 'coordinator')
  const coordinatorError = join(coordinatorDirectory, 'error.json')
  const coordinatorStore = createActorReceiptStore(coordinatorDirectory)
  const importedCoordinatorIds = new Set<string>()

  const baselineLayout = await productCall(context, 'workers-terminal-layout-before', ['terminal', 'layout', '--worktree', worktreeId], 'workers-run-use')
  const baselineTabs = tabIds(baselineLayout, 'terminal layout before coordinator')
  context.state.workersTerminalBaseline = baselineTabs
  context.state.workersTerminalCreationStarted = true
  const creation = await productCall(context, 'workers-coordinator-tab-create', [
    'terminal', 'tab', 'new', '--worktree', worktreeId, '--agent', 'shell', '--command', world.paths.coordinatorCommand,
    '--title', 'cli-parity-coordinator'
  ], 'workers-run-use')
  const createdLayout = await productCall(context, 'workers-coordinator-tab-layout', ['terminal', 'layout', '--worktree', worktreeId], 'workers-run-use')
  const coordinatorPane = addedPane(terminalPanes(createdLayout, 'coordinator terminal layout'), new Set(baselineTabs))
  ensure(terminalPanes(creation, 'coordinator terminal creation').some(pane => pane.sessionId === coordinatorPane.sessionId), 'coordinator tab creation did not return its session')
  const coordinatorSessionId = coordinatorPane.sessionId
  context.state.workersCoordinatorTabId = coordinatorPane.tabId
  context.state.workersCoordinatorSessionId = coordinatorSessionId

  let coordinatorReceipts: CliActorReceipt[]
  try {
    coordinatorReceipts = await waitForCoordinatorPhase(
      context, coordinatorStore, COORDINATOR_PHASE_ONE_IDS, coordinatorSessionId, coordinatorError,
      'CLI-COORDINATOR-PHASE-1', 'coordinator phase 1', 150_000, 'workers-run-use'
    )
  } catch (error) {
    const partialReceipts = readStore(coordinatorStore)
    importAvailableActorReceipts(context, partialReceipts, importedCoordinatorIds)
    importAvailableActorReceipts(context, availableWorkerReceipts(actorRoot), new Set())
    context.check(phaseFailureReceiptId(partialReceipts, COORDINATOR_PHASE_ONE_IDS, coordinatorError, 'workers-run-use'))
    throw error
  }
  context.check('workers-run-use')
  importAvailableActorReceipts(context, coordinatorReceipts, importedCoordinatorIds)
  const coordinatorRunList = actorReceipt(coordinatorReceipts, 'workers-run-list')
  coordinatorRun(coordinatorRunList, runId)
  const targetReceipt = actorReceipt(coordinatorReceipts, 'workers-target')
  const targetResult = actorResult(targetReceipt, 'coordinator target session')
  const target = object(targetResult.session ?? targetResult, 'coordinator target session result')
  const targetSessionId = nonEmptyText(target.id, 'coordinator target session ID')
  equal(target.worktreeId, worktreeId, 'coordinator target worktree')
  const taskReceipt = actorReceipt(coordinatorReceipts, 'workers-context-task')
  const taskResult = actorResult(taskReceipt, 'context Task create')
  const contextTask = object(taskResult.task ?? taskResult, 'context Task create result')
  const contextTaskId = nonEmptyText(contextTask.id, 'context Task ID')
  const contextDispatchReceipt = actorReceipt(coordinatorReceipts, 'workers-dispatch')
  const contextDispatchId = nonEmptyText(object(actorResult(contextDispatchReceipt, 'context Dispatch create').dispatch, 'context Dispatch result.dispatch').id, 'context Dispatch ID')
  const startComplete = requiredActorResult(coordinatorReceipts, 'workers-start-complete')
  const startStop = requiredActorResult(coordinatorReceipts, 'workers-start-stop')
  const startAbandon = requiredActorResult(coordinatorReceipts, 'workers-start-abandon')
  const dispatchIds = assertWorkerStartEvidence([startComplete, startStop, startAbandon], runId, readFileSync(world.paths.claudeWorkerLog, 'utf8'))
  const [completeDispatchId, stopDispatchId, abandonDispatchId] = dispatchIds as [string, string, string]
  const taskWorkerId = nonEmptyText(startComplete.taskId, 'completion worker Task ID')
  const controllerShowComplete = object(await productCall(context, 'workers-show', ['orchestration', 'worker-show', '--dispatch', completeDispatchId], 'workers-show'), 'completed controller worker-show')
  const completionSessionId = nonEmptyText(object(controllerShowComplete.worker, 'completed controller worker-show worker').sessionId, 'completed worker session ID')
  const questionWorkerStore = createActorReceiptStore(join(actorRoot, 'sessions', completionSessionId))
  let questionWorkerReceipts: CliActorReceipt[]
  try {
    questionWorkerReceipts = await waitForWorkerReceipts(context, questionWorkerStore, ['workers-ask', 'workers-done'], 'workers-show', 20_000)
  } catch (error) {
    const partialReceipts = readStore(questionWorkerStore)
    importAvailableActorReceipts(context, partialReceipts, new Set())
    context.check(phaseFailureReceiptId(partialReceipts, ['workers-ask', 'workers-done'], '', 'workers-ask'))
    throw error
  }
  importAvailableActorReceipts(context, questionWorkerReceipts, new Set())

  const askReceipt = actorReceipt(questionWorkerReceipts, 'workers-ask')
  const askResult = actorResult(askReceipt, 'worker ask')
  const messageId = nonEmptyText(askResult.messageId, 'worker question message ID')
  const replyReceipt = actorReceipt(coordinatorReceipts, 'workers-reply')
  const replayReceipt = actorReceipt(coordinatorReceipts, 'workers-reply-replay')
  const mismatchReceipt = actorReceipt(coordinatorReceipts, 'workers-reply-mismatch')
  const requestId = actorArgument(replyReceipt, '--retry-request')
  const absentRequestId = actorArgument(actorReceipt(coordinatorReceipts, 'workers-request-absent'), '--request')
  const requestResult = requiredActorResult(coordinatorReceipts, 'workers-request-show')
  const absentRequest = requiredActorResult(coordinatorReceipts, 'workers-request-absent')
  const refusalEnvelope = object(parseJson(mismatchReceipt.stdout, 'reply mismatch refusal'), 'reply mismatch refusal')
  const refusalError = object(refusalEnvelope.error, 'reply mismatch error')
  const mismatch = {
    code: stringField(refusalError, 'code', 'reply mismatch error'),
    message: stringField(refusalError, 'message', 'reply mismatch error')
  }
  const requestReadback = await productCall(context, 'workers-request-show-readback', ['orchestration', 'request-show', '--request', requestId], 'workers-request-show')
  const askAndReply = assertQuestionReplyEvidence({
    messageId, requestId, absentRequestId,
    ask: askResult, reply: actorResult(replyReceipt, 'coordinator reply'), replay: actorResult(replayReceipt, 'coordinator reply replay'),
    mismatch, request: requestResult, absent: absentRequest, readback: requestReadback
  })

  const priorActorReceipts = readActorReceipts(world.home)
  const priorRunShow = actorResult(actorReceipt(priorActorReceipts, 'actor-run-show'), 'original actor run-show')
  const priorRun = object(priorRunShow.run, 'original actor run-show result.run')
  equal(priorRun.id, runId, 'original actor Run ID')
  equal(priorRun.coordinatorSessionId, actorSessionId, 'original actor Run coordinator')
  const beforeGeneration = priorRun.consumerGeneration
  ensure(typeof beforeGeneration === 'number' && Number.isInteger(beforeGeneration), 'original actor consumer generation must be an integer')
  const runUseReceipt = actorReceipt(coordinatorReceipts, 'workers-run-use')
  const runUseResult = actorResult(runUseReceipt, 'coordinator run-use')
  const runUseRun = object(runUseResult.run, 'coordinator run-use result.run')
  const unauthorizedRunUse = await productRefusal(context, 'workers-run-use-controller', ['orchestration', 'run-use', '--id', runId], 'workers-run-use')
  const runUseEvidence = assertRunUseEvidence({
    runId, coordinatorSessionId, beforeGeneration, run: runUseRun, controllerRefusal: unauthorizedRunUse
  })

  context.check('workers-run-use')
  context.prove('workers-run-use', runUseEvidence)
  const dryRun = actorResult(actorReceipt(coordinatorReceipts, 'workers-dispatch-dry-run'), 'dispatch dry-run')
  const dispatchResult = actorResult(contextDispatchReceipt, 'context Dispatch create')
  const dispatchShow = actorResult(actorReceipt(coordinatorReceipts, 'workers-dispatch-show'), 'context dispatch-show')
  const readback = await productCall(context, 'workers-dispatch-show-readback', ['orchestration', 'dispatch-show', '--task', contextTaskId], 'workers-dispatch-show')
  const dispatchEvidence = assertDispatchEvidence({ taskId: contextTaskId, dryRun, dispatch: dispatchResult, dispatchShow, readback })
  context.check('workers-dispatch-dry-run')
  context.check('workers-dispatch')
  context.prove('workers-dispatch-dry-run', { dryRun: true, dispatch: null, preambleContainsTask: true })
  context.prove('workers-dispatch', { dispatchId: dispatchEvidence.dispatchId, taskId: dispatchEvidence.taskId, assigneeSessionId: dispatchEvidence.assigneeSessionId, status: 'dispatched' })
  context.prove('workers-dispatch-show', { dispatchId: dispatchEvidence.dispatchId, worker: null, preamble: true, readback: true })

  proveWorkerStart(context, 'workers-start-complete', startComplete)
  proveWorkerStart(context, 'workers-start-stop', startStop)
  context.check('workers-start-abandon')
  context.prove('workers-start-abandon', { ...startEvidence(startAbandon), workerLog: readFileSync(world.paths.claudeWorkerLog, 'utf8') })

  const doneReceipt = actorReceipt(questionWorkerReceipts, 'workers-done')
  assertWorkerCompletion({ receipt: doneReceipt, show: controllerShowComplete, dispatchId: completeDispatchId })
  context.check('workers-ask')
  context.check('workers-reply')
  context.check('workers-reply-replay')
  context.check('workers-request-show')
  context.check('workers-done')
  context.prove('workers-show', { dispatchId: completeDispatchId, workerState: 'succeeded', dispatchStatus: 'completed' })
  context.prove('workers-ask', { state: 'answered', answer: 'cli-parity-answer', messageId })
  context.prove('workers-reply', { kind: 'question_answer', messageId, duplicate: false, replayed: false })
  context.prove('workers-reply-replay', askAndReply)
  context.prove('workers-request-show', { requestId, state: 'completed', absentRequestId, absentState: 'absent', controllerReadback: 'completed' })
  context.prove('workers-done', { dispatchId: completeDispatchId, exitCode: doneReceipt.exitCode, workerState: 'succeeded', dispatchStatus: 'completed' })

  const stopReceipt = actorReceipt(coordinatorReceipts, 'workers-stop')
  const stopRepeat = actorReceipt(coordinatorReceipts, 'workers-stop-repeat')
  const stopResult = actorResult(stopReceipt, 'worker-stop')
  const stopRepeatResult = actorResult(stopRepeat, 'worker-stop repeat')
  const stoppedShow = await productCall(context, 'workers-show-stopped', ['orchestration', 'worker-show', '--dispatch', stopDispatchId], 'workers-stop')
  const stopSessions = await productCall(context, 'workers-stop-pty', ['terminal', 'sessions'], 'workers-stop')
  const unauthorizedStop = await productRefusal(context, 'workers-unauthorized-stop', ['orchestration', 'worker-stop', '--dispatch', abandonDispatchId], 'workers-stop')
  const stopSessionId = nonEmptyText(object(stoppedShow.worker, 'stopped worker-show worker').sessionId, 'stopped worker session ID')
  const stopEvidence = assertWorkerStopEvidence({
    sessionId: stopSessionId, stop: stopResult, repeat: stopRepeatResult, show: stoppedShow,
    terminalSessions: stopSessions, unauthorized: unauthorizedStop
  })
  context.prove('workers-stop', stopEvidence)

  const retainResult = actorResult(actorReceipt(coordinatorReceipts, 'workers-retain'), 'worker-retain')
  assertWorkerRetain(retainResult)
  context.check('workers-retain')
  context.prove('workers-retain', { state: 'retained', processAction: 'none' })

  const abandonedShowReceipt = actorReceipt(coordinatorReceipts, 'workers-abandon-show')
  const abandonedShow = actorResult(abandonedShowReceipt, 'coordinator abandoned worker-show')
  const controllerShowAbandoned = await productCall(context, 'workers-show-abandoned', ['orchestration', 'worker-show', '--dispatch', abandonDispatchId], 'workers-abandon')
  const abandonedTerminal = object(abandonedShow.terminal, 'coordinator abandoned worker-show terminal')
  const abandonSessionId = nonEmptyText(abandonedTerminal.id, 'abandoned worker session ID')
  const abandonSessions = await productCall(context, 'workers-abandon-pty', ['terminal', 'sessions'], 'workers-abandon')
  const abandonSession = terminalSessions(abandonSessions, 'abandoned worker sessions').find(session => session.sessionId === abandonSessionId)
  ensure(abandonSession !== undefined && typeof abandonSession.pid === 'number', 'abandoned worker terminal PID was not returned')
  const abandonPidAlive = pidIsAlive(abandonSession.pid as number)
  const abandonReceipt = actorReceipt(coordinatorReceipts, 'workers-abandon')

  const liveRead = await productCall(context, 'workers-read-live', ['orchestration', 'worker-read', '--dispatch', completeDispatchId, '--source', 'terminal'], 'workers-read-live')
  assertWorkerReadLive(liveRead, completeDispatchId)
  context.prove('workers-read-live', { dispatchId: completeDispatchId, source: 'terminal', archived: false, completionMarker: true })

  const listResult = await productCall(context, 'workers-list', ['orchestration', 'worker-list', '--run', runId], 'workers-list')
  const listEvidence = assertWorkerListEvidence({
    list: listResult, runId, worktreeId,
    dispatchIds: [completeDispatchId, stopDispatchId, abandonDispatchId], contextDispatchId
  })
  context.prove('workers-list', listEvidence)

  const dashboard = await productCall(context, 'workers-ps-dashboard', ['agent-status', 'dashboard', '--show-idle'], 'workers-ps-dashboard')
  assertWorktreeDashboardEvidence({ dashboard, worktreeId, sessionIds: [completionSessionId, abandonSessionId] })
  context.prove('workers-ps-dashboard', { worktreeId, sessionIds: [completionSessionId, abandonSessionId] })

  const runList = await productCall(context, 'workers-ps-runs', ['orchestration', 'run-list'], 'workers-ps-runs')
  assertWorktreeRunEvidence({ runList, runId, coordinatorSessionId })
  context.prove('workers-ps-runs', { runId, coordinatorSessionId })

  const taskList = await productCall(context, 'workers-ps-tasks', ['orchestration', 'task-list', '--run', runId], 'workers-ps-tasks')
  const correlation = assertWorktreeTaskEvidence({
    taskList, workers: listResult, dashboard, runId, worktreeId,
    taskId: contextTaskId, dispatchId: contextDispatchId, assigneeSessionId: targetSessionId,
    workerTaskId: taskWorkerId, workerDispatchId: completeDispatchId
  })
  context.prove('workers-ps-tasks', correlation)

  const messagesRefusal = await productRefusal(context, 'workers-unauthorized-reset', ['orchestration', 'reset', '--messages', '--yes'], 'workers-reset-messages')
  const releaseTrigger = await productCall(context, 'workers-release-trigger', ['terminal', 'send', coordinatorSessionId, 'cli-parity-release', '--enter'], 'workers-ps-tasks')
  object(releaseTrigger, 'coordinator phase release trigger')

  let phaseTwoReceipts: CliActorReceipt[]
  try {
    phaseTwoReceipts = await waitForCoordinatorPhase(
      context, coordinatorStore, COORDINATOR_PHASE_TWO_IDS, coordinatorSessionId, coordinatorError,
      'CLI-COORDINATOR-DONE', 'coordinator phase 2', 60_000, 'workers-release'
    )
  } catch (error) {
    const partialReceipts = readStore(coordinatorStore)
    importAvailableActorReceipts(context, partialReceipts, importedCoordinatorIds)
    context.check(phaseFailureReceiptId(partialReceipts, COORDINATOR_PHASE_TWO_IDS, coordinatorError, 'workers-release'))
    throw error
  }
  importCoordinatorReceipts(context, phaseTwoReceipts, COORDINATOR_PHASE_TWO_IDS, importedCoordinatorIds)

  const releaseResult = requiredActorResult(phaseTwoReceipts, 'workers-release')
  const releaseRepeat = requiredActorResult(phaseTwoReceipts, 'workers-release-repeat')
  const releaseAbandoned = requiredActorResult(phaseTwoReceipts, 'workers-release-abandoned')
  const archivedRead = requiredActorResult(phaseTwoReceipts, 'workers-read-archived')
  assertWorkerReadArchived(archivedRead, completeDispatchId)
  const releaseSessions = await productCall(context, 'workers-release-pty', ['terminal', 'sessions'], 'workers-release')
  const releaseEvidence = assertWorkerReleaseEvidence({
    dispatchId: completeDispatchId, sessionId: completionSessionId, release: releaseResult,
    repeat: releaseRepeat, releaseAbandoned, terminalSessions: releaseSessions
  })
  context.check('workers-release')
  context.check('workers-read-archived')
  context.prove('workers-release', releaseEvidence)
  context.prove('workers-read-archived', { dispatchId: completeDispatchId, archived: true, completionMarker: true })

  const closeAbandonedReceipt = actorReceipt(phaseTwoReceipts, 'workers-close-abandoned')
  equal(closeAbandonedReceipt.exitCode, 0, 'coordinator abandoned session close exit code')
  const abandonEvidence = assertWorkerAbandonEvidence({
    sessionId: abandonSessionId, abandon: actorResult(abandonReceipt, 'worker-abandon'),
    coordinatorShow: abandonedShow, controllerShow: controllerShowAbandoned, terminalSessions: abandonSessions,
    pidAlive: abandonPidAlive, closedByCoordinator: true
  })
  context.check('workers-abandon')
  context.prove('workers-abandon', abandonEvidence)

  const messagesReset = requiredActorResult(phaseTwoReceipts, 'workers-reset-messages')
  const resetInbox = requiredActorResult(phaseTwoReceipts, 'workers-reset-messages-readback')
  const allReset = requiredActorResult(phaseTwoReceipts, 'workers-reset-all')
  const resetRunList = requiredActorResult(phaseTwoReceipts, 'workers-reset-all-readback')
  context.check('workers-reset-messages')
  context.check('workers-reset-all')
  assertResetEvidence({
    runId, messagesReset, inbox: resetInbox, allReset, runList: resetRunList,
    messagesRefusal, allRefusal: messagesRefusal
  })
  context.prove('workers-reset-messages', { mode: 'messages', replayed: false, messagesAfterReset: 0, controllerRefusal: 'consumer_fenced' })
  context.prove('workers-reset-all', { mode: 'all', runAbsent: true, controllerRefusal: 'consumer_fenced' })

  const coordinatorTabId = stateString(context, 'workersCoordinatorTabId')
  await productCall(context, 'workers-coordinator-tab-close', ['terminal', 'tab', 'close', coordinatorTabId, '--yes'], 'workers-ps-tasks')
  const finalLayout = await productCall(context, 'workers-terminal-layout-after', ['terminal', 'layout', '--worktree', worktreeId], 'workers-ps-tasks')
  const finalTabs = tabIds(finalLayout, 'terminal layout after workers')
  equal([...finalTabs].sort(), [...baselineTabs].sort(), 'terminal tabs after worker checks')
  context.state.workersCleanupVerified = true
}

function startEvidence(start: ObjectValue): Record<string, unknown> {
  return {
    dispatchId: start.dispatchId,
    runId: start.runId,
    state: start.state,
    agent: object(object(start.launch, 'worker-start launch').effective, 'worker-start launch.effective').agent,
    mode: object(start.mode, 'worker-start mode').mode
  }
}


export async function cleanupWorkerChecks(
  context: Pick<CliCheckContext, 'state'>,
  attempt: (argv: string[]) => Promise<unknown | undefined>,
  errors: string[]
): Promise<void> {
  const state = context.state
  if (state.workersCleanupVerified === true) return
  const baselineValue = state.workersTerminalBaseline
  const worktreeId = state.worktreeId
  if (!Array.isArray(baselineValue) || !baselineValue.every((value): value is string => typeof value === 'string') ||
      typeof worktreeId !== 'string' || worktreeId.length === 0) {
    if (state.workersTerminalCreationStarted === true) errors.push('worker terminal cleanup lacks a valid baseline')
    return
  }
  let layout: unknown | undefined
  try {
    layout = await attempt(['terminal', 'layout', '--worktree', worktreeId])
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return
  }
  if (layout === undefined) return
  let openTabs: string[]
  try {
    openTabs = tabIds(layout, 'worker cleanup terminal layout')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return
  }
  const baseline = new Set(baselineValue)
  for (const tabId of openTabs) {
    if (baseline.has(tabId)) continue
    try {
      await attempt(['terminal', 'tab', 'close', tabId, '--yes'])
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
}
