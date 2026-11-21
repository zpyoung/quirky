import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcErrorCode, type ProcessSpawner, type Session, type StructuredMessage, type UsageReport, type UsageSummary } from '@quirky/protocol'
import { createProcessRunner } from '../../../packages/process/src/api'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import { createCodexRunner } from '../codex-runner'
import { createPiRunner } from '../pi-runner'
import type { NewStructuredMessage, StructuredContext } from '../runner'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'
import { createCodexAppServerFixture, isolatedProviderEnvironment } from './fakes/codex-app-server'
import { FakeQuery } from './fakes/fake-query'
import { fakePiTransports } from './fakes/pi-transport'
import { FakeWorld } from './fakes/world'

const FIVE_MIN = 300_000
const ONE_HOUR = 3_600_000

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

function recordingContext(extra: Partial<StructuredContext> = {}) {
  const reports: { sessionId: string; report: UsageReport }[] = []
  const messages: StructuredMessage[] = []
  const noSpawn: ProcessSpawner = {
    spawn() {
      throw new Error('must not spawn')
    }
  }
  const context: StructuredContext = {
    process: noSpawn,
    appendMessage(message: NewStructuredMessage) {
      const stored = { ...message, seq: messages.length + 1, at: message.at ?? Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus() {},
    async cancelAsk() {},
    createAsk: () => new Promise(() => {}),
    async setProviderSession() {},
    resolveClaudePath: async () => '/not-used/claude',
    resolveCodexPath: async () => '/not-used/codex',
    resolvePiPath: async () => '/fake/bin/pi',
    reportUsage: (sessionId, report) => void reports.push({ sessionId, report }),
    ...extra
  }
  return { context, reports, messages }
}

const session = (agent: Session['agent'], id = 's_1'): Session => ({
  id,
  kind: 'structured',
  agent,
  worktreeId: 'wt_1',
  cwd: '/work/tree',
  title: 'x',
  status: 'starting',
  createdAt: 1,
  lastActivityAt: 1,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
})

const tokensOf = (reports: { report: UsageReport }[]) => reports.flatMap(({ report }) => (report.tokens ? [report.tokens] : []))

describe('Claude usage reports', () => {
  function claude(startOptions: Parameters<ReturnType<typeof createClaudeRunner>['start']>[2] = {}) {
    const rec = recordingContext()
    const queries: FakeQuery[] = []
    const plansDir = mkdtempSync(join(tmpdir(), 'plans-'))
    const runner = createClaudeRunner(rec.context, {
      plansDir,
      query: (params: ClaudeQueryParams) => {
        const query = new FakeQuery(params)
        queries.push(query)
        return query
      }
    })
    const start = async (prompt = 'hi') => {
      await runner.start(session('claude'), prompt, startOptions)
      return queries[0]!
    }
    return { ...rec, runner, start, plansDir }
  }

  test('maps a result to per-category deltas against the previous result', async () => {
    const c = claude()
    const query = await c.start()
    query.emit({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        a: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 10 },
        b: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 2 }
      }
    })
    await until(() => c.reports.length === 1)
    expect(c.reports[0]!.report).toEqual({ turnEnded: true, tokens: { input: 105, output: 21, cacheRead: 50, cacheWrite: 12 } })
    await c.runner.send('s_1', 'again')
    query.emit({
      type: 'result',
      subtype: 'success',
      modelUsage: { a: { inputTokens: 130, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 10 } }
    })
    await until(() => c.reports.length === 2)
    // a category that went down is clamped to zero, never negative
    expect(c.reports[1]!.report.tokens).toEqual({ input: 25, output: 9, cacheRead: 0, cacheWrite: 0 })
    rmSync(c.plansDir, { recursive: true, force: true })
  })

  test('falls back to usage when there is no modelUsage', async () => {
    const c = claude()
    const query = await c.start()
    query.emit({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }
    })
    await until(() => c.reports.length === 1)
    expect(c.reports[0]!.report.tokens).toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 1 })
    rmSync(c.plansDir, { recursive: true, force: true })
  })

  test('the first result after a resume reports only the new spend, not the predecessor history', async () => {
    const c = claude({
      providerSession: { id: 'prev', transcriptPath: null },
      usageBaseline: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 }
    })
    const query = await c.start('')
    query.emit({
      type: 'result',
      subtype: 'success',
      modelUsage: { a: { inputTokens: 1010, outputTokens: 230, cacheReadInputTokens: 500, cacheCreationInputTokens: 150 } }
    })
    await until(() => c.reports.length === 1)
    expect(c.reports[0]!.report.tokens).toEqual({ input: 10, output: 30, cacheRead: 0, cacheWrite: 50 })
    rmSync(c.plansDir, { recursive: true, force: true })
  })

  test('main-thread assistant messages report cache tiers and reads; subagent messages do not', async () => {
    const c = claude()
    const query = await c.start()
    const before = Date.now()
    query.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        usage: { cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 }, cache_read_input_tokens: 0 }
      }
    })
    query.emit({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }], usage: { cache_read_input_tokens: 999 } }
    })
    await until(() => c.reports.length === 1)
    const first = c.reports[0]!.report.cache!
    expect(first.callStartedAt).toBeGreaterThanOrEqual(before - 1000)
    expect(first).toMatchObject({ wrote5m: 40, wrote1h: 60, read: 0 })

    await Bun.sleep(20)
    const toolResultAt = Date.now()
    query.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
    query.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { cache_read_input_tokens: 90 } }
    })
    await until(() => c.reports.length === 2)
    const second = c.reports[1]!.report.cache!
    expect(second).toMatchObject({ wrote5m: 0, wrote1h: 0, read: 90 })
    expect(second.callStartedAt).toBeGreaterThanOrEqual(toolResultAt)
    expect(second.callStartedAt).toBeGreaterThan(first.callStartedAt)
    rmSync(c.plansDir, { recursive: true, force: true })
  })
})

describe('Codex usage reports', () => {
  test('maps last-call counts to input, output, cache read and ends the turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-usage-'))
    const fixture = createCodexAppServerFixture(home)
    const processRunner = createProcessRunner({ owner: 'usage-test' })
    const rec = recordingContext({ process: processRunner, resolveCodexPath: async () => fixture.executable })
    const marker = "  notify('turn/started', { threadId, turn })"
    writeFileSync(
      fixture.executable,
      readFileSync(fixture.executable, 'utf8').replace(
        marker,
        `${marker}
  notify('thread/tokenUsage/updated', { threadId, tokenUsage: {
    total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 8, reasoningOutputTokens: 4 },
    last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 8, reasoningOutputTokens: 4 }
  } })`
      )
    )
    const runner = createCodexRunner(rec.context, { env: isolatedProviderEnvironment(home) })
    try {
      await runner.start({ ...session('codex'), cwd: home }, 'go')
      await until(() => rec.reports.some(({ report }) => report.turnEnded))
      expect(rec.reports.map(({ report }) => report)).toEqual([
        { tokens: { input: 92, output: 24, cacheRead: 8, cacheWrite: 0 } },
        { turnEnded: true }
      ])
      expect(rec.reports.every(({ report }) => report.cache === undefined)).toBe(true)
    } finally {
      await runner.stop('s_1')
      await processRunner.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

for (const variant of ['pi', 'omp'] as const) {
  describe(`${variant} usage reports`, () => {
    test('each assistant message_end reports its own usage and the finished turn is counted', async () => {
      const rec = recordingContext()
      const fake = fakePiTransports({})
      const runner = createPiRunner(rec.context, variant, { transport: fake.factory, env: {} })
      await runner.start(session(variant), 'hello')
      const transport = fake.last()
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 } } })
      transport.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } })
      transport.emit(
        variant === 'pi' ? { type: 'agent_settled' } : { type: 'agent_end', messages: [], isTerminal: true, yielded: true }
      )
      expect(rec.reports.map(({ report }) => report)).toEqual([
        { tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 } },
        { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
        { turnEnded: true }
      ])
      await runner.stop('s_1')
    })
  })
}

describe('usage summary in the plugin', () => {
  let chat: ChatBoot | undefined
  afterEach(async () => {
    await teardownChat(chat)
    chat = undefined
  })

  const summaryEvents = (boot: ChatBoot) =>
    boot.events.filter((e) => e.type === 'quirky.structured/usageChanged').map((e) => (e as { data: { sessionId: string; summary: UsageSummary } }).data)

  const tokens = (n: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n })

  test('folds deltas into own totals, counts turns, emits usageChanged and answers usage', async () => {
    chat = await bootChat()
    const s = await chat.create()
    const ctx = chat.runner.context
    expect(await chat.call('quirky.structured/usage', { session: s.id })).toEqual({ own: null, conversation: null, turns: 0, cache: null, subagentTokens: 0 })
    ctx.reportUsage!(s.id, { tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 } })
    ctx.reportUsage!(s.id, { tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, turnEnded: true })
    await waitFor(() => summaryEvents(chat!).length === 2)
    const last = summaryEvents(chat).at(-1)!
    expect(last.sessionId).toBe(s.id)
    expect(last.summary).toMatchObject({ sessionId: s.id, turns: 1, cache: null, own: { input: 11, output: 6, cacheRead: 4, cacheWrite: 3, total: 24 } })
    expect(await chat.call('quirky.structured/usage', { session: s.id })).toEqual({
      own: { input: 11, output: 6, cacheRead: 4, cacheWrite: 3, total: 24 },
      conversation: { input: 11, output: 6, cacheRead: 4, cacheWrite: 3, total: 24 },
      turns: 1,
      cache: null,
      subagentTokens: 0
    })
  })

  test('an unknown session is invalid-params', async () => {
    chat = await bootChat()
    const error = await chat.failure(chat.call('quirky.structured/usage', { session: 'nope' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })

  describe('cache tiers', () => {
    const cacheOf = async (boot: ChatBoot, id: string) => (await boot.call('quirky.structured/usage', { session: id })).cache
    const report = (boot: ChatBoot, id: string, cache: NonNullable<UsageReport['cache']>) => boot.runner.context.reportUsage!(id, { cache })
    const T = 1_000_000

    test('a write anchors its tier at the call start; a never-written tier stays absent', async () => {
      chat = await bootChat()
      const s = await chat.create()
      report(chat, s.id, { callStartedAt: T, wrote5m: 10, wrote1h: 0, read: 0 })
      expect(await cacheOf(chat, s.id)).toEqual({ tiers: [{ ttlMs: FIVE_MIN, anchorAt: T }] })
    })

    test('a 1h-only write creates only the 1h tier', async () => {
      chat = await bootChat()
      const s = await chat.create()
      report(chat, s.id, { callStartedAt: T, wrote5m: 0, wrote1h: 10, read: 0 })
      expect(await cacheOf(chat, s.id)).toEqual({ tiers: [{ ttlMs: ONE_HOUR, anchorAt: T }] })
    })

    test('a read refreshes every tier still warm at the call start', async () => {
      chat = await bootChat()
      const s = await chat.create()
      report(chat, s.id, { callStartedAt: T, wrote5m: 10, wrote1h: 10, read: 0 })
      report(chat, s.id, { callStartedAt: T + 60_000, wrote5m: 0, wrote1h: 0, read: 5 })
      expect(await cacheOf(chat, s.id)).toEqual({
        tiers: [
          { ttlMs: FIVE_MIN, anchorAt: T + 60_000 },
          { ttlMs: ONE_HOUR, anchorAt: T + 60_000 }
        ]
      })
    })

    test('a read refreshes only the tier that is still warm', async () => {
      chat = await bootChat()
      const s = await chat.create()
      report(chat, s.id, { callStartedAt: T, wrote5m: 10, wrote1h: 10, read: 0 })
      report(chat, s.id, { callStartedAt: T + FIVE_MIN + 1, wrote5m: 0, wrote1h: 0, read: 5 })
      expect(await cacheOf(chat, s.id)).toEqual({
        tiers: [
          { ttlMs: FIVE_MIN, anchorAt: T },
          { ttlMs: ONE_HOUR, anchorAt: T + FIVE_MIN + 1 }
        ]
      })
    })

    test('a read when every tier is cold refreshes nothing', async () => {
      chat = await bootChat()
      const s = await chat.create()
      report(chat, s.id, { callStartedAt: T, wrote5m: 10, wrote1h: 0, read: 0 })
      report(chat, s.id, { callStartedAt: T + ONE_HOUR, wrote5m: 0, wrote1h: 0, read: 5 })
      expect(await cacheOf(chat, s.id)).toEqual({ tiers: [{ ttlMs: FIVE_MIN, anchorAt: T }] })
    })

    test('a read on a session that never wrote leaves the cache absent', async () => {
      chat = await bootChat()
      const s = await chat.create()
      report(chat, s.id, { callStartedAt: T, wrote5m: 0, wrote1h: 0, read: 5 })
      expect(await cacheOf(chat, s.id)).toBeNull()
    })
  })

  describe('conversation total', () => {
    async function chain(boot: ChatBoot) {
      const a = boot.world.addStructuredSession('s_a')
      const b = boot.world.addStructuredSession('s_b')
      const c = boot.world.addStructuredSession('s_c')
      b.resumedFrom = a.id
      c.resumedFrom = b.id
      const ctx = boot.runner
      return { a, b, c, report: (id: string, n: number) => ctx.context ? ctx.context.reportUsage!(id, { tokens: tokensOfN(n) }) : undefined }
    }
    const tokensOfN = (n: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n })

    test('sums own over the resumedFrom chain', async () => {
      chat = await bootChat()
      await chat.create()
      const { c, report } = await chain(chat)
      report('s_a', 1)
      report('s_b', 10)
      report('s_c', 100)
      const result = await chat.call('quirky.structured/usage', { session: c.id })
      expect(result.own.input).toBe(100)
      expect(result.conversation).toEqual({ input: 111, output: 111, cacheRead: 111, cacheWrite: 111, total: 444 })
    })

    test('stops after including a forked session', async () => {
      chat = await bootChat()
      await chat.create()
      const { b, c, report } = await chain(chat)
      c.forked = true
      report('s_a', 1)
      report('s_b', 10)
      report('s_c', 100)
      expect((await chat.call('quirky.structured/usage', { session: c.id })).conversation.input).toBe(100)
      b.forked = true
      c.forked = false
      expect((await chat.call('quirky.structured/usage', { session: c.id })).conversation.input).toBe(110)
    })

    test('a missing predecessor counts as zero and a session without reports adds nothing', async () => {
      chat = await bootChat()
      await chat.create()
      const { b, c, report } = await chain(chat)
      report('s_c', 100)
      chat.world.sessions.delete(b.id)
      expect((await chat.call('quirky.structured/usage', { session: c.id })).conversation.input).toBe(100)
      expect(await chat.call('quirky.structured/usage', { session: 's_a' })).toEqual({ own: null, conversation: null, turns: 0, cache: null, subagentTokens: 0 })
    })
  })

  test('a resume hands the runner the predecessor\'s last journaled result totals as its baseline', async () => {
    const home = mkdtempSync('/tmp/qs-')
    chat = await bootChat({ home })
    chat.world.worktree.path = home
    const original = await chat.create()
    await waitFor(() => chat!.runner.started.length === 1)
    chat.world.sessions.get(original.id)!.providerSession = { id: 'provider-1', transcriptPath: null }
    const ctx = chat.runner.context
    ctx.appendMessage({ sessionId: original.id, role: 'result', text: 'one', data: { type: 'result', modelUsage: { m: { inputTokens: 1, outputTokens: 1 } } } })
    ctx.appendMessage({
      sessionId: original.id,
      role: 'result',
      text: 'two',
      data: { type: 'result', modelUsage: { m: { inputTokens: 30, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6 } } }
    })
    await chat.call('quirky.structured/stop', { session: original.id })
    const resumed = (await chat.call('quirky.structured/resume', { session: original.id })) as Session
    await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === resumed.id))
    const options = chat.runner.started.find((entry) => entry.sessionId === resumed.id)!.options
    expect(options.usageBaseline).toEqual({ input: 30, output: 4, cacheRead: 5, cacheWrite: 6 })
  })

  describe('baseline across a fork link', () => {
    const result = (total: number) => ({
      type: 'result',
      modelUsage: { m: { inputTokens: total, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
    })
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5))

    async function forkedAfterSpend() {
      const home = mkdtempSync('/tmp/qs-')
      chat = await bootChat({ home })
      chat.world.worktree.path = home
      const source = await chat.create()
      await waitFor(() => chat!.runner.started.length === 1)
      const record = chat.world.sessions.get(source.id)!
      record.providerSession = { id: 'provider-src', transcriptPath: null }
      record.status = 'done'
      chat.runner.context.setStatus(source.id, 'done')
      const ctx = chat.runner.context
      ctx.appendMessage({ sessionId: source.id, role: 'result', text: 'a', data: result(120_000) })
      await pause()
      const forked = (await chat.call('quirky.structured/fork', { session: source.id })) as Session
      await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === forked.id))
      chat.world.sessions.get(forked.id)!.providerSession = { id: 'provider-forked', transcriptPath: null }
      await pause()
      ctx.appendMessage({ sessionId: source.id, role: 'result', text: 'b', data: result(200_000) })
      return { source, forked }
    }

    const baselineOf = (id: string) => chat!.runner.started.find((entry) => entry.sessionId === id)!.options.usageBaseline

    test('a resumed fork with no turns carries the parent totals from the fork point, not its later spend', async () => {
      const { forked } = await forkedAfterSpend()
      await chat!.call('quirky.structured/stop', { session: forked.id })
      const resumed = (await chat!.call('quirky.structured/resume', { session: forked.id })) as Session
      await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === resumed.id))
      expect(baselineOf(resumed.id)).toEqual({ input: 120_000, output: 0, cacheRead: 0, cacheWrite: 0 })
    })

    test('a later resume chain that passes through the fork keeps the fork-point totals', async () => {
      const { forked } = await forkedAfterSpend()
      await chat!.call('quirky.structured/stop', { session: forked.id })
      const second = (await chat!.call('quirky.structured/resume', { session: forked.id })) as Session
      await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === second.id))
      chat!.world.sessions.get(second.id)!.providerSession = { id: 'provider-forked', transcriptPath: null }
      await chat!.call('quirky.structured/stop', { session: second.id })
      const third = (await chat!.call('quirky.structured/resume', { session: second.id })) as Session
      await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === third.id))
      expect(baselineOf(third.id)).toEqual({ input: 120_000, output: 0, cacheRead: 0, cacheWrite: 0 })
    })
  })

  test('a resume through a session with no completed turn keeps the earlier session\'s baseline', async () => {
    const home = mkdtempSync('/tmp/qs-')
    chat = await bootChat({ home })
    chat.world.worktree.path = home
    const a = await chat.create()
    await waitFor(() => chat!.runner.started.length === 1)
    chat.world.sessions.get(a.id)!.providerSession = { id: 'provider-1', transcriptPath: null }
    chat.runner.context.appendMessage({
      sessionId: a.id,
      role: 'result',
      text: 'done',
      data: { type: 'result', modelUsage: { m: { inputTokens: 100, outputTokens: 20 } } }
    })
    await chat.call('quirky.structured/stop', { session: a.id })
    const b = (await chat.call('quirky.structured/resume', { session: a.id })) as Session
    await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === b.id))
    chat.world.sessions.get(b.id)!.providerSession = { id: 'provider-1', transcriptPath: null }
    await chat.call('quirky.structured/stop', { session: b.id })
    const c = (await chat.call('quirky.structured/resume', { session: b.id })) as Session
    await waitFor(() => chat!.runner.started.some((entry) => entry.sessionId === c.id))
    expect(chat.runner.started.find((entry) => entry.sessionId === c.id)!.options.usageBaseline).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })
    chat.runner.context.reportUsage!(a.id, { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, turnEnded: true })
    chat.runner.context.reportUsage!(c.id, { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, turnEnded: true })
    const usage = await chat.call('quirky.structured/usage', { session: c.id })
    expect(usage.conversation.total).toBe(135)
    expect(usage.turns).toBe(2)
  })

  test('turns counts completed turns only, so mid-turn deltas leave it at zero', async () => {
    chat = await bootChat()
    const s = await chat.create()
    chat.runner.context.reportUsage!(s.id, { tokens: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 } })
    const usage = await chat.call('quirky.structured/usage', { session: s.id })
    expect(usage.conversation.total).toBe(5)
    expect(usage.turns).toBe(0)
  })

  test('the summary survives a daemon reboot', async () => {
    const home = mkdtempSync('/tmp/qs-')
    chat = await bootChat({ home })
    const s = await chat.create()
    chat.runner.context.reportUsage!(s.id, { tokens: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }, turnEnded: true })
    chat.runner.context.reportUsage!(s.id, { cache: { callStartedAt: 42, wrote5m: 1, wrote1h: 0, read: 0 } })
    const before = await chat.call('quirky.structured/usage', { session: s.id })
    await chat.stopDaemon()
    const second = new FakeWorld()
    second.addStructuredSession(s.id)
    chat = await bootChat({ home, world: second })
    expect(await chat.call('quirky.structured/usage', { session: s.id })).toEqual(before)
    expect(before.cache).toEqual({ tiers: [{ ttlMs: FIVE_MIN, anchorAt: 42 }] })
    expect(before.own.total).toBe(26)
  })
})
