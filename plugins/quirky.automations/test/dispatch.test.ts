import { afterEach, describe, expect, test } from 'bun:test'
import type { AutomationDefinition, AutomationRun } from '../types'
import { createAutomationDispatcher } from '../dispatch'
import type { AutomationDispatcher } from '../dispatch-contract'
import type { DispatchHarness, ScriptedCheckResult, ScriptedSession } from './dispatch-harness'
import {
  createDispatchHarness,
  makeCheckResult,
  makeDefinition
} from './dispatch-harness'

const fixtures: Array<{ dispatcher: AutomationDispatcher; close: () => void }> = []
const now = 1_800_000_000_000

function fixture() {
  const harness = createDispatchHarness(now)
  const dispatcher = createAutomationDispatcher(harness.context, harness.hooks)
  fixtures.push({ dispatcher, close: harness.close })
  return Object.assign(harness, { dispatcher })
}

afterEach(() => {
  for (const current of fixtures.splice(0)) {
    current.dispatcher.dispose()
    current.close()
  }
})

function waitRun(harness: DispatchHarness, id: string, status: AutomationRun['status']): Promise<AutomationRun> {
  return harness.waitForRunStatus(id, status)
}

function createCount(harness: DispatchHarness) {
  return harness.calls.filter((call) => call.method === 'quirky.structured/create').length
}

function newRun(harness: DispatchHarness, patch: Partial<AutomationDefinition> = {}, trigger: 'manual' | 'scheduled' = 'scheduled') {
  const definition = makeDefinition('auto', now, patch)
  return { definition, run: harness.addRun(definition, trigger) }
}

function successfulClaudeResult(harness: DispatchHarness, sessionId: string, text: string, data: Record<string, unknown> = { subtype: 'success', is_error: false }) {
  harness.appendMessage(sessionId, 'assistant', text)
  harness.appendMessage(sessionId, 'result', 'provider finished', {
    type: 'result', subtype: 'success', is_error: false, ...data
  })
  harness.setStatus(sessionId, 'done')
}

describe('automation run dispatcher', () => {
  test('concurrent dispatch claims one pending run once and stores precheck evidence', async () => {
    const harness = fixture()
    const gate = Promise.withResolvers<ScriptedCheckResult>()
    harness.setCheckGate(gate.promise)
    const { run } = newRun(harness, {
      workspaceMode: 'new_per_run', workspaceId: null,
      precheck: { command: 'bun test', timeoutSeconds: 12 }
    })

    const first = harness.dispatcher.dispatch(run.id)
    await harness.checkWasStarted
    const second = harness.dispatcher.dispatch(run.id)
    gate.resolve(makeCheckResult({ stdoutTail: 'ok' }))

    const [one, two] = await Promise.all([first, second])
    expect(one?.status).toBe('dispatched')
    expect(two?.status).toBe('dispatched')
    expect(createCount(harness)).toBe(1)
    const callOrder = harness.calls.map((call) => call.method)
    expect(callOrder.indexOf('quirky.checks/run')).toBeLessThan(callOrder.indexOf('quirky.worktree/create'))
    expect(callOrder.indexOf('quirky.worktree/create')).toBeLessThan(callOrder.indexOf('quirky.structured/create'))
    expect(harness.store.getRun(run.id)?.precheckResult).toMatchObject({
      command: 'bun test', startedAt: now, completedAt: now, pass: true, stdout: 'ok'
    })
  })
  test('new-per-run dispatch scopes one provenance capability to workspace creation only', async () => {
    const harness = fixture()
    const { run } = newRun(harness, { workspaceMode: 'new_per_run', workspaceId: null })

    const dispatched = await harness.dispatcher.dispatch(run.id)

    const create = harness.calls.find((call) => call.method === 'quirky.worktree/create')
    const request = create?.params.automationProvenanceRequest as Record<string, unknown>
    expect(dispatched?.status).toBe('dispatched')
    expect(harness.provenanceRequests).toHaveLength(1)
    expect(request).toMatchObject({ automationId: run.automationId, runId: run.id })
    expect(Object.keys(request).sort()).toEqual(['automationId', 'dispatchToken', 'runId'])
    expect(harness.provenanceRequests[0]).toEqual(request)
    expect(harness.provenanceRevoked).toEqual([request.dispatchToken])
  })

  test('existing-workspace dispatch does not issue provenance and failed creation revokes it', async () => {
    const ordinary = fixture()
    const existingRun = newRun(ordinary).run
    await ordinary.dispatcher.dispatch(existingRun.id)
    expect(ordinary.provenanceRequests).toEqual([])
    expect(ordinary.provenanceRevoked).toEqual([])
    expect(ordinary.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)

    const failed = fixture()
    failed.setWorktreeError(new Error('create refused'))
    const { run } = newRun(failed, { workspaceMode: 'new_per_run', workspaceId: null })
    const refused = await failed.dispatcher.dispatch(run.id)
    const request = failed.provenanceRequests[0]!

    expect(refused?.status).toBe('dispatch_failed')
    expect(failed.provenanceRevoked).toEqual([request.dispatchToken])
  })
  test('dispatcher disposal revokes an in-flight workspace capability', async () => {
    const harness = fixture()
    const gate = Promise.withResolvers<Record<string, unknown>>()
    harness.setWorktreeGate(gate.promise)
    const { run } = newRun(harness, { workspaceMode: 'new_per_run', workspaceId: null })
    const dispatch = harness.dispatcher.dispatch(run.id)
    await harness.worktreeWasStarted
    const request = harness.provenanceRequests[0]!

    harness.dispatcher.dispose()
    expect(harness.provenanceRevoked).toEqual([request.dispatchToken])

    gate.resolve({
      worktree: { id: 'wt-created', path: '/repo-a/created', name: 'created', repoId: 'repo-a' },
      setup: { ran: 'skipped' },
      warnings: []
    })
    await dispatch
    expect(harness.provenanceRevoked).toEqual([request.dispatchToken])
  })



  test('manual dispatch bypasses a failing scheduled precheck', async () => {
    const harness = fixture()
    harness.setCheckResult(makeCheckResult({ pass: false, exitCode: 9, stderrTail: 'manual should still run' }))
    const { run } = newRun(harness, { precheck: { command: 'false', timeoutSeconds: 5 } }, 'manual')

    const dispatched = await harness.dispatcher.dispatch(run.id)

    expect(dispatched?.status).toBe('dispatched')
    expect(harness.calls.some((call) => call.method === 'quirky.checks/run')).toBe(false)
    expect(createCount(harness)).toBe(1)
    expect(dispatched?.precheckResult).toBeUndefined()
  })

  test('scheduled nonzero and timed-out checks refuse before creating a workspace or session', async () => {
    for (const result of [
      makeCheckResult({ pass: false, exitCode: 3, stderrTail: 'lint failed', stdoutTail: 'é'.repeat(5_000) }),
      makeCheckResult({ pass: false, exitCode: null, timedOut: true, durationMs: 5000 })
    ]) {
      const harness = fixture()
      harness.setCheckResult(result)
      const { run } = newRun(harness, {
        workspaceMode: 'new_per_run', workspaceId: null,
        precheck: { command: 'check me', timeoutSeconds: 5 }
      })

      const refused = await harness.dispatcher.dispatch(run.id)

      expect(refused?.status).toBe('skipped_precheck')
      expect(refused?.precheckResult).toMatchObject({ command: 'check me', pass: false, timedOut: result.timedOut })
      expect(refused?.precheckResult).toHaveProperty('startedAt')
      expect(refused?.precheckResult).toHaveProperty('completedAt')
      const stdout = refused?.precheckResult?.stdout
      if (typeof stdout === 'string' && stdout.length > 0) {
        expect(stdout).toBe('é'.repeat(4_000))
        expect(refused?.precheckResult?.stdoutTruncated).toBe(true)
      }
      expect(createCount(harness)).toBe(0)
      expect(harness.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
      harness.dispatcher.dispose()
      harness.close()
      fixtures.pop()
    }
  })
  test('a precheck execution error is recorded as a refusal', async () => {
    const harness = fixture()
    harness.setCheckError(new Error('check shell is unavailable'))
    const { run } = newRun(harness, { precheck: { command: 'check me', timeoutSeconds: 5 } })

    const refused = await harness.dispatcher.dispatch(run.id)

    expect(refused?.status).toBe('skipped_precheck')
    expect(refused?.precheckResult).toMatchObject({
      command: 'check me', ran: false, pass: false, error: 'check shell is unavailable'
    })
    expect(createCount(harness)).toBe(0)
  })

  test('definition edits during awaited precheck cannot launch at a stale destination', async () => {
    const harness = fixture()
    const gate = Promise.withResolvers<ScriptedCheckResult>()
    harness.setCheckGate(gate.promise)
    const { definition, run } = newRun(harness, { precheck: { command: 'inspect', timeoutSeconds: 10 } })
    const dispatch = harness.dispatcher.dispatch(run.id)
    await harness.checkWasStarted
    harness.store.update(definition.id, { prompt: 'edited while checking' })
    gate.resolve(makeCheckResult())

    const refused = await dispatch

    expect(refused?.status).toBe('dispatch_failed')
    expect(refused?.error).toMatch(/changed/i)
    expect(createCount(harness)).toBe(0)
  })

  test('deleting an automation during preparation removes the claimed run without launching or rewriting it', async () => {
    const harness = fixture()
    const gate = Promise.withResolvers<ScriptedCheckResult>()
    harness.setCheckGate(gate.promise)
    const { definition, run } = newRun(harness, { precheck: { command: 'inspect', timeoutSeconds: 10 } })
    const dispatch = harness.dispatcher.dispatch(run.id)
    await harness.checkWasStarted
    harness.store.remove(definition.id)
    gate.resolve(makeCheckResult())

    expect(await dispatch).toBeNull()
    expect(harness.store.getRun(run.id)).toBeNull()
    expect(createCount(harness)).toBe(0)
  })
  test('target changes after precheck refuse before workspace creation or launch', async () => {
    const harness = fixture()
    const gate = Promise.withResolvers<ScriptedCheckResult>()
    harness.setCheckGate(gate.promise)
    const { run } = newRun(harness, {
      workspaceMode: 'new_per_run', workspaceId: null,
      precheck: { command: 'inspect', timeoutSeconds: 10 }
    })
    const dispatch = harness.dispatcher.dispatch(run.id)
    await harness.checkWasStarted
    const current = harness.resolution
    if (!current.available) throw new Error('expected local target')
    harness.resolution = {
      available: true,
      target: {
        ...current.target,
        repoPath: '/moved',
        cwd: '/moved/work',
        owner: { ...current.target.owner, repoPath: '/moved' }
      }
    }
    gate.resolve(makeCheckResult())

    const refused = await dispatch

    expect(refused?.status).toBe('dispatch_failed')
    expect(refused?.error).toMatch(/destination changed/i)
    expect(harness.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
    expect(createCount(harness)).toBe(0)
  })

  test('unavailable and remote targets remain visible refusals without local fallback', async () => {
    const harness = fixture()
    harness.resolution = {
      available: false,
      status: 'skipped_needs_interactive_auth',
      error: 'Remote execution requires an unsupported interactive host.'
    }
    const { run } = newRun(harness, {
      workspaceMode: 'new_per_run', workspaceId: null,
      precheck: { command: 'must not run', timeoutSeconds: 10 }
    })

    const refused = await harness.dispatcher.dispatch(run.id)

    expect(refused?.status).toBe('skipped_needs_interactive_auth')
    expect(refused?.error).toContain('unsupported interactive host')
    expect(harness.calls.some((call) => call.method === 'quirky.checks/run')).toBe(false)
    expect(harness.calls.some((call) => call.method === 'quirky.worktree/create')).toBe(false)
    expect(createCount(harness)).toBe(0)
  })

  test('new workspace setup failure is retained on the run and prevents launch', async () => {
    const harness = fixture()
    harness.setWorktreeResult({
      worktree: { id: 'wt-created', path: '/repo-a/created', name: 'auto-job-stamp-run', repoId: 'repo-a' },
      setup: { ran: 'daemon', exitCode: 8, timedOut: false },
      warnings: []
    })
    const { run } = newRun(harness, {
      name: 'Fix flaky tests', workspaceMode: 'new_per_run', workspaceId: null,
      baseBranch: 'main', setupDecision: 'run'
    })

    const failed = await harness.dispatcher.dispatch(run.id)

    expect(failed?.status).toBe('dispatch_failed')
    expect(failed?.workspaceId).toBe('wt-created')
    expect(failed?.workspaceDisplayName).toBe('auto-job-stamp-run')
    expect(createCount(harness)).toBe(0)
    expect(harness.calls.find((call) => call.method === 'quirky.worktree/create')?.params).toMatchObject({
      repo: 'id:repo-a', base: 'main', setup: 'run', noParent: true, activate: false, createdBy: 'api'
    })
    expect(harness.calls.find((call) => call.method === 'quirky.worktree/create')?.params).not.toHaveProperty('agent')
    const createParams = harness.calls.find((call) => call.method === 'quirky.worktree/create')?.params
    const name = String(createParams?.name)
    const stamp = name.slice('auto-fix-flaky-tests-'.length, -(`-${run.id}`).length)
    expect(stamp).toMatch(/^[0-9]{8}T[0-9]{6}Z$/)
  })
  test('new workspace terminal setup is awaited and nonzero exit prevents provider launch', async () => {
    const successful = fixture()
    successful.sessions.set('s_setup_ok', {
      id: 's_setup_ok', kind: 'terminal', agent: 'shell', worktreeId: 'wt-created',
      cwd: '/repo-a/created', title: 'Setup', status: 'exited', createdAt: now, lastActivityAt: now,
      exitCode: 0, exitSignal: null, exitCause: null, restorable: false, launchSettings: null
    })
    successful.setWorktreeResult({
      worktree: { id: 'wt-created', path: '/repo-a/created', name: 'setup-ok', repoId: 'repo-a' },
      setup: { ran: 'terminal', sessionId: 's_setup_ok' },
      warnings: []
    })
    const successRun = newRun(successful, {
      workspaceMode: 'new_per_run', workspaceId: null, setupDecision: 'run'
    }).run

    const launched = await successful.dispatcher.dispatch(successRun.id)

    expect(launched?.status).toBe('dispatched')
    expect(launched?.workspaceId).toBe('wt-created')
    expect(successful.calls.findIndex((call) => call.method === 'quirky.session/get'))
      .toBeGreaterThan(successful.calls.findIndex((call) => call.method === 'quirky.worktree/create'))
    expect(successful.calls.findIndex((call) => call.method === 'quirky.structured/create'))
      .toBeGreaterThan(successful.calls.findIndex((call) => call.method === 'quirky.session/get'))

    const failed = fixture()
    failed.sessions.set('s_setup_bad', {
      id: 's_setup_bad', kind: 'terminal', agent: 'shell', worktreeId: 'wt-created',
      cwd: '/repo-a/created', title: 'Setup', status: 'exited', createdAt: now, lastActivityAt: now,
      exitCode: 7, exitSignal: null, exitCause: null, restorable: false, launchSettings: null
    })
    failed.setWorktreeResult({
      worktree: { id: 'wt-created', path: '/repo-a/created', name: 'setup-failed', repoId: 'repo-a' },
      setup: { ran: 'terminal', sessionId: 's_setup_bad' },
      warnings: []
    })
    const failureRun = newRun(failed, {
      workspaceMode: 'new_per_run', workspaceId: null, setupDecision: 'run'
    }).run

    const refused = await failed.dispatcher.dispatch(failureRun.id)

    expect(refused?.status).toBe('dispatch_failed')
    expect(refused?.error).toContain('exited with 7')
    expect(refused?.workspaceId).toBe('wt-created')
    expect(createCount(failed)).toBe(0)
  })

  test('a successful early provider result completes after launch acknowledgement with bounded output', async () => {
    const harness = fixture()
    harness.onCreate = (session) => successfulClaudeResult(harness, session.id, 'x'.repeat(300_000))
    const { run } = newRun(harness)

    await harness.dispatcher.dispatch(run.id)
    const completed = await waitRun(harness, run.id, 'completed')

    expect(completed.sessionId).toBe('s_1')
    expect(completed.outputSnapshot?.content.length).toBeLessThanOrEqual(256 * 1024)
    expect(completed.outputSnapshot?.truncated).toBe(true)
    expect(completed.usage).toMatchObject({ status: 'unavailable', provider: 'claude', estimatedCostUsd: null })
  })

  test('provider error result fails even when the structured session reports done', async () => {
    const harness = fixture()
    harness.onCreate = (session) => {
      harness.appendMessage(session.id, 'result', 'provider error', {
        type: 'result', subtype: 'error_during_execution', is_error: true,
        errors: ['provider failed']
      })
      harness.setStatus(session.id, 'done')
    }
    const { run } = newRun(harness)

    await harness.dispatcher.dispatch(run.id)
    const failed = await waitRun(harness, run.id, 'dispatch_failed')

    expect(failed.error).toMatch(/provider/i)
    expect(failed.outputSnapshot?.content).toContain('provider error')
  })

  test('reuse uses a fresh post-cursor result and a session claimed by a newer run is not shared', async () => {
    const harness = fixture()
    const { definition, run: firstRun } = newRun(harness, { reuseSession: true })
    harness.onCreate = (session) => successfulClaudeResult(harness, session.id, 'first output', {
      subtype: 'success', is_error: false,
      usage: { input_tokens: 90, output_tokens: 30 }, total_cost_usd: 0.09
    })
    await harness.dispatcher.dispatch(firstRun.id)
    await waitRun(harness, firstRun.id, 'completed')

    harness.onCreate = null
    const secondRun = harness.store.createRun(definition.id, { trigger: 'manual', scheduledFor: now + 1, now: now + 1 })
    const second = await harness.dispatcher.dispatch(secondRun.id)
    expect(second?.status).toBe('dispatched')
    expect(second?.dispatchState).toMatchObject({ reused: true, messageCursor: 3 })
    expect(second?.launchSettings).toEqual(firstRun.launchSettings ?? harness.sessions.get('s_1')?.launchSettings)

    harness.setStatus('s_1', 'done')

    const thirdRun = harness.store.createRun(definition.id, { trigger: 'manual', scheduledFor: now + 2, now: now + 2 })
    const third = await harness.dispatcher.dispatch(thirdRun.id)
    expect(harness.store.getRun(secondRun.id)?.status).toBe('dispatched')
    expect(third?.status).toBe('dispatched')
    expect(third?.dispatchState?.reused).toBe(false)
    expect(third?.sessionId).not.toBe('s_1')
    expect(createCount(harness)).toBe(2)

    const reusedSession = harness.sessions.get('s_1')!
    harness.appendMessage(reusedSession.id, 'assistant', 'second output')
    harness.appendMessage(reusedSession.id, 'result', 'turn complete', {
      type: 'result', subtype: 'success', is_error: false,
      usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.102
    })
    harness.setStatus(reusedSession.id, 'done')
    const completed = await waitRun(harness, secondRun.id, 'completed')

    expect(completed.usage).toMatchObject({ status: 'known', inputTokens: 12, outputTokens: 5, totalTokens: 17 })
    expect(completed.usage?.estimatedCostUsd).toBeCloseTo(0.012, 9)
    expect(completed.usage).not.toMatchObject({ inputTokens: 90, outputTokens: 30 })
    expect(harness.calls.filter((call) => call.method === 'quirky.structured/send')).toHaveLength(1)
  })
  test('ambiguous reuse submission fails without a second prompt or fresh fallback', async () => {
    const harness = fixture()
    const { definition, run: firstRun } = newRun(harness, { reuseSession: true })
    harness.onCreate = (session) => successfulClaudeResult(harness, session.id, 'initial turn')
    await harness.dispatcher.dispatch(firstRun.id)
    await waitRun(harness, firstRun.id, 'completed')

    harness.onCreate = null
    harness.onSend = () => { throw new Error('transport dropped after acceptance') }
    const secondRun = harness.store.createRun(definition.id, { trigger: 'manual', scheduledFor: now + 1, now: now + 1 })

    const failed = await harness.dispatcher.dispatch(secondRun.id)

    expect(failed?.status).toBe('dispatch_failed')
    expect(failed?.error).toMatch(/failed ambiguously/i)
    expect(failed?.sessionId).toBe('s_1')
    expect(failed?.dispatchState?.reused).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'quirky.structured/send')).toHaveLength(1)
    expect(createCount(harness)).toBe(1)
  })

  test('Codex token evidence is per-turn and missing cost does not erase known cost', async () => {
    const harness = fixture()
    const { run } = newRun(harness, { agentId: 'codex' })
    harness.store.updateRun(run.id, {
      usage: { status: 'known', provider: 'codex', inputTokens: 99, estimatedCostUsd: 0.5 }
    }, now)
    harness.onCreate = (session) => {
      harness.appendMessage(session.id, 'assistant', 'Codex result')
      harness.appendMessage(session.id, 'system', 'Codex token usage updated', {
        type: 'thread/tokenUsage/updated',
        turnUsage: { inputTokens: 17, outputTokens: 6, cachedInputTokens: 4 }
      })
      harness.appendMessage(session.id, 'result', 'Codex turn completed', { status: 'completed' })
      harness.setStatus(session.id, 'done')
    }

    await harness.dispatcher.dispatch(run.id)
    const completed = await waitRun(harness, run.id, 'completed')

    expect(completed.usage).toMatchObject({
      status: 'known', provider: 'codex', inputTokens: 17, outputTokens: 6, cacheReadTokens: 4,
      totalTokens: 23, estimatedCostUsd: 0.5
    })
    expect(completed.usage).not.toHaveProperty('costUnavailableReason')
  })
  test('missing native token evidence stays explicitly unavailable', async () => {
    const harness = fixture()
    const { run } = newRun(harness, { agentId: 'codex' })
    harness.onCreate = (session) => {
      harness.appendMessage(session.id, 'result', 'Codex completed', { status: 'completed' })
      harness.setStatus(session.id, 'done')
    }

    await harness.dispatcher.dispatch(run.id)
    const completed = await waitRun(harness, run.id, 'completed')

    expect(completed.usage).toMatchObject({
      status: 'unavailable', provider: 'codex', estimatedCostUsd: null,
      unavailableReason: 'native_usage_missing'
    })
    expect(completed.usage).not.toHaveProperty('inputTokens')
  })

  test('waiting sessions are failed and stopped instead of leaving an unattended approval open', async () => {
    const harness = fixture()
    harness.onCreate = (session) => harness.setStatus(session.id, 'waiting')
    const { run } = newRun(harness)

    await harness.dispatcher.dispatch(run.id)
    const failed = await waitRun(harness, run.id, 'dispatch_failed')

    expect(failed.error).toMatch(/waiting|approval/i)
    expect(harness.calls.some((call) => call.method === 'quirky.structured/stop' && call.params.session === 's_1')).toBe(true)
  })

  test('restart attaches dispatched journal evidence, fails stranded rows, and never replays manual runs', async () => {
    const harness = fixture()
    const definition = makeDefinition('restart', now)
    harness.addDefinition(definition)
    const completedRun = harness.store.createRun(definition.id, { trigger: 'scheduled', scheduledFor: now, now })
    const session = {
      id: 's_durable', kind: 'structured' as const, agent: 'claude', worktreeId: 'wt-existing',
      cwd: '/repo-a/work', title: 'Claude', status: 'done' as const, createdAt: now, lastActivityAt: now,
      exitCode: null, exitSignal: null, exitCause: null, restorable: false, launchSettings: null
    } satisfies ScriptedSession
    harness.sessions.set(session.id, session)
    harness.appendMessage(session.id, 'assistant', 'durable output')
    harness.appendMessage(session.id, 'result', 'complete', { type: 'result', subtype: 'success', is_error: false })
    harness.store.claimRun(completedRun.id, now)
    harness.store.updateRun(completedRun.id, {
      status: 'dispatched', sessionId: session.id,
      dispatchState: { messageCursor: 0, reused: false, observedWorking: true, observationStartedAt: now }
    }, now)
    const manual = harness.store.createRun(definition.id, { trigger: 'manual', scheduledFor: now + 1, now: now + 1 })
    const stranded = harness.store.createRun(definition.id, { trigger: 'manual', scheduledFor: now + 2, now: now + 2 })
    harness.store.claimRun(stranded.id, now + 2)
    const lostRun = harness.store.createRun(definition.id, { trigger: 'scheduled', scheduledFor: now + 3, now: now + 3 })
    const lostSession = { ...session, id: 's_lost', status: 'exited' as const }
    harness.sessions.set(lostSession.id, lostSession)
    harness.store.claimRun(lostRun.id, now + 3)
    harness.store.updateRun(lostRun.id, {
      status: 'dispatched', sessionId: lostSession.id,
      dispatchState: { messageCursor: 0, reused: false, observedWorking: true, observationStartedAt: now + 3 }
    }, now + 3)

    await harness.dispatcher.start()

    expect((await waitRun(harness, completedRun.id, 'completed')).outputSnapshot?.content).toBe('durable output')
    expect((await waitRun(harness, manual.id, 'dispatch_failed')).error).toMatch(/restart|stranded/i)
    expect((await waitRun(harness, stranded.id, 'dispatch_failed')).error).toMatch(/restart|stranded/i)
    expect((await waitRun(harness, lostRun.id, 'dispatch_failed')).error).toMatch(/exited without/i)
    expect(createCount(harness)).toBe(0)
  })

  test('startup safely dispatches scheduled pending runs and is idempotent', async () => {
    const harness = fixture()
    const { run } = newRun(harness)

    await harness.dispatcher.start()
    expect(harness.store.getRun(run.id)?.status).toBe('dispatched')
    await harness.dispatcher.start()

    expect(createCount(harness)).toBe(1)
  })
  test('startup reconciles every active row beyond the store default page', async () => {
    const harness = fixture()
    const definition = makeDefinition('many', now)
    harness.addDefinition(definition)
    const rows = Array.from({ length: 105 }, (_, index) => harness.store.createRun(definition.id, {
      trigger: 'manual', scheduledFor: now + index, now: now + index
    }))

    await harness.dispatcher.start()

    expect(new Set(harness.changedRuns).size).toBe(105)
    expect(createCount(harness)).toBe(0)
  })

  test('dispose cancels its active precheck and prevents a late launch', async () => {
    const harness = fixture()
    const check = Promise.withResolvers<ScriptedCheckResult>()
    harness.setCheckGate(check.promise)
    const { run } = newRun(harness, { precheck: { command: 'wait', timeoutSeconds: 60 } })
    const dispatch = harness.dispatcher.dispatch(run.id)
    await harness.checkWasStarted

    harness.dispatcher.dispose()
    check.resolve(makeCheckResult({ pass: false, aborted: true }))

    await dispatch
    expect(harness.checkCancelCount).toBe(1)
    expect(createCount(harness)).toBe(0)
  })
  test('a saved provider edit does not change an already dispatched run identity', async () => {
    const harness = fixture()
    const { definition, run } = newRun(harness, {}, 'manual')
    const launched = await harness.dispatcher.dispatch(run.id)
    expect(launched?.status).toBe('dispatched')
    const sessionId = launched!.sessionId!
    harness.store.update(definition.id, { agentId: 'codex', prompt: 'next run uses another provider' })
    successfulClaudeResult(harness, sessionId, 'original Claude run finished')
    const completed = await waitRun(harness, run.id, 'completed')
    expect(completed.outputSnapshot?.content).toBe('original Claude run finished')
    expect(completed.launchSettings?.agent).toBe('claude')
  })
  test('provider exit retains its diagnostic output and explicit unavailable usage', async () => {
    const harness = fixture()
    harness.onCreate = (session) => {
      harness.appendMessage(session.id, 'system', 'Provider could not authenticate this account.')
      harness.setStatus(session.id, 'exited', 1)
    }
    const { run } = newRun(harness)
    await harness.dispatcher.dispatch(run.id)
    const failed = await waitRun(harness, run.id, 'dispatch_failed')
    expect(failed.outputSnapshot?.content).toBe('Provider could not authenticate this account.')
    expect(failed.usage).toMatchObject({ status: 'unavailable', unavailableReason: 'run_not_finished' })
  })
  test('a decreasing reused Claude running total is unavailable rather than a negative or repeated charge', async () => {
    const harness = fixture()
    const { definition, run } = newRun(harness, { reuseSession: true })
    harness.onCreate = (session) => successfulClaudeResult(harness, session.id, 'first', {
      usage: { input_tokens: 12, output_tokens: 3 }, total_cost_usd: 0.2
    })
    await harness.dispatcher.dispatch(run.id)
    await waitRun(harness, run.id, 'completed')
    harness.onSend = (session) => successfulClaudeResult(harness, session.id, 'after reset', {
      usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0.1
    })
    const reused = harness.store.createRun(definition.id, { trigger: 'manual', scheduledFor: now + 1, now: now + 1 })
    await harness.dispatcher.dispatch(reused.id)
    const completed = await waitRun(harness, reused.id, 'completed')
    expect(completed.usage).toMatchObject({ status: 'known', totalTokens: 7, estimatedCostUsd: null })
    expect(completed.usage).toHaveProperty('costUnavailableReason')
  })
  test('precheck JSON evidence stays bounded when control characters expand during serialization', async () => {
    const harness = fixture()
    const controls = '\u0001'.repeat(4_000)
    harness.setCheckResult(makeCheckResult({ stdoutTail: controls, stderrTail: controls }))
    const { run } = newRun(harness, { precheck: { command: `printf '${controls}' | tee /dev/stderr`, timeoutSeconds: 5 } })
    const dispatched = await harness.dispatcher.dispatch(run.id)
    expect(dispatched?.status).toBe('dispatched')
    expect(Buffer.byteLength(JSON.stringify(dispatched?.precheckResult), 'utf8')).toBeLessThanOrEqual(65_536)
    expect(dispatched?.precheckResult?.stdoutTruncated || dispatched?.precheckResult?.stderrTruncated).toBe(true)
  })
})
