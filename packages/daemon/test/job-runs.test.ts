import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'

describe('job runs', () => {
  let dir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-job-runs-'))
    dbPath = join(dir, 'quirky.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('starts empty', () => {
    expect(store.listJobRuns().size).toBe(0)
  })

  test('recordJobStart stores a running row', () => {
    store.recordJobStart('a', 100)
    expect(store.listJobRuns().get('a')).toEqual({ startedAt: 100, finishedAt: null, status: 'running' })
  })

  test('recordJobStart upserts and clears the previous finish and error', () => {
    store.recordJobStart('a', 100)
    store.recordJobFinish('a', 150, 'failed', 'boom')
    store.recordJobStart('a', 200)
    expect(store.listJobRuns().get('a')).toEqual({ startedAt: 200, finishedAt: null, status: 'running' })
  })

  test('recordJobFinish sets status, finish time and error', () => {
    store.recordJobStart('a', 100)
    store.recordJobFinish('a', 150, 'failed', 'boom')
    expect(store.listJobRuns().get('a')).toEqual({
      startedAt: 100,
      finishedAt: 150,
      status: 'failed',
      error: 'boom'
    })
    store.recordJobStart('b', 100)
    store.recordJobFinish('b', 120, 'ok')
    expect(store.listJobRuns().get('b')).toEqual({ startedAt: 100, finishedAt: 120, status: 'ok' })
  })

  test('recordJobFinish without an error clears a previous one', () => {
    store.recordJobStart('a', 100)
    store.recordJobFinish('a', 150, 'failed', 'boom')
    store.recordJobFinish('a', 160, 'ok')
    expect(store.listJobRuns().get('a')).toEqual({ startedAt: 100, finishedAt: 160, status: 'ok' })
  })

  test('recordJobSettled sets finished_at only for timed-out rows', () => {
    store.recordJobStart('t', 100)
    store.recordJobFinish('t', 200, 'timed-out')
    expect(store.listJobRuns().get('t')).toMatchObject({ status: 'timed-out', finishedAt: 200 })
    store.recordJobSettled('t', 300)
    expect(store.listJobRuns().get('t')).toMatchObject({ status: 'timed-out', finishedAt: 300 })
  })

  test('recordJobSettled leaves ok, failed and running rows alone', () => {
    store.recordJobStart('ok', 1)
    store.recordJobFinish('ok', 2, 'ok')
    store.recordJobStart('failed', 1)
    store.recordJobFinish('failed', 2, 'failed', 'x')
    store.recordJobStart('running', 1)
    const before = store.listJobRuns()
    for (const id of ['ok', 'failed', 'running', 'missing']) store.recordJobSettled(id, 999)
    expect(store.listJobRuns()).toEqual(before)
    expect(store.listJobRuns().has('missing')).toBe(false)
  })

  test('rows survive reopening the database', () => {
    store.recordJobStart('a', 100)
    store.recordJobFinish('a', 150, 'ok')
    store.close()
    store = new Store(dbPath)
    expect(store.listJobRuns().get('a')).toEqual({ startedAt: 100, finishedAt: 150, status: 'ok' })
  })
})
