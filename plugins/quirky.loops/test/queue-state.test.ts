import { expect, test } from 'bun:test'
import type { IterationEnd, QueueItem, QueueOperation } from '../src/types'
import {
  applyQueueOperation,
  claimNextQueueItem,
  QueueConflictError,
  QueueItemNotFoundError,
  settleQueueClaim,
} from '../src/queue'

function item(
  id: string,
  position: number,
  state: QueueItem['state'] = 'pending',
  body = `task ${id}`
): QueueItem {
  return { id, position, body, state }
}

function queue(...items: QueueItem[]): QueueItem[] {
  return items
}

test('add inserts at an absolute position and defaults to append with dense positions', () => {
  const original = queue(item('a', 0), item('b', 1, 'done'))

  const inserted = applyQueueOperation(original, { kind: 'add', body: 'inserted', position: 1 }, 'x')
  const appended = applyQueueOperation(inserted, { kind: 'add', body: 'appended' }, 'y')

  expect(inserted).toEqual([
    item('a', 0),
    item('x', 1, 'pending', 'inserted'),
    item('b', 2, 'done'),
  ])
  expect(appended).toEqual([
    item('a', 0),
    item('x', 1, 'pending', 'inserted'),
    item('b', 2, 'done'),
    item('y', 3, 'pending', 'appended'),
  ])
  expect(original).toEqual(queue(item('a', 0), item('b', 1, 'done')))
})

test('edit preserves a done item identity, position, and state', () => {
  const original = queue(item('a', 0, 'done'), item('b', 1))

  expect(applyQueueOperation(original, { kind: 'edit', id: 'a', body: '  revised task  ' })).toEqual([
    item('a', 0, 'done', '  revised task  '),
    item('b', 1),
  ])
})

test('move reorders a done item and may shift an in-flight item without changing its claim', () => {
  const original = queue(item('a', 0), item('claim', 1, 'in-flight', 'exact claimed body'), item('c', 2, 'done'))

  expect(applyQueueOperation(original, { kind: 'move', id: 'c', position: 0 })).toEqual([
    item('c', 0, 'done'),
    item('a', 1),
    item('claim', 2, 'in-flight', 'exact claimed body'),
  ])
})

test('remove accepts a done item and compacts later positions', () => {
  const original = queue(item('a', 0), item('done', 1, 'done'), item('c', 2))

  expect(applyQueueOperation(original, { kind: 'remove', id: 'done' })).toEqual([
    item('a', 0),
    item('c', 1),
  ])
})

test('editing, moving, or removing an in-flight item conflicts without changing the queue', () => {
  const original = queue(item('a', 0), item('claim', 1, 'in-flight', 'claimed body'))
  const operations: QueueOperation[] = [
    { kind: 'edit', id: 'claim', body: 'replacement' },
    { kind: 'move', id: 'claim', position: 0 },
    { kind: 'remove', id: 'claim' },
  ]

  for (const operation of operations) {
    expect(() => applyQueueOperation(original, operation)).toThrow(QueueConflictError)
    expect(original).toEqual(queue(item('a', 0), item('claim', 1, 'in-flight', 'claimed body')))
  }
})

test('add allows insertion before an in-flight item while retaining its exact body and identity', () => {
  const original = queue(item('claim', 0, 'in-flight', 'claimed body'))

  expect(applyQueueOperation(original, { kind: 'add', body: 'later task', position: 0 }, 'later')).toEqual([
    item('later', 0, 'pending', 'later task'),
    item('claim', 1, 'in-flight', 'claimed body'),
  ])
})

test('blank and non-string operation bodies are rejected as type errors', () => {
  const original = queue(item('a', 0))
  const invalidBodies = ['', ' \n\t ', 42]

  for (const body of invalidBodies) {
    expect(() =>
      applyQueueOperation(original, { kind: 'add', body } as unknown as QueueOperation, 'new')
    ).toThrow(TypeError)
  }
  expect(() => applyQueueOperation(original, { kind: 'edit', id: 'a', body: ' ' })).toThrow(TypeError)
})

test('positions must be nonnegative integers within the operation-specific final range', () => {
  const original = queue(item('a', 0), item('b', 1))
  const invalidOperations: QueueOperation[] = [
    { kind: 'add', body: 'x', position: -1 },
    { kind: 'add', body: 'x', position: 1.5 },
    { kind: 'add', body: 'x', position: 3 },
    { kind: 'move', id: 'a', position: -1 },
    { kind: 'move', id: 'a', position: 0.5 },
    { kind: 'move', id: 'a', position: 2 },
  ]

  for (const operation of invalidOperations) {
    expect(() => applyQueueOperation(original, operation, 'new')).toThrow(TypeError)
  }
  expect(() => applyQueueOperation(original, { kind: 'add', body: 'x' })).toThrow(TypeError)
})

test('unknown or malformed operations are rejected as type errors', () => {
  const original = queue(item('a', 0))

  expect(() => applyQueueOperation(original, { kind: 'rename', id: 'a' } as unknown as QueueOperation)).toThrow(TypeError)
  expect(() => applyQueueOperation(original, null as unknown as QueueOperation)).toThrow(TypeError)
})

test('a missing target id is reported as not found rather than invalid input', () => {
  const original = queue(item('a', 0))

  expect(() => applyQueueOperation(original, { kind: 'edit', id: 'missing', body: 'task' })).toThrow(
    QueueItemNotFoundError
  )
  expect(() => applyQueueOperation(original, { kind: 'move', id: 'missing', position: 0 })).toThrow(
    QueueItemNotFoundError
  )
  expect(() => applyQueueOperation(original, { kind: 'remove', id: 'missing' })).toThrow(QueueItemNotFoundError)
})

test('claim retries the first in-flight item before any pending item', () => {
  const original = queue(item('pending', 0), item('claimed', 1, 'in-flight', 'exact retry body'), item('done', 2, 'done'))

  expect(claimNextQueueItem(original, true)).toEqual({
    items: original,
    claim: { id: 'claimed', body: 'exact retry body' },
  })
  expect(original).toEqual(queue(item('pending', 0), item('claimed', 1, 'in-flight', 'exact retry body'), item('done', 2, 'done')))
})

test('claim marks only the first pending item in flight and returns its identity and body', () => {
  const original = queue(item('a', 0, 'done'), item('b', 1, 'pending', 'body B'), item('c', 2))

  expect(claimNextQueueItem(original, true)).toEqual({
    items: queue(item('a', 0, 'done'), item('b', 1, 'in-flight', 'body B'), item('c', 2)),
    claim: { id: 'b', body: 'body B' },
  })
  expect(original).toEqual(queue(item('a', 0, 'done'), item('b', 1, 'pending', 'body B'), item('c', 2)))
})

test('repeat resets completed items only when the next cycle is claimed', () => {
  const original = queue(item('a', 0, 'done', 'body A'), item('b', 1, 'done', 'body B'))
  const claimed = claimNextQueueItem(original, true)

  expect(claimed).toEqual({
    items: queue(item('a', 0, 'in-flight', 'body A'), item('b', 1, 'pending', 'body B')),
    claim: { id: 'a', body: 'body A' },
  })
  expect(original).toEqual(queue(item('a', 0, 'done', 'body A'), item('b', 1, 'done', 'body B')))
})

test('claim leaves a nonempty done queue exhausted when repeat is disabled', () => {
  const original = queue(item('a', 0, 'done'))

  expect(claimNextQueueItem(original, false)).toEqual({ items: original, claim: null })
})

test('empty queues have no claim, including when repeat is enabled', () => {
  expect(claimNextQueueItem([], true)).toEqual({ items: [], claim: null })
})

test('settlement completes exactly the claimed item', () => {
  const original = queue(item('a', 0, 'in-flight'), item('b', 1, 'pending'), item('c', 2, 'done'))

  expect(settleQueueClaim(original, 'a', 'settled')).toEqual([
    item('a', 0, 'done'),
    item('b', 1, 'pending'),
    item('c', 2, 'done'),
  ])
  expect(original).toEqual(queue(item('a', 0, 'in-flight'), item('b', 1, 'pending'), item('c', 2, 'done')))
})

test('failed, crashed, interrupted, stopped, and unverifiable attempts do not consume a claim', () => {
  const original = queue(item('a', 0, 'in-flight', 'retry me'))
  const nonSettledEnds: IterationEnd[] = ['crashed', 'interrupted', 'stopped', 'unverifiable']

  for (const end of nonSettledEnds) {
    expect(settleQueueClaim(original, 'a', end)).toEqual(original)
  }
})
