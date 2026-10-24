import { expect, test } from 'bun:test'
import type { Ask, Repo, Session, StructuredMessage, Worktree } from '@quirky/protocol'
import { initialState, reduce, sessionsOf, type AppState } from '../src/lib/state'

const repo: Repo = { id: 'r1', name: 'repo', path: '/repo', addedAt: 1 }
const wt = (id: string, name = id, isMain = false): Worktree => ({
  id,
  repoId: 'r1',
  path: `/wt/${id}`,
  branch: name,
  head: 'abc',
  isMain,
  name
})
const sess = (id: string, worktreeId: string, createdAt = 0, status: Session['status'] = 'running'): Session => ({
  id,
  kind: 'terminal',
  agent: 'shell',
  worktreeId,
  cwd: '/x',
  title: id,
  status,
  createdAt,
  lastActivityAt: createdAt,
  exitCode: null
})
const ask = (id: string): Ask => ({
  id,
  spec: { questions: [] },
  sessionId: null,
  worktreeId: null,
  createdAt: 0,
  envelope: { status: 'pending', askId: id, answers: {}, skipped: [] }
})
const msg = (sessionId: string, seq: number, text = 't'): StructuredMessage => ({
  sessionId,
  seq,
  role: 'assistant',
  text,
  at: 0
})
const settings = { worktreesRoot: '/w', terminalScrollback: 2000, notifications: true }

function loaded(): AppState {
  return reduce(initialState(), {
    type: 'snapshot',
    repos: [repo],
    worktrees: [wt('w2', 'zeta'), wt('w1', 'main', true)],
    sessions: [sess('s2', 'w1', 2), sess('s1', 'w1', 1)],
    asks: [ask('a1')],
    settings
  })
}

test('snapshot sorts, and selects the first worktree and its first session', () => {
  const state = loaded()
  expect(state.worktrees.map((w) => w.id)).toEqual(['w1', 'w2'])
  expect(state.selectedWorktreeId).toBe('w1')
  expect(state.selectedSessionId).toBe('s1')
  expect(sessionsOf(state, 'w1').map((s) => s.id)).toEqual(['s1', 's2'])
})

test('connected increments the epoch', () => {
  let state = reduce(initialState(), { type: 'connection', status: 'connected' })
  state = reduce(state, { type: 'connection', status: 'reconnecting' })
  state = reduce(state, { type: 'connection', status: 'connected' })
  expect(state.epoch).toBe(2)
  expect(state.connection).toBe('connected')
})

test('selecting a worktree restores its last session', () => {
  let state = loaded()
  state = reduce(state, { type: 'event', event: { type: 'session.changed', session: sess('s3', 'w2', 3) } })
  state = reduce(state, { type: 'selectSession', id: 's2' })
  state = reduce(state, { type: 'selectWorktree', id: 'w2' })
  expect(state.selectedSessionId).toBe('s3')
  state = reduce(state, { type: 'selectWorktree', id: 'w1' })
  expect(state.selectedSessionId).toBe('s2')
})

test('session.changed upserts and session.removed removes and reselects', () => {
  let state = loaded()
  state = reduce(state, { type: 'event', event: { type: 'session.changed', session: sess('s1', 'w1', 1, 'waiting') } })
  expect(state.sessions.find((s) => s.id === 's1')?.status).toBe('waiting')
  expect(state.sessions).toHaveLength(2)
  state = reduce(state, { type: 'event', event: { type: 'session.removed', sessionId: 's1' } })
  expect(state.sessions.map((s) => s.id)).toEqual(['s2'])
  expect(state.selectedSessionId).toBe('s2')
  state = reduce(state, { type: 'event', event: { type: 'session.removed', sessionId: 's2' } })
  expect(state.selectedSessionId).toBeNull()
})

test('removing the selected worktree falls back to another', () => {
  let state = loaded()
  state = reduce(state, { type: 'worktrees', worktrees: [wt('w2', 'zeta')] })
  expect(state.selectedWorktreeId).toBe('w2')
  expect(state.selectedSessionId).toBeNull()
})

test('asks are added once and removed on resolve', () => {
  let state = loaded()
  state = reduce(state, { type: 'event', event: { type: 'ask.created', ask: ask('a2') } })
  state = reduce(state, { type: 'event', event: { type: 'ask.created', ask: ask('a2') } })
  expect(state.asks.map((a) => a.id)).toEqual(['a1', 'a2'])
  state = reduce(state, {
    type: 'event',
    event: { type: 'ask.resolved', askId: 'a1', envelope: { status: 'answered', askId: 'a1', answers: {}, skipped: [] } }
  })
  expect(state.asks.map((a) => a.id)).toEqual(['a2'])
})

test('notify adds a toast and dismiss removes it', () => {
  let state = loaded()
  state = reduce(state, { type: 'event', event: { type: 'notify', title: 'wt', body: 'Claude finished', worktreeId: 'w1' } })
  expect(state.toasts).toHaveLength(1)
  expect(state.toasts[0]).toMatchObject({ title: 'wt', body: 'Claude finished', kind: 'info', worktreeId: 'w1' })
  state = reduce(state, { type: 'dismissToast', id: state.toasts[0]!.id })
  expect(state.toasts).toHaveLength(0)
})

test('structured messages append in order without duplicates', () => {
  let state = loaded()
  state = reduce(state, { type: 'structured', sessionId: 's1', messages: [msg('s1', 1), msg('s1', 2)] })
  state = reduce(state, { type: 'event', event: { type: 'structured.message', message: msg('s1', 3) } })
  state = reduce(state, { type: 'event', event: { type: 'structured.message', message: msg('s1', 2, 'dup') } })
  expect(state.structured.s1!.map((m) => m.seq)).toEqual([1, 2, 3])
  expect(state.structured.s1![1]!.text).toBe('t')
})

test('removing a session drops its structured messages', () => {
  let state = loaded()
  state = reduce(state, { type: 'structured', sessionId: 's1', messages: [msg('s1', 1)] })
  state = reduce(state, { type: 'event', event: { type: 'session.removed', sessionId: 's1' } })
  expect(state.structured.s1).toBeUndefined()
})
