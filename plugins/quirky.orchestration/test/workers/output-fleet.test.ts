import { describe, expect, test } from 'bun:test'
import type { RunId } from '../../src/contracts'
import type { WorkerArchive } from '../../src/worker-contracts'
import { createWorkerOutput } from '../../src/workers/output'
import { createWorkerFleet } from '../../src/workers/fleet'
import {
  callerFixture, makeDispatch, makeHarness, makeRecord, makeResource, sessionFixture
} from './output-fleet-support'

const transcriptMessages = (count: number): string => Array.from({ length: count }, (_, index) => JSON.stringify({
  type: index % 2 === 0 ? 'user' : 'assistant',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `message-${index}` }
})).join('\n')

const expectError = async (operation: Promise<unknown>, code: string): Promise<void> => {
  try {
    await operation
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(code)
    return
  }
  throw new Error(`expected ${code}`)
}
const textOf = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('text' in value)) return null
  return typeof value.text === 'string' ? value.text : null
}

describe('worker output source and archive behavior', () => {
  test('captures the exact public provider transcript as immutable evidence without persisting it', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const raw = transcriptMessages(2)
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: raw }
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const archive = await output.capture(dispatch.id)

    expect(archive).toMatchObject({
      dispatchId: dispatch.id,
      resourceId: `resource-${dispatch.id}`,
      kind: 'transcript_pin',
      status: 'captured',
      content: raw
    })
    expect(archive.sourceIdentity.length).toBeGreaterThan(0)
    expect(Object.isFrozen(archive)).toBe(true)
    expect(harness.repo.archive(dispatch.id)).toBeNull()
    expect(harness.calls.map(({ method }) => method)).toContain('quirky.session-info/transcript')
    expect(harness.calls.map(({ method }) => method)).not.toContain('quirky.terminal/history')
  })
  test('parses supported Codex transcript events into user and assistant messages', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture({ agent: 'codex' })
    const transcript = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'review this' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'I found the issue' } })
    ].join('\n')
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: transcript }
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const result = await output.read({ dispatchId: dispatch.id })

    expect(result.source).toBe('transcript')
    expect(result.messages).toHaveLength(2)
    expect(textOf(result.messages?.[0])).toBe('review this')
    expect(textOf(result.messages?.[1])).toBe('I found the issue')
  })


  test('labels an exact empty transcript and falls back to terminal output only for auto', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: '' }
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const automatic = await output.read({ dispatchId: dispatch.id })
    expect(automatic.source).toBe('terminal')
    expect(automatic.sourceExact).toBe(true)
    expect(automatic.fallbackReason).toBe('transcript_empty')
    expect(automatic.content).toContain('captured terminal output')

    const explicit = await output.read({ dispatchId: dispatch.id, source: 'transcript' })
    expect(explicit.source).toBe('transcript')
    expect(explicit.sourceExact).toBe(true)
    expect(explicit.fallbackReason).toBe('transcript_empty')
    expect(explicit.contentComplete).toBe(false)
    expect(harness.calls.filter(({ method }) => method === 'quirky.terminal/history')).toHaveLength(1)
  })
  test('labels parse failures while retaining the exact captured source', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: '{not valid json' }
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const automatic = await output.read({ dispatchId: dispatch.id })
    expect(automatic.source).toBe('terminal')
    expect(automatic.fallbackReason).toBe('transcript_parse_failed')
    expect(automatic.content).toContain('captured terminal output')

    const explicit = await output.read({ dispatchId: dispatch.id, source: 'transcript' })
    expect(explicit.source).toBe('transcript')
    expect(explicit.sourceExact).toBe(true)
    expect(explicit.fallbackReason).toBe('transcript_parse_failed')
    expect(explicit.contentComplete).toBe(false)
  })

  test('reports unsupported provider formats instead of interpreting their transcripts', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture({ agent: 'qwen-code' })
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: transcriptMessages(1) }
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const result = await output.read({ dispatchId: dispatch.id })

    expect(result.source).toBe('terminal')
    expect(result.fallbackReason).toBe('provider_unsupported')
    expect(result.content).toContain('captured terminal output')
    expect(harness.calls.map(({ method }) => method)).not.toContain('quirky.session-info/transcript')
  })
  test('continues a paged terminal fallback for its dispatch', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const terminalOutput = 'F'.repeat(40_000)
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: '{not valid json' },
      terminalLines: [terminalOutput]
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const first = await output.read({ dispatchId: dispatch.id })
    expect(first.source).toBe('terminal')
    expect(first.fallbackReason).toBe('transcript_parse_failed')
    expect(first.nextCursor).not.toBeNull()

    const second = await output.read({ dispatchId: dispatch.id, cursor: first.nextCursor! })

    expect(second.source).toBe('terminal')
    expect(second.fallbackReason).toBe('transcript_parse_failed')
    expect(second.content).toBe('F'.repeat(40_000 - 32 * 1_024))
    expect(second.nextCursor).toBeNull()
  })

  test('does not read session output until the attached process runtime epoch is proven', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id, { processRuntimeEpoch: null })],
      resources: [makeResource(dispatch, session.id)],
      session
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const result = await output.read({ dispatchId: dispatch.id })

    expect(result.source).toBe('terminal')
    expect(result.sourceExact).toBe(false)
    expect(result.fallbackReason).toBe('session_not_reported')
    expect(harness.calls).toEqual([])
  })


  test('bounds captured terminal archives to the newest 262144 characters', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const terminalTail = 'T'.repeat(300_000)
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: '' },
      terminalLines: ['older output', terminalTail]
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const archive = await output.capture(dispatch.id)

    expect(archive.kind).toBe('terminal_tail')
    expect(archive.status).toBe('captured')
    expect(archive.content).toBe('T'.repeat(262_144))
  })



  test('pins transcript pages to their source, allows appends, and rejects consumed-content drift', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const transcript = { path: session.providerSession!.transcriptPath!, text: transcriptMessages(60) }
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [makeRecord(dispatch, session.id)],
      resources: [makeResource(dispatch, session.id)],
      session,
      transcript
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const first = await output.read({ dispatchId: dispatch.id })
    expect(first.source).toBe('transcript')
    expect(first.sourceExact).toBe(true)
    expect(first.fallbackReason).toBeNull()
    expect(first.messages).toHaveLength(40)
    expect(first.contentComplete).toBe(false)
    expect(first.nextCursor?.startsWith('owr2_')).toBe(true)
    expect(first.nextCursor!.length).toBeLessThanOrEqual(2048)

    const second = await output.read({ dispatchId: dispatch.id, cursor: first.nextCursor! })
    expect(second.messages).toHaveLength(20)
    expect(second.nextCursor).toBeNull()
    expect(textOf(second.messages?.[0])).toBe('message-40')
    await expectError(output.read({ dispatchId: dispatch.id, source: 'terminal', cursor: first.nextCursor! }), 'source_changed')
    const maximum = await output.read({ dispatchId: dispatch.id, limit: 100 })
    expect(maximum.messages).toHaveLength(50)
    expect(maximum.nextCursor).not.toBeNull()

    transcript.text += `\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'new source version' } })}`
    const appended = await output.read({ dispatchId: dispatch.id, cursor: first.nextCursor! })
    expect(appended.messages).toHaveLength(21)
    expect(textOf(appended.messages?.[0])).toBe('message-40')
    expect(textOf(appended.messages?.[20])).toBe('new source version')
    expect(appended.sourceIdentity).toBe(first.sourceIdentity)

    transcript.text = transcript.text.replace('message-0', 'changed-message-0')
    await expectError(output.read({ dispatchId: dispatch.id, cursor: first.nextCursor! }), 'source_changed')
  })

  test('accepts append-only cursor continuation for terminal and structured sources', async () => {
    const terminalDispatch = makeDispatch()
    const terminalSession = sessionFixture()
    const terminalLines = ['T'.repeat(33_000)]
    const terminalHarness = makeHarness({
      dispatches: [terminalDispatch],
      records: [makeRecord(terminalDispatch, terminalSession.id)],
      resources: [makeResource(terminalDispatch, terminalSession.id)],
      session: terminalSession,
      terminalLines
    })
    const terminalOutput = createWorkerOutput(terminalHarness.core, terminalHarness.repo, terminalHarness.runtime)
    const firstTerminal = await terminalOutput.read({ dispatchId: terminalDispatch.id, source: 'terminal' })
    expect(firstTerminal.nextCursor).not.toBeNull()

    terminalLines.push('appended terminal line')
    const secondTerminal = await terminalOutput.read({ dispatchId: terminalDispatch.id, cursor: firstTerminal.nextCursor! })
    expect(secondTerminal.sourceIdentity).toBe(firstTerminal.sourceIdentity)
    expect(secondTerminal.content).toContain('appended terminal line')

    const journalDispatch = makeDispatch(2)
    const journalSession = sessionFixture({ kind: 'structured', agent: 'codex', providerSession: null })
    const journal = Array.from({ length: 60 }, (_, index) => ({
      sessionId: journalSession.id,
      seq: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `journal-${index}`,
      at: index
    }))
    const journalHarness = makeHarness({
      dispatches: [journalDispatch],
      records: [makeRecord(journalDispatch, journalSession.id, { mode: 'structured' })],
      resources: [makeResource(journalDispatch, journalSession.id)],
      session: journalSession,
      structuredMessages: journal
    })
    const journalOutput = createWorkerOutput(journalHarness.core, journalHarness.repo, journalHarness.runtime)
    const firstJournal = await journalOutput.read({ dispatchId: journalDispatch.id })
    expect(firstJournal.source).toBe('structured')
    expect(firstJournal.nextCursor).not.toBeNull()

    journal.push({ sessionId: journalSession.id, seq: 61, role: 'assistant', text: 'journal-60', at: 60 })
    const secondJournal = await journalOutput.read({ dispatchId: journalDispatch.id, cursor: firstJournal.nextCursor! })

    expect(secondJournal.messages).toHaveLength(21)
    expect(textOf(secondJournal.messages?.[20])).toBe('journal-60')
    expect(secondJournal.sourceIdentity).toBe(firstJournal.sourceIdentity)
  })

  test('keeps oversized multibyte structured messages on UTF-8 boundaries within the byte limit', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture({ kind: 'structured', agent: 'codex', providerSession: null })
    const record = makeRecord(dispatch, session.id, { mode: 'structured' })
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [record],
      resources: [makeResource(dispatch, session.id)],
      session,
      structuredMessages: [{ sessionId: session.id, seq: 1, role: 'assistant', text: '🧪é漢'.repeat(100_000), at: Date.now() }]
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const page = await output.read({ dispatchId: dispatch.id })

    expect(page.source).toBe('structured')
    expect(page.clipping.clipped).toBe(true)
    expect(page.contentComplete).toBe(false)
    expect(page.nextCursor).not.toBeNull()
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(512 * 1024)
    const text = textOf(page.messages?.[0])
    expect(text).not.toBeNull()
    expect(typeof text === 'string' && /[\uD800-\uDBFF]$/.test(text)).toBe(false)
  })

  test('reads transferred resources only from their frozen archive, never successor output', async () => {
    const dispatch = makeDispatch(1)
    const successor = makeDispatch(2)
    const session = sessionFixture()
    const raw = transcriptMessages(60)
    const resource = makeResource(dispatch, session.id)
    const harness = makeHarness({
      dispatches: [dispatch, successor],
      records: [makeRecord(dispatch, session.id), makeRecord(successor, 'successor-session')],
      resources: [resource],
      session,
      transcript: { path: session.providerSession!.transcriptPath!, text: raw }
    })
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)
    const archive: WorkerArchive = await output.capture(dispatch.id)
    harness.repo.putArchive(archive)
    harness.repo.putResource({
      ...resource,
      ownerDispatchId: successor.id,
      priorOwnerDispatchIds: [dispatch.id],
      sessionId: 'successor-session',
      processIncarnation: 'successor-incarnation',
      ownershipState: 'transferred'
    })
    session.id = 'successor-session'
    session.providerSession = { id: 'successor-provider-session', transcriptPath: '/private/successor.jsonl' }
    harness.calls.length = 0

    const result = await output.read({ dispatchId: dispatch.id })

    expect(result.archived).toBe(true)
    expect(result.sourceExact).toBe(true)
    expect(result.content).toContain('message-0')
    expect(result.content).not.toContain('successor')
    expect(result.nextCursor).not.toBeNull()
    expect(harness.calls).toEqual([])
    harness.repo.putArchive({ ...archive, content: archive.content.replace('message-50', 'changed-message-50') })
    await expectError(output.read({ dispatchId: dispatch.id, cursor: result.nextCursor! }), 'source_changed')
    expect(harness.calls).toEqual([])
  })
  test('reads current user-owned and external resources without losing exact identity', async () => {
    for (const ownershipState of ['user_owned', 'external'] as const) {
      const dispatch = makeDispatch()
      const session = sessionFixture()
      const resource = makeResource(dispatch, session.id, { ownershipState, releaseState: 'retained' })
      const harness = makeHarness({
        dispatches: [dispatch],
        records: [makeRecord(dispatch, session.id)],
        resources: [resource],
        session,
        transcript: { path: session.providerSession!.transcriptPath!, text: transcriptMessages(1) }
      })
      const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)
      const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

      const result = await output.read({ dispatchId: dispatch.id })
      const shown = await fleet.show({ dispatchId: dispatch.id })

      expect(result.archived).toBe(false)
      expect(result.sourceExact).toBe(true)
      expect(result.sessionId).toBe(session.id)
      expect(result.content).toContain('message-0')
      expect(shown.observation.exactWorker).toBe(true)
      expect(shown.terminal?.id).toBe(session.id)
      expect(shown.projection.liveness).toEqual({ status: 'live', reason: null })
      expect(shown.terminalResource).toMatchObject({ ownershipState, ownerDispatchId: dispatch.id })
      expect(harness.calls.map(({ method }) => method)).toContain('quirky.session-info/transcript')
      fleet.dispose()
    }
  })

  test('keeps a proven output exit over an agent-status recheck failure', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const record = makeRecord(dispatch, session.id)
    const observation = {
      status: 'exited' as const,
      exactWorker: true,
      reason: 'process_exited',
      identity: {
        sessionId: session.id, live: false as const, runtimeEpoch: 'session-epoch-1', processIncarnation: record.processIncarnation!,
        source: 'terminal_launch' as const, kind: 'terminal' as const, providerId: 'claude', worktreeId: 'wt-main'
      },
      session
    }
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [record],
      resources: [makeResource(dispatch, session.id)],
      session,
      observation
    })
    let observations = 0
    harness.runtime.observe = async () => {
      observations++
      if (observations === 3) throw new Error('host unavailable')
      return observation
    }
    const output = createWorkerOutput(harness.core, harness.repo, harness.runtime)

    const result = await output.read({ dispatchId: dispatch.id, source: 'terminal' })

    expect(observations).toBe(3)
    expect(result.agentLiveness).toEqual({ status: 'exited', reason: null })
  })

})

describe('worker fleet projection and snapshots', () => {
  test('uses bound Run scope and a pinned newest-first snapshot across concurrent inserts', async () => {
    const dispatches = Array.from({ length: 205 }, (_, index) => makeDispatch(index + 1, index % 2 === 0 ? 'run_1' as RunId : 'run_2' as RunId))
    const records = dispatches.map((dispatch) => makeRecord(dispatch, `session-${dispatch.id}`))
    const resources = dispatches.map((dispatch, index) => makeResource(dispatch, `session-${dispatch.id}`, index % 20 === 0 ? { ownershipState: 'user_owned', releaseState: 'retained' } : {}))
    const harness = makeHarness({ dispatches, records, resources, boundRunId: 'run_1' as RunId })
    const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

    const first = await fleet.list({ limit: 50, terminalState: 'active' }, callerFixture())
    expect(first.scope).toEqual({ runId: 'run_1', source: 'bound' })
    expect(first.workers).toHaveLength(50)
    expect(first.page.total).toBe(92)
    expect(first.page.nextCursor).not.toBeNull()
    expect(first.workers[0].dispatchId).toBe('ctx_0205')

    const inserted = makeDispatch(999, 'run_1' as RunId)
    harness.addDispatch(inserted, makeRecord(inserted, 'new-session'), makeResource(inserted, 'new-session'))
    const second = await fleet.list({ cursor: first.page.nextCursor!, limit: 50, terminalState: 'active' }, callerFixture())
    expect(second.workers).toHaveLength(42)
    expect(second.page.total).toBe(92)
    expect(second.workers.some((row) => row.dispatchId === inserted.id)).toBe(false)
    expect(new Set([...first.workers, ...second.workers].map((row) => row.dispatchId)).size).toBe(92)
    await expectError(fleet.list({ cursor: first.page.nextCursor!, terminalState: 'released' }, callerFixture()), 'cursor_invalid')
    const flagged = await fleet.list({ runId: 'run_2' as RunId, limit: 50 }, callerFixture())
    expect(flagged.scope).toEqual({ runId: 'run_2', source: 'flag' })
    expect(flagged.page.total).toBe(102)
    expect(flagged.workers.every((row) => row.runId === 'run_2')).toBe(true)
    const all = await fleet.list({}, null)
    expect(all.scope).toEqual({ runId: null, source: 'all' })
    expect(all.page.total).toBe(206)

    fleet.dispose()
    await expectError(fleet.list({ cursor: first.page.nextCursor!, limit: 50, terminalState: 'active' }, callerFixture()), 'worker_list_cursor_expired')
  })

  test('projects context-only dispatches from core enumeration without inventing workers', async () => {
    const dispatch = makeDispatch(1, 'run_1' as RunId, { status: 'completed', completedAt: new Date().toISOString() })
    const harness = makeHarness({ dispatches: [dispatch], records: [], resources: [] })
    const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

    const result = await fleet.list({}, null)

    expect(result.workers).toHaveLength(1)
    expect(result.workers[0]).toMatchObject({
      dispatchId: dispatch.id,
      workerState: null,
      terminalState: 'released',
      projection: {
        outcome: 'finished_unverified',
        liveness: { status: 'unverifiable', reason: 'missing_status' },
        nextAction: { kind: 'none' }
      }
    })
    fleet.dispose()
  })

  test('rejects an oversized no-limit legacy fleet snapshot with its typed error', async () => {
    const dispatches = Array.from({ length: 5_001 }, (_, index) => makeDispatch(index + 1))
    const harness = makeHarness({ dispatches, records: [], resources: [] })
    const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

    await expectError(fleet.list({}, null), 'worker_list_snapshot_too_large')
    fleet.dispose()
  })

  test('keeps outcome separate from stale restored liveness and preserves exact agent-wait observation', async () => {
    const dispatch = makeDispatch(1, 'run_1' as RunId, { status: 'completed', completedAt: new Date().toISOString() })
    const session = sessionFixture()
    const record = makeRecord(dispatch, session.id, { state: 'succeeded' })
    const observation = {
      status: 'live' as const,
      exactWorker: true,
      reason: null,
      identity: {
        sessionId: session.id, live: true as const, runtimeEpoch: 'session-epoch-1', processIncarnation: record.processIncarnation!,
        source: 'terminal_launch' as const, kind: 'terminal' as const, providerId: 'claude', worktreeId: 'wt-main'
      },
      session,
      agentWait: { waiting: true, source: 'hook', reason: 'approval prompt' }
    }
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [record],
      resources: [makeResource(dispatch, session.id)],
      session,
      observation,
      status: { state: 'working', display: 'unconfirmed', evidenceAt: Date.now(), restoredUnconfirmed: true, sessionId: session.id },
      attention: { guidance: true, input: true, approval: true, rootCompletion: true }
    })
    const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

    const shown = await fleet.show({ dispatchId: dispatch.id })

    expect(shown.projection.outcome).toBe('succeeded')
    expect(shown.projection.liveness).toEqual({ status: 'unverifiable', reason: 'restored_unconfirmed' })
    expect(shown.observation.agentWait).toEqual({ waiting: true, source: 'hook', reason: 'approval prompt' })
    expect(shown.projection.attention.categories).toEqual(expect.arrayContaining(['guidance', 'input', 'approval', 'root_completion', 'unverifiable']))
    expect(shown.projection.nextAction.kind).toBe('none')
    expect(shown.projection.attention.requiresAction).toBe(true)
    fleet.dispose()
  })

  test('rejects stale and over-skew evidence without declaring exit, but accepts five-second clock tolerance', async () => {
    const examples = [
      { evidenceAt: Date.now() - 31 * 60 * 1_000, expectedStatus: 'stale', reason: 'stale_status' },
      { evidenceAt: Date.now() + 6_000, expectedStatus: 'stale', reason: 'future_status' },
      { evidenceAt: Date.now() + 4_000, expectedStatus: 'fresh', reason: null }
    ] as const
    for (const example of examples) {
      const dispatch = makeDispatch()
      const harness = makeHarness({
        dispatches: [dispatch],
        status: {
          state: 'working', display: 'working', evidenceAt: example.evidenceAt,
          restoredUnconfirmed: false, sessionId: 'worker-session', agent: 'claude'
        }
      })
      const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

      const shown = await fleet.show({ dispatchId: dispatch.id })

      expect(shown.projection.evidence.liveStatus).toBe(example.expectedStatus)
      expect(shown.projection.liveness.status).toBe(example.expectedStatus === 'fresh' ? 'live' : 'unverifiable')
      expect(shown.projection.liveness.reason).toBe(example.reason)
      fleet.dispose()
    }
  })

  test('uses exact local observation only for a missing-status gap and reports remote limits without fake rows', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const record = makeRecord(dispatch, session.id)
    const observation = {
      status: 'live' as const,
      exactWorker: true,
      reason: null,
      identity: {
        sessionId: session.id, live: true as const, runtimeEpoch: 'session-epoch-1', processIncarnation: record.processIncarnation!,
        source: 'terminal_launch' as const, kind: 'terminal' as const, providerId: 'claude', worktreeId: 'wt-main'
      },
      session
    }
    const harness = makeHarness({ dispatches: [dispatch], records: [record], resources: [makeResource(dispatch, session.id)], session, observation, status: null })
    const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

    const shown = await fleet.show({ dispatchId: dispatch.id })
    const listed = await fleet.list({ includeRemote: true }, null)

    expect(shown.projection.liveness).toEqual({ status: 'live', reason: null })
    expect(listed.workers).toHaveLength(1)
    expect(listed.partialHostErrors).toEqual([{ host: 'remote', reason: 'capability_unsupported' }])
    fleet.dispose()
  })
  test('makes a live settled owned resource reclaimable and directs release', async () => {
    for (const state of ['succeeded', 'failed'] as const) {
      const dispatch = makeDispatch(1, 'run_1' as RunId, { status: state === 'succeeded' ? 'completed' : 'failed' })
      const session = sessionFixture()
      const record = makeRecord(dispatch, session.id, { state })
      const harness = makeHarness({
        dispatches: [dispatch],
        records: [record],
        resources: [makeResource(dispatch, session.id)],
        session,
        status: { state: 'working', display: 'idle', evidenceAt: Date.now(), restoredUnconfirmed: false, sessionId: session.id }
      })
      const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

      const shown = await fleet.show({ dispatchId: dispatch.id })

      expect(shown.projection.outcome).toBe(state)
      expect(shown.projection.liveness).toEqual({ status: 'live', reason: null })
      expect(shown.terminalResource?.ownershipState).toBe('owned')
      expect(shown.projection.nextAction).toEqual({ kind: 'release', argv: ['worker-release', '--dispatch', dispatch.id] })
      fleet.dispose()
    }
  })

  test('lets an exact current-incarnation exit outrank fresh working evidence', async () => {
    const dispatch = makeDispatch()
    const session = sessionFixture()
    const record = makeRecord(dispatch, session.id)
    const observation = {
      status: 'exited' as const,
      exactWorker: true,
      reason: 'process_exited',
      identity: {
        sessionId: session.id, live: false as const, runtimeEpoch: 'session-epoch-1', processIncarnation: record.processIncarnation!,
        source: 'terminal_launch' as const, kind: 'terminal' as const, providerId: 'claude', worktreeId: 'wt-main'
      },
      session
    }
    const harness = makeHarness({
      dispatches: [dispatch],
      records: [record],
      resources: [makeResource(dispatch, session.id)],
      session,
      observation,
      status: { state: 'working', display: 'working', evidenceAt: Date.now(), restoredUnconfirmed: false, sessionId: session.id }
    })
    const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

    const shown = await fleet.show({ dispatchId: dispatch.id })

    expect(shown.projection.evidence.liveStatus).toBe('fresh')
    expect(shown.projection.liveness).toEqual({ status: 'exited', reason: null })
    expect(shown.projection.nextAction).toEqual({ kind: 'recover', argv: ['worker-read', '--dispatch', dispatch.id] })
    fleet.dispose()
  })

  test('honors certified dispatch termination reasons over fresh working evidence', async () => {
    for (const terminationReason of ['exited', 'signaled', 'operator_close'] as const) {
      const dispatch = makeDispatch(1, 'run_1' as RunId, { terminationReason })
      const session = sessionFixture()
      const harness = makeHarness({
        dispatches: [dispatch],
        records: [makeRecord(dispatch, session.id)],
        resources: [makeResource(dispatch, session.id)],
        session,
        status: { state: 'working', display: 'working', evidenceAt: Date.now(), restoredUnconfirmed: false, sessionId: session.id }
      })
      const fleet = createWorkerFleet(harness.core, harness.repo, harness.runtime)

      const shown = await fleet.show({ dispatchId: dispatch.id })

      expect(shown.projection.evidence.liveStatus).toBe('fresh')
      expect(shown.projection.liveness).toEqual({ status: 'exited', reason: null })
      fleet.dispose()
    }
  })

})
