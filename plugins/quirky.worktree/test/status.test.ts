import { expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { mostUrgent, worktreeStatus } from '../src/status'

const session = (id: string, worktreeId: string, status: Session['status']): Session => ({
  id,
  kind: 'terminal',
  agent: 'shell',
  worktreeId,
  cwd: '/x',
  title: id,
  status,
  createdAt: 0,
  lastActivityAt: 0,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
})

test('picks the most urgent status', () => {
  expect(mostUrgent(['exited', 'running', 'done'])).toBe('done')
  expect(mostUrgent(['done', 'working', 'running'])).toBe('working')
  expect(mostUrgent(['working', 'waiting', 'done'])).toBe('waiting')
  expect(mostUrgent(['exited', 'running'])).toBe('running')
  expect(mostUrgent(['exited'])).toBe('exited')
})

test('treats starting as running and empty as null', () => {
  expect(mostUrgent(['starting', 'exited'])).toBe('running')
  expect(mostUrgent([])).toBeNull()
})

test('aggregates per worktree', () => {
  const sessions = [session('a', 'w1', 'done'), session('b', 'w1', 'waiting'), session('c', 'w2', 'running')]
  expect(worktreeStatus(sessions, 'w1')).toBe('waiting')
  expect(worktreeStatus(sessions, 'w2')).toBe('running')
  expect(worktreeStatus(sessions, 'w3')).toBeNull()
})
