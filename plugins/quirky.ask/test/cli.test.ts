import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope, QuirkyClient } from '@quirky/protocol'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'
import { cleanupAll, confirmSpec, connectAs, openWindow, startAsk, testCli } from './support'

let h: Harness
let dir: string

beforeEach(async () => {
  h = await startAsk()
  dir = mkdtempSync(join(tmpdir(), 'qa-cli-'))
})
afterEach(async () => {
  await cleanupAll()
  rmSync(dir, { recursive: true, force: true })
})

const specJson = JSON.stringify(confirmSpec)

async function cliFor(env: Record<string, string> = {}, options: Parameters<typeof testCli>[2] = {}) {
  const identity = { sessionId: env.QUIRKY_SESSION_ID, worktreeId: env.QUIRKY_WORKTREE_ID }
  const connect = () => connectAs(h, identity)
  return testCli(connect, await connect(), { env, cwd: dir, ...options })
}

/** Answers every new ask with `confirm yes` after `delayMs`, as the window would. */
async function answerAsksAfter(delayMs: number): Promise<void> {
  const window = await openWindow(h)
  window.client.onEvent((event) => {
    if (event.type !== 'quirky.ask/created') return
    const { id } = (event as any).data.ask
    setTimeout(() => {
      void window.client.callAny('quirky.ask/answer', { askId: id, answers: { go: { value: 'yes', source: 'input' } } }).catch(() => {})
    }, delayMs)
  })
}

const run = (cli: Awaited<ReturnType<typeof cliFor>>, command: keyof typeof commands, flags: Record<string, unknown>) =>
  commands[command]({ positionals: [], flags }, cli.ctx)

async function rejection(promise: Promise<unknown>): Promise<Error & { exit?: number }> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('quirky ask command module', () => {
  test('SC-28: prints the registered line immediately, then the answered envelope', async () => {
    await answerAsksAfter(300)
    const cli = await cliFor({ QUIRKY_SESSION_ID: 'sess_7', QUIRKY_WORKTREE_ID: 'wt_7' })
    const running = run(cli, 'ask', { spec: specJson })
    await Bun.sleep(100)
    expect(cli.lines).toHaveLength(1)
    const registered = cli.lines[0] as { status: string; askId: string }
    expect(registered.status).toBe('registered')
    expect(registered.askId).toMatch(/^ask_/)
    await running
    expect(cli.lines).toHaveLength(2)
    const envelope = cli.lines[1] as AskEnvelope
    expect(envelope).toMatchObject({ status: 'answered', answers: { go: { value: 'yes', source: 'input' } } })
    expect(envelope.askId).toBe(registered.askId)
    const [ask] = (await (await connectAs(h)).callAny('quirky.ask/list', {})) as { sessionId: string; worktreeId: string }[]
    expect(ask).toMatchObject({ sessionId: 'sess_7', worktreeId: 'wt_7' })
  })

  test('--spec @file is read through the context', async () => {
    writeFileSync(join(dir, 'spec.json'), specJson)
    await answerAsksAfter(20)
    const cli = await cliFor()
    await run(cli, 'ask', { spec: `@${join(dir, 'spec.json')}` })
    expect(cli.lines).toHaveLength(2)
  })

  test('SC-28: --timeout-ms cancels the ask, prints it as timed_out and returns', async () => {
    const cli = await cliFor()
    await run(cli, 'ask', { spec: specJson, 'timeout-ms': 300 })
    const [registered, timedOut] = cli.lines as [{ askId: string }, AskEnvelope]
    expect(timedOut).toEqual({ status: 'timed_out', askId: registered.askId, answers: {}, skipped: [], summary: '' })
    const [ask] = (await (await connectAs(h)).callAny('quirky.ask/list', {})) as { envelope: AskEnvelope }[]
    expect(ask.envelope.status).toBe('declined')
  })

  test('an ask answered before --timeout-ms is not cancelled', async () => {
    await answerAsksAfter(50)
    const cli = await cliFor()
    await run(cli, 'ask', { spec: specJson, 'timeout-ms': 5000 })
    expect((cli.lines[1] as AskEnvelope).status).toBe('answered')
  })

  test('--timeout-ms still prints timed_out when the cancel call fails', async () => {
    const cli = await cliFor()
    const call = cli.ctx.call
    cli.ctx.call = async (method, params) => {
      if (method === 'quirky.ask/cancel') throw new Error('boom')
      return call(method, params)
    }
    await run(cli, 'ask', { spec: specJson, 'timeout-ms': 150 })
    expect((cli.lines[1] as AskEnvelope).status).toBe('timed_out')
  })

  test('SC-28: wait --id resumes an abandoned ask and cancel --id prints the envelope', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const cli = await cliFor()
    await run(cli, 'wait', { id: askId, 'timeout-ms': 100 })
    expect(cli.lines).toEqual([{ status: 'timed_out', askId, answers: {}, skipped: [], summary: '' }])

    const second = ((await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }).askId
    const cancelled = await cliFor()
    await run(cancelled, 'cancel', { id: second })
    expect(cancelled.lines).toEqual([{ status: 'declined', askId: second, answers: {}, skipped: [], summary: '' }])
  })

  test('SC-28: wait --id on an answered ask prints the same envelope at once', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const answered = await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: 'yes', source: 'input' } } })
    const cli = await cliFor()
    await run(cli, 'wait', { id: askId })
    expect(cli.lines).toEqual([answered])
  })

  test('SC-28: a partial answer prints partial', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const cli = await cliFor()
    const running = run(cli, 'wait', { id: askId })
    await asker.callAny('quirky.ask/answer', { askId, answers: {}, skipped: ['go'] })
    await running
    expect(cli.lines).toEqual([{ status: 'partial', askId, answers: {}, skipped: ['go'], summary: '' }])
  })

  test('reconnects when the connection drops mid-wait', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    let first: QuirkyClient | null = null
    const connect = async () => {
      const client = await connectAs(h)
      first ??= client
      return client
    }
    const cli = testCli(connect, await connect())
    const running = run(cli, 'wait', { id: askId })
    await Bun.sleep(50)
    first!.close()
    await Bun.sleep(50)
    await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: 'yes', source: 'input' } } })
    await running
    expect(cli.reconnects).toBeGreaterThanOrEqual(1)
    expect((cli.lines[0] as AskEnvelope).status).toBe('answered')
  })

  test('invalid specs are usage errors naming the field, without contacting the daemon', async () => {
    const cli = await cliFor()
    const bad = JSON.stringify({ questions: [{ id: 'a', type: 'text', question: 'x' }, { id: 'a', type: 'text', question: 'y' }] })
    const error = await rejection(run(cli, 'ask', { spec: bad }))
    expect(error.exit).toBe(2)
    expect(error.message).toContain('questions[1].id')
    expect(((await (await connectAs(h)).callAny('quirky.ask/list', {})) as unknown[])).toEqual([])
  })

  test('--timeout-ms below 1 is a usage error', async () => {
    const cli = await cliFor()
    const error = await rejection(run(cli, 'ask', { spec: specJson, 'timeout-ms': 0 }))
    expect(error.exit).toBe(2)
    expect(error.message).toContain('--timeout-ms must be at least 1')
  })

  test('an unreadable @file and malformed JSON are usage errors', async () => {
    const cli = await cliFor()
    const missing = await rejection(run(cli, 'ask', { spec: `@${join(dir, 'nope.json')}` }))
    expect(missing.exit).toBe(2)
    expect(missing.message).toContain('--spec: cannot read')
    const bad = await rejection(run(cli, 'ask', { spec: '{nope' }))
    expect(bad.message).toContain('--spec is not valid JSON')
  })
})
