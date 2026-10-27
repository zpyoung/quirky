import { describe, expect, test } from 'bun:test'
import { displayTitle, nextTerminalTitle, recentOrder, removeRecent, touchRecent } from '../src/layout/titles'

describe('nextTerminalTitle', () => {
  test('SC-8: takes the lowest free number', () => {
    expect(nextTerminalTitle([])).toBe('Terminal 1')
    expect(nextTerminalTitle(['Terminal 1', 'Terminal 3'])).toBe('Terminal 2')
    expect(nextTerminalTitle(['Terminal 1', 'Terminal 2'])).toBe('Terminal 3')
  })

  test('ignores titles that only look like defaults', () => {
    expect(nextTerminalTitle(['Build', 'terminal 1', 'Terminal 1 copy', 'Terminal 01x'])).toBe('Terminal 1')
    expect(nextTerminalTitle(['Terminal 0'])).toBe('Terminal 1')
  })
})

describe('displayTitle', () => {
  const tab = { defaultTitle: 'Terminal 2', customTitle: null as string | null, liveTitle: null as string | null }

  test('SC-10: custom beats live beats default', () => {
    expect(displayTitle(tab)).toBe('Terminal 2')
    expect(displayTitle({ ...tab, liveTitle: 'deploy' })).toBe('deploy')
    expect(displayTitle({ ...tab, liveTitle: 'deploy', customTitle: 'Build' })).toBe('Build')
  })

  test('SC-10: clearing the custom title lets the live title show again', () => {
    expect(displayTitle({ ...tab, liveTitle: 'deploy', customTitle: '' })).toBe('deploy')
  })

  test('a blank live title falls back to the default', () => {
    expect(displayTitle({ ...tab, liveTitle: '  ' })).toBe('Terminal 2')
  })
})

describe('recent list', () => {
  test('touch moves an id to the front without duplicating it', () => {
    expect(touchRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(touchRecent(['a'], 'z')).toEqual(['z', 'a'])
  })

  test('touch and remove leave the input alone', () => {
    const recent = ['a', 'b']
    touchRecent(recent, 'b')
    removeRecent(recent, 'a')
    expect(recent).toEqual(['a', 'b'])
  })

  test('remove drops an id', () => {
    expect(removeRecent(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(removeRecent(['a'], 'z')).toEqual(['a'])
  })

  test('SC-21: Ctrl+Tab order is recent first, then the rest by position', () => {
    const tabs = [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }]
    expect(recentOrder(tabs, ['t4', 't1', 't3'])).toEqual(['t4', 't1', 't3', 't2'])
  })

  test('recent ids of closed tabs are skipped', () => {
    expect(recentOrder([{ id: 't1' }, { id: 't2' }], ['gone', 't2'])).toEqual(['t2', 't1'])
  })
})
