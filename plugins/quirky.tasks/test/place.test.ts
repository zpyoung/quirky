import { beforeEach, expect, test } from 'bun:test'
import { place } from '../src/list/place'

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
