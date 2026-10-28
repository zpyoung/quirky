import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { InboxResult, RunRow, TaskRow } from '../src/contracts'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import {
  call,
  mutation,
  pause,
  startOrchestrationFixture,
  type CliResult,
  type OrchestrationFixture,
  type OrchestrationParty
} from './fixture'

let fixture: OrchestrationFixture
beforeEach(async () => {
  fixture = await startOrchestrationFixture()
})
afterEach(async () => {
  await fixture?.cleanup()
  fixture = undefined!
})

function jsonResult<T>(result: CliResult): T {
  if (result.code !== 0) throw new Error(`quirky exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

async function cliJson<T>(party: OrchestrationParty, args: string[], retryRequest = crypto.randomUUID()): Promise<T> {
  const result = await fixture.runCli(party, [
    'orchestration',
    ...args,
    '--retry-request',
    retryRequest,
    '--json'
  ])
  return jsonResult<T>(result)
}

function expectCliFailure(result: CliResult): void {
  expect(result.code).not.toBe(0)
}

describe('quirky orchestration generated CLI acceptance', () => {
  test('AC1–7 CLI flags normalize typed IDs, address unions, CSV/JSON arrays, and JSON output', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const requestBase = crypto.randomUUID()
    const created = await cliJson<{ run: RunRow; mutation: { requestId: string; replayed: boolean } }>(
      coordinator,
      ['run-create', '--objective', 'CLI typed contract'],
      requestBase
    )
    expect(created.run.coordinatorSessionId).toBe(coordinator.id)
    expect(created.mutation.replayed).toBe(false)

    const replay = await cliJson<{ run: RunRow; mutation: { requestId: string; replayed: boolean } }>(
      coordinator,
      ['run-create', '--objective', 'CLI typed contract'],
      requestBase
    )
    expect(replay.run.id).toBe(created.run.id)
    expect(replay.mutation).toMatchObject({ requestId: created.mutation.requestId, replayed: true })
    const mismatch = await fixture.runCli(coordinator, [
      'orchestration',
      'run-create',
      '--objective',
      'different payload under same base',
      '--retry-request',
      requestBase,
      '--json'
    ])
    expectCliFailure(mismatch)

    const show = await cliJson<{ run: RunRow }>(coordinator, ['run-show', '--id', created.run.id])
    expect(show.run.id).toBe(created.run.id)
    const first = await cliJson<{ task: TaskRow }>(coordinator, [
      'task-create',
      '--run',
      created.run.id,
      '--spec',
      'first dependency',
      '--task-title',
      'A'
    ])
    const second = await cliJson<{ task: TaskRow }>(coordinator, [
      'task-create',
      '--run',
      created.run.id,
      '--spec',
      'second dependency',
      '--task-title',
      'B'
    ])
    const multiDependencyTask = await cliJson<{ task: TaskRow }>(coordinator, [
      'task-create',
      '--run',
      created.run.id,
      '--spec',
      'multiple dependency JSON input',
      '--deps',
      JSON.stringify([first.task.id, second.task.id])
    ])
    expect(multiDependencyTask.task.dependencyTaskIds).toEqual([first.task.id, second.task.id])
    const jsonTask = await cliJson<{ task: TaskRow }>(coordinator, [
      'task-create',
      '--run',
      created.run.id,
      '--spec',
      'JSON dependency input',
      '--deps',
      JSON.stringify([first.task.id])
    ])
    expect(jsonTask.task.dependencyTaskIds).toEqual([first.task.id])
    const taskList = await cliJson<{ runId: string; tasks: TaskRow[] }>(coordinator, [
      'task-list',
      '--run',
      created.run.id,
      '--status',
      'pending'
    ])
    expect(taskList.runId).toBe(created.run.id)
    expect(taskList.tasks.map((task) => task.id)).toContain(multiDependencyTask.task.id)

    const dispatch = await cliJson<{ dryRun: false; dispatch: { id: string; taskId: string } }>(coordinator, [
      'dispatch',
      '--run',
      created.run.id,
      '--task',
      first.task.id,
      '--to',
      worker.id
    ])
    expect(dispatch.dispatch.taskId).toBe(first.task.id)
    const dispatchShow = await cliJson<{ dispatch: { id: string; taskId: string } }>(coordinator, [
      'dispatch-show',
      '--task',
      first.task.id
    ])
    expect(dispatchShow.dispatch.id).toBe(dispatch.dispatch.id)

    const runAddress = await cliJson<{ kind: string; messages: { mailbox: unknown }[] }>(coordinator, [
      'send',
      '--to',
      `run:${created.run.id}`,
      '--run',
      created.run.id,
      '--type',
      'status',
      '--subject',
      'CLI Run address',
      '--body',
      'to Run mailbox',
      '--task-id',
      first.task.id,
      '--dispatch-id',
      dispatch.dispatch.id,
      '--files-modified',
      'src/a.ts,src/b.ts'
    ])
    expect(runAddress.messages[0]?.mailbox).toEqual({ kind: 'run', runId: created.run.id })
    const inbox = await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', { full: true, limit: 100 })
    const structured = inbox.messages.find((message) => message.subject === 'CLI Run address')
    expect(structured?.payload).toMatchObject({ taskId: first.task.id, dispatchId: dispatch.dispatch.id, filesModified: ['src/a.ts', 'src/b.ts'] })

    const dispatchAddress = await cliJson<{ messages: { mailbox: unknown }[] }>(coordinator, [
      'send',
      '--to',
      `dispatch:${dispatch.dispatch.id}`,
      '--run',
      created.run.id,
      '--type',
      'status',
      '--subject',
      'CLI Dispatch address',
      '--payload',
      JSON.stringify({ source: 'cli', value: 3 })
    ])
    expect(dispatchAddress.messages[0]?.mailbox).toEqual({ kind: 'dispatch', dispatchId: dispatch.dispatch.id })
    const messagesBeforePayloadConflict = (await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', {
      full: true,
      limit: 100
    })).count
    const conflictingPayload = await fixture.runCli(coordinator, [
      'orchestration',
      'send',
      '--to',
      `run:${created.run.id}`,
      '--run',
      created.run.id,
      '--type',
      'status',
      '--subject',
      'invalid mixed payload',
      '--payload',
      JSON.stringify({ raw: true }),
      '--task-id',
      first.task.id,
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expectCliFailure(conflictingPayload)
    expect((await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', {
      full: true,
      limit: 100
    })).count).toBe(messagesBeforePayloadConflict)
    const groupAddress = await cliJson<{ messages: { mailbox: unknown }[] }>(coordinator, [
      'send',
      '--to',
      '@all',
      '--run',
      created.run.id,
      '--type',
      'status',
      '--subject',
      'CLI group address',
      '--body',
      'fan out'
    ])
    expect(new Set(groupAddress.messages.map((message) => JSON.stringify(message.mailbox))).size).toBe(groupAddress.messages.length)

    const check = await cliJson<{ mode: string; messages: { type: string }[] }>(coordinator, [
      'check',
      '--peek',
      '--run',
      created.run.id,
      '--types',
      'status,question'
    ])
    expect(check.mode).toBe('peek')
    expect(check.messages.every((message) => ['status', 'question'].includes(message.type))).toBe(true)
  }, 60_000)

  test('AC8 CLI waits honor their timeout and deliver a later message', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const { run } = await call<{ run: RunRow }>(coordinator, 'quirky.orchestration/runCreate', {
      ...mutation(),
      objective: 'CLI wait timing'
    })

    const timedOut = await fixture.runCli(coordinator, [
      'orchestration',
      'check',
      '--unread',
      '--run',
      run.id,
      '--wait',
      '--timeout-ms',
      '0',
      '--types',
      'question',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ], { processTimeoutMs: 3_000 })
    expect(timedOut.code).toBe(0)
    expect(JSON.parse(timedOut.stdout)).toMatchObject({ mode: 'consume', timedOut: true, messages: [] })

    const child = fixture.spawnCli(coordinator, [
      'orchestration',
      'check',
      '--unread',
      '--run',
      run.id,
      '--wait',
      '--timeout-ms',
      '30000',
      '--types',
      'question',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    const stdoutPromise = new Response(child.stdout).text()
    const stderrPromise = new Response(child.stderr).text()
    const exited = child.exited
    try {
      await call(coordinator, 'quirky.orchestration/send', {
        ...mutation(),
        to: { kind: 'run', runId: run.id },
        type: 'question',
        subject: 'wake the generated CLI waiter',
        body: 'question delivery'
      })
      const [stdout, , code] = await Promise.all([stdoutPromise, stderrPromise, exited])
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ timedOut: false, messages: [{ subject: 'wake the generated CLI waiter' }] })
    } finally {
      try {
        child.kill('SIGTERM')
      } catch {}
      await Promise.allSettled([stdoutPromise, stderrPromise, exited])
    }
  }, 45_000)

  test('AC10 CLI timeout exits one with the exact resume command, then resumes and replies using --id', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await call<{ run: RunRow }>(coordinator, 'quirky.orchestration/runCreate', {
      ...mutation(),
      objective: 'CLI ask/resume'
    })
    const task = await call<{ task: TaskRow }>(coordinator, 'quirky.orchestration/taskCreate', {
      ...mutation(),
      runId: run.id,
      spec: 'CLI question task'
    })
    await call(coordinator, 'quirky.orchestration/dispatch', {
      ...mutation(),
      runId: run.id,
      taskId: task.task.id,
      to: worker.id
    })

    const timeout = await fixture.runCli(worker, [
      'orchestration',
      'ask',
      '--run',
      run.id,
      '--question',
      'Select an option',
      '--options',
      'yes,no',
      '--timeout-ms',
      '40',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expect(timeout.code).toBe(1)
    const timeoutResult = JSON.parse(timeout.stdout) as { state: string; messageId: string }
    const questionId = timeoutResult.messageId
    expect(questionId).toBeTruthy()
    expect(timeoutResult.state).toBe('timedOut')
    expect(`${timeout.stdout}\n${timeout.stderr}`).toContain(`quirky orchestration ask --resume ${questionId}`)

    const questionCount = async () => {
      const inbox = await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', { full: true, limit: 100 })
      return inbox.messages.filter((message) => message.id === questionId).length
    }
    expect(await questionCount()).toBe(1)
    const answer = await fixture.runCli(coordinator, [
      'orchestration',
      'reply',
      '--id',
      questionId,
      '--body',
      'yes',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expect(answer.code).toBe(0)
    expect(JSON.parse(answer.stdout)).toMatchObject({ kind: 'question_answer', duplicate: false })

    const resume = await fixture.runCli(worker, [
      'orchestration',
      'ask',
      '--resume',
      questionId,
      '--timeout-ms',
      '800',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expect(resume.code).toBe(0)
    expect(JSON.parse(resume.stdout)).toMatchObject({ state: 'answered', answer: 'yes', messageId: questionId })
    expect(await questionCount()).toBe(1)

    const duplicate = await fixture.runCli(coordinator, [
      'orchestration',
      'reply',
      '--id',
      questionId,
      '--body',
      'yes',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expect(duplicate.code).toBe(0)
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ duplicate: true })
    const conflict = await fixture.runCli(coordinator, [
      'orchestration',
      'reply',
      '--id',
      questionId,
      '--body',
      'no',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expectCliFailure(conflict)
  }, 45_000)

  test('AC10 a CLI ask cancelled by Task settlement exits one and prints the same resumable question ID', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await call<{ run: RunRow }>(coordinator, 'quirky.orchestration/runCreate', {
      ...mutation(),
      objective: 'CLI ask cancellation'
    })
    const task = await call<{ task: TaskRow }>(coordinator, 'quirky.orchestration/taskCreate', {
      ...mutation(),
      runId: run.id,
      spec: 'cancel the pending CLI question'
    })
    await call(coordinator, 'quirky.orchestration/dispatch', {
      ...mutation(),
      runId: run.id,
      taskId: task.task.id,
      to: worker.id
    })
    const requestBase = crypto.randomUUID()
    const child = fixture.spawnCli(worker, [
      'orchestration',
      'ask',
      '--run',
      run.id,
      '--question',
      'cancel this question through task settlement',
      '--timeout-ms',
      '10000',
      '--retry-request',
      requestBase,
      '--json'
    ])
    const stdoutPromise = new Response(child.stdout).text()
    const stderrPromise = new Response(child.stderr).text()
    const exited = child.exited
    try {
      const question = await waitForAsync(async () => {
        const inbox = await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', { full: true, limit: 100 })
        return inbox.messages.find((message) => message.type === 'question')
      }, 5000)
      await call(coordinator, 'quirky.orchestration/taskUpdate', {
        ...mutation(),
        runId: run.id,
        taskId: task.task.id,
        status: 'completed',
        result: 'cancelled by coordinator settlement'
      })
      const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, exited])
      const result = JSON.parse(stdout) as { state: string; messageId: string }
      expect(code).toBe(1)
      expect(result).toMatchObject({ state: 'cancelled', messageId: question.id })
      expect(stderr).toContain(`quirky orchestration ask --resume ${question.id}`)
      const inbox = await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', { full: true, limit: 100 })
      expect(inbox.messages.filter((message) => message.id === question.id)).toHaveLength(1)
    } finally {
      try {
        child.kill('SIGTERM')
      } catch {}
      await Promise.allSettled([stdoutPromise, stderrPromise, exited])
    }
  }, 20_000)

  test('AC13 destructive reset requires CLI confirmation and --yes only bypasses it in this test', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const created = await cliJson<{ run: RunRow }>(coordinator, ['run-create', '--objective', 'CLI reset scope'])
    const message = await cliJson<{ messages: unknown[] }>(coordinator, [
      'send',
      '--to',
      `run:${created.run.id}`,
      '--type',
      'status',
      '--subject',
      'before reset',
      '--body',
      'message to clear'
    ])
    expect(message.messages).toHaveLength(1)

    const unconfirmed = await fixture.runCli(coordinator, [
      'orchestration',
      'reset',
      '--messages',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expectCliFailure(unconfirmed)
    expect((await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', {
      full: true,
      limit: 100
    })).messages.some((item) => item.subject === 'before reset')).toBe(true)

    const confirmed = await fixture.runCli(coordinator, [
      'orchestration',
      'reset',
      '--messages',
      '--yes',
      '--retry-request',
      crypto.randomUUID(),
      '--json'
    ])
    expect(confirmed.code).toBe(0)
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ mode: 'messages' })
    const inbox = await call<InboxResult>(coordinator, 'quirky.orchestration/inbox', { full: true, limit: 100 })
    expect(inbox.messages).toHaveLength(0)
    expect((await call<{ run: RunRow }>(coordinator, 'quirky.orchestration/runShow', { runId: created.run.id })).run.id).toBe(created.run.id)
  }, 30_000)
})
