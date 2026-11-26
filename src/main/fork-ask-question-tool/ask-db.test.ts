import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskDb, type RegisterAskParams } from './ask-db'

function baseParams(overrides: Partial<RegisterAskParams> = {}): RegisterAskParams {
  return {
    askId: 'ask_1',
    requestId: 'req_1',
    paneKey: 'pane:1',
    worktreeId: 'wt_1',
    origin: 'cli',
    specJson: '{"questions":[]}',
    timeoutMs: null,
    handoff: null,
    ...overrides
  }
}

describe('AskDb', () => {
  let db: AskDb | undefined
  let dir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('durably inserts a registered ask', () => {
    db = new AskDb(':memory:')
    const { row, created } = db.registerAsk(baseParams())
    expect(created).toBe(true)
    expect(row.ask_id).toBe('ask_1')
    expect(row.status).toBe('registered')
    expect(row.pane_key).toBe('pane:1')
    expect(row.answers_json).toBeNull()
  })

  it('keeps a hand-off timeout for its wait but arms no registry expiry', () => {
    db = new AskDb(':memory:')
    const { row } = db.registerAsk(
      baseParams({
        paneKey: null,
        origin: 'handoff',
        timeoutMs: 60_000,
        handoff: {
          runId: 'run_1',
          dispatchId: 'dispatch_1',
          askerHandle: 'term_1',
          questionId: null
        }
      })
    )
    expect(row.timeout_ms).toBe(60_000)
    expect(row.expires_at).toBeNull()
  })

  it('restores rows unchanged after reopening the database file', () => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    first.registerAsk(baseParams())
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    const row = reopened.getAsk('ask_1')
    expect(row?.request_id).toBe('req_1')
    expect(row?.spec_json).toBe('{"questions":[]}')
  })

  it('persists a partial and survives a reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    first.registerAsk(baseParams())
    first.updatePartial('ask_1', '{"q1":{"draft":"in progress"}}')
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    expect(reopened.getAsk('ask_1')?.partial_json).toBe('{"q1":{"draft":"in progress"}}')
  })

  it('purges resolved rows older than 24h but keeps pending rows', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams({ askId: 'ask_stale', requestId: 'req_stale' }))
    db.commitAskResult(
      'ask_stale',
      { status: 'answered', answersJson: '{}' },
      '2024-01-01T00:00:00.000Z'
    )
    db.registerAsk(baseParams({ askId: 'ask_pending', requestId: 'req_pending' }))

    const purged = db.purgeStaleTerminalRows('2024-01-02T00:00:01.000Z')

    expect(purged).toBe(1)
    expect(db.getAsk('ask_stale')).toBeUndefined()
    expect(db.getAsk('ask_pending')).toBeDefined()
  })

  it('does not purge a resolved row inside the 24h retention window', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams())
    db.commitAskResult(
      'ask_1',
      { status: 'answered', answersJson: '{}' },
      '2024-01-01T12:00:00.000Z'
    )

    const purged = db.purgeStaleTerminalRows('2024-01-02T00:00:00.000Z')

    expect(purged).toBe(0)
    expect(db.getAsk('ask_1')).toBeDefined()
  })

  it('sweeps stale rows immediately and again on every interval', () => {
    vi.useFakeTimers({ now: new Date('2024-01-02T00:00:01.000Z') })
    db = new AskDb(':memory:')
    db.registerAsk(baseParams({ askId: 'ask_stale', requestId: 'req_stale' }))
    db.commitAskResult(
      'ask_stale',
      { status: 'answered', answersJson: '{}' },
      '2024-01-01T00:00:00.000Z'
    )

    db.startPeriodicPurge(1_000)
    expect(db.getAsk('ask_stale')).toBeUndefined()

    db.registerAsk(baseParams({ askId: 'ask_stale_2', requestId: 'req_stale_2' }))
    db.commitAskResult(
      'ask_stale_2',
      { status: 'answered', answersJson: '{}' },
      '2024-01-01T00:00:00.000Z'
    )
    vi.advanceTimersByTime(1_000)
    expect(db.getAsk('ask_stale_2')).toBeUndefined()

    vi.useRealTimers()
  })

  it('stops the sweep on close, leaving no live handle behind', () => {
    vi.useFakeTimers({ now: new Date('2024-01-02T00:00:01.000Z') })
    // Own instance, closed within the test — the shared `db` var stays for afterEach's cleanup
    // of a database this test never opened.
    const owned = new AskDb(':memory:')
    owned.startPeriodicPurge(1_000)
    owned.close()

    // If the interval survived close(), running it here would query a closed connection and throw.
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()

    vi.useRealTimers()
  })

  it('stopPeriodicPurge halts future sweeps without closing the db', () => {
    vi.useFakeTimers({ now: new Date('2024-01-02T00:00:01.000Z') })
    db = new AskDb(':memory:')
    db.startPeriodicPurge(1_000)
    db.stopPeriodicPurge()

    db.registerAsk(baseParams({ askId: 'ask_stale', requestId: 'req_stale' }))
    db.commitAskResult(
      'ask_stale',
      { status: 'answered', answersJson: '{}' },
      '2024-01-01T00:00:00.000Z'
    )
    vi.advanceTimersByTime(5_000)

    expect(db.getAsk('ask_stale')).toBeDefined()
    vi.useRealTimers()
  })

  it('keeps seq monotonic across row changes and across a reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    const registered = first.registerAsk(baseParams())
    const afterPartial = first.updatePartial('ask_1', '{}')
    expect(afterPartial.seq).toBeGreaterThan(registered.row.seq)
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    const second = reopened.registerAsk(baseParams({ askId: 'ask_2', requestId: 'req_2' }))
    expect(second.row.seq).toBeGreaterThan(afterPartial.seq)
  })

  it('is idempotent on request_id: a replay returns the first row and inserts no second one', () => {
    db = new AskDb(':memory:')
    const first = db.registerAsk(baseParams())
    const replay = db.registerAsk(baseParams({ askId: 'ask_2' }))

    expect(replay.created).toBe(false)
    expect(replay.row.ask_id).toBe(first.row.ask_id)
    expect(db.getAsk('ask_2')).toBeUndefined()
  })

  it('derives expires_at from timeout_ms at registration and keeps it unchanged after a reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    const { row } = first.registerAsk(baseParams({ timeoutMs: 60_000 }), '2024-01-01T00:00:00.000Z')
    expect(row.expires_at).toBe('2024-01-01T00:01:00.000Z')
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    expect(reopened.getAsk('ask_1')?.expires_at).toBe('2024-01-01T00:01:00.000Z')
  })

  it('clamps expires_at instead of throwing when timeoutMs would overflow Date', () => {
    db = new AskDb(':memory:')
    const { row } = db.registerAsk(
      baseParams({ timeoutMs: Number.MAX_SAFE_INTEGER }),
      '2024-01-01T00:00:00.000Z'
    )
    expect(row.expires_at).toBe(new Date(8_640_000_000_000_000).toISOString())
  })

  it('round-trips the hand-off identity columns', () => {
    db = new AskDb(':memory:')
    const { row } = db.registerAsk(
      baseParams({
        origin: 'handoff',
        handoff: {
          runId: 'run_1',
          dispatchId: 'dispatch_1',
          askerHandle: 'coordinator',
          questionId: null
        }
      })
    )
    expect(row.handoff_run_id).toBe('run_1')
    expect(row.handoff_dispatch_id).toBe('dispatch_1')
    expect(row.handoff_asker).toBe('coordinator')
    expect(row.handoff_question_id).toBeNull()

    const updated = db.setHandoffQuestionId('ask_1', 'question_1')
    expect(updated.handoff_question_id).toBe('question_1')
  })

  it('listPending returns non-terminal rows in seq order and excludes every terminal status', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams({ askId: 'ask_answered', requestId: 'req_answered' }))
    db.commitAskResult('ask_answered', { status: 'answered', answersJson: '{}' })
    db.registerAsk(baseParams({ askId: 'ask_declined', requestId: 'req_declined' }))
    db.commitAskResult('ask_declined', { status: 'declined', answersJson: '{}' })
    db.registerAsk(baseParams({ askId: 'ask_timed_out', requestId: 'req_timed_out' }))
    db.commitAskResult('ask_timed_out', { status: 'timed_out', answersJson: '{}' })
    db.registerAsk(baseParams({ askId: 'ask_unavailable', requestId: 'req_unavailable' }))
    db.commitAskResult('ask_unavailable', { status: 'unavailable', answersJson: '{}' })
    db.registerAsk(baseParams({ askId: 'ask_pending_1', requestId: 'req_pending_1' }))
    db.registerAsk(baseParams({ askId: 'ask_pending_2', requestId: 'req_pending_2' }))

    const pending = db.listPending()

    expect(pending.map((row) => row.ask_id)).toEqual(['ask_pending_1', 'ask_pending_2'])
    expect(pending.every((row) => row.status === 'registered')).toBe(true)
  })

  it('listSinceSeq returns everything above the boundary in seq order, terminal rows included, seq <= n excluded', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams({ askId: 'ask_1', requestId: 'req_1' }))
    const boundary = db.registerAsk(baseParams({ askId: 'ask_2', requestId: 'req_2' }))
    db.registerAsk(baseParams({ askId: 'ask_3', requestId: 'req_3' }))
    // Why: committing bumps ask_3's own seq past its registration, so this also proves the
    // ordering is by seq — not by registration order or insertion order.
    db.commitAskResult('ask_3', { status: 'answered', answersJson: '{}' })
    db.registerAsk(baseParams({ askId: 'ask_4', requestId: 'req_4' }))

    const missed = db.listSinceSeq(boundary.row.seq)

    const seqs = missed.map((row) => row.seq)
    expect(missed.map((row) => row.ask_id)).toEqual(['ask_3', 'ask_4'])
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b))
    expect(missed.every((row) => row.seq > boundary.row.seq)).toBe(true)
    expect(missed.find((row) => row.ask_id === 'ask_3')?.status).toBe('answered')
  })
  it('lists pending asks in registration order even after a draft update bumps seq', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams({ askId: 'ask_a', requestId: 'req_a' }))
    db.registerAsk(baseParams({ askId: 'ask_b', requestId: 'req_b' }))
    db.updatePartial('ask_b', '{}')
    db.updatePartial('ask_a', '{}')
    db.updatePartial('ask_b', '{}')

    expect(db.listPending().map((row) => row.ask_id)).toEqual(['ask_a', 'ask_b'])
  })

  it('stamps a fresh seq when touchSeq promotes a queued ask', () => {
    db = new AskDb(':memory:')
    const { row } = db.registerAsk(baseParams())
    expect(db.touchSeq('ask_1').seq).toBeGreaterThan(row.seq)
  })
})
