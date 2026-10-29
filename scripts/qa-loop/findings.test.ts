import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AREAS, addFindings, claim, finish, nextArea, pastDeadline, release, type Finding } from './findings'

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

  test('a lane claims the oldest open finding and keeps it until it finishes', () => {
    addFindings(dir, [finding('first'), finding('second')])
    expect(claim(dir, 1)).toMatchObject({ kind: 'item', item: { id: 'qa-git-1', status: 'in-progress', lane: 1 } })
    expect(claim(dir, 1)).toMatchObject({ kind: 'item', item: { id: 'qa-git-1' } })
    expect(claim(dir, 2)).toMatchObject({ kind: 'item', item: { id: 'qa-git-2', lane: 2 } })
    expect(claim(dir, 3)).toEqual({ kind: 'empty' })
    finish(dir, 'qa-git-1', 'done', 'https://github.com/zpyoung/quirky/pull/9')
    expect(claim(dir, 1)).toEqual({ kind: 'empty' })
  })

  test('a released finding goes back to the queue, a blocked one does not', () => {
    addFindings(dir, [finding('first'), finding('second')])
    claim(dir, 1)
    claim(dir, 2)
    release(dir, 'qa-git-1')
    finish(dir, 'qa-git-2', 'blocked', 'needs a design decision')
    expect(claim(dir, 3)).toMatchObject({ kind: 'item', item: { id: 'qa-git-1', lane: 3 } })
  })

  test('a fixed finding is not filed again, a blocked one is not either', () => {
    addFindings(dir, [finding('first'), finding('second')])
    claim(dir, 1)
    finish(dir, 'qa-git-1', 'done', 'pr')
    claim(dir, 1)
    finish(dir, 'qa-git-2', 'blocked', 'why')
    expect(addFindings(dir, [finding('first'), finding('second')])).toEqual([])
  })

  test('areas come round in order', () => {
    const seen = AREAS.map(() => nextArea(dir))
    expect(seen).toEqual([...AREAS])
    expect(nextArea(dir)).toBe(AREAS[0]!)
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
