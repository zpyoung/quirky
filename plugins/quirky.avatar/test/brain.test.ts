import { afterEach, describe, expect, test } from 'bun:test'
import type { AvatarApp, ToolCall } from '../src/contracts'
import { callFingerprint } from '../src/fingerprint'
import { register, rotationLimit } from '../src/brain/session'
import { makeTestApp, sampleMandate, type TestApp } from './support'

type Usage = { contextTokens: number; contextWindow: number | null }
type Reply = { text: string; contextUsage?: unknown; delayMs?: number; before?: { role: string; text: string; data?: unknown }[] }
type Sent = { session: string; text: string }

const json = (actions: unknown[]) => `\`\`\`json\n${JSON.stringify(actions)}\n\`\`\``
const NOOP = json([])
const until = async (condition: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

type Harness = ReturnType<typeof harness>

/** An app whose `quirky.structured/*` calls are faked: `respond` decides what each sent prompt is answered with. */
function harness(respond: (prompt: Sent, sentBefore: Sent[]) => Reply, options: { settings?: Record<string, unknown>; createDelayMs?: number; onCreate?: (n: number, app: AvatarApp) => void } = {}) {
  const t: TestApp = makeTestApp({ settings: options.settings })
  const { app } = t
  const mandate = sampleMandate({ worktreeId: 'wt-1', level: 'full', guidelines: ["Don't update snapshots to make failing tests pass"] })
  app.store.mandates.put(mandate)
  app.services.handoff.active = () => [{ worktreeId: 'wt-1', sessionId: null, state: 'working', mandate }]
  app.services.handoff.mandate = () => mandate
  const sentToWorker: { worktreeId: string; text: string; undeliveredThen: number[]; stoppedThen: number }[] = []
  const created: Record<string, unknown>[] = []
  const sent: Sent[] = []
  const stopped: string[] = []
  let count = 0
  app.services.supervisor.send = (async (worktreeId: string, text: string) => {
    sentToWorker.push({ worktreeId, text, undeliveredThen: app.store.undeliveredJournal().map((e) => e.seq), stoppedThen: stopped.length })
    return { sent: true }
  }) as never

  t.fakeCalls['quirky.structured/create'] = async (params) => {
    created.push(params)
    const n = ++count
    if (options.createDelayMs !== undefined && n > 1) await new Promise((resolve) => setTimeout(resolve, options.createDelayMs))
    options.onCreate?.(n, app)
    return { id: `s${n}` }
  }
  t.fakeCalls['quirky.structured/stop'] = (params) => {
    stopped.push(params.session as string)
    return { ok: true, closed: true }
  }
  t.fakeCalls['quirky.structured/send'] = (params) => {
    const prompt: Sent = { session: params.session as string, text: params.text as string }
    const before = [...sent]
    sent.push(prompt)
    const reply = respond(prompt, before)
    let seq = 0
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs ?? 0))
      for (const extra of reply.before ?? []) {
        await t.deliver({ type: 'quirky.structured/message', data: { message: { sessionId: prompt.session, seq: ++seq, role: extra.role, text: extra.text, ...(extra.data === undefined ? {} : { data: extra.data }), at: 1 } } } as never)
      }
      await t.deliver({ type: 'quirky.structured/message', data: { message: { sessionId: prompt.session, seq: ++seq, role: 'assistant', text: reply.text, at: 1 } } } as never)
      await t.deliver({ type: 'quirky.structured/message', data: { message: { sessionId: prompt.session, seq: ++seq, role: 'result', data: reply.contextUsage === undefined ? undefined : { contextUsage: reply.contextUsage }, at: 1 } } } as never)
      await t.deliver({ type: 'quirky.structured/settled', data: { sessionId: prompt.session, worktreeId: 'wt-1', agent: 'claude', state: 'done', at: 1 } } as never)
    })()
    return { ok: true }
  }
  disposers.push(register(app))
  return { t, app, mandate, created, sent, stopped, sentToWorker }
}

const call = (over: Partial<ToolCall> = {}): ToolCall => ({ agent: 'claude', sessionId: 'worker-1', worktreeId: 'wt-1', cwd: '/work/wt-1', toolName: 'Bash', toolInput: { command: 'bun test --update-snapshots' }, event: 'PreToolUse', ...over })
const isRebuild = (prompt: Sent) => prompt.text.includes('You are taking over supervision')
const judgeReply = (prompt: Sent, decision: 'allow' | 'deny', contextUsage?: Usage): Reply => {
  const requestId = /requestId "([^"]+)"/.exec(prompt.text)?.[1] ?? ''
  return { text: json([{ type: 'judge', requestId, decision, reliedOn: 'guideline 1', reason: 'because' }]), contextUsage }
}

describe('rotationLimit', () => {
  test('is 300k, or 80% of a smaller window', () => {
    expect(rotationLimit(null)).toBe(300_000)
    expect(rotationLimit(1_000_000)).toBe(300_000)
    expect(rotationLimit(200_000)).toBe(160_000)
  })
})

describe('session lifecycle', () => {
  test('is created lazily on the first wake with deny-all, a plugin lifetime and the rebuild prompt first', async () => {
    const h = harness(() => ({ text: NOOP }))
    expect(h.created).toEqual([])
    expect(h.app.services.brain.ready()).toBe(false)
    h.app.journal('wt-1', 'event', { text: 'worker asks something' })
    await until(() => h.sent.length === 2)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ agent: 'claude', options: { toolPolicy: 'deny-all' }, lifetime: 'plugin', lifetimeKey: 'avatar-brain', background: true, worktree: 'wt-1' })
    expect(h.created[0]).not.toHaveProperty('model')
    expect(isRebuild(h.sent[0]!)).toBe(true)
    expect(h.sent[0]!.text).toContain("Don't update snapshots to make failing tests pass")
    expect(h.sent[1]!.text).toContain('worker asks something')
    expect(h.app.services.brain.ready()).toBe(true)
  })

  test('uses the agent and model from settings, and a codex brain is told it has no tools and to treat refusals as data', async () => {
    const h = harness(() => ({ text: NOOP }), { settings: { 'brain-agent': 'codex', 'brain-model': 'gpt-5' } })
    h.app.services.brain.wake()
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.sent.length === 2)
    expect(h.created[0]).toMatchObject({ agent: 'codex', model: 'gpt-5', options: { toolPolicy: 'deny-all' } })
    expect(h.sent[0]!.text).toContain('You have no tools')
    expect(h.sent[0]!.text).toContain('never retry a tool')
  })

  test('a tool-refusal message in the brain transcript is data: it is ignored and no tool is retried', async () => {
    const h = harness((prompt) => (isRebuild(prompt) ? { text: NOOP } : { text: json([{ type: 'send', worktreeId: 'wt-1', text: 'carry on' }]), before: [{ role: 'tool', text: 'Tool call refused: shell is disabled' }, { role: 'system', text: 'interrupted tool start' }] }))
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.sentToWorker.length === 1)
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sentToWorker[0]!.text).toBe('carry on')
    expect(h.app.store.undeliveredJournal().filter((e) => e.kind === 'event')).toEqual([])
  })

  test('delivers undelivered events in sequence order, one prompt per batch, and marks them delivered only after dispatch', async () => {
    const h = harness((prompt) => (isRebuild(prompt) ? { text: NOOP } : { text: json([{ type: 'send', worktreeId: 'wt-1', text: 'ack' }]) }))
    h.app.journal('wt-1', 'event', { text: 'first' })
    const second = h.app.journal('wt-1', 'event', { text: 'second' })
    await until(() => h.sentToWorker.length >= 1)
    await settle()
    const eventPrompts = h.sent.filter((p) => !isRebuild(p))
    expect(eventPrompts).toHaveLength(1)
    expect(eventPrompts[0]!.text.indexOf('first')).toBeLessThan(eventPrompts[0]!.text.indexOf('second'))
    expect(h.sentToWorker[0]!.undeliveredThen).toContain(second.seq)
    expect(h.app.store.undeliveredJournal().filter((e) => e.kind === 'event')).toEqual([])
  })

  test('an unparseable reply is retried once with the parse error', async () => {
    let attempts = 0
    const h = harness((prompt) => {
      if (isRebuild(prompt)) return { text: NOOP }
      attempts += 1
      return attempts === 1 ? { text: 'sure, will do' } : { text: json([{ type: 'send', worktreeId: 'wt-1', text: 'ok' }]) }
    })
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.sentToWorker.length === 1)
    const retryPrompt = h.sent.filter((p) => !isRebuild(p))[1]!
    expect(retryPrompt.text).toContain('found none')
    expect(h.app.needs.list({ open: true })).toEqual([])
    expect(h.app.store.journalSince(0).filter((e) => e.kind === 'brain-error')).toHaveLength(1)
  })

  test('a second unparseable reply parks the event as a brain-error need and does not redeliver it', async () => {
    const h = harness((prompt) => (isRebuild(prompt) ? { text: NOOP } : { text: 'still not json' }))
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.app.needs.list({ open: true }).length === 1)
    await settle()
    expect(h.app.needs.list({ open: true })[0]).toMatchObject({ kind: 'brain-error', worktreeId: 'wt-1' })
    expect(h.sent.filter((p) => !isRebuild(p))).toHaveLength(2)
    expect(h.app.store.undeliveredJournal().filter((e) => e.kind === 'event')).toEqual([])
  })

  test('entries that are not events are never sent to the brain', async () => {
    const h = harness(() => ({ text: NOOP }))
    h.app.journal('wt-1', 'gate', { outcome: 'allow' })
    h.app.journal('wt-1', 'event', { text: 'real event' })
    await until(() => h.sent.length === 2)
    expect(h.sent[1]!.text).not.toContain('outcome')
    expect(h.app.store.undeliveredJournal().filter((e) => e.kind === 'gate')).toEqual([])
  })
})

describe('rotation', () => {
  test('SC-29: rotates after the event is dispatched at 301k, and a question that arrived during the switch goes to the new session first, once', async () => {
    let question: { seq: number } | null = null
    const h = harness(
      (prompt) => {
        if (isRebuild(prompt)) return { text: NOOP, contextUsage: { contextTokens: 38_000, contextWindow: 1_000_000 } }
        if (prompt.text.includes('permission request from fix-desktop')) return { text: json([{ type: 'send', worktreeId: 'wt-1', text: 'allowed' }]), contextUsage: { contextTokens: 301_000, contextWindow: 1_000_000 } }
        return { text: NOOP, contextUsage: { contextTokens: 40_000, contextWindow: 1_000_000 } }
      },
      {
        createDelayMs: 20,
        onCreate: (n, app) => {
          if (n === 2) question = app.journal('wt-1', 'event', { text: 'worker question: which tooltip text?' })
        }
      }
    )
    h.app.journal('wt-1', 'event', { text: 'permission request from fix-desktop' })
    await until(() => h.sent.filter((p) => p.session === 's2').length === 2)
    await settle()

    expect(h.stopped).toEqual(['s1'])
    expect(h.sentToWorker[0]!.stoppedThen).toBe(0)
    expect(h.created).toHaveLength(2)
    const s1 = h.sent.filter((p) => p.session === 's1')
    const s2 = h.sent.filter((p) => p.session === 's2')
    expect(isRebuild(s2[0]!)).toBe(true)
    expect(s2[1]!.text).toContain('which tooltip text?')
    expect(s1.some((p) => p.text.includes('which tooltip text?'))).toBe(false)
    expect(h.sent.filter((p) => p.text.includes('which tooltip text?'))).toHaveLength(1)
    expect(h.sent.filter((p) => p.text.includes('permission request from fix-desktop') && !isRebuild(p))).toHaveLength(1)
    expect(question).not.toBeNull()
    expect(h.app.store.undeliveredJournal().filter((e) => e.kind === 'event')).toEqual([])

    const rotation = h.app.store.journalSince(0).find((e) => e.kind === 'rotation')
    expect(rotation?.data).toMatchObject({ fromTokens: 301_000, toSession: 's2' })
    const rows = h.app.store.brainSessions.list()
    expect(rows.map((r) => r.sessionId)).toEqual(['s1', 's2'])
    expect(rows[0]).toMatchObject({ endTokens: 301_000 })
    expect(rows[0]!.endedAt).not.toBeNull()
    expect(rows[1]!.endedAt).toBeNull()
  })

  test('does not rotate below the limit', async () => {
    const h = harness((prompt) => ({ text: NOOP, contextUsage: { contextTokens: 299_999, contextWindow: 1_000_000 } }))
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.sent.length === 2)
    await settle()
    expect(h.created).toHaveLength(1)
    expect(h.stopped).toEqual([])
  })
  test('does not rotate on assistant usage without result contextUsage', async () => {
    const h = harness((prompt) => ({
      text: NOOP,
      ...(isRebuild(prompt) ? {} : { before: [{ role: 'assistant', text: '', data: { usage: { contextTokens: 301_000, contextWindow: 1_000_000 } } }] })
    }))
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.sent.length === 2)
    await settle()
    expect(h.created).toHaveLength(1)
    expect(h.stopped).toEqual([])
  })

  test('ignores malformed result footprints and preserves last-known usage', async () => {
    const malformed: unknown[] = [
      null,
      'not an object',
      { contextTokens: Number.NaN, contextWindow: 1_000_000 },
      { contextTokens: Number.POSITIVE_INFINITY, contextWindow: 1_000_000 },
      { contextTokens: '301000', contextWindow: 1_000_000 }
    ]
    for (const contextUsage of malformed) {
      const h = harness((prompt) => ({
        text: NOOP,
        contextUsage: isRebuild(prompt) ? { contextTokens: 301_000, contextWindow: 1_000_000 } : contextUsage
      }))
      h.app.journal('wt-1', 'event', { text: 'e' })
      await until(() => h.created.length === 2)
      await settle()
      const rotation = h.app.store.journalSince(0).find((entry) => entry.kind === 'rotation')
      expect(rotation?.data).toMatchObject({ fromTokens: 301_000, toSession: 's2' })
      expect(h.app.store.brainSessions.list()[0]).toMatchObject({ endTokens: 301_000 })
    }
  })

  test('treats a non-number context window as unknown', async () => {
    const h = harness((prompt) => ({
      text: NOOP,
      ...(isRebuild(prompt) ? {} : { contextUsage: { contextTokens: 200_000, contextWindow: '200000' } })
    }))
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.sent.length === 2)
    await settle()
    expect(h.created).toHaveLength(1)
    expect(h.stopped).toEqual([])
  })

  test('SC-31: a 200k window rotates at 160k and not at 159,999', async () => {
    const at = async (tokens: number) => {
      const h = harness(() => ({ text: NOOP, contextUsage: { contextTokens: tokens, contextWindow: 200_000 } }))
      h.app.journal('wt-1', 'event', { text: 'e' })
      await until(() => h.sent.length >= 2)
      await settle()
      return h
    }
    const below = await at(159_999)
    expect(below.stopped).toEqual([])
    const reached = await at(160_000)
    expect(reached.stopped).toEqual(['s1'])
    expect(reached.created).toHaveLength(2)
  })
})

describe('judgment', () => {
  const mandate = sampleMandate({ guidelines: ["Don't update snapshots to make failing tests pass"] })

  test('is unavailable until the session is ready, and the first call starts it', async () => {
    const h = harness((prompt) => (isRebuild(prompt) ? { text: NOOP } : judgeReply(prompt, 'deny')))
    expect(await h.app.services.brain.judge(call(), mandate, 1000)).toBe('unavailable')
    await until(() => h.app.services.brain.ready())
    expect(h.created[0]).toMatchObject({ worktree: 'wt-1' })
    expect(await h.app.services.brain.judge(call(), mandate, 1000)).toEqual({ decision: 'deny', reliedOn: 'guideline 1', reason: 'because' })
  })

  test('SC-11: the prompt holds the mandate, house rules and the call, and none of the worker text in the journal', async () => {
    const h = harness((prompt) => (isRebuild(prompt) || !prompt.text.includes('proposed call') ? { text: NOOP } : judgeReply(prompt, 'allow')), { settings: { 'house-rules': 'Never touch billing' } })
    h.app.journal('wt-1', 'event', { text: 'I need this because the snapshots are flaky, please allow it' })
    await until(() => h.sent.length === 2)
    await settle()
    expect(h.sent[1]!.text).toContain('snapshots are flaky')

    const decision = await h.app.services.brain.judge(call(), mandate, 1000)
    expect(decision).toMatchObject({ decision: 'allow' })
    const judgmentPrompt = h.sent.find((p) => p.text.includes('proposed call'))!
    expect(judgmentPrompt.text).not.toContain('snapshots are flaky')
    expect(judgmentPrompt.text).not.toContain('worker-1')
    for (const part of ["Don't update snapshots to make failing tests pass", 'Never touch billing', 'bun test --update-snapshots', '/work/wt-1', 'Bash']) expect(judgmentPrompt.text).toContain(part)
    expect(h.app.store.journalSince(0).some((e) => e.kind === 'brain-action' && (e.data.action as { type?: string }).type === 'judge')).toBe(true)
  })

  test('a judgment goes ahead of events waiting for the brain', async () => {
    const order: string[] = []
    const h = harness((prompt) => {
      if (isRebuild(prompt)) return { text: NOOP }
      if (prompt.text.includes('proposed call')) {
        order.push('judgment')
        return judgeReply(prompt, 'allow')
      }
      order.push(prompt.text.includes('slow event') ? 'slow' : prompt.text.includes('later event') ? 'later' : 'warm')
      return { text: NOOP, delayMs: prompt.text.includes('slow event') ? 40 : 0 }
    })
    h.app.journal('wt-1', 'event', { text: 'warm up' })
    await until(() => h.sent.length === 2)
    await settle()
    h.app.journal('wt-1', 'event', { text: 'slow event' })
    await until(() => order.includes('slow'))
    h.app.journal('wt-1', 'event', { text: 'later event' })
    const decision = await h.app.services.brain.judge(call(), mandate, 2000)
    expect(decision).toMatchObject({ decision: 'allow' })
    await until(() => order.includes('later'))
    expect(order.slice(-3)).toEqual(['slow', 'judgment', 'later'])
  })

  test('resolves timeout at the deadline and keeps a late answer for the exact call', async () => {
    const h = harness((prompt) => (isRebuild(prompt) ? { text: NOOP } : { ...judgeReply(prompt, 'deny'), delayMs: 60 }))
    h.app.services.brain.wake()
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.app.services.brain.ready())
    await settle()
    const started = Date.now()
    expect(await h.app.services.brain.judge(call(), mandate, 15)).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(55)
    const fingerprint = callFingerprint('claude', 'wt-1', 'Bash', { command: 'bun test --update-snapshots' })
    await until(() => h.app.store.lateAnswers.get(fingerprint) !== null)
    expect(h.app.store.lateAnswers.get(fingerprint)).toMatchObject({ decision: 'deny', worktreeId: 'wt-1', usedAt: null })
  })

  test('a reply with no matching judge action is retried once, then the judgment is unavailable', async () => {
    const h = harness((prompt) => (isRebuild(prompt) || !prompt.text.includes('proposed call') ? { text: NOOP } : { text: json([{ type: 'noop', reason: 'dunno' }]) }))
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.app.services.brain.ready())
    expect(await h.app.services.brain.judge(call(), mandate, 1000)).toBe('unavailable')
    expect(h.sent.filter((p) => p.text.includes('holds no judge action'))).toHaveLength(1)
  })
})

describe('session death', () => {
  test('SC-25: judgments are unavailable until a new session, rebuilt from the journal, is ready', async () => {
    const h = harness((prompt) => (isRebuild(prompt) ? { text: NOOP } : judgeReply(prompt, 'allow')), { createDelayMs: 40 })
    h.app.journal('wt-1', 'event', { text: 'e' })
    await until(() => h.app.services.brain.ready())
    await settle()

    await h.t.deliver({ type: 'quirky.session/changed', data: { session: { id: 's1', status: 'exited' } } } as never)
    expect(h.app.services.brain.ready()).toBe(false)
    expect(await h.app.services.brain.judge(call(), sampleMandate(), 1000)).toBe('unavailable')
    await until(() => h.app.services.brain.ready())

    expect(h.created).toHaveLength(2)
    const rebuilt = h.sent.filter((p) => p.session === 's2')[0]!
    expect(isRebuild(rebuilt)).toBe(true)
    expect(rebuilt.text).toContain("Don't update snapshots to make failing tests pass")
    expect(h.app.store.brainSessions.list()[0]!.endedAt).not.toBeNull()
    expect(h.app.store.journalSince(0).some((e) => e.kind === 'brain-error' && e.data.reason === 'session-died')).toBe(true)
    expect(await h.app.services.brain.judge(call(), sampleMandate(), 1000)).toMatchObject({ decision: 'allow' })
  })

  test('events not yet delivered when the session dies go to the new session', async () => {
    let first = true
    const h = harness((prompt) => {
      if (isRebuild(prompt)) return { text: NOOP }
      if (first) {
        first = false
        return { text: NOOP, delayMs: 60 }
      }
      return { text: NOOP }
    })
    h.app.journal('wt-1', 'event', { text: 'in flight when the session dies' })
    await until(() => h.sent.length === 2)
    await h.t.deliver({ type: 'quirky.session/changed', data: { session: { id: 's1', status: 'exited' } } } as never)
    await until(() => h.sent.some((p) => p.session === 's2' && !isRebuild(p)))
    expect(h.sent.filter((p) => p.session === 's2' && p.text.includes('in flight when the session dies'))).toHaveLength(1)
    await settle()
    expect(h.app.store.undeliveredJournal().filter((e) => e.kind === 'event')).toEqual([])
  })
})
