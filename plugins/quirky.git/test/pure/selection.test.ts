import { describe, expect, test } from 'bun:test'
import { EMPTY_SELECTION, isSelected, reduceSelection, type SelectionAction, type SelectionState } from '../../src/panel/selection'

const order = ['a.ts', 'b.ts', 'c.ts', 'd.ts']

const run = (state: SelectionState, action: SelectionAction) => reduceSelection(state, action)

describe('SC-15 walkthrough', () => {
  test('click, shift-click, mod-click, escape', () => {
    // 1. click a.ts: opens its diff, anchor a.ts, nothing selected
    let r = run(EMPTY_SELECTION, { type: 'click', path: 'a.ts' })
    expect(r.open).toBe('a.ts')
    expect(r.state).toEqual({ selected: [], anchor: 'a.ts' })

    // 2. shift-click c.ts: a, b, c; the anchor stays
    r = run(r.state, { type: 'shift-click', path: 'c.ts', order })
    expect(r.open).toBeNull()
    expect(r.state).toEqual({ selected: ['a.ts', 'b.ts', 'c.ts'], anchor: 'a.ts' })

    // 3. mod-click b.ts: toggled off, a and c remain
    r = run(r.state, { type: 'mod-click', path: 'b.ts' })
    expect(r.open).toBeNull()
    expect(r.state.selected).toEqual(['a.ts', 'c.ts'])
    expect(r.state.anchor).toBe('b.ts')

    // 4. escape: nothing selected, bar hidden
    r = run(r.state, { type: 'escape' })
    expect(r.open).toBeNull()
    expect(r.state).toEqual(EMPTY_SELECTION)
  })
})

describe('click', () => {
  test('clears the selection and opens the row', () => {
    const r = run({ selected: ['a.ts', 'b.ts'], anchor: 'a.ts' }, { type: 'click', path: 'd.ts' })
    expect(r).toEqual({ state: { selected: [], anchor: 'd.ts' }, open: 'd.ts' })
  })
})

describe('mod-click', () => {
  test('selects an unselected row and moves the anchor', () => {
    const r = run(EMPTY_SELECTION, { type: 'mod-click', path: 'b.ts' })
    expect(r.state).toEqual({ selected: ['b.ts'], anchor: 'b.ts' })
    expect(r.open).toBeNull()
  })

  test('toggles a selected row off and keeps the others', () => {
    const r = run({ selected: ['a.ts', 'b.ts'], anchor: 'a.ts' }, { type: 'mod-click', path: 'a.ts' })
    expect(r.state).toEqual({ selected: ['b.ts'], anchor: 'a.ts' })
  })

  test('adds to an existing selection', () => {
    const r = run({ selected: ['a.ts'], anchor: 'a.ts' }, { type: 'mod-click', path: 'd.ts' })
    expect(r.state.selected).toEqual(['a.ts', 'd.ts'])
  })
})

describe('shift-click', () => {
  test('selects the range from the anchor, in either direction', () => {
    expect(run({ selected: [], anchor: 'c.ts' }, { type: 'shift-click', path: 'a.ts', order }).state.selected).toEqual([
      'a.ts',
      'b.ts',
      'c.ts'
    ])
  })

  test('replaces the previous range', () => {
    const first = run({ selected: [], anchor: 'a.ts' }, { type: 'shift-click', path: 'd.ts', order })
    expect(first.state.selected).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(run(first.state, { type: 'shift-click', path: 'b.ts', order }).state.selected).toEqual(['a.ts', 'b.ts'])
  })

  test('with no anchor it selects just that row and anchors it', () => {
    expect(run(EMPTY_SELECTION, { type: 'shift-click', path: 'b.ts', order }).state).toEqual({
      selected: ['b.ts'],
      anchor: 'b.ts'
    })
  })

  test('with an anchor no longer visible it starts over from the clicked row', () => {
    expect(run({ selected: [], anchor: 'gone.ts' }, { type: 'shift-click', path: 'b.ts', order }).state).toEqual({
      selected: ['b.ts'],
      anchor: 'b.ts'
    })
  })

  test('shift-clicking the anchor selects only it', () => {
    expect(run({ selected: ['a.ts', 'b.ts'], anchor: 'a.ts' }, { type: 'shift-click', path: 'a.ts', order }).state.selected).toEqual(['a.ts'])
  })

  test('never opens a row', () => {
    expect(run({ selected: [], anchor: 'a.ts' }, { type: 'shift-click', path: 'c.ts', order }).open).toBeNull()
  })
})

describe('context-click', () => {
  test('on an unselected row selects only it', () => {
    const r = run({ selected: ['a.ts', 'b.ts'], anchor: 'a.ts' }, { type: 'context-click', path: 'd.ts' })
    expect(r.state).toEqual({ selected: ['d.ts'], anchor: 'd.ts' })
    expect(r.open).toBeNull()
  })

  test('on a selected row keeps the selection', () => {
    const state = { selected: ['a.ts', 'b.ts'], anchor: 'a.ts' }
    expect(run(state, { type: 'context-click', path: 'b.ts' }).state).toBe(state)
  })
})

describe('escape, reset and prune', () => {
  test('escape clears the selection and anchor', () => {
    expect(run({ selected: ['a.ts'], anchor: 'a.ts' }, { type: 'escape' }).state).toEqual(EMPTY_SELECTION)
  })

  test('escape on an empty selection returns the same state', () => {
    expect(run(EMPTY_SELECTION, { type: 'escape' }).state).toBe(EMPTY_SELECTION)
  })

  test('reset (view mode or worktree change) clears everything', () => {
    expect(run({ selected: ['a.ts'], anchor: 'a.ts' }, { type: 'reset' }).state).toEqual(EMPTY_SELECTION)
  })

  test('prune drops selected paths that are no longer visible', () => {
    const r = run({ selected: ['a.ts', 'b.ts', 'x.ts'], anchor: 'x.ts' }, { type: 'prune', order })
    expect(r.state).toEqual({ selected: ['a.ts', 'b.ts'], anchor: null })
  })

  test('prune returns the same state when nothing changed', () => {
    const state = { selected: ['a.ts'], anchor: 'a.ts' }
    expect(run(state, { type: 'prune', order }).state).toBe(state)
  })
})

describe('isSelected', () => {
  test('reads membership', () => {
    const state = { selected: ['a.ts'], anchor: null }
    expect(isSelected(state, 'a.ts')).toBe(true)
    expect(isSelected(state, 'b.ts')).toBe(false)
  })
})
