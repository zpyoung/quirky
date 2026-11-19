import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcErrorCode, type ProcessSpawner, type Session, type StructuredMessage } from '@quirky/protocol'
import { createProcessRunner } from '../../../packages/process/src/api'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { createClaudeRunner } from '../claude-runner'
import { createCodexRunner } from '../codex-runner'
import { capabilitiesFor } from '../capabilities'
import { createPiRunner } from '../pi-runner'
import type { NewStructuredMessage, StructuredContext } from '../runner'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'
import { createCodexAppServerFixture, isolatedProviderEnvironment } from './fakes/codex-app-server'

const noSpawn: ProcessSpawner = {
  spawn() {
    throw new Error('must not spawn')
  }
}

function bareContext(extra: Partial<StructuredContext> = {}): StructuredContext {
  const messages: StructuredMessage[] = []
  return {
    process: noSpawn,
    appendMessage: (message: NewStructuredMessage) => {
      const stored = { ...message, seq: messages.length + 1, at: Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus() {},
    async createAsk() {
      throw new Error('no asks')
    },
    async cancelAsk() {},
    async setProviderSession() {},
    resolveClaudePath: async () => '/bin/claude',
    resolveCodexPath: async () => '/bin/codex',
    resolvePiPath: async () => '/bin/pi',
    ...extra
  }
}

describe('runner fork', () => {
  test('claude forks through the SDK in the source folder and reports the new id', async () => {
    const calls: { id: string; options?: { dir?: string } }[] = []
    const runner = createClaudeRunner(bareContext(), {
      forkSession: async (id, options) => {
        calls.push({ id, ...(options === undefined ? {} : { options }) })
        return { sessionId: 'claude-forked' }
      }
    })
    const forked = await runner.fork!({ providerSession: { id: 'claude-src', transcriptPath: null }, cwd: '/work/tree', launchOptions: {} })
    expect(forked).toEqual({ id: 'claude-forked', transcriptPath: null })
    expect(calls).toEqual([{ id: 'claude-src', options: { dir: '/work/tree' } }])
  })

  test('claude surfaces an SDK failure as the thrown message', async () => {
    const runner = createClaudeRunner(bareContext(), {
      forkSession: async () => {
        throw new Error('Session claude-src not found')
      }
    })
    await expect(runner.fork!({ providerSession: { id: 'claude-src', transcriptPath: null }, cwd: '/w', launchOptions: {} })).rejects.toThrow('Session claude-src not found')
  })

  test('codex forks the thread over its own app-server and leaves the source thread alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-fork-'))
    const fixture = createCodexAppServerFixture(home)
    const processRunner = createProcessRunner({ owner: 'fork-test' })
    const runner = createCodexRunner(bareContext({ process: processRunner, resolveCodexPath: async () => fixture.executable }), { env: isolatedProviderEnvironment(home) })
    try {
      const forked = await runner.fork!({ providerSession: { id: 'thread-src', transcriptPath: null }, cwd: home, launchOptions: {} })
      expect(forked).toEqual({ id: 'forked-thread-src', transcriptPath: '/rollouts/forked-thread-src.jsonl' })
      const methods = fixture.requests().map((request) => request.method)
      expect(methods).toContain('thread/fork')
      expect(methods).not.toContain('thread/resume')
      expect(methods).not.toContain('turn/start')
      expect(fixture.requests().find((request) => request.method === 'thread/fork')?.params).toMatchObject({ threadId: 'thread-src' })
    } finally {
      await processRunner.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('pi and omp have no fork and say so in their capability', () => {
    for (const agent of ['pi', 'omp'] as const) {
      expect(createPiRunner(bareContext(), agent).fork).toBeUndefined()
      expect(capabilitiesFor(agent)!.fork).toEqual({ ok: false, reason: `${agent} can't fork from Quirky yet` })
    }
  })

  test('the fork capability is ok exactly for runners that implement fork', () => {
    expect(capabilitiesFor('claude')!.fork).toEqual({ ok: true })
    expect(capabilitiesFor('codex')!.fork).toEqual({ ok: true })
  })
})

describe('quirky.structured/fork', () => {
  let chat: ChatBoot | undefined
  afterEach(async () => {
    await teardownChat(chat)
    chat = undefined
  })

  async function prepared(options: { title?: string; titleCustom?: boolean; agent?: Session['agent']; status?: Session['status'] } = {}) {
    const home = mkdtempSync('/tmp/qs-')
    chat = await bootChat({ home })
    chat.world.worktree.path = home
    const source = await chat.create()
    await waitFor(() => chat!.runner.started.length === 1)
    const record = chat.world.sessions.get(source.id)!
    record.providerSession = { id: 'provider-src', transcriptPath: '/t/src.jsonl' }
    record.title = options.title ?? 'Source chat'
    if (options.titleCustom) record.titleCustom = true
    if (options.agent) record.agent = options.agent
    record.status = options.status ?? 'done'
    chat.runner.context.setStatus(source.id, record.status)
    record.launchSettings = { agent: 'claude', options: { model: { value: 'opus', source: 'user' } }, args: null } as unknown as Session['launchSettings']
    return { source, record, chat }
  }

  test('registers a forked record with its title, lineage and launch settings', async () => {
    const { source, record, chat } = await prepared({ title: 'Plan the thing' })
    const forked = (await chat.call('quirky.structured/fork', { session: source.id })) as Session
    expect(forked).toMatchObject({ resumedFrom: source.id, forked: true, title: 'Plan the thing (fork)', launchSettings: record.launchSettings })
    expect(forked.titleCustom).toBeUndefined()
    const registered = chat.world.registerCalls.at(-1)!
    expect(registered).toMatchObject({ resumedFrom: source.id, forked: true, title: 'Plan the thing (fork)', kind: 'structured' })
    expect(registered.titleCustom).toBeUndefined()
  })

  test('carries a user-set title flag onto the fork', async () => {
    const { source, chat } = await prepared({ title: 'Mine', titleCustom: true })
    const forked = (await chat.call('quirky.structured/fork', { session: source.id })) as Session
    expect(forked).toMatchObject({ title: 'Mine (fork)', titleCustom: true })
  })

  test('starts the runner on the new provider conversation with no prompt, and leaves the source alone', async () => {
    const { source, record, chat } = await prepared()
    const before = JSON.stringify(record)
    const forked = (await chat.call('quirky.structured/fork', { session: source.id })) as Session
    await waitFor(() => chat.runner.started.some((entry) => entry.sessionId === forked.id))
    const start = chat.runner.started.find((entry) => entry.sessionId === forked.id)!
    expect(start.options.providerSession).toEqual({ id: 'provider-forked', transcriptPath: null })
    expect(chat.runner.forks).toEqual([{ providerSession: { id: 'provider-src', transcriptPath: '/t/src.jsonl' }, cwd: record.cwd, launchOptions: expect.any(Object) }])
    expect(chat.runner.sent).toEqual([])
    expect(JSON.stringify(chat.world.sessions.get(source.id))).toBe(before)
    expect(chat.runner.started.filter((entry) => entry.sessionId === source.id)).toHaveLength(1)
    // the source's owner key is untouched, so the source can still be resumed after a stop
    await chat.call('quirky.structured/stop', { session: forked.id })
  })

  test('the fork reports only its own spend, even on a Claude result that includes the parent', async () => {
    const { source, chat } = await prepared()
    const ctx = chat.runner.context
    ctx.appendMessage({
      sessionId: source.id,
      role: 'result',
      text: 'done',
      data: { type: 'result', modelUsage: { m: { inputTokens: 30, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6 } } }
    })
    ctx.reportUsage!(source.id, { tokens: { input: 30, output: 4, cacheRead: 5, cacheWrite: 6 }, turnEnded: true })
    const forked = (await chat.call('quirky.structured/fork', { session: source.id })) as Session
    await waitFor(() => chat.runner.started.some((entry) => entry.sessionId === forked.id))
    expect(chat.runner.started.find((entry) => entry.sessionId === forked.id)!.options.usageBaseline).toEqual({ input: 30, output: 4, cacheRead: 5, cacheWrite: 6 })
    expect((await chat.call('quirky.structured/usage', { session: forked.id })).conversation).toBeNull()
    ctx.reportUsage!(forked.id, { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, turnEnded: true })
    const usage = await chat.call('quirky.structured/usage', { session: forked.id })
    expect(usage.conversation).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 })
    expect((await chat.call('quirky.structured/usage', { session: source.id })).conversation.total).toBe(45)
  })

  test('a send during the provider copy is queued, then goes out once the fork is done', async () => {
    const { source, chat } = await prepared()
    const gate = Promise.withResolvers<void>()
    chat.runner.forkGate = gate.promise
    const forking = chat.call('quirky.structured/fork', { session: source.id })
    await waitFor(() => chat.runner.forks.length === 1)
    const result = await chat.call('quirky.structured/send', { session: source.id, text: 'mid-fork' })
    expect(result).toMatchObject({ ok: true, queuedId: expect.any(String) })
    expect(chat.runner.sent).toEqual([])
    gate.resolve()
    await forking
    await waitFor(() => chat.runner.sent.length === 1)
    expect(chat.runner.sent[0]).toMatchObject({ sessionId: source.id, text: 'mid-fork' })
  })

  for (const status of ['working', 'waiting'] as const) {
    test(`refuses a ${status} source with turn-running`, async () => {
      const { source, chat } = await prepared({ status })
      const error = await chat.failure(chat.call('quirky.structured/fork', { session: source.id }))
      expect(error).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'turn-running' } })
      expect(chat.runner.forks).toEqual([])
    })
  }

  test('refuses an agent whose capability is not ok with fork-unsupported', async () => {
    const { source, chat } = await prepared({ agent: 'pi' })
    const error = await chat.failure(chat.call('quirky.structured/fork', { session: source.id }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'fork-unsupported' } })
    expect(error.message).toContain("pi can't fork")
  })

  test('turns a runner failure into a conflict carrying its message', async () => {
    const { source, chat } = await prepared()
    chat.runner.forkError = new Error('Session provider-src not found')
    const error = await chat.failure(chat.call('quirky.structured/fork', { session: source.id }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Session provider-src not found' })
    expect(chat.world.registerCalls.filter((call) => call.forked === true)).toEqual([])
  })

  test('rejects a source with no provider conversation and a non-structured source', async () => {
    const { source, record, chat } = await prepared()
    record.providerSession = null
    expect(await chat.failure(chat.call('quirky.structured/fork', { session: source.id }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    const terminal = chat.world.addTerminalSession()
    expect(await chat.failure(chat.call('quirky.structured/fork', { session: terminal.id }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
  })
})
