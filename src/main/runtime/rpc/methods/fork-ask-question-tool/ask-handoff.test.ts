import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskEnvelope } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { OrchestrationDb } from '../../../orchestration/db'
import { createAskRpcHarness, type AskRpcHarness } from './ask-rpc-test-harness'

const WORKER_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COORDINATOR_PANE_KEY = 'tab_coord:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function textSpec() {
  return { questions: [{ id: 'q1', type: 'text', question: 'What is your name?' }] }
}

function seedActiveDispatch(
  orchestrationDb: OrchestrationDb,
  assigneeHandle: string,
  assigneePaneKey: string
) {
  const run = orchestrationDb.createRun({
    objective: 'test run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = orchestrationDb.createTask({ spec: 'help the human', runId: run.id })
  const dispatch = orchestrationDb.createDispatchContext({
    taskId: task.id,
    assigneeHandle,
    assigneePaneKey,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  return { run, dispatch }
}

// Why: worktree scoping (F5) reads worker_dispatches.worktree_id, which only the full
// worker-start flow populates — createDispatchContext alone never writes a worker_dispatches row.
function seedActiveWorkerDispatch(
  orchestrationDb: OrchestrationDb,
  worktreeId: string,
  assigneeHandle: string,
  assigneePaneKey: string
) {
  const run = orchestrationDb.createRun({
    objective: 'test run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = orchestrationDb.createTask({ spec: 'help the human', runId: run.id })
  const started = orchestrationDb.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  orchestrationDb.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: assigneeHandle,
    paneKey: assigneePaneKey,
    processIncarnation: `runtime:pty:${assigneeHandle}`,
    worktreeId,
    setupState: 'not_applicable',
    effects: []
  })
  return { run, dispatch: started.dispatch }
}

// Why: the no-UI path only hands off when neither the local renderer nor a roster connection can
// render the ask (tech.md C4) — every test here registers a pane no surface claims.
async function registerHandoff(h: AskRpcHarness, requestId = 'req_h1') {
  h.setPaneOwner(WORKER_PANE_KEY, 'term_worker')
  return h.call('ask.register', {
    spec: textSpec(),
    requestId,
    paneKey: WORKER_PANE_KEY,
    cwd: '/repo'
  }) as Promise<{ askId: string }>
}

describe('ask.* coordinator hand-off (C7)', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness

  beforeEach(() => {
    h = harness.setup()
  })
  afterEach(() => harness.cleanup())

  it('registers as origin handoff without blocking when no UI can render it but a run is active', async () => {
    const { dispatch } = seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    const row = h.askDb.getAsk(askId)
    expect(row?.origin).toBe('handoff')
    expect(row?.status).toBe('registered')
    expect(row?.handoff_dispatch_id).toBe(dispatch.id)
    expect(row?.handoff_question_id).toBeNull()
  })

  it('with no active run and no UI, register resolves unavailable immediately with no row', async () => {
    const result = (await registerHandoff(h)) as unknown as { status?: string; askId?: string }
    expect(result.status).toBe('unavailable')
    expect(result.askId).toBeUndefined()
  })

  it('the first waitChunk creates the orchestration question and the coordinator reply resolves the ask', async () => {
    const { dispatch } = seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)

    const waitPromise = h.call('ask.wait', { askId, chunkMs: 5000 })
    const questionId = h.askDb.getAsk(askId)?.handoff_question_id
    expect(questionId).toBeTruthy()

    const question = h.orchestrationDb.getQuestion(questionId as string)
    expect(question?.dispatch_id).toBe(dispatch.id)

    const run = h.orchestrationDb.getRun(dispatch.run_id)
    h.orchestrationDb.answerQuestion({
      messageId: questionId as string,
      runId: dispatch.run_id,
      consumerGeneration: run?.consumer_generation as number,
      body: 'q1: Ada'
    })
    h.runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, 'status')

    const envelope = (await waitPromise) as AskEnvelope
    expect(envelope).toMatchObject({
      status: 'answered',
      askId,
      answers: { q1: { value: 'Ada', source: 'input' } }
    })
  })

  it('a reply with no parseable line at all falls back to the first question, per its own type rules', async () => {
    seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    const waitPromise = h.call('ask.wait', { askId, chunkMs: 5000 })
    const row = h.askDb.getAsk(askId)
    const questionId = row?.handoff_question_id as string
    const run = h.orchestrationDb.getRun(row?.handoff_run_id as string)

    h.orchestrationDb.answerQuestion({
      messageId: questionId,
      runId: row?.handoff_run_id as string,
      consumerGeneration: run?.consumer_generation as number,
      body: 'Ada Lovelace, no colon here'
    })
    h.runtime.notifyMessageArrived(`dispatch:${row?.handoff_dispatch_id}`, 'status')

    const envelope = (await waitPromise) as AskEnvelope
    expect(envelope).toMatchObject({
      status: 'answered',
      askId,
      answers: { q1: { value: 'Ada Lovelace, no colon here', source: 'input' } }
    })
  })

  it('createQuestion throwing dispatch_inactive resolves the ask unavailable naming that reason, never retried', async () => {
    const { dispatch } = seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    h.orchestrationDb.completeDispatch(dispatch.id)

    const createQuestionSpy = vi.spyOn(h.orchestrationDb, 'createQuestion')
    const first = (await h.call('ask.wait', { askId, chunkMs: 1000 })) as AskEnvelope
    expect(first.status).toBe('unavailable')
    expect(createQuestionSpy).toHaveBeenCalledTimes(1)

    const second = (await h.call('ask.wait', { askId, chunkMs: 1000 })) as AskEnvelope
    expect(second.status).toBe('unavailable')
    expect(createQuestionSpy).toHaveBeenCalledTimes(1)
  })

  it('cancel resolves a pending hand-off ask declined', async () => {
    seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    const cancelled = (await h.call('ask.cancel', { askId })) as AskEnvelope
    expect(cancelled).toMatchObject({ status: 'declined', askId })
    expect(h.askDb.getAsk(askId)?.status).toBe('declined')
  })

  it('cancelling a hand-off ask closes its orchestration question so the coordinator stops seeing it', async () => {
    seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    const waitPromise = h.call('ask.wait', { askId, chunkMs: 5000 })
    const questionId = h.askDb.getAsk(askId)?.handoff_question_id ?? ''
    expect(h.orchestrationDb.getQuestion(questionId)?.status).toBe('pending')

    await h.call('ask.cancel', { askId })
    await waitPromise

    expect(h.orchestrationDb.getQuestion(questionId)?.status).toBe('closed')
  })

  it('the hand-off question is created exactly once across a simulated restart', async () => {
    const { dispatch } = seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)

    const createQuestionSpy = vi.spyOn(h.orchestrationDb, 'createQuestion')
    const firstChunk = (await h.call('ask.wait', { askId, chunkMs: 10 })) as AskEnvelope
    expect(firstChunk.status).toBe('pending')
    expect(createQuestionSpy).toHaveBeenCalledTimes(1)
    const questionIdAfterFirstChunk = h.askDb.getAsk(askId)?.handoff_question_id
    expect(questionIdAfterFirstChunk).toBeTruthy()

    // Why: a restart rebuilds the runtime and AskRegistry from durable state; only
    // handoff_question_id (persisted) — not any in-memory cache — may prevent a second create.
    // restarted.orchestrationDb is the same underlying instance, so the original spy (still
    // attached) is reused rather than re-spying, which vi.spyOn would hand back unchanged anyway.
    const restarted = h.simulateRestart()
    const resumedChunk = (await restarted.call('ask.wait', { askId, chunkMs: 10 })) as AskEnvelope
    expect(resumedChunk.status).toBe('pending')
    expect(createQuestionSpy).toHaveBeenCalledTimes(1)
    expect(h.askDb.getAsk(askId)?.handoff_question_id).toBe(questionIdAfterFirstChunk)

    const run = restarted.orchestrationDb.getRun(dispatch.run_id)
    restarted.orchestrationDb.answerQuestion({
      messageId: questionIdAfterFirstChunk as string,
      runId: dispatch.run_id,
      consumerGeneration: run?.consumer_generation as number,
      body: 'q1: Grace'
    })
    restarted.runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, 'status')
    const finalChunk = (await restarted.call('ask.wait', { askId, chunkMs: 5000 })) as AskEnvelope
    expect(finalChunk).toMatchObject({ status: 'answered', askId })
  })

  it('F2: a direct answer while a hand-off wait is parked wakes it with the terminal envelope', async () => {
    seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    // Creates the coordinator question and parks past it, so the loop below is polling for a reply.
    const primed = (await h.call('ask.wait', { askId, chunkMs: 10 })) as AskEnvelope
    expect(primed.status).toBe('pending')

    const waitPromise = h.call('ask.wait', { askId, chunkMs: 5000 })
    const startedAt = Date.now()
    // Bypasses the coordinator entirely — commits straight to askDb, never touching the question.
    const answered = (await h.call('ask.answer', {
      askId,
      answers: { q1: { value: 'Ada', source: 'input' } }
    })) as { committed: boolean }
    expect(answered.committed).toBe(true)

    const envelope = (await waitPromise) as AskEnvelope
    // Generous bound: proves the wait woke on the answer's notify rather than sitting out chunkMs.
    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(envelope).toMatchObject({ status: 'answered', askId })
  })

  it('F3: a crash between createQuestion and setHandoffQuestionId is recovered by adopting the existing question', async () => {
    seedActiveDispatch(h.orchestrationDb, 'term_worker', WORKER_PANE_KEY)
    const { askId } = await registerHandoff(h)
    const row = h.askDb.getAsk(askId)

    // Simulates the crash window: the coordinator question exists, but the process died before
    // the second write persisted its id back onto the ask row.
    const created = h.orchestrationDb.createQuestion({
      runId: row?.handoff_run_id as string,
      dispatchId: row?.handoff_dispatch_id as string,
      askerHandle: row?.handoff_asker as string,
      question: 'a question from the crash window'
    })
    expect(h.askDb.getAsk(askId)?.handoff_question_id).toBeNull()

    const createQuestionSpy = vi.spyOn(h.orchestrationDb, 'createQuestion')
    const chunk = (await h.call('ask.wait', { askId, chunkMs: 10 })) as AskEnvelope
    expect(chunk.status).toBe('pending')
    expect(createQuestionSpy).not.toHaveBeenCalled()
    expect(h.askDb.getAsk(askId)?.handoff_question_id).toBe(created.question.message_id)
  })

  it('F5: a workspace-scoped hand-off reaches the dispatch for that workspace and not another', async () => {
    const other = seedActiveWorkerDispatch(
      h.orchestrationDb,
      'wt_other',
      'term_other',
      'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    const target = seedActiveWorkerDispatch(
      h.orchestrationDb,
      'wt_target',
      'term_target',
      'tab_target:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    )
    h.setKnownWorktree('wt_target')

    const result = (await h.call('ask.register', {
      spec: textSpec(),
      requestId: 'req_f5',
      worktreeId: 'wt_target',
      cwd: '/repo'
    })) as { askId?: string; status?: string }

    expect(result.status).toBeUndefined()
    const row = h.askDb.getAsk(result.askId as string)
    expect(row?.handoff_dispatch_id).toBe(target.dispatch.id)
    expect(row?.handoff_dispatch_id).not.toBe(other.dispatch.id)
  })
})
