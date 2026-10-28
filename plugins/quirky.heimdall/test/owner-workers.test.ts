import { expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import type { KernelStore } from '../src/contracts'
import type { OwnerEnrollment } from '../src/owner/contracts'
import { executeWorkerIntervention } from '../src/owner/workers'

const enrollment = { watcherId: 'watcher', orchestrationRunId: 'owned-run' } as OwnerEnrollment
const store = { journal: () => [{ kind: 'attempt', state: 'running', dispatchId: 'worker' }] } as unknown as KernelStore

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
