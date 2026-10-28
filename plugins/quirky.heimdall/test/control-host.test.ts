import { describe, expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import type { Enrollment, KernelStore } from '../src/contracts'
import { createControlHost, type OperatorKernel } from '../src/control-host'
import type { ServiceRunDetail } from '../../quirky.orchestration/src/services/contracts'

function fixture() {
  const enrollment: Enrollment = {
    watcherId: 'watcher', kind: 'objective', workspaceKey: 'local::/isolated', workspacePath: '/isolated',
    executionHostId: 'local', schedulerOwner: 'local', kindPayload: {}, enabled: true, paused: false, commandRevision: 0,
    capabilities: {}, budget: { wallClockActiveMs: null, turns: null }, coordinator: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: 'run_owned', createdAtMs: 0, terminalAtMs: null, parkReason: 'worker-question', haltReason: null
  }
  const view: ServiceRunDetail = {
    run: { id: 'run_owned', objective: 'Fixture worker', coordinatorSessionId: null, coordinatorHistory: [], consumerGeneration: 1,
      createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', serviceOwner: { pluginId: 'quirky.heimdall', key: 'watcher' } },
    workers: [{ taskId: 'task_dispatch', dispatchId: 'ctx_dispatch', sessionId: 'session', processIncarnation: 'incarnation', state: 'live', assignmentActive: true, lastContactAtMs: 0 }],
    questions: [{ messageId: 'msg_question', runId: 'run_owned', dispatchId: 'ctx_dispatch', askerSessionId: 'session', status: 'pending',
      answerMessageId: null, answerBody: null, answeredByGeneration: null, createdAt: '2026-10-27T00:00:00.000Z', answeredAt: null, closedAt: null, body: 'Continue?' }]
  }
  let serviceResponse: unknown = view
  let wrongReplyIdentity = false
  const call: PluginContext['call'] = async (method, params = {}) => {
    if (method === 'quirky.orchestration/serviceRunShow') return structuredClone(serviceResponse)
    if (method === 'quirky.orchestration/serviceReply') {
      view.questions[0]!.status = 'answered'
      view.questions[0]!.answerBody = String(params.body)
      return { kind: 'question_answer', messageId: wrongReplyIdentity ? 'msg_another' : 'msg_question', answerMessageId: 'msg_answer', threadId: 'thread', duplicate: false,
        mutation: { requestId: params.requestId, replayed: false } }
    }
    if (method === 'quirky.orchestration/serviceWorkerStop') {
      view.workers[0]!.state = 'exited'
      view.workers[0]!.assignmentActive = false
      return { dispatchId: 'ctx_dispatch', state: 'stopped', processAction: 'closed_agent_terminal', mutation: { requestId: params.requestId, replayed: false } }
    }
    throw new Error(`Unexpected owner operation ${method}`)
  }
  // Only the public call boundary is exercised; unrelated context/store ports must not be used.
  const context = { call } as PluginContext
  const unused = () => { throw new Error('Unexpected kernel mutation in owner adapter') }
  const kernel: OperatorKernel = { store: {} as KernelStore, inspect: unused, runner: unused, changed: unused, reconcile: unused, forgetRunner: unused }
  return {
    host: createControlHost(context, kernel),
    enrollment,
    view,
    mismatchReply() { wrongReplyIdentity = true },
    serviceResponse(value: unknown) { serviceResponse = value }
  }
}

describe('owner service response certainty', () => {
  test('accepts full public run/question rows and a receipt-backed exact answer', async () => {
    const t = fixture()
    expect(await t.host.answerQuestion(t.enrollment, 'msg_question', 'Proceed')).toMatchObject({ kind: 'applied' })
    expect(t.view.questions[0]).toMatchObject({ status: 'answered', answerBody: 'Proceed' })
    expect(await t.host.answerQuestion(t.enrollment, 'msg_question', 'Again')).toMatchObject({ kind: 'refused', reason: 'question-already-answered' })
  })

  test('accepts a full exact-worker stop receipt without classifying the confirmed effect as unknown', async () => {
    const t = fixture()
    expect(await t.host.stopWorker(t.enrollment, { dispatchId: 'ctx_dispatch', sessionId: 'session', processIncarnation: 'incarnation' })).toMatchObject({ kind: 'applied' })
    expect(t.view.workers[0]!.state).toBe('exited')
  })

  test('a reply for another question never confirms this answer even after the remote mutation', async () => {
    const t = fixture()
    t.mismatchReply()
    expect(await t.host.answerQuestion(t.enrollment, 'msg_question', 'Proceed')).toMatchObject({ kind: 'indeterminate' })
    expect(t.view.questions[0]!.status).toBe('answered')
  })
  test('rejects missing and malformed owner assignment activity but preserves explicit false', async () => {
    const t = fixture()
    const missing = { ...t.view.workers[0]! } as { assignmentActive?: boolean }
    delete missing.assignmentActive
    t.serviceResponse({ ...t.view, workers: [missing] })
    await expect(t.host.workers(t.enrollment)).rejects.toThrow()

    for (const activity of [null, 'false', 1, {}]) {
      t.serviceResponse({
        ...t.view,
        workers: [{ ...t.view.workers[0]!, assignmentActive: activity }]
      })
      await expect(t.host.workers(t.enrollment)).rejects.toThrow()
    }

    t.serviceResponse({
      ...t.view,
      workers: [{ ...t.view.workers[0]!, assignmentActive: false }]
    })
    expect(await t.host.workers(t.enrollment)).toMatchObject([{
      identity: { dispatchId: 'ctx_dispatch' },
      state: 'live',
      assignmentActive: false
    }])
  })
})
