import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RpcError, RpcErrorCode, type AskEnvelope, type QuirkyClient } from '@quirky/protocol'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'
import { cleanupAll, confirmSpec, connectAs, deploy, openWindow, startAsk, testCli } from './support'

const CLI_MAIN = resolve(import.meta.dir, '../../../packages/cli/src/main.ts')

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
  await openWindow(h, `ask-cli-${crypto.randomUUID()}`)
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
      void window.client.callAny('quirky.ask/answer', { askId: id, answers: { go: { value: true, source: 'input' } } }).catch(() => {})
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
    // a second's gap between creating and answering keeps the order check meaningful on a loaded machine
    await answerAsksAfter(1000)
    const cli = await cliFor()
    const running = run(cli, 'ask', { spec: specJson })
    await waitFor(() => cli.lines.length > 0)
    expect(cli.lines).toHaveLength(1)
    const registered = cli.lines[0] as { status: string; askId: string }
    expect(registered.status).toBe('registered')
    expect(registered.askId).toMatch(/^ask_/)
    await running
    expect(cli.lines).toHaveLength(2)
    const envelope = cli.lines[1] as AskEnvelope
    expect(envelope).toMatchObject({ status: 'answered', answers: { go: { value: true, source: 'input' } } })
    expect(envelope.askId).toBe(registered.askId)
  })

  test('an unattached caller without an authenticated session gets a terminal unavailable registration, not a pending wait', async () => {
    const client = await connectAs(h)
    const cli = testCli(() => connectAs(h), client, { cwd: dir })
    await run(cli, 'ask', { spec: specJson })
    expect(cli.lines).toEqual([{
      status: 'unavailable',
      reason: expect.any(String)
    }])
  })

  test('--spec @file is read through the context', async () => {
    writeFileSync(join(dir, 'spec.json'), specJson)
    await answerAsksAfter(20)
    const cli = await cliFor()
    await run(cli, 'ask', { spec: `@${join(dir, 'spec.json')}` })
    expect(cli.lines).toHaveLength(2)
  })

  test('SC-28: --timeout-ms hands the deadline to the daemon, which stores timed_out', async () => {
    const cli = await cliFor()
    await run(cli, 'ask', { spec: specJson, 'timeout-ms': 300 })
    const [registered, timedOut] = cli.lines as [{ askId: string }, AskEnvelope]
    expect(timedOut).toEqual({ status: 'timed_out', askId: registered.askId, answers: {}, skipped: ['go'], summary: '' })
    const [ask] = (await (await connectAs(h)).callAny('quirky.ask/list', {})) as { envelope: AskEnvelope }[]
    expect(ask.envelope.status).toBe('timed_out')
  })
  test('Q2: CLI timeout preserves the terminal default summary in the public resolution event', async () => {
    const window = await openWindow(h)
    const cli = await cliFor()
    const timedSpec = JSON.stringify({ questions: [{ id: 'go', type: 'confirm', question: 'Go?', default: true }] })

    await run(cli, 'ask', { spec: timedSpec, 'timeout-ms': 20 })

    const [registered, envelope] = cli.lines as [{ askId: string }, AskEnvelope]
    expect(envelope).toEqual({
      status: 'timed_out',
      askId: registered.askId,
      answers: { go: { value: true, source: 'default' } },
      skipped: [],
      summary: 'Go?: Yes'
    })
    await waitFor(() => window.events.some((event) => event.type === 'quirky.ask/resolved'))
    expect(window.events.find((event) => event.type === 'quirky.ask/resolved')).toMatchObject({
      data: { askId: registered.askId, envelope: { status: 'timed_out', summary: 'Go?: Yes' } }
    })
  })


  test('an ask answered before --timeout-ms is not cancelled', async () => {
    await answerAsksAfter(50)
    const cli = await cliFor()
    await run(cli, 'ask', { spec: specJson, 'timeout-ms': 5000 })
    expect((cli.lines[1] as AskEnvelope).status).toBe('answered')
  })

  test('ask --timeout-ms never cancels or expires from the CLI', async () => {
    const cli = await cliFor()
    const methods: string[] = []
    const call = cli.ctx.call
    cli.ctx.call = async (method, params) => {
      methods.push(method)
      return call(method, params)
    }
    await run(cli, 'ask', { spec: specJson, 'timeout-ms': 150 })
    expect((cli.lines[1] as AskEnvelope).status).toBe('timed_out')
    expect(methods).not.toContain('quirky.ask/cancel')
    expect(methods).not.toContain('quirky.ask/expire')
    expect(methods).toContain('quirky.ask/register')
  })

  test('SC-28: wait --id resumes an abandoned ask and cancel --id prints the envelope', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const cli = await cliFor()
    await run(cli, 'wait', { id: askId, 'timeout-ms': 100 })
    expect(cli.lines).toEqual([{ status: 'timed_out', askId, answers: {}, skipped: ['go'], summary: '' }])

    const second = ((await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }).askId
    const cancelled = await cliFor()
    await run(cancelled, 'cancel', { id: second })
    expect(cancelled.lines).toEqual([{ status: 'declined', askId: second, answers: {}, skipped: [], summary: '' }])
  })
  test('Q2: CLI cancellation flashes the terminal envelope while FIFO promotes the next ask', async () => {
    const caller = await connectAs(h, { sessionId: 'sess_fifo', worktreeId: 'wt_fifo' })
    const window = await openWindow(h)
    const first = (await caller.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const second = (await caller.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    await waitFor(() => window.events.filter((event) => event.type === 'quirky.ask/created').length === 2)

    const cli = await cliFor()
    await run(cli, 'cancel', { id: first.askId })
    expect(cli.lines).toEqual([{ status: 'declined', askId: first.askId, answers: {}, skipped: [], summary: '' }])

    await waitFor(() => window.events.some((event) => event.type === 'quirky.ask/surfaced'))
    const resolvedFirst = window.events.find((event) => event.type === 'quirky.ask/resolved' && (event.data as { askId: string }).askId === first.askId)
    const surfacedSecond = window.events.find((event) => event.type === 'quirky.ask/surfaced')
    expect(resolvedFirst).toMatchObject({ data: { askId: first.askId, envelope: { status: 'declined', summary: '' }, seq: 3 } })
    expect(surfacedSecond).toMatchObject({ data: { ask: { id: second.askId, queued: false }, seq: 4 } })

    const answered = await caller.callAny('quirky.ask/answer', { askId: second.askId, answers: { go: { value: true, source: 'input' } } })
    expect(answered).toMatchObject({ status: 'answered', askId: second.askId, summary: 'Go?: Yes' })
    await waitFor(() => window.events.some((event) => event.type === 'quirky.ask/resolved' && (event.data as { askId: string }).askId === second.askId))
    const askSequences = window.events.flatMap((event) => {
      if (
        event.type !== 'quirky.ask/created' &&
        event.type !== 'quirky.ask/surfaced' &&
        event.type !== 'quirky.ask/resolved'
      ) return []
      if (!('data' in event)) return []
      const data = event.data
      if (typeof data !== 'object' || data === null || Array.isArray(data) || !('seq' in data) || typeof data.seq !== 'number') return []
      return [data.seq]
    })
    expect(askSequences).toEqual([1, 2, 3, 4, 5])
    expect(await caller.callAny('quirky.ask/list', { pendingOnly: true })).toEqual([])
  })


  test('SC-28: wait --id on an answered ask prints the same envelope at once', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const answered = await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: true, source: 'input' } } })
    const cli = await cliFor()
    await run(cli, 'wait', { id: askId })
    expect(cli.lines).toEqual([answered])
  })

  test('Q2: wait retries a typed capacity conflict without reconnecting or expiring the ask', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    const cli = await cliFor()
    const call = cli.ctx.call
    const methods: string[] = []
    const sleeps: number[] = []
    let busy = true
    cli.ctx.call = async (method, params) => {
      methods.push(method)
      if (method === 'quirky.ask/wait' && busy) {
        busy = false
        throw new RpcError(RpcErrorCode.Conflict, 'ask wait capacity is busy', { reason: 'runtime_busy' })
      }
      return call(method, params)
    }
    cli.ctx.sleep = async (ms) => {
      sleeps.push(ms)
      await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: true, source: 'input' } } })
    }

    await run(cli, 'wait', { id: askId, 'timeout-ms': 1000 })

    expect((cli.lines[0] as AskEnvelope).status).toBe('answered')
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[0]).toBeLessThanOrEqual(250)
    expect(cli.reconnects).toBe(0)
    expect(methods).not.toContain('quirky.ask/expire')
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
    await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: true, source: 'input' } } })
    await running
    expect(cli.reconnects).toBeGreaterThanOrEqual(1)
    expect((cli.lines[0] as AskEnvelope).status).toBe('answered')
  })

  test('invalid specs are usage errors naming the field, without contacting the daemon', async () => {
    const cli = await cliFor()
    const bad = JSON.stringify({ questions: [{ id: 'a', type: 'text', question: 'x' }, { id: 'a', type: 'text', question: 'y' }] })
    const error = await rejection(run(cli, 'ask', { spec: bad }))
    expect(error.exit).toBe(2)
    expect(error.message).toBe("questions[1].id: duplicate question id 'a'")
    expect(((await (await connectAs(h)).callAny('quirky.ask/list', {})) as unknown[])).toEqual([])
  })

  test('--timeout-ms below 1 is a usage error', async () => {
    const cli = await cliFor()
    const error = await rejection(run(cli, 'ask', { spec: specJson, 'timeout-ms': 0 }))
    expect(error.exit).toBe(2)
    expect(error.message).toContain('--timeout-ms must be at least 1')
  })

  test('--chunk-ms below 1 is a usage error on both commands', async () => {
    const cli = await cliFor()
    for (const command of ['ask', 'wait'] as const) {
      const error = await rejection(run(cli, command, { spec: specJson, id: 'ask_x', 'chunk-ms': 0 }))
      expect(error.exit).toBe(2)
      expect(error.message).toBe('--chunk-ms must be at least 1')
    }
    const wait = await rejection(run(cli, 'wait', { id: 'ask_x', 'timeout-ms': 0 }))
    expect(wait.message).toBe('--timeout-ms must be at least 1')
    expect(cli.lines).toEqual([])
  })

  test('an unreadable @file and malformed JSON are usage errors', async () => {
    const cli = await cliFor()
    const missing = await rejection(run(cli, 'ask', { spec: `@${join(dir, 'nope.json')}` }))
    expect(missing.exit).toBe(2)
    expect(missing.message).toContain('--spec: cannot read')
    const bad = await rejection(run(cli, 'ask', { spec: '{nope' }))
    expect(bad.message).toStartWith('Invalid JSON for --spec:')
  })
})

const specErrorRows: [name: string, spec: unknown, message: string][] = [
  ['min above max', { questions: [{ id: 'n', type: 'number', question: 'N?', min: 5, max: 1 }] }, 'questions[0].min: min must not exceed max'],
  ['fractional default for an integer', { questions: [{ id: 'n', type: 'number', question: 'N?', integer: true, default: 2.5 }] }, 'questions[0].default: default must be an integer'],
  ['default above max', { questions: [{ id: 'n', type: 'number', question: 'N?', max: 10, default: 11 }] }, 'questions[0].default: default is above max'],
  ['impossible date default', { questions: [{ id: 'd', type: 'date', question: 'D?', default: '2026-02-30' }] }, 'questions[0].default: default must be an ISO 8601 date (YYYY-MM-DD)'],
  ['select default not an option', { questions: [{ id: 's', type: 'select', question: 'S?', options: [{ value: 'a', label: 'A' }], default: 'staging' }] }, 'questions[0].default: default must match one option value'],
  ['nested repetition pattern', { questions: [{ id: 't', type: 'text', question: 'T?', pattern: '(a+)+' }] }, 'questions[0].pattern: pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine'],
  ['default outside the pattern', { questions: [{ id: 't', type: 'text', question: 'T?', pattern: '^[a-z]+$', default: 'ABC' }] }, 'questions[0].default: default does not match pattern'],
  ['unknown format', { questions: [{ id: 't', type: 'text', question: 'T?', format: 'phone' }] }, "questions[0].format: format must be 'email' or 'url'"],
  ['unknown type', { questions: [{ id: 'x', type: 'slider', question: 'X?' }] }, 'questions[0].type: type must be one of select | multiselect | text | number | date | confirm'],
  ['no questions', { questions: [] }, 'questions: at least one question is required'],
  ['eleven questions', { questions: Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, type: 'confirm', question: `Q${i}?` })) }, 'questions: at most 10 questions allowed'],
  ['thirteen options', { questions: [{ id: 's', type: 'select', question: 'S?', options: Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, label: `V${i}` })) }] }, 'questions[0].options: at most 12 options allowed'],
  ['duplicate id', { questions: [{ id: 'a', type: 'confirm', question: 'A?' }, { id: 'a', type: 'confirm', question: 'B?' }] }, "questions[1].id: duplicate question id 'a'"]
]

const credentialRows: [name: string, spec: unknown, message: string][] = [
  ['credential-shaped id', { questions: [{ id: 'db_password', type: 'text', question: 'Value?' }] }, 'questions[0].id: credential-shaped id is not permitted'],
  ['pass in question text', { questions: [{ id: 'p', type: 'text', question: 'Which pass should we use?' }] }, 'questions[0].question: credential-shaped question text is not permitted'],
  ['API key in question text', { questions: [{ id: 'p', type: 'text', question: 'Paste your API key' }] }, 'questions[0].question: credential-shaped question text is not permitted'],
  ['credential-shaped option value', { questions: [{ id: 'p', type: 'select', question: 'Which?', options: [{ value: 'MYSECRET', label: 'One' }] }] }, 'questions[0].options[0].value: credential-shaped option value is not permitted'],
  ['masked flag', { questions: [{ id: 'p', type: 'text', question: 'Value?', masked: false }] }, 'questions[0]: masked/sensitive input is not permitted; collect credentials out of band'],
  [
    'sensitive flag and credential-shaped id',
    { questions: [{ id: 'apiToken', type: 'text', question: 'Value?', sensitive: true }] },
    'questions[0]: masked/sensitive input is not permitted; collect credentials out of band; questions[0].id: credential-shaped id is not permitted'
  ]
]

describe('spec refusals', () => {
  async function expectRefused(spec: unknown, message: string): Promise<void> {
    const cli = await cliFor({ QUIRKY_SESSION_ID: 'sess_1' })
    const error = await rejection(run(cli, 'ask', { spec: JSON.stringify(spec) }))
    expect(error.exit).toBe(2)
    expect(error.message).toBe(message)
    expect(cli.lines).toEqual([])
    expect(await (await connectAs(h)).callAny('quirky.ask/list', {})).toEqual([])
  }

  for (const [name, spec, message] of specErrorRows) {
    test(`SC-2: ${name} is refused with exit 2 and nothing is registered`, () => expectRefused(spec, message))
  }

  test('SC-2: bad JSON is refused with Invalid JSON for --spec', async () => {
    const cli = await cliFor()
    const error = await rejection(run(cli, 'ask', { spec: 'not json' }))
    expect(error.exit).toBe(2)
    expect(error.message).toStartWith('Invalid JSON for --spec:')
    expect(await (await connectAs(h)).callAny('quirky.ask/list', {})).toEqual([])
  })

  test('SC-2: a spec with two problems reports both, joined with "; "', async () => {
    await expectRefused(
      { questions: [{ id: 'n', type: 'number', question: 'N?', min: 5, max: 1 }, { id: 'n', type: 'confirm', question: 'M?' }] },
      "questions[0].min: min must not exceed max; questions[1].id: duplicate question id 'n'"
    )
  })

  for (const [name, spec, message] of credentialRows) {
    test(`SC-3: ${name} is refused with exit 2 and nothing is registered`, () => expectRefused(spec, message))
  }

  test('SC-3: header, label, description and default may say API token', async () => {
    const accepted = {
      questions: [
        {
          id: 'which',
          type: 'select',
          question: 'Which one?',
          header: 'API token',
          options: [{ value: 'a', label: 'API token', description: 'API token' }]
        },
        { id: 'free', type: 'text', question: 'Anything else?', default: 'API token' }
      ]
    }
    const cli = await cliFor({ QUIRKY_SESSION_ID: 'sess_1' })
    await run(cli, 'ask', { spec: JSON.stringify(accepted), 'chunk-ms': 100 })
    expect(cli.lines).toHaveLength(2)
    expect((cli.lines[0] as { status: string }).status).toBe('registered')
    expect((cli.lines[1] as { status: string }).status).toBe('pending')
  })
})

describe('deadlines', () => {
  const colorSpec = {
    questions: [
      { id: 'color', type: 'select', question: 'Color?', options: [{ value: 'blue', label: 'Blue' }, { value: 'red', label: 'Red' }], default: 'blue' },
      { id: 'note', type: 'text', question: 'Note?' },
      { id: 'size', type: 'number', question: 'Size?' },
      { id: 'agree', type: 'confirm', question: 'Agree?', default: true }
    ]
  }

  test('SC-8: at the deadline defaults win, then drafts, then the question is skipped', async () => {
    const window = await openWindow(h)
    const cli = await cliFor()
    const running = run(cli, 'ask', { spec: JSON.stringify(colorSpec), 'timeout-ms': 1500 })
    await Bun.sleep(150)
    const registered = cli.lines[0] as { status: string; askId: string }
    expect(registered.status).toBe('registered')
    const saver = await connectAs(h)
    await saver.callAny('quirky.ask/updatePartial', {
      askId: registered.askId,
      partial: { note: { draft: 'typed draft before the timeout' }, size: { draft: 'abc' } }
    })
    await running
    expect(cli.lines).toHaveLength(2)
    expect(cli.lines[1]).toEqual({
      status: 'timed_out',
      askId: registered.askId,
      answers: {
        color: { value: 'blue', label: 'Blue', source: 'default' },
        note: { value: 'typed draft before the timeout', source: 'input' },
        agree: { value: true, source: 'default' }
      },
      skipped: ['size'],
      summary: 'Color?: Blue\nNote?: typed draft before the timeout\nAgree?: Yes'
    })
    const [ask] = (await saver.callAny('quirky.ask/list', {})) as { envelope: AskEnvelope }[]
    expect(ask.envelope.status).toBe('timed_out')
    const resolved = window.events.filter((event) => event.type === 'quirky.ask/resolved')
    expect(resolved).toHaveLength(1)
    expect((resolved[0] as any).data.envelope.status).toBe('timed_out')
  }, 10_000)

  test('SC-10: wait --timeout-ms times the ask out with the same rules', async () => {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: deploy })) as { askId: string }
    const cli = await cliFor()
    const startedAt = Date.now()
    await run(cli, 'wait', { id: askId, 'timeout-ms': 500 })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450)
    const envelope = cli.lines[0] as AskEnvelope
    expect(envelope).toMatchObject({
      status: 'timed_out',
      askId,
      answers: {
        env: { value: 'dev', label: 'Dev', source: 'default' },
        go: { value: true, source: 'default' }
      },
      skipped: ['replicas', 'ship']
    })
    expect(Object.keys(envelope.answers)).toEqual(['env', 'go'])
    const [ask] = (await asker.callAny('quirky.ask/list', {})) as { envelope: AskEnvelope }[]
    expect(ask.envelope).toEqual(envelope)
    expect(await asker.callAny('quirky.ask/expire', { askId })).toEqual(envelope)
  })

  test('the wait loop calls the daemon in chunks of at most 60000 ms and stops at the smaller limit', async () => {
    let clock = 0
    const calls: [string, Record<string, unknown>][] = []
    const cli = await cliFor({}, { now: () => clock, sleep: async () => {} })
    cli.ctx.call = async (method, params = {}) => {
      calls.push([method, params])
      if (method === 'quirky.ask/wait') {
        clock += params.timeoutMs as number
        return { status: 'pending', askId: 'ask_x', answers: {}, skipped: [], summary: '' }
      }
      return { status: 'timed_out', askId: 'ask_x', answers: {}, skipped: [], summary: '' }
    }
    await run(cli, 'wait', { id: 'ask_x', 'chunk-ms': 150_000 })
    expect(calls.map(([, params]) => params.timeoutMs)).toEqual([60_000, 60_000, 30_000])
    expect(cli.lines).toEqual([{ status: 'pending', askId: 'ask_x', instruction: 'quirky ask wait --id ask_x' }])

    calls.length = 0
    clock = 0
    cli.lines.length = 0
    await run(cli, 'wait', { id: 'ask_x', 'timeout-ms': 90_000, 'chunk-ms': 200_000 })
    expect(calls.map(([method, params]) => [method, params.timeoutMs])).toEqual([
      ['quirky.ask/wait', 60_000],
      ['quirky.ask/wait', 30_000],
      ['quirky.ask/expire', undefined]
    ])
    expect((cli.lines[0] as AskEnvelope).status).toBe('timed_out')

    calls.length = 0
    clock = 0
    cli.lines.length = 0
    await run(cli, 'wait', { id: 'ask_x', 'timeout-ms': 200_000, 'chunk-ms': 70_000 })
    expect(calls.map(([method, params]) => [method, params.timeoutMs])).toEqual([
      ['quirky.ask/wait', 60_000],
      ['quirky.ask/wait', 10_000]
    ])
    expect((cli.lines[0] as { status: string }).status).toBe('pending')
  })

  test('the earlier limit wins even when a failed call carries the clock past both', async () => {
    let clock = 0
    const calls: string[] = []
    const cli = await cliFor({}, { now: () => clock, sleep: async (ms) => { clock += ms } })
    cli.ctx.call = async (method) => {
      calls.push(method)
      if (method === 'quirky.ask/wait') throw new Error('connection lost')
      return { status: 'timed_out', askId: 'ask_x', answers: {}, skipped: [], summary: '' }
    }
    await run(cli, 'wait', { id: 'ask_x', 'chunk-ms': 100, 'timeout-ms': 200 })
    expect(calls).toEqual(['quirky.ask/wait'])
    expect(cli.lines).toEqual([{ status: 'pending', askId: 'ask_x', instruction: 'quirky ask wait --id ask_x' }])

    calls.length = 0
    cli.lines.length = 0
    clock = 0
    await run(cli, 'wait', { id: 'ask_x', 'chunk-ms': 300, 'timeout-ms': 200 })
    expect(calls).toEqual(['quirky.ask/wait', 'quirky.ask/expire'])
    expect((cli.lines[0] as AskEnvelope).status).toBe('timed_out')
  })
})

describe('--chunk-ms', () => {
  async function pendingAsk(): Promise<{ asker: QuirkyClient; askId: string }> {
    const asker = await connectAs(h)
    const { askId } = (await asker.callAny('quirky.ask/create', { spec: confirmSpec })) as { askId: string }
    return { asker, askId }
  }

  test('SC-20: ask returns a pending envelope after the chunk and leaves the ask answerable', async () => {
    const cli = await cliFor()
    const startedAt = Date.now()
    await run(cli, 'ask', { spec: specJson, 'chunk-ms': 300 })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
    const [registered, pending] = cli.lines as [{ status: string; askId: string }, Record<string, unknown>]
    expect(registered).toEqual({ status: 'registered', askId: registered.askId })
    expect(registered.askId).toMatch(/^ask_/)
    expect(pending).toEqual({ status: 'pending', askId: registered.askId, instruction: `quirky ask wait --id ${registered.askId}` })
    expect(Object.keys(pending)).toEqual(['status', 'askId', 'instruction'])
    const asker = await connectAs(h)
    const [ask] = (await asker.callAny('quirky.ask/list', {})) as { envelope: AskEnvelope }[]
    expect(ask.envelope.status).toBe('pending')
    const answered = (await asker.callAny('quirky.ask/answer', { askId: registered.askId, answers: { go: { value: true, source: 'input' } } })) as AskEnvelope
    expect(answered.status).toBe('answered')
  })

  test('SC-20: wait --chunk-ms repeats the pending line, then prints the final envelope at once', async () => {
    const { asker, askId } = await pendingAsk()
    const first = await cliFor()
    await run(first, 'wait', { id: askId, 'chunk-ms': 300 })
    expect(first.lines).toEqual([{ status: 'pending', askId, instruction: `quirky ask wait --id ${askId}` }])

    const answered = await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: true, source: 'input' } } })
    const second = await cliFor()
    const startedAt = Date.now()
    await run(second, 'wait', { id: askId, 'chunk-ms': 300 })
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(second.lines).toEqual([answered])
  })

  test('SC-20: without --chunk-ms both commands wait until the ask ends', async () => {
    const { asker, askId } = await pendingAsk()
    const waiting = await cliFor()
    const running = run(waiting, 'wait', { id: askId })
    const asking = await cliFor()
    const askRunning = run(asking, 'ask', { spec: specJson })
    await Bun.sleep(600)
    expect(waiting.lines).toEqual([])
    expect(asking.lines).toHaveLength(1)
    const own = (asking.lines[0] as { askId: string }).askId
    await asker.callAny('quirky.ask/answer', { askId, answers: { go: { value: true, source: 'input' } } })
    await asker.callAny('quirky.ask/answer', { askId: own, answers: { go: { value: false, source: 'input' } } })
    await Promise.all([running, askRunning])
    expect((waiting.lines[0] as AskEnvelope).status).toBe('answered')
    expect(asking.lines).toHaveLength(2)
    expect((asking.lines[1] as AskEnvelope).answers).toEqual({ go: { value: false, source: 'input' } })
  })

  test('SC-20: the real quirky binary prints the same two lines', async () => {
    const userHome = mkdtempSync(join(tmpdir(), 'qa-cli-home-'))
    try {
      const proc = Bun.spawn([process.execPath, CLI_MAIN, 'ask', '--spec', specJson, '--chunk-ms', '300'], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: userHome, QUIRKY_HOME: h.home },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20_000
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const lines = stdout.trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toHaveLength(2)
      const askId = lines[0].askId as string
      expect(lines[0]).toEqual({ status: 'registered', askId })
      expect(askId).toMatch(/^ask_/)
      expect(lines[1]).toEqual({ status: 'pending', askId, instruction: `quirky ask wait --id ${askId}` })
    } finally {
      rmSync(userHome, { recursive: true, force: true })
    }
  }, 30_000)
})
