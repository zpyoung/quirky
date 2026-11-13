import { expect, test } from 'bun:test'
import type { PluginContext, PluginStore } from '@quirky/protocol'
import type { OrchestrationCore } from '../../src/core'
import { createServiceHandlers, type ServiceCoordinatorPort } from '../../src/services/handlers'
import { createServiceCoordinator } from '../../src/services/coordinator'
import { OrchestrationMessages } from '../../src/messaging'

function captureError(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  return undefined
}

test('session callers cannot register a service submission hook', () => {
  const context = {
    error: (_kind: string, message: string) => new Error(message),
  } as unknown as PluginContext
  let mutations = 0
  const port = {
    context,
    requireOwnedRun() {
      throw new Error('owner check must not run for a session caller')
    },
    serviceRegisterSubmissionPreflight() {
      mutations++
    },
  } as unknown as ServiceCoordinatorPort
  const handler = createServiceHandlers(port).serviceRegisterSubmissionPreflight
  const error = captureError(() => handler({
    runId: 'run_owned',
    method: 'quirky.heimdall/submissionPreflight',
    requestId: '00000000-0000-4000-8000-000000000002',
    contractVersion: 1,
  }, { role: 'cli', sessionId: 'worker-session' }))

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ data: { reason: 'consumer_fenced' } })
  expect(mutations).toBe(0)
})

test('submission callback methods cannot escape the registering plugin namespace', () => {
  const context = {
    error: (_kind: string, message: string) => new Error(message),
  } as unknown as PluginContext
  let mutations = 0
  const store = {
    run() {
      mutations++
      return { changes: 1, lastInsertRowid: 1 }
    },
  } as unknown as PluginStore
  const core = {
    store,
    requireCoordinator() {},
    requireOwnedRun() {},
    mutate() {
      mutations++
      return Promise.resolve({ registered: true })
    },
  } as unknown as OrchestrationCore
  const coordinator = createServiceCoordinator(context, core, {} as never)
  const error = captureError(() => coordinator.serviceRegisterSubmissionPreflight({
    runId: 'run_owned',
    method: 'quirky.other/submissionPreflight',
    requestId: '00000000-0000-4000-8000-000000000003',
    contractVersion: 1,
  }, {
    kind: 'service',
    pluginId: 'quirky.heimdall',
    runId: 'run_owned',
    authority: 'kernel_plugin',
  }))

  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ data: { reason: 'consumer_fenced' } })
  expect(mutations).toBe(0)
})

test.each([false, true])('preflight callback errors are logged without changing the verdict (throwing logger: %s)', async (throwFromLog) => {
  const logs: string[] = []
  const context = {
    call: async () => { throw new Error('boom') },
    log(message: string) {
      logs.push(message)
      if (throwFromLog) throw new Error('logger unavailable')
    },
  } as unknown as PluginContext
  const core = {
    store: {
      get: () => ({ owner_plugin_id: 'acme.owner', method: 'acme.owner/preflight' }),
    },
    requireOwnedRun() {},
    onBindingChanged() {},
    onQuestionsClosed() {},
    onDispatchSettled() {},
    onDispatchFenced() {},
    onMessageCommitted() {},
  } as unknown as OrchestrationCore
  const messages = new OrchestrationMessages(context, core)

  expect(await messages.runFederatedSubmissionPreflight({
    runId: 'run_owned',
    taskId: 'task_owned',
    dispatchId: 'dispatch_owned',
    type: 'worker_done',
    subject: 'Worker completion',
    body: 'Finished',
    payload: null,
  })).toEqual({
    kind: 'rejected',
    code: 'submission_preflight_unavailable',
    reason: 'Registered submission preflight did not return an accepted verdict.',
  })
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('acme.owner/preflight')
  expect(logs[0]).toContain('boom')
})
