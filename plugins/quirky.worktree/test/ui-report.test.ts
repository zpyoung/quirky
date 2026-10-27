import { expect, test } from 'bun:test'
import type { Repo, Session, Worktree } from '@quirky/protocol'
import { buildReport } from '../src/report'

const repo = (id: string, name: string): Repo => ({ id, name, path: `/r/${name}`, addedAt: 0 })

const worktree = (id: string, repoId: string, name: string, branch: string | null = name): Worktree => ({
  id,
  repoId,
  path: `/w/${name}`,
  branch,
  head: 'abc',
  isMain: false,
  name
})

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

test('SC-35: the report groups worktrees under their repo with status and selection', () => {
  const report = buildReport(
    [repo('r1', 'api'), repo('r2', 'web')],
    [worktree('w1', 'r1', 'main'), worktree('w2', 'r1', 'fix-login'), worktree('w3', 'r2', 'main')],
    [session('s1', 'w2', 'running'), session('s2', 'w2', 'waiting')],
    'w2'
  )
  expect(report).toEqual({
    repos: [
      {
        id: 'r1',
        name: 'api',
        worktrees: [
          { id: 'w1', name: 'main', branch: 'main', status: null, selected: false },
          { id: 'w2', name: 'fix-login', branch: 'fix-login', status: 'waiting', selected: true }
        ]
      },
      { id: 'r2', name: 'web', worktrees: [{ id: 'w3', name: 'main', branch: 'main', status: null, selected: false }] }
    ]
  })
})

test('SC-35: every status is null when quirky.session is off', () => {
  const report = buildReport([repo('r1', 'api')], [worktree('w1', 'r1', 'main')], null, null)
  expect(report.repos[0]!.worktrees[0]!.status).toBeNull()
})

test('a detached worktree reports a null branch and a repo with none reports an empty list', () => {
  const report = buildReport([repo('r1', 'api'), repo('r2', 'web')], [worktree('w1', 'r1', 'x', null)], [], null)
  expect(report.repos[0]!.worktrees[0]!.branch).toBeNull()
  expect(report.repos[1]!.worktrees).toEqual([])
})

test('a worktree drawn from an agent summary also reports its display and label', () => {
  const summary = {
    state: 'waiting' as const,
    display: 'permission' as const,
    label: 'Needs attention',
    detail: '',
    progress: null,
    stateStartedAt: 1000,
    evidenceAt: 1000,
    restoredUnconfirmed: false
  }
  const report = buildReport(
    [repo('r1', 'api')],
    [worktree('w1', 'r1', 'main'), worktree('w2', 'r1', 'fix')],
    [{ ...session('s1', 'w1', 'waiting'), agentStatus: summary }, session('s2', 'w2', 'working')],
    null,
    2000
  )
  expect(report.repos[0]!.worktrees).toEqual([
    { id: 'w1', name: 'main', branch: 'main', status: 'waiting', display: 'permission', label: 'Needs attention', selected: false },
    { id: 'w2', name: 'fix', branch: 'fix', status: 'working', selected: false }
  ])
})
