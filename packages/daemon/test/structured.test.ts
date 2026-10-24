import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  RpcErrorCode,
  type QuirkyClient,
  type QuirkyEvent,
  type RpcError,
  type Session,
  type Worktree
} from '@quirky/protocol'
import {
  createStubRunner,
  type StructuredContext,
  type StructuredRunner
} from '../src/structured/runner'
import { startHarness, waitFor, type Harness, waitForAsync } from './helpers'

class FakeRunner implements StructuredRunner {
  started: { session: Session; prompt: string }[] = []
  sent: { sessionId: string; text: string }[] = []
  stopped: string[] = []
  constructor(readonly context: StructuredContext) {}
  async start(session: Session, prompt: string) {
    this.started.push({ session, prompt })
    this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
    this.context.setStatus(session.id, 'working')
  }
  async send(sessionId: string, text: string) {
    this.sent.push({ sessionId, text })
    this.context.appendMessage({ sessionId, role: 'user', text, data: { n: 1 } })
  }
  async stop(sessionId: string) {
    this.stopped.push(sessionId)
  }
}

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]
let worktree: Worktree
let runner: FakeRunner

async function setup(factory?: Parameters<typeof startHarness>[0]) {
  h = await startHarness({
    runnerFactory: (context) => (runner = new FakeRunner(context)),
    resolveClaudePath: async () => '/usr/local/bin/claude',
    ...factory
  })
  h.git.addRepo('/fake/alpha')
  ;({ client, events } = await h.connectWithEvents('cli'))
  const repo = await client.call('repo.add', { path: '/fake/alpha' })
  ;[worktree] = await client.call('worktree.list', { repoId: repo.id })
}

afterEach(() => h.cleanup())

describe('structured sessions with a runner', () => {
  beforeEach(() => setup())

  test('createStructured stores the session and starts the runner', async () => {
    const session = await client.call('session.createStructured', {
      worktreeId: worktree.id,
      agent: 'claude',
      prompt: 'fix the bug'
    })
    expect(session).toMatchObject({ kind: 'structured', agent: 'claude', worktreeId: worktree.id, cwd: '/fake/alpha' })
    await waitFor(() => runner.started.length === 1)
    expect(runner.started[0].prompt).toBe('fix the bug')
    expect(runner.started[0].session.id).toBe(session.id)
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
    await waitForAsync(async () => (await client.call('session.list', {}))[0].status === 'working')
  })

  test('messages are stored, emitted and read back after a seq', async () => {
    const session = await client.call('session.createStructured', {
      worktreeId: worktree.id,
      agent: 'claude',
      prompt: 'go'
    })
    await waitFor(() => runner.started.length === 1)
    await client.call('structured.send', { sessionId: session.id, text: 'more' })
    expect(runner.sent).toEqual([{ sessionId: session.id, text: 'more' }])

    const all = await client.call('structured.messages', { sessionId: session.id })
    expect(all.map((m) => [m.seq, m.role, m.text])).toEqual([
      [1, 'user', 'go'],
      [2, 'user', 'more']
    ])
    expect(all[1].data).toEqual({ n: 1 })
    const after = await client.call('structured.messages', { sessionId: session.id, afterSeq: 1 })
    expect(after.map((m) => m.seq)).toEqual([2])
    const emitted = events.filter((e) => e.type === 'structured.message')
    expect(emitted).toHaveLength(2)
  })

  test('runner status updates notify on done and closing stops the runner', async () => {
    const session = await client.call('session.createStructured', {
      worktreeId: worktree.id,
      agent: 'claude',
      prompt: 'go'
    })
    await waitFor(() => runner.started.length === 1)
    runner.context.setStatus(session.id, 'done')
    await waitFor(() => h.notifications.length === 1)
    expect(h.notifications[0]).toEqual({ title: 'main', body: 'Claude finished' })
    await client.call('session.close', { sessionId: session.id })
    expect(runner.stopped).toEqual([session.id])
    expect(h.pty.requests.some((r) => r.type === 'forget')).toBe(false)
    expect(await client.call('session.list', {})).toEqual([])
  })

  test('runner asks resolve when the ask is answered', async () => {
    const session = await client.call('session.createStructured', {
      worktreeId: worktree.id,
      agent: 'claude',
      prompt: 'go'
    })
    const pending = runner.context.createAsk(
      { questions: [{ id: 'ok', type: 'confirm', question: 'Run rm?' }] },
      session.id
    )
    const ask = await waitForAsync(async () => (await client.call('ask.list', { pendingOnly: true }))[0])
    expect(ask).toMatchObject({ sessionId: session.id, worktreeId: worktree.id })
    await client.call('ask.answer', { askId: ask.id, answers: { ok: { value: true, source: 'input' } } })
    expect((await pending).status).toBe('answered')
    expect(await runner.context.resolveClaudePath()).toBe('/usr/local/bin/claude')
  })

  test('validates agent and session kind', async () => {
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise
      } catch (error) {
        return (error as RpcError).code
      }
    }
    expect(
      await code(client.call('session.createStructured', { worktreeId: worktree.id, agent: 'codex', prompt: 'x' }))
    ).toBe(RpcErrorCode.InvalidParams)
    const terminal = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    expect(await code(client.call('structured.send', { sessionId: terminal.id, text: 'x' }))).toBe(
      RpcErrorCode.InvalidParams
    )
    expect(await code(client.call('structured.messages', { sessionId: 's_nope' }))).toBe(RpcErrorCode.NotFound)
    expect(await code(client.call('terminal.attach', { sessionId: 's_nope', cols: 1, rows: 1 }))).toBe(
      RpcErrorCode.NotFound
    )
  })
})

describe('stub runner', () => {
  beforeEach(() => setup({ runnerFactory: createStubRunner }))

  test('reports that structured sessions are unavailable', async () => {
    const session = await client.call('session.createStructured', {
      worktreeId: worktree.id,
      agent: 'claude',
      prompt: 'x'
    })
    const messages = await waitForAsync(async () => {
      const found = await client.call('structured.messages', { sessionId: session.id })
      return found.length > 0 && found
    })
    expect(messages[0].text).toContain('structured sessions are not available in this build')
    await waitForAsync(async () => (await client.call('session.list', {}))[0].status === 'exited')
    await expect(client.call('structured.send', { sessionId: session.id, text: 'x' })).rejects.toThrow(
      'structured sessions are not available in this build'
    )
  })
})
