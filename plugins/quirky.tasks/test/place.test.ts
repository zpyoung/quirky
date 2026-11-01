import { beforeEach, expect, test } from 'bun:test'
import { LIST_SNAPSHOT_LIMIT, place, type ListSnapshot } from '../src/list/place'

beforeEach(() => { place.takeFocus() })

test('scrollTop defaults to zero for a place that was never set', () => {
  expect(place.scrollTop('compact', 'issues|is:issue is:open|1')).toBe(0)
})

test('scrollTop is remembered per form and per view key', () => {
  place.setScrollTop('compact', 'key-a', 120)
  place.setScrollTop('expanded', 'key-a', 480)
  place.setScrollTop('compact', 'key-b', 7)
  expect(place.scrollTop('compact', 'key-a')).toBe(120)
  expect(place.scrollTop('expanded', 'key-a')).toBe(480)
  expect(place.scrollTop('compact', 'key-b')).toBe(7)
  expect(place.scrollTop('expanded', 'key-b')).toBe(0)
})

test('setScrollTop overwrites the earlier value', () => {
  place.setScrollTop('compact', 'key-over', 120)
  place.setScrollTop('compact', 'key-over', 30)
  expect(place.scrollTop('compact', 'key-over')).toBe(30)
})

test('takeFocus returns nothing when no focus was requested', () => {
  expect(place.takeFocus()).toBeNull()
})

test('takeFocus returns the requested target once, then null', () => {
  place.requestFocus('collapse')
  expect(place.takeFocus()).toBe('collapse')
  expect(place.takeFocus()).toBeNull()
})

test('a later requestFocus replaces an unclaimed one', () => {
  place.requestFocus('row')
  place.requestFocus('expand')
  expect(place.takeFocus()).toBe('expand')
  expect(place.takeFocus()).toBeNull()
})

function snapshot(page: number): ListSnapshot {
  return { list: { items: [], repositories: [], page, totalPages: 1, perRepo: 0, failures: [], sources: {} }, checks: {}, merge: {} }
}

test('listSnapshot is null for a view that was never saved', () => {
  expect(place.listSnapshot('never-saved')).toBeNull()
})

test('setListSnapshot keeps the latest snapshot per view key', () => {
  place.setListSnapshot('snap-a', snapshot(1))
  place.setListSnapshot('snap-b', snapshot(2))
  place.setListSnapshot('snap-a', snapshot(3))
  expect(place.listSnapshot('snap-a')?.list.page).toBe(3)
  expect(place.listSnapshot('snap-b')?.list.page).toBe(2)
})

test('snapshots are bounded and drop the oldest view first', () => {
  for (let index = 0; index < LIST_SNAPSHOT_LIMIT + 5; index++) place.setListSnapshot(`bound-${index}`, snapshot(index))
  for (let index = 0; index < 5; index++) expect(place.listSnapshot(`bound-${index}`)).toBeNull()
  for (let index = 5; index < LIST_SNAPSHOT_LIMIT + 5; index++) expect(place.listSnapshot(`bound-${index}`)?.list.page).toBe(index)
})

test('saving a view again makes it the newest, so it outlives older ones', () => {
  for (let index = 0; index < LIST_SNAPSHOT_LIMIT; index++) place.setListSnapshot(`recent-${index}`, snapshot(index))
  place.setListSnapshot('recent-0', snapshot(99))
  place.setListSnapshot('recent-new', snapshot(100))
  expect(place.listSnapshot('recent-0')?.list.page).toBe(99)
  expect(place.listSnapshot('recent-1')).toBeNull()
})
