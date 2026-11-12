import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { avatarMigrations } from '../store-migrations'
import { callFingerprint } from '../src/fingerprint'
import { createAvatarStore } from '../src/store'
import { memoryPluginStore, sampleMandate } from './support'

const fresh = () => createAvatarStore(memoryPluginStore())

describe('avatar store tables', () => {
  test('mandates round-trip their JSON and boolean columns and keep one row per worktree', () => {
    const store = fresh()
    const mandate = sampleMandate({ switches: { messaging: true, historyRewrite: false, deploys: true }, allowSplit: true, agent: 'codex' })
    store.mandates.put(mandate)
    expect(store.mandates.get('wt-1')).toEqual(mandate)
    store.mandates.put({ ...mandate, goal: 'New goal' })
    expect(store.mandates.list()).toHaveLength(1)
    expect(store.mandates.get('wt-1')?.goal).toBe('New goal')
    expect(store.mandates.get('missing')).toBeNull()
  })

  test('handoffs round-trip and list filters by field, including null', () => {
    const store = fresh()
    const base = { state: 'working' as const, sessionId: null, active: true, handedOffAt: 5, takenBackAt: null }
    store.handoffs.put({ worktreeId: 'a', ...base })
    store.handoffs.put({ worktreeId: 'b', ...base, active: false, takenBackAt: 9, sessionId: 's-1' })
    expect(store.handoffs.get('b')).toEqual({ worktreeId: 'b', ...base, active: false, takenBackAt: 9, sessionId: 's-1' })
    expect(store.handoffs.list({ active: true }).map((row) => row.worktreeId)).toEqual(['a'])
    expect(store.handoffs.list({ takenBackAt: null }).map((row) => row.worktreeId)).toEqual(['a'])
    expect(store.handoffs.delete('a')).toBe(true)
    expect(store.handoffs.delete('a')).toBe(false)
  })

  test('record cursors round-trip, upsert and delete by session', () => {
    const store = fresh()
    const row = {
      sessionId: 's',
      worktreeId: 'a',
      path: '/t.jsonl',
      readOffset: 42,
      pending: [{ agent: 'codex', cwd: '/w', toolName: 'shell', toolInput: { command: ['ls', '-la'] }, at: 7, fingerprint: 'f' }],
      updatedAt: 9
    }
    store.recordCursors.put(row)
    expect(store.recordCursors.get('s')).toEqual(row)
    store.recordCursors.put({ ...row, readOffset: 50 })
    expect(store.recordCursors.list()).toEqual([{ ...row, readOffset: 50 }])
    expect(store.recordCursors.delete('s')).toBe(true)
    expect(store.recordCursors.delete('s')).toBe(false)
  })

  test('every other table round-trips a row', () => {
    const store = fresh()
    const goal = { id: 'g1', goal: 'ship', worktreeIds: ['a', 'b'], mergeOrder: ['b', 'a'] }
    store.sharedGoals.put(goal)
    expect(store.sharedGoals.get('g1')).toEqual(goal)

    const receipt = { id: 'r1', fingerprint: 'f', sessionId: 's', toolName: 'Bash', at: 3, outcome: 'allow' as const, step: 'level' as const }
    store.receipts.put(receipt)
    expect(store.receipts.get('r1')).toEqual(receipt)
    store.receipts.put({ ...receipt, id: 'r2', step: null })
    expect(store.receipts.get('r2')?.step).toBeNull()

    const approval = { id: 'ap1', worktreeId: 'a', fingerprint: 'f', usedAt: null }
    store.approvals.put(approval)
    expect(store.approvals.get('ap1')).toEqual(approval)

    const late = { fingerprint: 'f', worktreeId: 'a', decision: 'allow' as const, reason: 'ok', createdAt: 2, usedAt: null }
    store.lateAnswers.put(late)
    expect(store.lateAnswers.get('f')).toEqual(late)

    const need = { id: 'n1', worktreeId: 'a', kind: 'held-call' as const, title: 'Held', detail: { call: { toolName: 'Bash' } }, actions: ['allow-once' as const, 'deny' as const], createdAt: 4, resolvedAt: null, resolution: null }
    store.needs.put(need)
    expect(store.needs.get('n1')).toEqual(need)

    const guess = { id: 'q1', worktreeId: 'a', question: 'Which?', choice: 'x', confirmedAt: null, redoneAt: null, commitsSince: ['abc'] }
    store.guesses.put(guess)
    expect(store.guesses.get('q1')).toEqual(guess)

    const finding = { id: 'f1', worktreeId: 'a', source: 'bot' as const, summary: 'nit', detail: { line: 3 }, valid: false, reason: 'wrong', threadId: 't', commitSha: 'abc', createdAt: 6 }
    store.findings.put(finding)
    expect(store.findings.get('f1')).toEqual(finding)
    store.findings.put({ ...finding, id: 'f2', valid: null, reason: null, threadId: null, commitSha: null })
    expect(store.findings.get('f2')?.valid).toBeNull()

    const stuck = { worktreeId: 'a', rung: 2 as const, counters: { nudges: 1 }, updatedAt: 7 }
    store.stuck.put(stuck)
    expect(store.stuck.get('a')).toEqual(stuck)

    const brain = { id: 'b1', sessionId: 's', startedAt: 1, endedAt: null, endTokens: null }
    store.brainSessions.put(brain)
    expect(store.brainSessions.get('b1')).toEqual(brain)
  })

  test('outbox round-trips and refuses a second row with the same idempotency key', () => {
    const store = fresh()
    const row = { id: 'o1', worktreeId: 'a', kind: 'push' as const, payload: { branch: 'x' }, idempotencyKey: 'k', state: 'recorded' as const, result: null }
    store.outbox.put(row)
    expect(store.outbox.get('o1')).toEqual(row)
    store.outbox.put({ ...row, state: 'done', result: { sha: 'abc' } })
    expect(store.outbox.get('o1')).toMatchObject({ state: 'done', result: { sha: 'abc' } })
    expect(() => store.outbox.put({ ...row, id: 'o2' })).toThrow()
  })

  test('the migrations create every table in the data model', () => {
    const plugin = memoryPluginStore()
    const tables = plugin.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((row) => row.name)
    expect(tables.sort()).toEqual(
      ['approvals', 'brain_sessions', 'findings', 'guesses', 'handoffs', 'journal', 'late_answers', 'mandates', 'needs_you', 'outbox', 'receipts', 'record_cursors', 'shared_goals', 'stuck'].sort()
    )
    expect(avatarMigrations.length).toBeGreaterThan(0)
  })

  test('upgrading from the first migration preserves handoffs and journal rows', () => {
    const home = mkdtempSync(join(tmpdir(), 'quirky-avatar-store-'))
    try {
      const { handoff, journalEntry } = (() => {
        const first = openPluginStore({ home, pluginId: 'quirky.avatar', migrations: avatarMigrations.slice(0, 1), isActive: () => true })
        try {
          expect(first.store.version).toBe(1)
          expect(first.store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'record_cursors'")).toEqual([])
          const store = createAvatarStore(first.store)
          const handoff = { worktreeId: 'a', state: 'working' as const, sessionId: 's', active: true, handedOffAt: 5, takenBackAt: null }
          store.handoffs.put(handoff)
          const journalEntry = store.appendJournal({ at: 7, worktreeId: 'a', kind: 'handoff', data: { goal: 'preserve me' } })
          return { handoff, journalEntry }
        } finally {
          first.close()
        }
      })()

      const upgraded = openPluginStore({ home, pluginId: 'quirky.avatar', migrations: avatarMigrations, isActive: () => true })
      try {
        const store = createAvatarStore(upgraded.store)
        expect(avatarMigrations.length).toBeGreaterThan(1)
        expect(upgraded.store.version).toBe(avatarMigrations.length)
        expect(store.handoffs.get('a')).toEqual(handoff)
        expect(store.journalSince(0)).toEqual([journalEntry])
        expect(store.recordCursors.list()).toEqual([])
      } finally {
        upgraded.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('avatar journal', () => {
  test('seq increases, entries read back in order and data round-trips', () => {
    const store = fresh()
    const first = store.appendJournal({ at: 1, worktreeId: 'a', kind: 'handoff', data: { goal: 'x' } })
    const second = store.appendJournal({ at: 2, worktreeId: null, kind: 'sleep', data: {} })
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(first).toEqual({ seq: first.seq, at: 1, worktreeId: 'a', kind: 'handoff', data: { goal: 'x' } })
    expect(store.journalSince(0)).toEqual([first, second])
    expect(store.journalSince(first.seq)).toEqual([second])
  })

  test('undelivered entries drop out once marked delivered', () => {
    const store = fresh()
    const first = store.appendJournal({ at: 1, worktreeId: 'a', kind: 'event', data: {} })
    const second = store.appendJournal({ at: 2, worktreeId: 'a', kind: 'event', data: {} })
    expect(store.undeliveredJournal().map((entry) => entry.seq)).toEqual([first.seq, second.seq])
    store.markDelivered(first.seq)
    expect(store.undeliveredJournal().map((entry) => entry.seq)).toEqual([second.seq])
  })

  test('a page is newest first and filters by worktree and cursor', () => {
    const store = fresh()
    const a1 = store.appendJournal({ at: 1, worktreeId: 'a', kind: 'gate', data: {} })
    store.appendJournal({ at: 2, worktreeId: 'b', kind: 'gate', data: {} })
    const a2 = store.appendJournal({ at: 3, worktreeId: 'a', kind: 'gate', data: {} })
    expect(store.journalPage({ worktreeId: 'a' }).map((entry) => entry.seq)).toEqual([a2.seq, a1.seq])
    expect(store.journalPage({ before: a2.seq, limit: 1 }).map((entry) => entry.at)).toEqual([2])
  })

  test('a throwing transaction rolls back its table and journal writes', () => {
    const store = fresh()
    expect(() =>
      store.transaction(() => {
        store.mandates.put(sampleMandate())
        store.appendJournal({ at: 1, worktreeId: 'wt-1', kind: 'handoff', data: {} })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(store.mandates.list()).toEqual([])
    expect(store.journalSince(0)).toEqual([])
  })
})

describe('callFingerprint', () => {
  test('is a sha256 hex that ignores object key order at any depth', () => {
    const a = callFingerprint('claude', 'wt', 'Bash', { command: 'ls', opts: { a: 1, b: [{ y: 1, x: 2 }] } })
    const b = callFingerprint('claude', 'wt', 'Bash', { opts: { b: [{ x: 2, y: 1 }], a: 1 }, command: 'ls' })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })

  test('differs when the agent, worktree, tool or input differs', () => {
    const base = callFingerprint('claude', 'wt', 'Bash', { command: 'ls' })
    expect(callFingerprint('codex', 'wt', 'Bash', { command: 'ls' })).not.toBe(base)
    expect(callFingerprint('claude', 'other', 'Bash', { command: 'ls' })).not.toBe(base)
    expect(callFingerprint('claude', 'wt', 'Read', { command: 'ls' })).not.toBe(base)
    expect(callFingerprint('claude', 'wt', 'Bash', { command: 'pwd' })).not.toBe(base)
  })
})
