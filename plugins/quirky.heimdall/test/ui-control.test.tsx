import { describe, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import type { ApprovalScope } from '../src/contracts'
import type { CommandRequest, OpenEscalation, WatcherDetail, WatcherWorker, WorkerIdentity } from '../src/control-contracts'
import { UI_CONTROL_COMMAND, dispatchFleetControl, registerFleetControl, requestFleetControl, type FleetControlArgs } from '../src/ui-control'
import { answerDraftKey, commandEligibility, ownerEpochKey, sameCommandOwner, type CommandReceipt } from '../src/ui-model'

const ownerFence = {
  executionHostId: 'host',
  schedulerOwner: 'scheduler',
  workspaceKey: 'workspace',
  revision: 1
}

const workerIdentity: WorkerIdentity = {
  dispatchId: 'dispatch-1',
  sessionId: 'session-1',
  processIncarnation: 'process-1',
  pid: 42,
  startTime: '2026-11-14T00:00:00.000Z',
  terminalHandle: 'terminal-1'
}

const approvalScope: ApprovalScope = {
  actionKind: 'commit',
  contentIdentity: 'content-1',
  evidenceKey: 'evidence-1',
  preparedCommitSha: 'commit-1'
}

function detail(overrides: Partial<WatcherDetail> = {}): WatcherDetail {
  return {
    target: { watcherId: 'watcher-1' },
    ownerFence,
    ownerContact: 'live',
    observedAtMs: 10,
    name: 'Watcher',
    workers: [],
    openEscalations: [],
    pendingControls: [],
    ownerIncarnation: 'incarnation-1',
    ...overrides
  } as WatcherDetail
}

function liveWorker(identity: WorkerIdentity = workerIdentity, question?: WatcherWorker['question']): WatcherWorker {
  return {
    identity,
    state: 'live',
    assignmentActive: true,
    ...(question ? { question } : {})
  }
}

function controlArgs(overrides: Partial<FleetControlArgs> = {}): FleetControlArgs {
  return { action: 'edit-budget', instance: 'instance-1', generation: 'generation-1', revision: 0, ...overrides }
}

function contextWithCall(call: (method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>): UiPluginContext {
  return { call: async (method: string, params?: Record<string, unknown>) => call(method, params) } as unknown as UiPluginContext
}

const invalidControlArgs: unknown[] = [
  { action: 'delete', instance: 'i', generation: 'g', revision: 0 },
  { action: 'edit-budget', instance: 'i', revision: 0 },
  { action: 'edit-budget', instance: '', generation: 'g', revision: 0 },
  { action: 'edit-budget', instance: 'i', generation: ' ', revision: 0 },
  { action: 'cancel-budget', instance: 'i', generation: 'g', revision: -1 },
  { action: 'cancel-budget', instance: 'i', generation: 'g', revision: 1.5 },
  { action: 'cancel-budget', instance: 'i', generation: 'g' },
  { action: 'cancel-concurrency', instance: 'i', generation: 'g', revision: Number.MAX_SAFE_INTEGER + 1 },
  { action: 'cancel-budget', instance: 'i', generation: 'g', revision: 0, extra: true },
  null,
  []
]

const invalidArgsMessage = 'Heimdall UI control needs a known action, instance, generation and revision.'
const invalidReplyMessage = 'The window returned an invalid Heimdall UI control result.'

describe('Heimdall mounted UI control transport', () => {
  test('dispatches only to the exact registered instance and reports an unknown instance as undelivered', () => {
    const context = {} as UiPluginContext
    let calls = 0
    const unregister = registerFleetControl(context, 'mounted-instance', () => {
      calls += 1
      return true
    })

    expect(dispatchFleetControl(context, controlArgs({ instance: 'unknown-instance' }))).toEqual({
      ...controlArgs({ instance: 'unknown-instance' }),
      delivered: 0
    })
    expect(calls).toBe(0)
    expect(dispatchFleetControl(context, controlArgs({ instance: 'mounted-instance' }))).toEqual({
      ...controlArgs({ instance: 'mounted-instance' }),
      delivered: 1
    })
    expect(calls).toBe(1)
    unregister()
  })

  test('rejects malformed control arguments with the contract error', () => {
    const context = {} as UiPluginContext
    for (const args of invalidControlArgs) {
      expect(() => dispatchFleetControl(context, args)).toThrow(invalidArgsMessage)
    }
  })

  test('dispatches synchronously and returns a plain delivery result', () => {
    const context = {} as UiPluginContext
    let applied = false
    const unregister = registerFleetControl(context, 'instance-1', (args) => {
      applied = args.action === 'edit-budget' && args.revision === 0
      return applied
    })

    const result = dispatchFleetControl(context, controlArgs())
    expect(applied).toBe(true)
    expect(result).toEqual({ ...controlArgs(), delivered: 1 })
    expect(result).not.toBeInstanceOf(Promise)
    unregister()
  })

  test('request targets its own window and validates the complete command reply', async () => {
    const args = controlArgs({ action: 'cancel-concurrency', revision: 3 })
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const context = contextWithCall((method, params) => {
      calls.push([method, params])
      if (method === 'ui.window.self') return { connId: 7 }
      return { result: { ...args, delivered: 1 } }
    })

    await expect(requestFleetControl(context, args)).resolves.toEqual({ ...args, delivered: 1 })
    expect(calls).toEqual([
      ['ui.window.self', {}],
      ['ui.window.command.run', { connId: 7, id: UI_CONTROL_COMMAND, args }]
    ])
  })

  test('rejects invalid self identities and malformed or mismatched command replies', async () => {
    const args = controlArgs()
    const validResult = { ...args, delivered: 1 }
    const invalidReplies: unknown[] = [
      undefined,
      null,
      {},
      { result: null },
      { result: { ...args, delivered: 2 } },
      { result: { ...args, delivered: '1' } },
      { result: { ...args, delivered: 1, extra: true } },
      { result: { ...args, instance: 'different-instance', delivered: 1 } },
      { result: { ...args, revision: 1, delivered: 1 } },
      { result: validResult, extra: true }
    ]

    const invalidSelf = contextWithCall((method) => method === 'ui.window.self' ? { connId: 0 } : { result: validResult })
    await expect(requestFleetControl(invalidSelf, args)).rejects.toThrow('ui.window.self returned an invalid connection identity.')

    for (const reply of invalidReplies) {
      const context = contextWithCall((method) => method === 'ui.window.self' ? { connId: 7 } : reply)
      await expect(requestFleetControl(context, args)).rejects.toThrow(invalidReplyMessage)
    }
  })

  test('propagates failures from either window transport call', async () => {
    for (const failedMethod of ['ui.window.self', 'ui.window.command.run']) {
      const context = contextWithCall((method) => {
        if (method === failedMethod) throw new Error(`failed ${method}`)
        return method === 'ui.window.self' ? { connId: 7 } : { result: { ...controlArgs(), delivered: 0 } }
      })
      await expect(requestFleetControl(context, controlArgs())).rejects.toThrow(`failed ${failedMethod}`)
    }
  })
})

describe('Heimdall command identity helpers', () => {
  test('owner epochs include host, scheduler, workspace and incarnation but exclude fence revision', () => {
    const baseline = detail()
    const key = ownerEpochKey(baseline)
    expect(ownerEpochKey(detail({ ownerFence: { ...ownerFence, revision: 2 } }))).toBe(key)
    expect(ownerEpochKey(detail({ ownerFence: { ...ownerFence, executionHostId: 'host-2' } }))).not.toBe(key)
    expect(ownerEpochKey(detail({ ownerFence: { ...ownerFence, schedulerOwner: 'scheduler-2' } }))).not.toBe(key)
    expect(ownerEpochKey(detail({ ownerFence: { ...ownerFence, workspaceKey: 'workspace-2' } }))).not.toBe(key)
    expect(ownerEpochKey(detail({ ownerIncarnation: 'incarnation-2' }))).not.toBe(key)
  })

  test('answer draft keys partition all six worker identity fields and the question', () => {
    const key = answerDraftKey(workerIdentity, 'message-1')
    const changedIdentities: WorkerIdentity[] = [
      { ...workerIdentity, dispatchId: 'dispatch-2' },
      { ...workerIdentity, sessionId: 'session-2' },
      { ...workerIdentity, processIncarnation: 'process-2' },
      { ...workerIdentity, pid: 43 },
      { ...workerIdentity, startTime: '2026-11-14T00:00:01.000Z' },
      { ...workerIdentity, terminalHandle: 'terminal-2' }
    ]
    for (const identity of changedIdentities) expect(answerDraftKey(identity, 'message-1')).not.toBe(key)
    expect(answerDraftKey(workerIdentity, 'message-2')).not.toBe(key)
    expect(answerDraftKey({ ...workerIdentity }, 'message-1')).toBe(key)
  })

  test('approvals require an open escalation and a deep canonical scope match', () => {
    const request = { kind: 'approve', escalationId: 'escalation-1', scope: approvalScope } as const
    const escalation: OpenEscalation = {
      escalationId: 'escalation-1',
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount: 1,
      approvalScope: { preparedCommitSha: 'commit-1', evidenceKey: 'evidence-1', contentIdentity: 'content-1', actionKind: 'commit' }
    }
    expect(commandEligibility(request, { kind: 'none' }, detail({ openEscalations: [escalation] }))).toBeNull()
    expect(commandEligibility(request, { kind: 'none' }, detail({ openEscalations: [] }))).toBe('The approval scope changed')
    expect(commandEligibility(request, { kind: 'none' }, detail({
      openEscalations: [{ ...escalation, status: 'approved' }]
    }))).toBe('The approval scope changed')
    expect(commandEligibility(request, { kind: 'none' }, detail({ openEscalations: [{
      ...escalation,
      approvalScope: { ...approvalScope, preparedCommitSha: 'commit-2' }
    }] }))).toBe('The approval scope changed')
  })

  test('stop-worker eligibility checks live state and every captured identity field', () => {
    const command = { kind: 'stop-worker', identity: workerIdentity } as const
    expect(commandEligibility(command, { kind: 'none' }, detail({ workers: [liveWorker({ ...workerIdentity })] }))).toBeNull()

    const changedIdentities: WorkerIdentity[] = [
      { ...workerIdentity, dispatchId: 'dispatch-2' },
      { ...workerIdentity, sessionId: 'session-2' },
      { ...workerIdentity, processIncarnation: 'process-2' },
      { ...workerIdentity, pid: 43 },
      { ...workerIdentity, startTime: '2026-11-14T00:00:01.000Z' },
      { ...workerIdentity, terminalHandle: 'terminal-2' }
    ]
    for (const identity of changedIdentities) {
      expect(commandEligibility(command, { kind: 'none' }, detail({ workers: [liveWorker(identity)] }))).toBe('The worker\'s process changed')
    }
    expect(commandEligibility(command, { kind: 'none' }, detail({ workers: [
      { ...liveWorker(), state: 'exited' }
    ] }))).toBe('The worker\'s process changed')
  })

  test('answers require the exact worker receipt and the same unanswered question', () => {
    const command = { kind: 'answer-question', messageId: 'message-1', body: 'yes' } as const
    const receipt: CommandReceipt = { kind: 'answer', worker: workerIdentity, messageId: 'message-1' }
    const current = detail({ workers: [liveWorker(workerIdentity, { messageId: 'message-1', body: 'Question?' })] })
    expect(commandEligibility(command, receipt, current)).toBeNull()
    expect(commandEligibility(command, { kind: 'none' }, current)).toBe('The worker\'s question changed')
    expect(commandEligibility({ ...command, messageId: 'message-2' }, receipt, current)).toBe('The worker\'s question changed')

    for (const identity of [
      { ...workerIdentity, sessionId: 'session-2' },
      { ...workerIdentity, processIncarnation: 'process-2' },
      { ...workerIdentity, pid: 43 },
      { ...workerIdentity, startTime: '2026-11-14T00:00:01.000Z' },
      { ...workerIdentity, terminalHandle: 'terminal-2' }
    ]) {
      expect(commandEligibility(command, receipt, detail({
        workers: [liveWorker(identity, { messageId: 'message-1', body: 'Question?' })]
      }))).toBe('The worker\'s process changed')
    }
    expect(commandEligibility(command, receipt, detail({
      workers: [liveWorker(workerIdentity, { messageId: 'message-1', body: 'Question?', answered: true })]
    }))).toBe('The worker\'s question changed')
    expect(commandEligibility(command, receipt, detail({
      workers: [liveWorker(workerIdentity, { messageId: 'message-2', body: 'A new question' })]
    }))).toBe('The worker\'s question changed')
    expect(commandEligibility(command, receipt, detail({ workers: [] }))).toBe('The worker\'s question changed')
  })

  test('all other command kinds remain eligible for the server-side fence to decide', () => {
    const request = { target: { watcherId: 'watcher-1' }, expectedOwner: ownerFence, command: { kind: 'pause' } } satisfies CommandRequest
    expect(commandEligibility(request.command, { kind: 'none' }, detail())).toBeNull()
  })

  test('sameCommandOwner compares target, every owner fence field, revision and incarnation', () => {
    const request: CommandRequest & { expectedIncarnation?: string } = {
      target: { watcherId: 'watcher-1', connectionId: 'peer-1', pairingRevision: 3 },
      expectedOwner: ownerFence,
      command: { kind: 'pause' },
      expectedIncarnation: 'incarnation-1'
    }
    const latest = detail({ target: request.target })
    expect(sameCommandOwner(request, latest)).toBe(true)
    expect(sameCommandOwner({ ...request, expectedOwner: { ...ownerFence, revision: 2 } }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, expectedOwner: { ...ownerFence, executionHostId: 'host-2' } }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, expectedOwner: { ...ownerFence, schedulerOwner: 'scheduler-2' } }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, expectedOwner: { ...ownerFence, workspaceKey: 'workspace-2' } }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, expectedIncarnation: 'incarnation-2' }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, target: { ...request.target, watcherId: 'watcher-2' } }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, target: { ...request.target, connectionId: 'peer-2' } }, latest)).toBe(false)
    expect(sameCommandOwner({ ...request, target: { ...request.target, pairingRevision: 4 } }, latest)).toBe(false)
  })
})
