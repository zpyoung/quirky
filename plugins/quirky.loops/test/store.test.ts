import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { IterationDetail, LoopSnapshot } from '../src/types'
import { loopMigrations, LoopStore } from '../src/store'

const roots: string[] = []
const databases: Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function memoryStore(readOnly = false) {
  const root = mkdtempSync(join(tmpdir(), 'quirky-loop-store-'))
  roots.push(root)
  const database = new Database(join(root, 'loops.sqlite'))
  databases.push(database)
  for (const migration of loopMigrations()) {
    if (typeof migration === 'string') database.exec(migration)
    else migration({
      version: 0,
      run: (sql, ...params) => database.query(sql).run(...params),
      get: (sql, ...params) => database.query(sql).get(...params) as never,
      all: (sql, ...params) => database.query(sql).all(...params) as never,
      exec: (sql) => database.exec(sql),
      transaction: (work) => database.transaction(work)()
    })
  }
  const pluginStore = {
    version: 1,
    readOnly,
    run: (sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]) => database.query(sql).run(...params),
    get: <T>(sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]) => database.query(sql).get(...params) as T | null,
    all: <T>(sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]) => database.query(sql).all(...params) as T[],
    exec: (sql: string) => database.exec(sql),
    transaction: <T>(work: () => T) => database.transaction(work)()
  }
  return { database, store: new LoopStore(pluginStore as never), pluginStore }
}

function snapshot(): LoopSnapshot {
  return {
    id: 'loop-a',
    name: 'Feature',
    slug: 'feature-loop-a',
    worktreeId: 'wt-a',
    cwd: '/tmp/workspace',
    workspaceKind: 'folder',
    agent: 'claude',
    preset: 'until-done',
    config: {
      promptSource: { kind: 'repeat', body: 'implement' },
      pacing: { kind: 'on-idle' },
      sessionPolicy: 'fresh',
      done: {},
      caps: {},
      noProgress: false,
      checkpointCommits: false,
      askBeforeNext: false,
      resumeAtLimitReset: false
    },
    state: 'running',
    pauseReason: null,
    pauseDetail: null,
    sessionId: null,
    iterationsCompleted: 0,
    activeMs: 0,
    costUsd: null,
    phase: null,
    nextIterationAt: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    notesPath: '/tmp/workspace/.quirky/loops/feature-loop-a/notes.md',
    warnings: [],
    recentIterations: []
  }
}

function attempt(n: number, attemptNumber = 1): IterationDetail {
  return {
    loopId: 'loop-a',
    n,
    attempt: attemptNumber,
    sessionId: 'session-a',
    promptSent: 'prompt',
    startedAt: n,
    endedAt: n + 1,
    endReason: 'settled',
    doneConfig: {},
    check: { ran: true, pass: false, exitCode: 1, timedOut: false, stdoutTail: 'x'.repeat(5000), stderrTail: '', durationMs: 1 },
    evaluator: null,
    markers: { done: false },
    diff: null,
    treeBefore: null,
    treeAfter: null,
    protectedPathHits: [],
    checkpointCommit: null,
    costUsd: null,
    usageLimit: null,
    outputTail: 'y'.repeat(17000)
  }
}

describe('LoopStore', () => {
  test('persists steer notes and bounded attempts across store instances', () => {
    const { store, pluginStore } = memoryStore()
    store.saveLoop(snapshot())
    const noteId = store.addSteerNote('loop-a', 'use banana', 4)
    store.saveAttempt(attempt(1))

    const reopened = new LoopStore(pluginStore as never)
    expect(reopened.getLoop('loop-a')?.state).toBe('running')
    expect(reopened.iterations('loop-a', 50)[0]).toMatchObject({
      n: 1,
      outputTail: 'y'.repeat(16384),
      check: { stdoutTail: 'x'.repeat(4000) }
    })
    expect(reopened.steerNotes('loop-a')).toEqual([{ id: noteId, body: 'use banana', createdAt: 4 }])
    reopened.consumeSteerNotes('loop-a', [noteId], 2)
    expect(reopened.steerNotes('loop-a')).toEqual([])
    expect(reopened.steerNotes('loop-a', true)).toMatchObject([{ id: noteId, consumedByIteration: 2 }])
  })

  test('limits snapshots to 50 attempts and ended history to 200 attempts', () => {
    const { store } = memoryStore()
    const loop = snapshot()
    store.saveLoop(loop)
    for (let n = 1; n <= 220; n++) store.saveAttempt(attempt(n))

    expect(store.getLoop('loop-a')?.recentIterations).toHaveLength(50)
    store.saveLoop({ ...loop, state: 'stopped', endedAt: 300, updatedAt: 300 })
    store.pruneEndedAttempts()
    expect(store.iterations('loop-a', 500)).toHaveLength(200)
    expect(store.iterations('loop-a', 500)[0]?.n).toBe(21)
  })

  test('refuses mutations in read-only mode but preserves snapshot reads', () => {
    const { store } = memoryStore(true)
    expect(() => store.saveLoop(snapshot())).toThrow(/read.only/i)
    expect(store.getLoop('loop-a')).toBeNull()
  })
})
