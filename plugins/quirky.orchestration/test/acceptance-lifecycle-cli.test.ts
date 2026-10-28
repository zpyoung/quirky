import { afterEach, expect, test } from 'bun:test'
import type { OrchestrationMethodResult } from '../src/contracts'
import { call, mutation, startOrchestrationFixture, type OrchestrationFixture } from './fixture'

let fixture: OrchestrationFixture | undefined

afterEach(async () => {
  await fixture?.cleanup()
  fixture = undefined
})

test('a rejected lifecycle receipt is auditable but the CLI does not report success', async () => {
  fixture = await startOrchestrationFixture()
  const coordinator = await fixture.createParty('coordinator')
  const worker = await fixture.createParty('worker')
  const outsider = await fixture.createParty('outsider')
  const created = await call<OrchestrationMethodResult<'runCreate'>>(coordinator, 'quirky.orchestration/runCreate', {
    ...mutation(), objective: 'CLI lifecycle rejection boundary'
  })
  const task = await call<OrchestrationMethodResult<'taskCreate'>>(coordinator, 'quirky.orchestration/taskCreate', {
    ...mutation(), runId: created.run.id, spec: 'Only the assigned process may settle this Task.'
  })
  const attempt = await call<OrchestrationMethodResult<'dispatch'>>(coordinator, 'quirky.orchestration/dispatch', {
    ...mutation(), runId: created.run.id, taskId: task.task.id, to: worker.id
  })
  if (attempt.dryRun) throw new Error('fixture unexpectedly previewed a Dispatch')
  const argv = [
    'orchestration', 'send', '--to', `run:${created.run.id}`,
    '--type', 'worker_done', '--subject', 'Exact-owner report probe',
    '--body', 'I do not own this attempt. This is a rejection probe. The Task must remain dispatched.',
    '--task-id', task.task.id, '--dispatch-id', attempt.dispatch.id, '--outcome', 'succeeded', '--json'
  ]
  const rejected = await fixture.runCli(outsider, argv)
  const receipt: unknown = JSON.parse(rejected.stdout)
  expect(typeof receipt).toBe('object')
  if (receipt === null || typeof receipt !== 'object' || !('report' in receipt)) {
    throw new Error('rejected lifecycle command omitted its auditable report receipt')
  }
  const report = receipt.report
  if (report === null || typeof report !== 'object' || !('status' in report) || !('reason' in report)) {
    throw new Error('rejected lifecycle receipt omitted its rejection reason')
  }
  expect(report.status).toBe('rejected')
  expect(typeof report.reason).toBe('string')
  expect(rejected.code).toBe(1)
  expect(rejected.stderr).toContain(String(report.reason))
  const pending = await call<OrchestrationMethodResult<'taskList'>>(coordinator, 'quirky.orchestration/taskList', {
    runId: created.run.id
  })
  expect(pending.tasks.find(row => row.id === task.task.id)?.status).toBe('dispatched')
  const accepted = await fixture.runCli(worker, argv)
  expect(accepted.code).toBe(0)
  const settled = await call<OrchestrationMethodResult<'taskList'>>(coordinator, 'quirky.orchestration/taskList', {
    runId: created.run.id
  })
  expect(settled.tasks.find(row => row.id === task.task.id)?.status).toBe('completed')
}, 30_000)
