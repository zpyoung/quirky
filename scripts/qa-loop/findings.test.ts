import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AREA_POOLS,
  MAX_OPEN_WORKTREES,
  addFindings,
  answer,
  assign,
  finish,
  listFindings,
  nextArea,
  openFindings,
  pastDeadline,
  prioritize,
  question,
  release,
  review,
  rework,
  type Finding
} from './findings'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-loop-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const finding = (title: string, area = 'git'): Omit<Finding, 'id' | 'status' | 'createdAt'> => ({
  area,
  title,
  steps: ['open Changes'],
  expected: 'the file is listed',
  actual: 'nothing is listed',
  evidence: []
})

describe('findings queue', () => {
  test('adds findings with stable ids and skips one already open under the same title', () => {
    expect(addFindings(dir, [finding('Stage All does nothing')])).toEqual(['qa-git-1'])
    expect(addFindings(dir, [finding('stage all  does nothing'), finding('Diff tab blank')])).toEqual(['qa-git-2'])
  })

  test('assigns the oldest queued finding to a worktree named after it', () => {
    addFindings(dir, [finding('first'), finding('second')])
    expect(assign(dir)).toMatchObject({ kind: 'item', item: { id: 'qa-git-1', status: 'in-progress', worktree: 'fix-qa-git-1' } })
    expect(assign(dir)).toMatchObject({ kind: 'item', item: { id: 'qa-git-2', worktree: 'fix-qa-git-2' } })
    expect(assign(dir)).toEqual({ kind: 'empty' })
  })

  test('a prioritized finding goes ahead of the older backlog', () => {
    addFindings(dir, [finding('old'), finding('new regression')])
    prioritize(dir, 'qa-git-2')
    expect(assign(dir)).toMatchObject({ kind: 'item', item: { id: 'qa-git-2' } })
  })

  test('holds findings in the queue once the worktree cap is reached and frees a slot on close', () => {
    addFindings(dir, Array.from({ length: MAX_OPEN_WORKTREES + 1 }, (_, index) => finding(`finding ${index}`)))
    for (let index = 0; index < MAX_OPEN_WORKTREES; index++) expect(assign(dir).kind).toBe('item')
    expect(openFindings(dir)).toHaveLength(MAX_OPEN_WORKTREES)
    expect(assign(dir)).toEqual({ kind: 'full', open: MAX_OPEN_WORKTREES })
    finish(dir, 'qa-git-1', 'done', 'pr')
    expect(assign(dir)).toMatchObject({ kind: 'item', item: { id: `qa-git-${MAX_OPEN_WORKTREES + 1}` } })
  })

  test('questions and reviews keep the worktree slot until the finding closes', () => {
    addFindings(dir, [finding('first')])
    assign(dir)
    question(dir, 'qa-git-1', 'keep the old label?')
    expect(openFindings(dir)).toMatchObject([{ id: 'qa-git-1', status: 'needs-answer' }])
    answer(dir, 'qa-git-1', 'yes')
    review(dir, 'qa-git-1', 'https://github.com/zpyoung/quirky/pull/9')
    expect(openFindings(dir)).toMatchObject([{ status: 'in-review', pr: 'https://github.com/zpyoung/quirky/pull/9' }])
    rework(dir, 'qa-git-1', 'add a test for the empty list')
    review(dir, 'qa-git-1', 'https://github.com/zpyoung/quirky/pull/9')
    finish(dir, 'qa-git-1', 'done', 'https://github.com/zpyoung/quirky/pull/9')
    expect(openFindings(dir)).toEqual([])
    expect(listFindings(dir, { status: 'done' })[0]!.notes?.map((note) => note.kind)).toEqual(['question', 'answer', 'rework'])
  })

  test('refuses a step that does not fit the finding, so a stale command cannot undo work', () => {
    addFindings(dir, [finding('first')])
    expect(() => review(dir, 'qa-git-1', 'pr')).toThrow('todo')
    assign(dir)
    expect(() => answer(dir, 'qa-git-1', 'yes')).toThrow('in-progress')
    expect(() => rework(dir, 'qa-git-1', 'more')).toThrow('in-progress')
  })

  test('a released finding goes back to the queue without its worktree, a blocked one does not', () => {
    addFindings(dir, [finding('first'), finding('second')])
    assign(dir)
    assign(dir)
    release(dir, 'qa-git-1')
    finish(dir, 'qa-git-2', 'blocked', 'stale: already fixed')
    expect(listFindings(dir, { status: 'todo' })[0]).not.toHaveProperty('worktree')
    expect(assign(dir)).toMatchObject({ kind: 'item', item: { id: 'qa-git-1' } })
    expect(assign(dir)).toEqual({ kind: 'empty' })
  })

  test('a fixed finding is not filed again, a blocked one is not either', () => {
    addFindings(dir, [finding('first'), finding('second')])
    finish(dir, 'qa-git-1', 'done', 'pr')
    finish(dir, 'qa-git-2', 'blocked', 'why')
    expect(addFindings(dir, [finding('first'), finding('second')])).toEqual([])
  })

  test('filters findings by status and area', () => {
    addFindings(dir, [finding('first'), finding('second', 'files')])
    expect(listFindings(dir, { area: 'files' }).map((item) => item.id)).toEqual(['qa-files-1'])
    expect(listFindings(dir, { status: 'done' })).toEqual([])
  })

  test('each pool rotates through its own areas independently', () => {
    expect(AREA_POOLS.native.map(() => nextArea(dir, 'native'))).toEqual([...AREA_POOLS.native])
    expect(nextArea(dir, 'web')).toBe(AREA_POOLS.web[0]!)
    expect(nextArea(dir, 'native')).toBe(AREA_POOLS.native[0]!)
    expect(nextArea(dir, 'web')).toBe(AREA_POOLS.web[1]!)
  })

  test('a queue file from the earlier harness keeps working', () => {
    writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [], nextArea: 3 }))
    expect(nextArea(dir, 'web')).toBe(AREA_POOLS.web[0]!)
  })

  test('the deadline passes at the configured time', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ deadline: '2026-10-30T04:00:00-05:00' }))
    expect(pastDeadline(dir, new Date('2026-10-30T03:59:00-05:00'))).toBe(false)
    expect(pastDeadline(dir, new Date('2026-10-30T04:00:00-05:00'))).toBe(true)
  })

  test('the queue file is plain JSON a person can read', () => {
    addFindings(dir, [finding('first')])
    expect(JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')).findings[0].title).toBe('first')
  })
})
