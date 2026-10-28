import { expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import type { KernelStore } from '../src/contracts'
import type { OwnerEnrollment } from '../src/owner/contracts'
import { executeWorkerIntervention } from '../src/owner/workers'

const enrollment = { watcherId: 'watcher', orchestrationRunId: 'owned-run' } as OwnerEnrollment
const store = { journal: () => [{ kind: 'attempt', state: 'running', dispatchId: 'worker' }] } as unknown as KernelStore
async function runStop(
  workerState: 'live' | 'exited' | 'unverifiable',
  serviceResult: {
    dispatchId: string
    processAction: 'closed_agent_terminal' | 'none' | 'unknown'
    state: string
    alreadySettled?: boolean
  }
) {
  const context = {
    call: async (method: string) => method === 'quirky.orchestration/serviceRunShow'
      ? {
          run: { id: 'owned-run' },
          workers: [{ dispatchId: 'worker', sessionId: 'session', processIncarnation: 'incarnation', state: workerState }],
          questions: []
        }
      : serviceResult
  } as unknown as PluginContext
  return executeWorkerIntervention(context, store, enrollment, { kind: 'stop-worker', dispatchId: 'worker' }, 'attempt')
}

test('only exact terminal stop receipts establish an applied worker stop', async () => {
  const confirmed = [
    { dispatchId: 'worker', processAction: 'closed_agent_terminal' as const, state: 'stopped' },
    { dispatchId: 'worker', processAction: 'none' as const, state: 'stopped', alreadySettled: true },
    { dispatchId: 'worker', processAction: 'none' as const, state: 'succeeded', alreadySettled: true },
    { dispatchId: 'worker', processAction: 'none' as const, state: 'failed', alreadySettled: true }
  ]
  for (const receipt of confirmed) {
    expect((await runStop('live', receipt)).effect).toBe('landed')
  }
})

test('an exited worker with exact identity is delegated to the owner service', async () => {
  const result = await runStop('exited', {
    dispatchId: 'worker',
    processAction: 'closed_agent_terminal',
    state: 'stopped'
  })
  expect(result.effect).toBe('landed')
})

test('stopped or released labels alone do not establish an applied stop', async () => {
  for (const state of ['stopped', 'released']) {
    expect((await runStop('live', { dispatchId: 'worker', processAction: 'none', state })).effect).toBe('not-landed')
  }
})

test('unknown stop receipts and a mismatched dispatch receipt remain indeterminate', async () => {
  const unknownAction = await runStop('live', {
    dispatchId: 'worker',
    processAction: 'unknown',
    state: 'stopped'
  })
  const unknownState = await runStop('live', {
    dispatchId: 'worker',
    processAction: 'none',
    state: 'stop_unknown'
  })
  const otherDispatch = await runStop('live', {
    dispatchId: 'another-worker',
    processAction: 'closed_agent_terminal',
    state: 'stopped'
  })
  expect(unknownAction.effect).toBe('indeterminate')
  expect(unknownState.effect).toBe('indeterminate')
  expect(otherDispatch.effect).toBe('indeterminate')
})

test('an intervention cannot message a dispatch outside the watcher owned run', async () => {
  let effect = false
  const context = { call: async (method: string) => {
    if (method === 'quirky.orchestration/serviceRunShow') return { run: { id: 'owned-run' }, workers: [], questions: [] }
    effect = true
    throw new Error('unexpected effect')
  } } as unknown as PluginContext
  const result = await executeWorkerIntervention(context, store, enrollment, { kind: 'message-worker', dispatchId: 'foreign', body: 'do work' }, 'attempt')
  expect(result.effect).toBe('not-landed')
  expect(result.reason).toBe('worker-not-owned')
  expect(effect).toBe(false)
})

test('an unverifiable process is never stopped from a remembered session identity', async () => {
  let stopped = false
  const context = { call: async (method: string) => {
    if (method === 'quirky.orchestration/serviceRunShow') return { run: { id: 'owned-run' }, workers: [{ dispatchId: 'worker', sessionId: 'old-session', processIncarnation: 'old-incarnation', state: 'unverifiable' }], questions: [] }
    stopped = true
    throw new Error('unexpected stop')
  } } as unknown as PluginContext
  const result = await executeWorkerIntervention(context, store, enrollment, { kind: 'stop-worker', dispatchId: 'worker' }, 'attempt')
  expect(result.effect).toBe('not-landed')
  expect(result.reason).toBe('worker-unverifiable')
  expect(stopped).toBe(false)
})

test('answer-worker refuses another dispatch question even inside the same run', async () => {
  let answered = false
  const context = { call: async (method: string) => {
    if (method === 'quirky.orchestration/serviceRunShow') return { run: { id: 'owned-run' }, workers: [{ dispatchId: 'worker', state: 'live' }], questions: [{ messageId: 'question', dispatchId: 'other', status: 'pending' }] }
    answered = true
    throw new Error('unexpected answer')
  } } as unknown as PluginContext
  const result = await executeWorkerIntervention(context, store, enrollment, { kind: 'answer-worker', dispatchId: 'worker', messageId: 'question', body: 'yes' }, 'attempt')
  expect(result.effect).toBe('not-landed')
  expect(result.reason).toBe('question-not-owned')
  expect(answered).toBe(false)
})
