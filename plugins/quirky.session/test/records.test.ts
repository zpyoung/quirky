import { describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { SessionRecords } from '../src/records'
import { memoryStore, migrateStore } from './memory-store'

const session: Session = {
  id: 's_new',
  kind: 'terminal',
  agent: 'claude',
  worktreeId: 'wt',
  cwd: '/work',
  title: 'Claude',
  status: 'running',
  createdAt: 2,
  lastActivityAt: 2,
  exitCode: null,
  launch: { command: 'claude', args: '--model haiku', env: { A: '1' } },
  providerSession: { id: 'abc', transcriptPath: '/t.jsonl' },
  promptDelivery: 'pending',
  resumedFrom: 's_old'
}

describe('session store migration 2', () => {
  test('SC-38: a row written before it reads with null launch fields, and keeps working', () => {
    const store = memoryStore(1)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo')"
    )
    migrateStore(store, 1)
    const records = new SessionRecords(store)

    expect(records.get('s_old')).toEqual({
      id: 's_old',
      kind: 'terminal',
      agent: 'claude',
      worktreeId: 'wt',
      cwd: '/work',
      title: 'Claude',
      status: 'running',
      createdAt: 1,
      lastActivityAt: 1,
      exitCode: null,
      launch: null,
      providerSession: null,
      promptDelivery: null,
      resumedFrom: null
    })
    expect(records.update('s_old', { status: 'exited', exitCode: 0 })).toMatchObject({ status: 'exited', launch: null })
    expect(records.repoIdOf('s_old')).toBe('repo')
  })

  test('the new columns round-trip through insert and update', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    expect(records.get('s_new')).toEqual(session)

    records.update('s_new', { promptDelivery: 'pasted', providerSession: { id: 'xyz', transcriptPath: null } })
    expect(records.get('s_new')).toEqual({ ...session, promptDelivery: 'pasted', providerSession: { id: 'xyz', transcriptPath: null } })
  })

  test('a session recorded without the new fields stores them as null', () => {
    const records = new SessionRecords(memoryStore())
    const { launch, providerSession, promptDelivery, resumedFrom, ...bare } = session
    records.insert(bare, 'repo')
    expect(records.get('s_new')).toMatchObject({ launch: null, providerSession: null, promptDelivery: null, resumedFrom: null })
  })

  test('a row whose JSON column is damaged reads as null instead of failing the listing', () => {
    const store = memoryStore()
    const records = new SessionRecords(store)
    records.insert(session, 'repo')
    store.run("UPDATE sessions SET launch = '{broken', provider_session = '[' WHERE id = 's_new'")
    expect(records.list()).toEqual([{ ...session, launch: null, providerSession: null }])
  })

  test('pending deliveries can be swept to not-delivered', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    records.insert({ ...session, id: 's_done', promptDelivery: 'pasted' }, 'repo')
    expect(records.sweepPendingDeliveries()).toEqual(['s_new'])
    expect(records.get('s_new')?.promptDelivery).toBe('not-delivered')
    expect(records.get('s_done')?.promptDelivery).toBe('pasted')
    expect(records.sweepPendingDeliveries()).toEqual([])
  })
})
