import { expect, test } from 'bun:test'
import { initialState, reduce } from '../src/lib/state'

test('connected increments the epoch', () => {
  let state = reduce(initialState(), { type: 'connection', status: 'connected' })
  state = reduce(state, { type: 'connection', status: 'reconnecting' })
  state = reduce(state, { type: 'connection', status: 'connected' })
  expect(state.epoch).toBe(2)
  expect(state.connection).toBe('connected')
})

test('unreachable is a connection status that leaves the epoch alone', () => {
  const state = reduce(initialState(), { type: 'connection', status: 'unreachable' })
  expect(state.connection).toBe('unreachable')
  expect(state.epoch).toBe(0)
})

test('a notify event adds a toast, and dismiss removes it', () => {
  let state = reduce(initialState(), { type: 'event', event: { type: 'notify', title: 'wt', body: 'Claude finished' } })
  expect(state.toasts).toHaveLength(1)
  expect(state.toasts[0]).toMatchObject({ title: 'wt', body: 'Claude finished', kind: 'info' })
  expect(state.toasts[0]).not.toHaveProperty('open')
  state = reduce(state, { type: 'dismissToast', id: state.toasts[0]!.id })
  expect(state.toasts).toHaveLength(0)
})

test('a notify event keeps the view its toast opens', () => {
  const state = reduce(initialState(), {
    type: 'event',
    event: { type: 'notify', title: 'wt', body: 'done', open: { view: 'view:quirky.session/worktree', input: { worktree: 'w1' } } }
  })
  expect(state.toasts[0]!.open).toEqual({ view: 'view:quirky.session/worktree', input: { worktree: 'w1' } })
})

test('events other than notify leave the state alone', () => {
  const state = initialState()
  expect(reduce(state, { type: 'event', event: { type: 'plugin.changed' } })).toBe(state)
  expect(reduce(state, { type: 'event', event: { type: 'ui.state.changed', layout: { view: null, panel: null, sidebar: true, focus: null } } })).toBe(state)
})

test('toasts get increasing ids', () => {
  let state = reduce(initialState(), { type: 'toast', toast: { kind: 'error', title: 'a', body: 'x' } })
  state = reduce(state, { type: 'toast', toast: { kind: 'error', title: 'b', body: 'y' } })
  expect(state.toasts.map((t) => t.id)).toEqual([1, 2])
})
