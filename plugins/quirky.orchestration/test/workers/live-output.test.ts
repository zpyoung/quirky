import { describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import type { DispatchRow } from '../../src/contracts'
import type { TerminalResource, WorkerObservation, WorkerOutput, WorkerReadResult, WorkerRecord } from '../../src/worker-contracts'
import type { Harness } from './output-fleet-support'
import { createWorkerOutput } from '../../src/workers/output'
import {
  makeDispatch, makeHarness, makeRecord, makeResource, sessionFixture
} from './output-fleet-support'

type FixtureOptions = {
  index?: number
  session?: Session
  transcript?: { path: string; text: string } | Error
  terminalLines?: string[]
  terminalScreenLines?: string[]
  structuredMessages?: readonly { sessionId: string; seq: number; role: string; text: string; at: number }[]
  record?: Partial<WorkerRecord>
  resource?: Partial<TerminalResource>
}
type HistoryReader = (params: Record<string, unknown>) => unknown | Promise<unknown>
type ScreenReader = (sessionId: string, lines: number) => unknown | Promise<unknown>
type OutputFixture = {
  dispatch: DispatchRow
  session: Session
  harness: Harness
  output: WorkerOutput
  screenCalls: Array<{ sessionId: string; lines: number }>
  historyCalls: Array<Record<string, unknown>>
  setHistoryReader(reader: HistoryReader): void
  setScreenReader(reader: ScreenReader): void
}

function makeOutputFixture(options: FixtureOptions = {}): OutputFixture {
  const dispatch = makeDispatch(options.index ?? 1)
  const session = options.session ?? sessionFixture()
  const record = makeRecord(dispatch, session.id, options.record)
  const resource = makeResource(dispatch, session.id, options.resource)
  const harness = makeHarness({
    dispatches: [dispatch], records: [record], resources: [resource], session,
    transcript: options.transcript,
    terminalLines: options.terminalLines ?? [],
    terminalScreenLines: options.terminalScreenLines ?? [],
    structuredMessages: options.structuredMessages
  })
  const screenCalls: Array<{ sessionId: string; lines: number }> = []
  const historyCalls: Array<Record<string, unknown>> = []
  let historyReader: HistoryReader = () => ({ lines: options.terminalLines ?? [], cursor: null })
  let screenReader: ScreenReader = (_sessionId, lines) => ({
    lines: lines === 0 ? options.terminalScreenLines ?? [] : [], cols: 80, rows: 24, alt: false
  })
  const context = harness.runtime.context
  const originalCall = context.call.bind(context)
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.terminal/history') {
      historyCalls.push(params)
      return historyReader(params)
    }
    return originalCall(method, params)
  }) as typeof context.call
  context.pty.read = (async (sessionId: string, lines: number) => {
    screenCalls.push({ sessionId, lines })
    return screenReader(sessionId, lines)
  }) as typeof context.pty.read
  return {
    dispatch, session, harness, output: createWorkerOutput(harness.core, harness.repo, harness.runtime),
    screenCalls, historyCalls,
    setHistoryReader(reader: HistoryReader) { historyReader = reader },
    setScreenReader(reader: ScreenReader) { screenReader = reader }
  }
}

function clearReads(fixture: OutputFixture): void {
  fixture.screenCalls.length = 0
  fixture.historyCalls.length = 0
  fixture.harness.calls.length = 0
}

async function expectOutputError(operation: Promise<unknown>, kind: string, reason: string): Promise<void> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const outputError = error as Error & { kind?: unknown; data?: { reason?: unknown } }
    expect(outputError.kind).toBe(kind)
    expect(outputError.data?.reason).toBe(reason)
    expect(outputError.message).toContain(reason)
    return
  }
  throw new Error(`expected ${kind}/${reason}`)
}

describe('live worker terminal output', () => {
  test('returns the exact visible viewport for explicit terminal output and keeps empty output empty', async () => {
    const fixture = makeOutputFixture({ terminalScreenLines: ['VISIBLE'] })
    const result = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })

    expect(result).toMatchObject({
      dispatchId: fixture.dispatch.id, sessionId: fixture.session.id, source: 'terminal', archived: false,
      sourceExact: true, fallbackReason: null, content: 'VISIBLE', contentComplete: true,
      clipping: { clipped: false, maxBytes: 524288 }, nextCursor: null,
      terminalLiveness: 'live', agentLiveness: { status: 'live', reason: null }, warnings: []
    })
    expect(fixture.screenCalls).toEqual([{ sessionId: fixture.session.id, lines: 0 }])
    expect(fixture.historyCalls).toEqual([{ session: fixture.session.id, lines: 1024, format: 'text' }])

    const empty = makeOutputFixture()
    const emptyResult = await empty.output.read({ dispatchId: empty.dispatch.id, source: 'terminal' })
    expect(emptyResult).toMatchObject({ content: '', sourceExact: true, contentComplete: true, warnings: [] })
    expect(empty.screenCalls).toEqual([{ sessionId: empty.session.id, lines: 0 }])
  })

  test('automatic terminal fallback includes the viewport without erasing its reason', async () => {
    const session = sessionFixture()
    const cases: Array<{ options: FixtureOptions; reason: string }> = [
      { options: { session, transcript: { path: session.providerSession!.transcriptPath!, text: '' }, terminalScreenLines: ['VISIBLE'] }, reason: 'transcript_empty' },
      { options: { session: sessionFixture({ providerSession: null }), terminalScreenLines: ['VISIBLE'] }, reason: 'session_not_reported' },
      { options: { session: sessionFixture({ agent: 'qwen-code' }), terminalScreenLines: ['VISIBLE'] }, reason: 'provider_unsupported' }
    ]
    for (const [index, scenario] of cases.entries()) {
      const fixture = makeOutputFixture({ ...scenario.options, index: index + 1 })
      const result = await fixture.output.read({ dispatchId: fixture.dispatch.id })
      expect(result).toMatchObject({
        source: 'terminal', archived: false, sourceExact: true, content: 'VISIBLE',
        fallbackReason: scenario.reason, contentComplete: false
      })
      expect(fixture.screenCalls).toEqual([{ sessionId: fixture.session.id, lines: 0 }])
    }
  })

  test('prefers valid transcripts and structured journals without acquiring a viewport', async () => {
    const session = sessionFixture()
    const transcript = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'TRANSCRIPT' } })
    const transcriptFixture = makeOutputFixture({
      session, transcript: { path: session.providerSession!.transcriptPath!, text: transcript }, terminalScreenLines: ['SCREEN']
    })
    const automatic = await transcriptFixture.output.read({ dispatchId: transcriptFixture.dispatch.id })
    const explicit = await transcriptFixture.output.read({ dispatchId: transcriptFixture.dispatch.id, source: 'transcript' })
    expect(automatic.source).toBe('transcript')
    expect(explicit).toMatchObject({ source: 'transcript', sourceExact: true })
    expect(transcriptFixture.screenCalls).toEqual([])
    expect(transcriptFixture.historyCalls).toEqual([])

    const journalSession = sessionFixture({ kind: 'structured', agent: 'codex', providerSession: null })
    const journalFixture = makeOutputFixture({
      session: journalSession,
      record: { mode: 'structured' },
      structuredMessages: [{ sessionId: journalSession.id, seq: 1, role: 'assistant', text: 'JOURNAL', at: 1 }],
      terminalScreenLines: ['SCREEN']
    })
    const journal = await journalFixture.output.read({ dispatchId: journalFixture.dispatch.id })
    expect(journal.source).toBe('structured')
    expect(journalFixture.screenCalls).toEqual([])
    expect(journalFixture.historyCalls).toEqual([])

    const explicitEmptyFixture = makeOutputFixture({
      transcript: { path: session.providerSession!.transcriptPath!, text: '' }, terminalScreenLines: ['SCREEN']
    })
    const explicitEmpty = await explicitEmptyFixture.output.read({ dispatchId: explicitEmptyFixture.dispatch.id, source: 'transcript' })
    expect(explicitEmpty).toMatchObject({ source: 'transcript', fallbackReason: 'transcript_empty' })
    expect(explicitEmptyFixture.screenCalls).toEqual([])
    expect(explicitEmptyFixture.historyCalls).toEqual([])
  })

  test('places paginated history before the viewport and preserves repeated lines and separators', async () => {
    const fixture = makeOutputFixture({ terminalScreenLines: ['same', 'VISIBLE'] })
    fixture.setHistoryReader((params) => params.before === 'older'
      ? { lines: ['old'], cursor: null }
      : { lines: ['same'], cursor: 'older' })
    const result = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    expect(result.content).toBe('old\nsame\nsame\nVISIBLE')
    expect(fixture.historyCalls).toEqual([
      { session: fixture.session.id, lines: 1024, format: 'text' },
      { session: fixture.session.id, lines: 1024, format: 'text', before: 'older' }
    ])

    const alternate = makeOutputFixture({ terminalLines: ['history'] })
    alternate.setScreenReader(() => ({ lines: ['ALT RENDERED'], cols: 80, rows: 24, alt: true }))
    expect((await alternate.output.read({ dispatchId: alternate.dispatch.id, source: 'terminal' })).content).toBe('history\nALT RENDERED')

    const noScreen = makeOutputFixture({ terminalLines: ['history'] })
    expect((await noScreen.output.read({ dispatchId: noScreen.dispatch.id, source: 'terminal' })).content).toBe('history')
    const noHistory = makeOutputFixture({ terminalScreenLines: ['screen'] })
    expect((await noHistory.output.read({ dispatchId: noHistory.dispatch.id, source: 'terminal' })).content).toBe('screen')
  })

  test('pages the bounded multibyte viewport tail without splitting UTF-8 characters', async () => {
    const screen = '🧪é漢'.repeat(70_000) + 'END'
    const fixture = makeOutputFixture()
    fixture.setScreenReader(() => ({ lines: [screen], cols: 80, rows: 24, alt: false }))
    const pages: WorkerReadResult[] = []
    let page = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    pages.push(page)
    const maxPages = Math.ceil(Buffer.byteLength(screen) / (32768 - 3))
    while (page.nextCursor !== null) {
      if (pages.length > maxPages) throw new Error('terminal output did not finish paging')
      page = await fixture.output.read({ dispatchId: fixture.dispatch.id, cursor: page.nextCursor })
      pages.push(page)
    }
    const archive = await fixture.output.capture(fixture.dispatch.id)
    const joined = pages.map(({ content }) => content).join('')

    expect(joined).toBe(archive.content)
    expect(archive.content.length).toBeLessThanOrEqual(262144)
    expect(archive.content.endsWith('END')).toBe(true)
    expect(archive.content.length).toBeGreaterThan(0)
    expect(archive.content.charCodeAt(0) >= 0xdc00 && archive.content.charCodeAt(0) <= 0xdfff).toBe(false)
    expect(pages[0]?.nextCursor).not.toBeNull()
    expect(pages[0]?.nextCursor?.length).toBeLessThanOrEqual(2048)
    expect(pages[0]).toMatchObject({ clipping: { clipped: true }, contentComplete: false })
    expect(pages.at(-1)?.nextCursor).toBeNull()
    for (const item of pages) {
      expect(item.warnings).toContain('terminal_tail_limited')
      expect(item.contentComplete).toBe(false)
      expect(new TextEncoder().encode(item.content).byteLength).toBeLessThanOrEqual(32768)
      expect(new TextEncoder().encode(JSON.stringify(item)).byteLength).toBeLessThanOrEqual(524288)
      expect(item.content).not.toContain('\ufffd')
      expect(/^[\uDC00-\uDFFF]/.test(item.content)).toBe(false)
      expect(/[\uD800-\uDBFF]$/.test(item.content)).toBe(false)
    }
    expect(fixture.screenCalls.every(({ sessionId, lines }) => sessionId === fixture.session.id && lines === 0)).toBe(true)
  })

  test('stops repeated history cursors and preserves the history page cap', async () => {
    const repeated = makeOutputFixture({ terminalScreenLines: ['screen'] })
    repeated.setHistoryReader(() => ({ lines: ['same'], cursor: 'repeat' }))
    const repeatedResult = await repeated.output.read({ dispatchId: repeated.dispatch.id, source: 'terminal' })
    expect(repeated.historyCalls).toHaveLength(2)
    expect(repeatedResult.content).toBe('same\nsame\nscreen')
    expect(repeatedResult.warnings).toContain('terminal_tail_limited')

    const capped = makeOutputFixture()
    let page = 0
    capped.setHistoryReader(() => ({ lines: [], cursor: `cursor-${++page}` }))
    const cappedResult = await capped.output.read({ dispatchId: capped.dispatch.id, source: 'terminal' })
    expect(capped.historyCalls).toHaveLength(128)
    expect(cappedResult.warnings).toContain('terminal_tail_limited')
  })

  test('treats rejected or malformed viewport data as an unavailable combined capture', async () => {
    const malformedScreens: unknown[] = [
      { lines: 'not-an-array', cols: 80, rows: 24, alt: false },
      { lines: [1], cols: 80, rows: 24, alt: false },
      { lines: [], cols: 0, rows: 24, alt: false },
      { lines: [], cols: 80, rows: 0, alt: false },
      { lines: [], cols: 1.5, rows: 24, alt: false },
      { lines: [], cols: 80, rows: 1.5, alt: false },
      { lines: [], cols: 80, rows: 24, alt: 'false' }
    ]
    for (const [index, malformed] of malformedScreens.entries()) {
      const fixture = makeOutputFixture({ index: index + 1 })
      fixture.setScreenReader(() => malformed)
      const result = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
      expect(result).toMatchObject({ content: '', sourceExact: false, contentComplete: false, nextCursor: null })
      expect(result.warnings).toContain('terminal_history_unreadable')
    }
    const rejected = makeOutputFixture()
    rejected.setScreenReader(() => { throw new Error('pty read failed') })
    const rejectedResult = await rejected.output.read({ dispatchId: rejected.dispatch.id, source: 'terminal' })
    expect(rejectedResult).toMatchObject({ content: '', sourceExact: false, contentComplete: false, nextCursor: null })
    expect(rejectedResult.warnings).toContain('terminal_history_unreadable')

    for (const brokenHistory of [
      () => { throw new Error('history failed') },
      () => ({ lines: 'not-an-array', cursor: null }),
      () => ({ lines: [1], cursor: null })
    ]) {
      const fixture = makeOutputFixture({ terminalScreenLines: ['SCREEN MUST NOT ESCAPE'] })
      fixture.setHistoryReader(brokenHistory)
      const result = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
      expect(result).toMatchObject({ content: '', sourceExact: false, contentComplete: false, nextCursor: null })
      expect(result.warnings).toContain('terminal_history_unreadable')
      expect(fixture.screenCalls).toEqual([{ sessionId: fixture.session.id, lines: 0 }])
    }
  })

  test('rechecks the exact lease after reading the viewport before returning any text', async () => {
    const fixture = makeOutputFixture({ terminalScreenLines: ['SUCCESSOR TEXT'] })
    const initial = await fixture.harness.runtime.observe(fixture.harness.records[0]!, fixture.dispatch)
    const changed: WorkerObservation = {
      status: 'identity_changed', exactWorker: false, reason: 'identity_changed', identity: null, session: null
    }
    let observation = initial
    fixture.harness.runtime.observe = async () => observation
    fixture.setScreenReader(() => {
      observation = changed
      return { lines: ['SUCCESSOR TEXT'], cols: 80, rows: 24, alt: false }
    })
    const result = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    expect(result).toMatchObject({ content: '', sourceExact: false, contentComplete: false })
    expect(result.warnings).toContain('terminal_lease_changed')
    expect(fixture.screenCalls).toEqual([{ sessionId: fixture.session.id, lines: 0 }])
  })

  test('continues an append-only live cursor and rejects consumed screen rewrites', async () => {
    let screen = 'X'.repeat(33_000)
    const fixture = makeOutputFixture()
    fixture.setScreenReader(() => ({ lines: [screen], cols: 80, rows: 24, alt: false }))
    const first = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    expect(first.content).toBe('X'.repeat(32_768))
    expect(first.nextCursor).not.toBeNull()
    expect(first.nextCursor!.length).toBeLessThanOrEqual(2048)
    expect(first.sourceIdentity).not.toBe('')

    screen += ' appended'
    const appended = await fixture.output.read({ dispatchId: fixture.dispatch.id, cursor: first.nextCursor! })
    expect(appended.content).toBe(`${'X'.repeat(232)} appended`)
    expect(appended.sourceIdentity).toBe(first.sourceIdentity)
    expect(appended.nextCursor).toBeNull()
    expect(appended.contentComplete).toBe(true)

    screen = `Y${screen.slice(1)}`
    await expectOutputError(
      fixture.output.read({ dispatchId: fixture.dispatch.id, cursor: first.nextCursor! }), 'conflict', 'source_changed'
    )
  })

  test('rejects invalid and foreign cursors before reading PTY output', async () => {
    const fixture = makeOutputFixture({ terminalScreenLines: ['X'.repeat(33_000)] })
    const first = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    expect(first.nextCursor).not.toBeNull()

    clearReads(fixture)
    await expectOutputError(
      fixture.output.read({ dispatchId: fixture.dispatch.id, cursor: 'invalid-cursor' }), 'invalid-params', 'cursor_invalid'
    )
    expect(fixture.screenCalls).toEqual([])
    expect(fixture.historyCalls).toEqual([])

    const other = makeDispatch(2)
    fixture.harness.addDispatch(other, makeRecord(other, fixture.session.id), makeResource(other, fixture.session.id))
    await expectOutputError(
      fixture.output.read({ dispatchId: other.id, cursor: first.nextCursor! }), 'invalid-params', 'cursor_invalid'
    )
    expect(fixture.screenCalls).toEqual([])
    expect(fixture.historyCalls).toEqual([])

    await expectOutputError(
      fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'transcript', cursor: first.nextCursor! }), 'conflict', 'source_changed'
    )
    expect(fixture.screenCalls).toEqual([])
    expect(fixture.historyCalls).toEqual([])
  })

  test('does not read without a proven lease and reads transferred output only from its frozen archive', async () => {
    const unproven = makeOutputFixture({ record: { processRuntimeEpoch: null }, terminalScreenLines: ['NO LEASE'] })
    const unavailable = await unproven.output.read({ dispatchId: unproven.dispatch.id, source: 'terminal' })
    expect(unavailable.sourceExact).toBe(false)
    expect(unavailable.warnings).toContain('terminal_lease_unavailable')
    expect(unproven.screenCalls).toEqual([])
    expect(unproven.historyCalls).toEqual([])

    const fixture = makeOutputFixture({ terminalScreenLines: ['FROZEN VIEWPORT'] })
    const live = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    expect(live.content).toBe('FROZEN VIEWPORT')
    const archive = await fixture.output.capture(fixture.dispatch.id)
    expect(archive.content).toBe('FROZEN VIEWPORT')
    expect(archive).toMatchObject({ kind: 'terminal_tail', status: 'captured' })
    fixture.harness.repo.putArchive(archive)
    const successor = makeDispatch(2)
    fixture.harness.addDispatch(successor, makeRecord(successor, 'successor-session'), makeResource(successor, 'successor-session'))
    const resource = fixture.harness.resources[0]!
    fixture.harness.repo.putResource({
      ...resource, ownerDispatchId: successor.id, priorOwnerDispatchIds: [fixture.dispatch.id],
      sessionId: 'successor-session', processIncarnation: 'successor-incarnation', ownershipState: 'transferred'
    })
    clearReads(fixture)

    const transferred = await fixture.output.read({ dispatchId: fixture.dispatch.id, source: 'terminal' })
    expect(transferred).toMatchObject({ content: 'FROZEN VIEWPORT', source: 'terminal', archived: true, sourceExact: true })
    expect(fixture.screenCalls).toEqual([])
    expect(fixture.historyCalls).toEqual([])
    const released = makeOutputFixture({ terminalScreenLines: ['RELEASED VIEWPORT'] })
    expect((await released.output.read({ dispatchId: released.dispatch.id, source: 'terminal' })).content).toBe('RELEASED VIEWPORT')
    const releasedArchive = await released.output.capture(released.dispatch.id)
    released.harness.repo.putArchive(releasedArchive)
    released.harness.repo.putResource({ ...released.harness.resources[0]!, releaseState: 'released' })
    clearReads(released)
    const archived = await released.output.read({ dispatchId: released.dispatch.id, source: 'terminal' })
    expect(archived).toMatchObject({ content: 'RELEASED VIEWPORT', source: 'terminal', archived: true, sourceExact: true })
    expect(released.screenCalls).toEqual([])
    expect(released.historyCalls).toEqual([])
  })
})
