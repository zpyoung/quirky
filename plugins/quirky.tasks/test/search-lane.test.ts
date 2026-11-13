import { describe, expect, test } from 'bun:test'
import type { TasksState } from '../src/contracts'
import { committed, createSearchLane, expected, observe, sending, settled, typed } from '../src/list/search-lane'

function reply(query: string, revision: number, mode: 'prs' | 'issues' = 'prs'): TasksState {
  return {
    revision,
    navigation: {
      source: 'github', mode, repoIds: null, query, page: 1, scrollTop: 0,
      detail: null, newIssue: false, project: null,
      lastList: { mode, query, page: 1 }
    },
    preferences: {
      showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github',
      defaultTaskViewPreset: 'all', defaultRepoSelection: null
    },
    issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
    projects: {
      pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {},
      columnWidths: {}, roadmapZoom: 'month'
    },
    links: {}
  }
}

const initial = { mode: 'prs', query: 'is:open' }

describe('expanded Tasks search lane', () => {
  test('L1: Projects drops pending text even while a commit is in flight', () => {
    const lane = createSearchLane()
    observe(lane, initial)
    sending(lane, 'is:open a')
    typed(lane)
    expect(observe(lane, { mode: 'projects', query: '' })).toBe('drop')
    expect(lane.dirty).toBe(false)
    expect(lane.inFlight).toBe(1)
    expect(lane.synced).toEqual(initial)
  })

  test('L2: any in-flight commit holds reconciliation, including an outside query', () => {
    const lane = createSearchLane()
    observe(lane, initial)
    sending(lane, 'is:open a')
    sending(lane, 'is:open b')
    typed(lane)
    settled(lane, reply('is:open a', 2))
    expect(observe(lane, { mode: 'prs', query: 'is:open outside' })).toBe('keep')
    expect(lane.dirty).toBe(true)
    expect(lane.synced).toEqual(initial)
    expect(lane.own).toEqual({ mode: 'prs', query: 'is:open a', revision: 2 })
    settled(lane, reply('is:open b', 3))
    expect(observe(lane, { mode: 'prs', query: 'is:open outside' })).toBe('adopt')
    expect(lane.dirty).toBe(false)
  })

  test('L3: unchanged observations keep pending text and consume an own reply', () => {
    const lane = createSearchLane()
    observe(lane, initial)
    sending(lane, initial.query)
    settled(lane, reply(initial.query, 2))
    typed(lane)
    expect(observe(lane, { ...initial })).toBe('keep')
    expect(lane.dirty).toBe(true)
    expect(lane.own).toBeNull()
  })

  test('L4: an own echo keeps newer text by mode and query, not by revision', () => {
    const lane = createSearchLane()
    observe(lane, initial)
    sending(lane, 'is:open a')
    committed(lane)
    typed(lane)
    settled(lane, reply('is:open a', 2))
    expect(observe(lane, { mode: 'prs', query: 'is:open a' })).toBe('keep')
    expect(lane.synced).toEqual({ mode: 'prs', query: 'is:open a' })
    expect(lane.dirty).toBe(true)
    expect(lane.own).toBeNull()
  })

  test('L5: outside query and mode changes replace pending text, and initial state is adopted', () => {
    const lane = createSearchLane()
    expect(observe(lane, initial)).toBe('adopt')
    typed(lane)
    expect(observe(lane, { mode: 'prs', query: 'is:open outside' })).toBe('adopt')
    expect(lane.dirty).toBe(false)
    sending(lane, 'is:open own')
    settled(lane, reply('is:open own', 2))
    typed(lane)
    expect(observe(lane, { mode: 'issues', query: 'is:open own' })).toBe('adopt')
    expect(lane.synced).toEqual({ mode: 'issues', query: 'is:open own' })
    expect(lane.own).toBeNull()
    expect(lane.dirty).toBe(false)
  })

  test('L6: out-of-order and failed settlements do not replace the newest successful reply', () => {
    const lane = createSearchLane()
    sending(lane, 'is:open a')
    sending(lane, 'is:open b')
    sending(lane, 'is:open c')
    settled(lane, reply('is:open b', 3))
    settled(lane, reply('is:open a', 2))
    expect(lane.own).toEqual({ mode: 'prs', query: 'is:open b', revision: 3 })
    settled(lane, null)
    expect(lane.inFlight).toBe(0)
    expect(lane.own).toEqual({ mode: 'prs', query: 'is:open b', revision: 3 })
  })

  test('L7: commits compare with the last sent query only while something is in flight', () => {
    const lane = createSearchLane()
    expect(expected(lane, initial.query)).toBe(initial.query)
    sending(lane, 'is:open a')
    expect(expected(lane, initial.query)).toBe('is:open a')
    sending(lane, initial.query)
    expect(expected(lane, initial.query)).toBe(initial.query)
    settled(lane, reply('is:open a', 2))
    expect(expected(lane, 'is:open a')).toBe(initial.query)
    settled(lane, null)
    expect(expected(lane, 'is:open a')).toBe('is:open a')
    typed(lane)
    committed(lane)
    expect(lane.dirty).toBe(false)
  })

  test('L8: a settled echo without newer text is adopted and cannot mask a later outside change', () => {
    const lane = createSearchLane()
    observe(lane, initial)
    sending(lane, 'is:open a')
    settled(lane, reply('is:open a', 2))
    expect(observe(lane, { mode: 'prs', query: 'is:open a' })).toBe('adopt')
    expect(lane.own).toBeNull()
    typed(lane)
    expect(observe(lane, { mode: 'prs', query: 'is:open outside' })).toBe('adopt')
    expect(lane.dirty).toBe(false)
    expect(lane.own).toBeNull()
  })
})
