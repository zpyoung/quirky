import { expect, test } from 'bun:test'
import type { PluginContext, PluginStore } from '@quirky/protocol'
import type { ServiceCoordinatorPrincipal } from '../../src/contracts'
import type { OrchestrationCore } from '../../src/core'
import { createServiceHandlers, type ServiceCoordinatorPort } from '../../src/services/handlers'
import { createServiceCoordinator } from '../../src/services/coordinator'

test('submission preflight registration derives owner authority from the plugin caller and owned Run', async () => {
  const calls: { pluginId: string; runId: string; method: string }[] = []
  const context = {
    error: (_kind: string, message: string) => new Error(message),
  } as unknown as PluginContext
  const port = {
    context,
    requireOwnedRun(pluginId: string, runId: string) {
      if (pluginId !== 'quirky.heimdall' || runId !== 'run_owned') throw new Error('run owner mismatch')
    },
    serviceRegisterSubmissionPreflight(params: { runId: string; method: string }, principal: ServiceCoordinatorPrincipal) {
      calls.push({ pluginId: principal.pluginId, runId: params.runId, method: params.method })
      return { runId: params.runId as `run_${string}`, method: params.method, registered: true as const, mutation: { requestId: '00000000-0000-4000-8000-000000000001', replayed: false } }
    },
  } as unknown as ServiceCoordinatorPort
  const handler = createServiceHandlers(port).serviceRegisterSubmissionPreflight
  const result = await handler({
    runId: 'run_owned',
    method: 'quirky.heimdall/submissionPreflight',
    requestId: '00000000-0000-4000-8000-000000000001',
    contractVersion: 1,
  }, { role: 'plugin', pluginId: 'quirky.heimdall' })
  expect(result).toMatchObject({ runId: 'run_owned', registered: true })
  expect(calls).toEqual([{
    pluginId: 'quirky.heimdall',
    runId: 'run_owned',
    method: 'quirky.heimdall/submissionPreflight',
  }])
})

test('session callers cannot register a service submission hook', async () => {
  const context = {
    error: (_kind: string, message: string) => new Error(message),
  } as unknown as PluginContext
  const port = {
    context,
    requireOwnedRun() {
      throw new Error('owner check must not run for a session caller')
    },
  } as unknown as ServiceCoordinatorPort
  const handler = createServiceHandlers(port).serviceRegisterSubmissionPreflight
  await expect(async () => handler({
    runId: 'run_owned',
    method: 'quirky.heimdall/submissionPreflight',
    requestId: '00000000-0000-4000-8000-000000000002',
    contractVersion: 1,
  }, { role: 'cli', sessionId: 'worker-session' })).rejects.toThrow('kernel-authenticated plugin caller')
})

test('submission callback methods cannot escape the registering plugin namespace', async () => {
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
  await expect(async () => coordinator.serviceRegisterSubmissionPreflight({
    runId: 'run_owned',
    method: 'quirky.other/submissionPreflight',
    requestId: '00000000-0000-4000-8000-000000000003',
    contractVersion: 1,
  }, {
    kind: 'service',
    pluginId: 'quirky.heimdall',
    runId: 'run_owned',
    authority: 'kernel_plugin',
  })).rejects.toThrow('registering plugin namespace')
  expect(mutations).toBe(0)
})
